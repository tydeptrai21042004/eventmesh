/**
 * Optional, stateless application-evidence path. This is NOT a Fiber payment
 * receipt, a payment-verification result, a consensus protocol or an escrow.
 * An ACCEPT countersignature attests to the exact provider-signed statement;
 * it does not certify that an off-chain computation/delivery was correct.
 *
 * Versioned independently from the existing EventMesh event transcript so
 * legacy transcripts, event hashes and signature domains are unchanged.
 */
import { z } from "zod";
import {
  canonical,
  publicKeyFromPrivate,
  sha256Hex,
  signObject,
  verifyObject
} from "@eventmesh/core";

const hash32 = z.string().regex(/^0x[0-9a-f]{64}$/i);
const pubkey = z.string().regex(/^0x[0-9a-f]{66}$/i);
const signature = z.string().regex(/^0x[0-9a-f]{128}$/i);
const timestamp = z.string().datetime({ offset: true });

/** A signed claim about a particular request/result; payment is only a reference. */
export const ApplicationReceiptSchema = z.object({
  version: z.literal("eventmesh-app-receipt-v1"),
  sessionId: z.string().min(1).max(128),
  requestId: z.string().min(1).max(128),
  serviceHash: hash32,
  resultHash: hash32,
  payment: z.object({
    paymentHash: hash32,
    purposeHash: hash32
  }).strict().optional(),
  provider: pubkey,
  consumer: pubkey,
  createdAt: timestamp,
  expiresAt: timestamp
}).strict().superRefine((receipt, context) => {
  if (receipt.provider.toLowerCase() === receipt.consumer.toLowerCase()) {
    context.addIssue({ code: "custom", path: ["consumer"], message: "provider and consumer must be distinct" });
  }
  if (Date.parse(receipt.createdAt) >= Date.parse(receipt.expiresAt)) {
    context.addIssue({ code: "custom", path: ["expiresAt"], message: "expiresAt must follow createdAt" });
  }
});
export type ApplicationReceipt = z.infer<typeof ApplicationReceiptSchema>;

export const ProviderSignedReceiptSchema = z.object({
  receipt: ApplicationReceiptSchema,
  receiptHash: hash32,
  providerSignature: signature
}).strict();
export type ProviderSignedReceipt = z.infer<typeof ProviderSignedReceiptSchema>;

export const ReceiptAcknowledgementSchema = z.object({
  receiptHash: hash32,
  providerSignature: signature,
  decision: z.enum(["ACCEPT", "REJECT"]),
  acknowledgedAt: timestamp
}).strict();
export type ReceiptAcknowledgement = z.infer<typeof ReceiptAcknowledgementSchema>;

export const CountersignedReceiptSchema = ProviderSignedReceiptSchema.extend({
  acknowledgement: ReceiptAcknowledgementSchema.optional(),
  consumerSignature: signature.optional()
}).strict();
export type CountersignedReceipt = z.infer<typeof CountersignedReceiptSchema>;

const PROVIDER_DOMAIN = "EventMesh/ApplicationReceipt/v1/provider";
const CONSUMER_DOMAIN = "EventMesh/ApplicationReceipt/v1/consumer";

function equalHex(a: string, b: string) { return a.toLowerCase() === b.toLowerCase(); }

export function applicationReceiptHash(receipt: ApplicationReceipt) {
  return sha256Hex(canonical({ domain: "EventMesh/ApplicationReceipt/v1/body", receipt: ApplicationReceiptSchema.parse(receipt) }));
}

/** Sign only if the caller owns the declared provider identity. */
export function createProviderReceipt(receipt: ApplicationReceipt, providerPrivateKey: string): ProviderSignedReceipt {
  const body = ApplicationReceiptSchema.parse(receipt);
  if (!equalHex(publicKeyFromPrivate(providerPrivateKey), body.provider)) {
    throw new Error("RECEIPT_PROVIDER_KEY_MISMATCH");
  }
  const receiptHash = applicationReceiptHash(body);
  return {
    receipt: body,
    receiptHash,
    providerSignature: signObject({ domain: PROVIDER_DOMAIN, receiptHash }, providerPrivateKey)
  };
}

/** A consumer can accept OR reject exactly the provider-signed receipt. */
export function acknowledgeApplicationReceipt(
  providerReceipt: ProviderSignedReceipt,
  consumerPrivateKey: string,
  decision: "ACCEPT" | "REJECT",
  acknowledgedAt: string = new Date().toISOString()
): CountersignedReceipt {
  const parsed = ProviderSignedReceiptSchema.parse(providerReceipt);
  if (!equalHex(publicKeyFromPrivate(consumerPrivateKey), parsed.receipt.consumer)) {
    throw new Error("RECEIPT_CONSUMER_KEY_MISMATCH");
  }
  const providerProof = verifyApplicationReceipt(parsed);
  if (!providerProof.ok) throw new Error(`INVALID_PROVIDER_RECEIPT:${providerProof.errors.join("|")}`);
  if (!Number.isFinite(Date.parse(acknowledgedAt))
    || Date.parse(acknowledgedAt) < Date.parse(parsed.receipt.createdAt)
    || Date.parse(acknowledgedAt) > Date.parse(parsed.receipt.expiresAt)) {
    throw new Error("RECEIPT_ACK_OUTSIDE_VALIDITY_WINDOW");
  }
  const acknowledgement = ReceiptAcknowledgementSchema.parse({
    receiptHash: parsed.receiptHash,
    providerSignature: parsed.providerSignature,
    decision,
    acknowledgedAt
  });
  return {
    ...parsed,
    acknowledgement,
    consumerSignature: signObject({ domain: CONSUMER_DOMAIN, acknowledgement }, consumerPrivateKey)
  };
}

export type ReceiptVerification = {
  ok: boolean;
  errors: string[];
  providerSignatureValid: boolean;
  consumerSignatureValid: boolean;
  /** True only for an authentic, explicit consumer ACCEPT. */
  acceptedByBoth: boolean;
  /** A paymentHash reference or signed claim NEVER establishes Fiber payment. */
  fiberPaymentVerified: false;
  /** This stateless artifact does not establish uniqueness or resolve forks. */
  uniqueGlobalStateProven: false;
};

export function verifyApplicationReceipt(
  input: unknown,
  options: { expectedProvider?: string; expectedConsumer?: string; requireAcceptance?: boolean } = {}
): ReceiptVerification {
  const errors: string[] = [];
  let providerSignatureValid = false;
  let consumerSignatureValid = false;
  let acceptedByBoth = false;
  const parsed = CountersignedReceiptSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false, errors: ["INVALID_RECEIPT_SCHEMA"], providerSignatureValid,
      consumerSignatureValid, acceptedByBoth, fiberPaymentVerified: false,
      uniqueGlobalStateProven: false
    };
  }
  const { receipt, receiptHash, providerSignature, acknowledgement, consumerSignature } = parsed.data;
  if (options.expectedProvider && !equalHex(options.expectedProvider, receipt.provider)) errors.push("PROVIDER_IDENTITY_NOT_PINNED");
  if (options.expectedConsumer && !equalHex(options.expectedConsumer, receipt.consumer)) errors.push("CONSUMER_IDENTITY_NOT_PINNED");
  if (!equalHex(applicationReceiptHash(receipt), receiptHash)) errors.push("RECEIPT_HASH_MISMATCH");
  providerSignatureValid = verifyObject({ domain: PROVIDER_DOMAIN, receiptHash }, providerSignature, receipt.provider);
  if (!providerSignatureValid) errors.push("PROVIDER_SIGNATURE_INVALID");

  if (Boolean(acknowledgement) !== Boolean(consumerSignature)) errors.push("INCOMPLETE_CONSUMER_ACK");
  if (acknowledgement && consumerSignature) {
    if (!equalHex(acknowledgement.receiptHash, receiptHash)
      || !equalHex(acknowledgement.providerSignature, providerSignature)) {
      errors.push("ACK_NOT_BOUND_TO_PROVIDER_RECEIPT");
    }
    if (Date.parse(acknowledgement.acknowledgedAt) < Date.parse(receipt.createdAt)
      || Date.parse(acknowledgement.acknowledgedAt) > Date.parse(receipt.expiresAt)) {
      errors.push("ACK_OUTSIDE_VALIDITY_WINDOW");
    }
    consumerSignatureValid = verifyObject(
      { domain: CONSUMER_DOMAIN, acknowledgement }, consumerSignature, receipt.consumer
    );
    if (!consumerSignatureValid) errors.push("CONSUMER_SIGNATURE_INVALID");
    acceptedByBoth = errors.length === 0 && acknowledgement.decision === "ACCEPT";
  }
  if (options.requireAcceptance && !acceptedByBoth) errors.push("CONSUMER_ACCEPTANCE_REQUIRED");
  return {
    ok: errors.length === 0,
    errors,
    providerSignatureValid,
    consumerSignatureValid,
    acceptedByBoth: errors.length === 0 && acceptedByBoth,
    fiberPaymentVerified: false,
    uniqueGlobalStateProven: false
  };
}
