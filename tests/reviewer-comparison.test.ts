import { describe, expect, it } from "vitest";
import { compareAlternatives } from "../benchmarks/compare-alternatives.js";

describe("reviewer alternatives: measured proof semantics, not market demand", () => {
  const report = compareAlternatives();
  it("shows a one-DB idempotent API prevents duplicate business transitions", () => {
    expect(report.observations.idempotentApi.replayReturnsOriginalResult).toBe(true);
  });
  it("shows simple countersigned receipts already prove one-shot bilateral acknowledgement", () => {
    expect(report.observations.simpleCountersignedReceipts.acceptedReceiptOneValid).toBe(true);
  });
  it("shows two valid but conflicting signed receipts do not select a global winner", () => {
    expect(report.observations.simpleCountersignedReceipts.conflictingAcceptedReceiptTwoAlsoValid).toBe(true);
    expect(report.observations.simpleCountersignedReceipts.conflictVisibleGivenBothReceipts).toBe(true);
    expect(report.observations.simpleCountersignedReceipts.resolvesConflictingAcceptancesAutomatically).toBe(false);
  });
  it("shows EventMesh adds event history, not a magic fork-resolution guarantee", () => {
    expect(report.observations.eventMeshTranscript.acceptedTranscriptOneValid).toBe(true);
    expect(report.observations.eventMeshTranscript.conflictingAcceptedTranscriptTwoAlsoValid).toBe(true);
    expect(report.observations.eventMeshTranscript.conflictingEventHashesVisibleGivenBothTranscripts).toBe(true);
    expect(report.observations.eventMeshTranscript.resolvesTwoFullyCountersignedForksAutomatically).toBe(false);
    expect(report.observations.eventMeshTranscript.carriesOrderedSignedEventAndAckHistory).toBe(true);
  });
});
