import {
  FiberPaymentClaimSchema,
  canonical,
  computeFiberPaymentPurposeHash,
  sha256Hex,
  type ApplicationProfile,
  type SignedEvent,
  type TranscriptExport
} from "@eventmesh/core";
import type { AdapterValidation, EventMeshAdapter } from "./index.js";


const PAID_SERVICE_RULES = {
  domain: "EventMesh/PaidServiceProfile/v1",
  requiredEvents: ["SERVICE_REQUESTED", "SERVICE_ACCEPTED", "RESULT_COMMITTED", "SESSION_COMPLETED"],
  optionalEvents: ["PAYMENT_SETTLED"],
  ordering: "SERVICE_REQUESTED < SERVICE_ACCEPTED < RESULT_COMMITTED < [PAYMENT_SETTLED] < SESSION_COMPLETED",
  paymentBinding: ["sessionId", "obligationId", "settlesEventHash", "purposeHash"],
  finalState: ["requestId", "service", "resultHash", "paymentHash", "completed"]
} as const;

export const PAID_SERVICE_PROFILE: ApplicationProfile = {
  id: "paid-service",
  version: "1.0.0",
  rulesHash: sha256Hex(canonical(PAID_SERVICE_RULES))
};

export const PAID_SERVICE_EVENT_TYPES = [
  "SERVICE_REQUESTED",
  "SERVICE_ACCEPTED",
  "RESULT_COMMITTED",
  "PAYMENT_SETTLED",
  "SESSION_COMPLETED"
] as const;

type RecordValue = Record<string, unknown>;

function objectPayload(event: SignedEvent): RecordValue | undefined {
  return event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? event.payload as RecordValue
    : undefined;
}

function requestIdFrom(event: SignedEvent): string | undefined {
  const payload = objectPayload(event);
  return typeof payload?.requestId === "string" && payload.requestId.length > 0 ? payload.requestId : undefined;
}

function isHash32(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value);
}

function validatePaidServiceEvent(event: SignedEvent): AdapterValidation {
  const payload = objectPayload(event);
  if (!payload) return { ok: false, reason: "payload must be an object" };

  if (event.type === "PAYMENT_SETTLED") {
    const parsed = FiberPaymentClaimSchema.safeParse(event.payload);
    return parsed.success ? { ok: true } : { ok: false, reason: "invalid Fiber payment claim" };
  }

  const requestId = requestIdFrom(event);
  if (!requestId) return { ok: false, reason: "requestId is required" };

  switch (event.type) {
    case "SERVICE_REQUESTED":
      return typeof payload.service === "string" && payload.service.length > 0
        ? { ok: true }
        : { ok: false, reason: "service is required" };
    case "SERVICE_ACCEPTED":
      return { ok: true };
    case "RESULT_COMMITTED":
      return isHash32(payload.resultHash)
        ? { ok: true }
        : { ok: false, reason: "resultHash must be a 32-byte 0x hash" };
    case "SESSION_COMPLETED":
      return { ok: true };
    default:
      return { ok: false, reason: `unsupported event type ${event.type}` };
  }
}

function validatePaidServiceTranscript(transcript: TranscriptExport): AdapterValidation {
  const events = [...transcript.events].sort((a, b) => a.event.sequence - b.event.sequence);
  if (events.some(({ ack }) => ack?.decision !== "ACCEPT")) {
    return { ok: false, reason: "all reference paid-service events must be explicitly ACCEPTed" };
  }

  const allowed = new Set<string>(PAID_SERVICE_EVENT_TYPES);
  const unsupported = events.find(({ event }) => !allowed.has(event.type));
  if (unsupported) return { ok: false, reason: `unsupported event type ${unsupported.event.type}` };

  const expectedSender = new Map<string, string>([
    ["SERVICE_REQUESTED", transcript.session.session.operatorA],
    ["SERVICE_ACCEPTED", transcript.session.session.operatorB],
    ["RESULT_COMMITTED", transcript.session.session.operatorB],
    ["PAYMENT_SETTLED", transcript.session.session.operatorA],
    ["SESSION_COMPLETED", transcript.session.session.operatorB]
  ]);
  const wrongSender = events.find(({ event }) =>
    event.sender.toLowerCase() !== expectedSender.get(event.type)?.toLowerCase()
  );
  if (wrongSender) return { ok: false, reason: `${wrongSender.event.type} was authored by the wrong operator` };

  const byType = new Map<string, typeof events>();
  for (const row of events) byType.set(row.event.type, [...(byType.get(row.event.type) ?? []), row]);
  for (const type of ["SERVICE_REQUESTED", "SERVICE_ACCEPTED", "RESULT_COMMITTED", "SESSION_COMPLETED"]) {
    if ((byType.get(type)?.length ?? 0) !== 1) return { ok: false, reason: `${type} must occur exactly once` };
  }
  if ((byType.get("PAYMENT_SETTLED")?.length ?? 0) > 1) return { ok: false, reason: "PAYMENT_SETTLED may occur at most once" };

  const index = (type: string) => events.findIndex(({ event }) => event.type === type);
  const requestIndex = index("SERVICE_REQUESTED");
  const acceptIndex = index("SERVICE_ACCEPTED");
  const resultIndex = index("RESULT_COMMITTED");
  const paymentIndex = index("PAYMENT_SETTLED");
  const completeIndex = index("SESSION_COMPLETED");
  if (!(requestIndex < acceptIndex && acceptIndex < resultIndex && resultIndex < completeIndex)) {
    return { ok: false, reason: "expected SERVICE_REQUESTED -> SERVICE_ACCEPTED -> RESULT_COMMITTED -> SESSION_COMPLETED ordering" };
  }
  if (paymentIndex >= 0 && !(resultIndex < paymentIndex && paymentIndex < completeIndex)) {
    return { ok: false, reason: "PAYMENT_SETTLED must occur after RESULT_COMMITTED and before SESSION_COMPLETED" };
  }

  const requestIds = new Set(events
    .filter(({ event }) => event.type !== "PAYMENT_SETTLED")
    .map(({ event }) => requestIdFrom(event))
    .filter((value): value is string => !!value));
  if (requestIds.size !== 1) return { ok: false, reason: "all application events must bind the same requestId" };

  if (paymentIndex >= 0) {
    const payment = FiberPaymentClaimSchema.safeParse(events[paymentIndex].event.payload);
    if (!payment.success || payment.data.sessionId !== transcript.session.session.sessionId) {
      return { ok: false, reason: "PAYMENT_SETTLED must bind this EventMesh sessionId" };
    }
    const requestId = [...requestIds][0];
    const resultEvent = events[resultIndex].event;
    if (payment.data.obligationId !== requestId) {
      return { ok: false, reason: "payment obligationId must match the paid-service requestId" };
    }
    if (payment.data.settlesEventHash?.toLowerCase() !== resultEvent.eventHash.toLowerCase()) {
      return { ok: false, reason: "payment settlesEventHash must bind the RESULT_COMMITTED event" };
    }
    if (!payment.data.purposeHash) return { ok: false, reason: "payment purposeHash is required" };
    if (computeFiberPaymentPurposeHash(payment.data).toLowerCase() !== payment.data.purposeHash.toLowerCase()) {
      return { ok: false, reason: "payment purposeHash does not match the canonical obligation binding" };
    }
  }

  return { ok: true };
}

/**
 * Small reference adapter used by the funding demo. It intentionally models
 * only application semantics; payment execution, wallet authority, service
 * scheduling, escrow, and dispute arbitration remain outside EventMesh.
 */
export const paidServiceReferenceAdapter: EventMeshAdapter<{
  kind: "paid-service";
  requestId: string;
  service: string;
  resultHash: string;
  paymentHash?: string;
  completed: true;
}> = {
  name: "paid-service-reference",
  eventTypes: PAID_SERVICE_EVENT_TYPES,
  validateEvent: validatePaidServiceEvent,
  validateTranscript: validatePaidServiceTranscript,
  deriveFinalState(transcript) {
    const events = [...transcript.events].sort((a, b) => a.event.sequence - b.event.sequence);
    const requested = events.find(({ event }) => event.type === "SERVICE_REQUESTED")!.event;
    const result = events.find(({ event }) => event.type === "RESULT_COMMITTED")!.event;
    const payment = events.find(({ event }) => event.type === "PAYMENT_SETTLED")?.event;
    const requestPayload = objectPayload(requested)!;
    const resultPayload = objectPayload(result)!;
    const paymentClaim = payment ? FiberPaymentClaimSchema.parse(payment.payload) : undefined;
    return {
      kind: "paid-service",
      requestId: String(requestPayload.requestId),
      service: String(requestPayload.service),
      resultHash: String(resultPayload.resultHash),
      ...(paymentClaim ? { paymentHash: paymentClaim.paymentHash.toLowerCase() } : {}),
      completed: true
    };
  }
};
