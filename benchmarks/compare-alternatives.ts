/**
 * Deterministic, local comparison of proof semantics with identical request
 * identifiers and result hashes. NOT a live Fiber, latency or disaster-recovery
 * benchmark. It deliberately includes negative outcomes for EventMesh.
 */
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  PROTOCOL, SIGNING_DOMAIN, ZERO_HASH, publicKeyFromPrivate,
  signAck, signEvent, signProtocolObject, verifyTranscript,
  type SignedEvent, type SignedAck, type TranscriptExport
} from "@eventmesh/core";
import {
  createProviderReceipt, acknowledgeApplicationReceipt, verifyApplicationReceipt,
  type ApplicationReceipt
} from "@eventmesh/adapter-sdk";

const aPrivate = `0x${"41".repeat(32)}`;
const bPrivate = `0x${"42".repeat(32)}`;
const a = publicKeyFromPrivate(aPrivate);
const b = publicKeyFromPrivate(bPrivate);
const createdAt = "2026-09-29T12:00:00.000Z";
const resultOne = `0x${"ab".repeat(32)}`;
const resultTwo = `0x${"cd".repeat(32)}`;
const requestId = "comparison-job-001";

function minimalReceipt(resultHash: string): ApplicationReceipt {
  return {
    version: "eventmesh-app-receipt-v1", sessionId: "comparison-session", requestId,
    serviceHash: `0x${"ef".repeat(32)}`, resultHash,
    provider: b, consumer: a, createdAt, expiresAt: "2026-09-29T13:00:00.000Z"
  };
}

function agreedReceipt(resultHash: string) {
  return acknowledgeApplicationReceipt(
    createProviderReceipt(minimalReceipt(resultHash), bPrivate), aPrivate, "ACCEPT", "2026-09-29T12:01:00.000Z"
  );
}

function signedTranscript(resultHash: string): TranscriptExport {
  const session = {
    protocol: PROTOCOL, sessionId: "comparison-session", operatorA: a, operatorB: b,
    operatorAUrl: "https://operator-a.example", operatorBUrl: "https://operator-b.example",
    createdAt, expiresAt: "2026-09-29T13:00:00.000Z", maxEvents: 5
  } as const;
  const events: Array<{ event: SignedEvent; ack: SignedAck }> = [];
  function append(type: string, payload: object, author: "a" | "b") {
    const sender = author === "a" ? a : b;
    const event = signEvent({
      sessionId: session.sessionId, sequence: events.length + 1,
      previousHash: events.at(-1)?.event.eventHash ?? ZERO_HASH, type, payload, sender,
      createdAt: "2026-09-29T12:00:30.000Z"
    }, author === "a" ? aPrivate : bPrivate);
    const ack = signAck({
      eventHash: event.eventHash, decision: "ACCEPT", operator: author === "a" ? b : a,
      createdAt: "2026-09-29T12:00:31.000Z"
    }, author === "a" ? bPrivate : aPrivate);
    events.push({ event, ack });
  }
  append("SERVICE_REQUESTED", { requestId }, "a");
  append("RESULT_COMMITTED", { requestId, resultHash }, "b");
  return {
    session: {
      session,
      signatureA: signProtocolObject(SIGNING_DOMAIN.SESSION, session, aPrivate),
      signatureB: signProtocolObject(SIGNING_DOMAIN.SESSION, session, bPrivate)
    },
    events
  };
}

/** A one-DB reference model, NOT a two-operator distributed implementation. */
class IdempotentApi {
  private readonly results = new Map<string, string>();
  deliver(id: string, resultHash: string) {
    if (!this.results.has(id)) this.results.set(id, resultHash);
    return this.results.get(id)!;
  }
}

export function compareAlternatives() {
  const api = new IdempotentApi();
  const first = api.deliver(requestId, resultOne);
  const replayed = api.deliver(requestId, resultTwo);
  const signedOne = agreedReceipt(resultOne);
  const signedTwo = agreedReceipt(resultTwo);
  const transcriptOne = signedTranscript(resultOne);
  const transcriptTwo = signedTranscript(resultTwo);
  const receiptProofOne = verifyApplicationReceipt(signedOne, { requireAcceptance: true });
  const receiptProofTwo = verifyApplicationReceipt(signedTwo, { requireAcceptance: true });
  const meshProofOne = verifyTranscript(transcriptOne);
  const meshProofTwo = verifyTranscript(transcriptTwo);

  return {
    schema: "eventmesh-review-comparison-v1",
    evidenceClass: "DETERMINISTIC_LOCAL_PROOF_SEMANTICS_ONLY",
    inputs: { requestId, samePartyKeys: true, simulatedPayment: false, results: [resultOne, resultTwo] },
    artifactSizesBytes: {
      // JSON bytes are not a comparable performance benchmark: the transcript
      // has two events, while the receipt has one signed claim.
      idempotentApiSingleRecord: Buffer.byteLength(JSON.stringify({ requestId, resultHash: first })),
      countersignedReceipt: Buffer.byteLength(JSON.stringify(signedOne)),
      twoEventTranscript: Buffer.byteLength(JSON.stringify(transcriptOne))
    },
    observations: {
      idempotentApi: {
        replayReturnsOriginalResult: first === replayed,
        independentlyVerifiableBilateralSignature: false,
        durableAcrossServerCrashWithoutPersistentDatabase: false
      },
      simpleCountersignedReceipts: {
        acceptedReceiptOneValid: receiptProofOne.ok && receiptProofOne.acceptedByBoth,
        conflictingAcceptedReceiptTwoAlsoValid: receiptProofTwo.ok && receiptProofTwo.acceptedByBoth,
        conflictVisibleGivenBothReceipts: signedOne.receipt.resultHash !== signedTwo.receipt.resultHash,
        resolvesConflictingAcceptancesAutomatically: false
      },
      eventMeshTranscript: {
        acceptedTranscriptOneValid: meshProofOne.ok,
        conflictingAcceptedTranscriptTwoAlsoValid: meshProofTwo.ok,
        conflictingEventHashesVisibleGivenBothTranscripts:
          transcriptOne.events[1].event.eventHash !== transcriptTwo.events[1].event.eventHash,
        resolvesTwoFullyCountersignedForksAutomatically: false,
        carriesOrderedSignedEventAndAckHistory: transcriptOne.events.length > 1
      }
    },
    limitations: [
      "No real Fiber payment or independent receiver-FNN verification occurred.",
      "No network partition, crash, durable-store recovery or performance measurement was executed.",
      "Idempotent API assumes one authoritative persistent backend, which is a different trust model.",
      "Two different accepted proofs can coexist in either receipt or EventMesh format if both parties sign them.",
      "A second proof cannot be detected if the verifier never receives it; neither format guarantees evidence availability.",
      "The sample JSON byte sizes describe different evidence contents and must not be interpreted as an equivalent-workload throughput benchmark.",
      "The full operator recovery implementation must be tested separately; this comparison does not validate it."
    ]
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.stdout.write(`${JSON.stringify(compareAlternatives(), null, 2)}\n`);
}
