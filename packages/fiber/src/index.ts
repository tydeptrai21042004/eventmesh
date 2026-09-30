import {
  CkbScriptSchema,
  FiberPaymentClaimSchema,
  FiberPaymentEvidenceSchema,
  canonical,
  computeFiberPaymentPurposeHash,
  type CkbScript,
  type FiberPaymentClaim,
  type FiberPaymentEvidence
} from "@eventmesh/core";

type RpcEnvelope<T> = {
  jsonrpc: "2.0";
  id: number;
  result?: T;
  error?: { code: number; message: string };
};

const quantity = (value: string) => `0x${BigInt(value).toString(16)}`;
const numeric = (value: unknown) => {
  try {
    return typeof value === "string" || typeof value === "number" ? BigInt(value) : undefined;
  } catch {
    return undefined;
  }
};
const normalizeScript = (value: unknown): CkbScript | undefined => {
  const parsed = CkbScriptSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

function invoiceDescriptions(invoice: any): string[] {
  const attrs = Array.isArray(invoice?.data?.attrs) ? invoice.data.attrs : [];
  return attrs
    .flatMap((attr: any) => [
      attr?.description,
      attr?.Description,
      attr?.type === "description" ? attr?.value : undefined
    ])
    .filter((value: unknown): value is string => typeof value === "string");
}

function invoiceUdtScript(invoice: any): CkbScript | undefined {
  if (invoice?.udt_type_script) return normalizeScript(invoice.udt_type_script);
  if (invoice?.udtTypeScript) return normalizeScript(invoice.udtTypeScript);
  const attrs = Array.isArray(invoice?.data?.attrs) ? invoice.data.attrs : [];
  for (const attr of attrs) {
    const candidate = attr?.udt_script ?? attr?.udt_type_script ?? (attr?.type === "udt_script" ? attr?.value : undefined);
    const parsed = normalizeScript(candidate);
    if (parsed) return parsed;
  }
  return undefined;
}

function payeePublicKey(invoice: any): string | undefined {
  const attrs = Array.isArray(invoice?.data?.attrs) ? invoice.data.attrs : [];
  for (const attr of attrs) {
    const value = attr?.payee_public_key ?? (attr?.type === "payee_public_key" ? attr?.value : undefined);
    if (typeof value === "string") return value;
  }
  return undefined;
}

export class FiberRpcClient {
  constructor(private url: string, private token?: string, private timeout = 10000) {}

  private async call<T>(method: string, params: unknown[]): Promise<T> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const response = await fetch(this.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
      signal: AbortSignal.timeout(this.timeout)
    });
    if (!response.ok) throw new Error(`Fiber HTTP ${response.status}`);
    const body = await response.json() as RpcEnvelope<T>;
    if (body.error) throw new Error(`Fiber RPC ${body.error.code}: ${body.error.message}`);
    if (body.result === undefined) throw new Error("Fiber RPC returned no result");
    return body.result;
  }

  async newInvoice(input: {
    amount: string;
    currency?: "Fibb" | "Fibt" | "Fibd";
    description?: string;
    sessionId?: string;
    obligationId?: string;
    settlesEventHash?: string;
    purposeHash?: string;
    expectedPayeePublicKey?: string;
    expirySeconds?: number;
    udtTypeScript?: CkbScript;
  }) {
    const effectivePurposeHash = input.purposeHash ?? (input.sessionId && (input.obligationId || input.settlesEventHash)
      ? computeFiberPaymentPurposeHash({
          sessionId: input.sessionId,
          amount: input.amount,
          currency: input.currency ?? "Fibt",
          udtTypeScript: input.udtTypeScript,
          obligationId: input.obligationId,
          settlesEventHash: input.settlesEventHash,
          expectedPayeePublicKey: input.expectedPayeePublicKey
        })
      : undefined);
    const description = [
      input.description ?? "EventMesh payment",
      input.sessionId ? `eventmesh:${input.sessionId}` : undefined,
      input.obligationId ? `eventmesh-obligation:${input.obligationId}` : undefined,
      input.settlesEventHash ? `eventmesh-settles:${input.settlesEventHash.toLowerCase()}` : undefined,
      effectivePurposeHash ? `eventmesh-purpose:${effectivePurposeHash.toLowerCase()}` : undefined
    ].filter(Boolean).join(" | ");
    const result = await this.call<any>("new_invoice", [{
      amount: quantity(input.amount),
      currency: input.currency ?? "Fibt",
      description,
      expiry: quantity(String(input.expirySeconds ?? 3600)),
      ...(input.udtTypeScript ? { udt_type_script: CkbScriptSchema.parse(input.udtTypeScript) } : {})
    }]);

    if (input.sessionId && result.invoice?.data?.payment_hash) {
      result.eventMeshClaim = FiberPaymentClaimSchema.parse({
        paymentHash: result.invoice.data.payment_hash,
        sessionId: input.sessionId,
        amount: result.invoice.amount,
        currency: result.invoice.currency,
        ...(input.udtTypeScript ? { udtTypeScript: input.udtTypeScript } : {}),
        ...(input.obligationId ? { obligationId: input.obligationId } : {}),
        ...(input.settlesEventHash ? { settlesEventHash: input.settlesEventHash } : {}),
        ...(effectivePurposeHash ? { purposeHash: effectivePurposeHash } : {}),
        ...(input.expectedPayeePublicKey ? { expectedPayeePublicKey: input.expectedPayeePublicKey } : {})
      });
    }
    return result;
  }

  sendPayment(invoice: string) {
    return this.call("send_payment", [{ invoice }]);
  }
  getPayment(paymentHash: string) {
    return this.call<any>("get_payment", [paymentHash]);
  }
  getInvoice(paymentHash: string) {
    return this.call<any>("get_invoice", [paymentHash]);
  }

  /** Sender-side evidence is useful corroboration, but is not sufficient for ACCEPT. */
  async verifySentPaymentClaim(claim: FiberPaymentClaim) {
    const parsedClaim = FiberPaymentClaimSchema.parse(claim);
    const payment = await this.getPayment(parsedClaim.paymentHash);
    if (payment.status !== "Success") return { ok: false as const, reason: `PAYMENT_STATUS_${payment.status ?? "UNKNOWN"}`, payment };
    if (payment.payment_hash && payment.payment_hash.toLowerCase() !== parsedClaim.paymentHash.toLowerCase()) {
      return { ok: false as const, reason: "PAYMENT_HASH_MISMATCH", payment };
    }
    if (numeric(payment.amount) !== undefined && numeric(payment.amount) !== numeric(parsedClaim.amount)) {
      return { ok: false as const, reason: "FIBER_AMOUNT_MISMATCH", payment };
    }
    return { ok: true as const, payment };
  }

  /**
   * Receiver-owned evidence is authoritative for EventMesh PAYMENT_SETTLED ACCEPT.
   * The receiver queries its own FNN and binds payment hash, amount, currency,
   * session marker, and (when claimed) the exact UDT type script.
   */
  async verifyReceivedPaymentClaim(claim: FiberPaymentClaim): Promise<
    | { ok: true; invoice: any; evidence: FiberPaymentEvidence }
    | { ok: false; reason: string; invoice?: any }
  > {
    const parsedClaim = FiberPaymentClaimSchema.parse(claim);
    const result = await this.getInvoice(parsedClaim.paymentHash);
    if (result.status !== "Paid") return { ok: false, reason: `FIBER_INVOICE_${String(result.status ?? "UNKNOWN").toUpperCase()}`, invoice: result };
    const invoice = result.invoice;
    if (!invoice) return { ok: false, reason: "FIBER_INVOICE_MISSING", invoice: result };
    if (invoice.data?.payment_hash?.toLowerCase() !== parsedClaim.paymentHash.toLowerCase()) {
      return { ok: false, reason: "FIBER_PAYMENT_HASH_MISMATCH", invoice: result };
    }
    if (invoice.currency !== parsedClaim.currency || numeric(invoice.amount) !== numeric(parsedClaim.amount)) {
      return { ok: false, reason: "FIBER_AMOUNT_OR_CURRENCY_MISMATCH", invoice: result };
    }

    if (parsedClaim.purposeHash) {
      const derivedPurposeHash = computeFiberPaymentPurposeHash(parsedClaim);
      if (derivedPurposeHash.toLowerCase() !== parsedClaim.purposeHash.toLowerCase()) {
        return { ok: false, reason: "FIBER_PURPOSE_HASH_INVALID", invoice: result };
      }
    }

    const descriptions = invoiceDescriptions(invoice).flatMap((description) => description.split(/\s*\|\s*/));
    const marker = `eventmesh:${parsedClaim.sessionId}`;
    if (!descriptions.includes(marker)) {
      return { ok: false, reason: "FIBER_SESSION_BINDING_MISMATCH", invoice: result };
    }
    if (parsedClaim.obligationId && !descriptions.includes(`eventmesh-obligation:${parsedClaim.obligationId}`)) {
      return { ok: false, reason: "FIBER_OBLIGATION_BINDING_MISMATCH", invoice: result };
    }
    const settlesEventHash = parsedClaim.settlesEventHash;
    if (settlesEventHash && !descriptions.some((value) => value.toLowerCase() === `eventmesh-settles:${settlesEventHash.toLowerCase()}`)) {
      return { ok: false, reason: "FIBER_SETTLED_EVENT_BINDING_MISMATCH", invoice: result };
    }
    const purposeHash = parsedClaim.purposeHash;
    if (purposeHash && !descriptions.some((value) => value.toLowerCase() === `eventmesh-purpose:${purposeHash.toLowerCase()}`)) {
      return { ok: false, reason: "FIBER_PURPOSE_BINDING_MISMATCH", invoice: result };
    }

    const observedPayee = payeePublicKey(invoice);
    if (parsedClaim.expectedPayeePublicKey && (!observedPayee || observedPayee.toLowerCase() !== parsedClaim.expectedPayeePublicKey.toLowerCase())) {
      return { ok: false, reason: "FIBER_PAYEE_MISMATCH", invoice: result };
    }

    const observedUdtTypeScript = invoiceUdtScript(invoice);
    if (parsedClaim.udtTypeScript) {
      if (!observedUdtTypeScript) return { ok: false, reason: "FIBER_UDT_SCRIPT_NOT_OBSERVED", invoice: result };
      if (canonical(observedUdtTypeScript) !== canonical(parsedClaim.udtTypeScript)) {
        return { ok: false, reason: "FIBER_UDT_SCRIPT_MISMATCH", invoice: result };
      }
    } else if (observedUdtTypeScript) {
      return { ok: false, reason: "FIBER_UNEXPECTED_UDT_SCRIPT", invoice: result };
    }

    const evidence = FiberPaymentEvidenceSchema.parse({
      claim: parsedClaim,
      verifier: "RECEIVER_FNN",
      verifiedAt: new Date().toISOString(),
      invoiceStatus: "Paid",
      ...(observedPayee ? { payeePublicKey: observedPayee } : {}),
      ...(observedUdtTypeScript ? { observedUdtTypeScript } : {})
    });
    return { ok: true, invoice: result, evidence };
  }
}
