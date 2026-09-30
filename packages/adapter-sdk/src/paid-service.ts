import {
  FiberPaymentClaimSchema,
  type SignedEvent,
  type TranscriptExport
} from "@eventmesh/core";
import type { AdapterValidation, EventMeshAdapter } from "./index.js";

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
  const actualTypes = events.map(({ event }) => event.type);
  const expectedTypes = [...PAID_SERVICE_EVENT_TYPES];

  if (actualTypes.length !== expectedTypes.length || actualTypes.some((type, index) => type !== expectedTypes[index])) {
    return {
      ok: false,
      reason: `expected ordered events ${expectedTypes.join(" -> ")}, got ${actualTypes.join(" -> ") || "none"}`
    };
  }

  if (events.some(({ ack }) => ack?.decision !== "ACCEPT")) {
    return { ok: false, reason: "all reference paid-service events must be explicitly ACCEPTed" };
  }

  const requestIds = new Set(events
    .filter(({ event }) => event.type !== "PAYMENT_SETTLED")
    .map(({ event }) => requestIdFrom(event))
    .filter((value): value is string => !!value));
  if (requestIds.size !== 1) return { ok: false, reason: "all application events must bind the same requestId" };

  const payment = FiberPaymentClaimSchema.safeParse(events.find(({ event }) => event.type === "PAYMENT_SETTLED")?.event.payload);
  if (!payment.success || payment.data.sessionId !== transcript.session.session.sessionId) {
    return { ok: false, reason: "PAYMENT_SETTLED must bind this EventMesh sessionId" };
  }

  const requestId = [...requestIds][0];
  const resultEvent = events.find(({ event }) => event.type === "RESULT_COMMITTED")!.event;
  if (payment.data.obligationId && payment.data.obligationId !== requestId) {
    return { ok: false, reason: "payment obligationId must match the paid-service requestId" };
  }
  if (payment.data.settlesEventHash && payment.data.settlesEventHash.toLowerCase() !== resultEvent.eventHash.toLowerCase()) {
    return { ok: false, reason: "payment settlesEventHash must bind the RESULT_COMMITTED event" };
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
  paymentHash: string;
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
    const payment = events.find(({ event }) => event.type === "PAYMENT_SETTLED")!.event;
    const requestPayload = objectPayload(requested)!;
    const resultPayload = objectPayload(result)!;
    const paymentClaim = FiberPaymentClaimSchema.parse(payment.payload);
    return {
      kind: "paid-service",
      requestId: String(requestPayload.requestId),
      service: String(requestPayload.service),
      resultHash: String(resultPayload.resultHash),
      paymentHash: paymentClaim.paymentHash.toLowerCase(),
      completed: true
    };
  }
};
