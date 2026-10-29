import { describe, expect, it } from "vitest";
import { publicKeyFromPrivate, signObject } from "@eventmesh/core";
import {
  acknowledgeApplicationReceipt,
  applicationReceiptHash,
  createProviderReceipt,
  verifyApplicationReceipt,
  type ApplicationReceipt
} from "@eventmesh/adapter-sdk";

const providerKey = `0x${"31".repeat(32)}`;
const consumerKey = `0x${"32".repeat(32)}`;
const strangerKey = `0x${"33".repeat(32)}`;
const createdAt = "2026-09-29T12:00:00.000Z";
const acknowledgedAt = "2026-09-29T12:01:00.000Z";
const expiresAt = "2026-09-29T13:00:00.000Z";

function receipt(overrides: Partial<ApplicationReceipt> = {}): ApplicationReceipt {
  return {
    version: "eventmesh-app-receipt-v1",
    sessionId: "session-001",
    requestId: "job-001",
    serviceHash: `0x${"aa".repeat(32)}`,
    resultHash: `0x${"bb".repeat(32)}`,
    payment: { paymentHash: `0x${"cc".repeat(32)}`, purposeHash: `0x${"dd".repeat(32)}` },
    provider: publicKeyFromPrivate(providerKey),
    consumer: publicKeyFromPrivate(consumerKey),
    createdAt,
    expiresAt,
    ...overrides
  };
}

function accepted() {
  return acknowledgeApplicationReceipt(createProviderReceipt(receipt(), providerKey), consumerKey, "ACCEPT", acknowledgedAt);
}

describe("minimal application receipt (not settlement or consensus)", () => {
  it("verifies independent provider and consumer signatures for one exact result", () => {
    const proof = accepted();
    const result = verifyApplicationReceipt(proof, {
      requireAcceptance: true,
      expectedProvider: publicKeyFromPrivate(providerKey),
      expectedConsumer: publicKeyFromPrivate(consumerKey)
    });
    expect(result.ok).toBe(true);
    expect(result.providerSignatureValid).toBe(true);
    expect(result.consumerSignatureValid).toBe(true);
    expect(result.acceptedByBoth).toBe(true);
    expect(result.fiberPaymentVerified).toBe(false);
    expect(result.uniqueGlobalStateProven).toBe(false);
  });

  it("supports standalone provider signatures without mislabeling them mutual acceptance", () => {
    const proof = createProviderReceipt(receipt(), providerKey);
    expect(verifyApplicationReceipt(proof).ok).toBe(true);
    expect(verifyApplicationReceipt(proof).acceptedByBoth).toBe(false);
    expect(verifyApplicationReceipt(proof, { requireAcceptance: true }).ok).toBe(false);
  });

  it("distinguishes signed rejection from an agreed acceptance", () => {
    const rejected = acknowledgeApplicationReceipt(
      createProviderReceipt(receipt(), providerKey), consumerKey, "REJECT", acknowledgedAt
    );
    expect(verifyApplicationReceipt(rejected).ok).toBe(true);
    expect(verifyApplicationReceipt(rejected).acceptedByBoth).toBe(false);
    expect(verifyApplicationReceipt(rejected, { requireAcceptance: true }).ok).toBe(false);
  });

  it("fails when changing the result hash or payment reference after signing", () => {
    const proof = accepted();
    expect(verifyApplicationReceipt({ ...proof, receipt: { ...proof.receipt, resultHash: `0x${"ee".repeat(32)}` } }).ok).toBe(false);
    expect(verifyApplicationReceipt({ ...proof, receipt: { ...proof.receipt, payment: { ...proof.receipt.payment!, paymentHash: `0x${"ee".repeat(32)}` } } }).ok).toBe(false);
  });

  it("fails if consumer's signature, decision or provider signature is transplanted", () => {
    const proof = accepted();
    expect(verifyApplicationReceipt({ ...proof, consumerSignature: proof.providerSignature }).ok).toBe(false);
    expect(verifyApplicationReceipt({ ...proof, acknowledgement: { ...proof.acknowledgement!, decision: "REJECT" } }).ok).toBe(false);
    expect(verifyApplicationReceipt({ ...proof, acknowledgement: { ...proof.acknowledgement!, providerSignature: `0x${"ff".repeat(64)}` } }).ok).toBe(false);
    expect(verifyApplicationReceipt({ ...proof, consumerSignature: undefined }).ok).toBe(false);
  });

  it("enforces distinct identities, the intended signing keys and externally pinned public keys", () => {
    expect(() => createProviderReceipt(receipt(), strangerKey)).toThrow("PROVIDER_KEY_MISMATCH");
    expect(() => createProviderReceipt(receipt({ consumer: publicKeyFromPrivate(providerKey) }), providerKey)).toThrow();
    expect(() => acknowledgeApplicationReceipt(createProviderReceipt(receipt(), providerKey), strangerKey, "ACCEPT", acknowledgedAt))
      .toThrow("CONSUMER_KEY_MISMATCH");
    expect(verifyApplicationReceipt(accepted(), { expectedProvider: publicKeyFromPrivate(strangerKey) }).ok).toBe(false);
  });

  it("rejects acknowledgements outside the signed validity window", () => {
    const providerProof = createProviderReceipt(receipt(), providerKey);
    expect(() => acknowledgeApplicationReceipt(providerProof, consumerKey, "ACCEPT", "2026-09-29T13:00:01.000Z"))
      .toThrow("RECEIPT_ACK_OUTSIDE_VALIDITY_WINDOW");
    const proof = accepted();
    expect(verifyApplicationReceipt({ ...proof, acknowledgement: { ...proof.acknowledgement!, acknowledgedAt: "2026-09-29T13:00:01.000Z" } }).ok).toBe(false);
  });

  it("does not accept a different signature domain or missing hash", () => {
    const proof = createProviderReceipt(receipt(), providerKey);
    const wrongDomain = signObject({ domain: "some-other-protocol", receiptHash: applicationReceiptHash(proof.receipt) }, providerKey);
    expect(verifyApplicationReceipt({ ...proof, providerSignature: wrongDomain }).ok).toBe(false);
    expect(verifyApplicationReceipt({ ...proof, receiptHash: `0x${"00".repeat(32)}` }).ok).toBe(false);
  });

  it("keeps a payment reference separate from payment verification", () => {
    const proof = accepted();
    const result = verifyApplicationReceipt(proof, { requireAcceptance: true });
    expect(result.ok).toBe(true);
    expect(result.fiberPaymentVerified).toBe(false);
    // A receipt MAY identify an intended Fiber payment, but only an independent
    // receiver-FNN query can establish its settlement status.
  });
});
