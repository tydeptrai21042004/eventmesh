import { afterEach, describe, expect, it, vi } from "vitest";
import { FiberRpcClient } from "@eventmesh/fiber";
import { computeFiberPaymentPurposeHash, type FiberPaymentClaim } from "@eventmesh/core";

const hash = `0x${"22".repeat(32)}`;
const baseClaim: FiberPaymentClaim = {
  paymentHash: hash,
  sessionId: "ses_test",
  amount: "0x5f5e100",
  currency: "Fibt"
};

function mockRpc(result: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
    status: 200,
    headers: { "content-type": "application/json" }
  })));
}

afterEach(() => vi.unstubAllGlobals());

describe("receiver-owned Fiber evidence", () => {
  it("accepts a paid invoice bound to hash, amount, currency, and session", async () => {
    mockRpc({
      status: "Paid",
      invoice: {
        currency: "Fibt",
        amount: "0x5f5e100",
        data: { payment_hash: hash, attrs: [{ description: "job 1 | eventmesh:ses_test" }, { payee_public_key: "02abc" }] }
      }
    });
    const result = await new FiberRpcClient("http://fnn.test").verifyReceivedPaymentClaim(baseClaim);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.evidence.verifier).toBe("RECEIVER_FNN");
  });

  it("rejects sender-success style evidence when receiver invoice is not Paid", async () => {
    mockRpc({ status: "Open", invoice: { currency: "Fibt", amount: "0x5f5e100", data: { payment_hash: hash, attrs: [{ description: "eventmesh:ses_test" }] } } });
    const result = await new FiberRpcClient("http://fnn.test").verifyReceivedPaymentClaim(baseClaim);
    expect(result).toMatchObject({ ok: false, reason: "FIBER_INVOICE_OPEN" });
  });

  it("rejects a wrong session binding", async () => {
    mockRpc({ status: "Paid", invoice: { currency: "Fibt", amount: "0x5f5e100", data: { payment_hash: hash, attrs: [{ description: "eventmesh:other_session" }] } } });
    const result = await new FiberRpcClient("http://fnn.test").verifyReceivedPaymentClaim(baseClaim);
    expect(result).toMatchObject({ ok: false, reason: "FIBER_SESSION_BINDING_MISMATCH" });
  });


  it("verifies obligation, result, purpose, and expected-payee bindings", async () => {
    const settlesEventHash = `0x${"77".repeat(32)}`;
    const claimBase = {
      ...baseClaim,
      obligationId: "job-77",
      settlesEventHash,
      expectedPayeePublicKey: "02receiver"
    };
    const purposeHash = computeFiberPaymentPurposeHash(claimBase);
    const claim = { ...claimBase, purposeHash };
    mockRpc({
      status: "Paid",
      invoice: {
        currency: "Fibt", amount: "0x5f5e100",
        data: { payment_hash: hash, attrs: [
          { description: `eventmesh:ses_test | eventmesh-obligation:job-77 | eventmesh-settles:${settlesEventHash} | eventmesh-purpose:${purposeHash}` },
          { payee_public_key: "02receiver" }
        ] }
      }
    });
    const result = await new FiberRpcClient("http://fnn.test").verifyReceivedPaymentClaim(claim);
    expect(result.ok).toBe(true);
  });

  it("rejects a receiver identity mismatch", async () => {
    mockRpc({
      status: "Paid",
      invoice: { currency: "Fibt", amount: "0x5f5e100", data: { payment_hash: hash, attrs: [
        { description: "eventmesh:ses_test" }, { payee_public_key: "02other" }
      ] } }
    });
    const result = await new FiberRpcClient("http://fnn.test").verifyReceivedPaymentClaim({ ...baseClaim, expectedPayeePublicKey: "02receiver" });
    expect(result).toMatchObject({ ok: false, reason: "FIBER_PAYEE_MISMATCH" });
  });

  it("requires exact UDT script when the claim names one", async () => {
    const script = { code_hash: `0x${"33".repeat(32)}`, hash_type: "type" as const, args: `0x${"44".repeat(32)}` };
    mockRpc({ status: "Paid", invoice: { currency: "Fibt", amount: "0x5f5e100", data: { payment_hash: hash, attrs: [{ description: "eventmesh:ses_test" }, { udt_script: script }] } } });
    const result = await new FiberRpcClient("http://fnn.test").verifyReceivedPaymentClaim({ ...baseClaim, udtTypeScript: script });
    expect(result.ok).toBe(true);
  });
});
