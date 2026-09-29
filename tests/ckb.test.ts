import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectAnchorRpc, minimumStandardSecpOutputCapacityCkb } from "@eventmesh/ckb";
import { buildAnchorDataHex, computePaymentEvidenceRoot, computeTranscriptRoot, finalStateHashFrom } from "@eventmesh/core";

const txHash = `0x${"55".repeat(32)}`;
const dataHex = `0x${"66".repeat(64)}`;
const response = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
  status: 200,
  headers: { "content-type": "application/json" }
});

afterEach(() => vi.unstubAllGlobals());

describe("CKB anchor verification", () => {
  it("accounts for v0.2 commitment occupied capacity", () => {
    const v02 = buildAnchorDataHex("ses_capacity", computeTranscriptRoot([]), finalStateHashFrom({}), computePaymentEvidenceRoot([]));
    expect((v02.length - 2) / 2).toBe(141);
    expect(minimumStandardSecpOutputCapacityCkb(v02)).toBe(202);
  });

  it("requires committed status and exact output data", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ tx_status: { status: "committed", block_hash: "0x01" }, transaction: { outputs_data: [dataHex] } })));
    expect(await inspectAnchorRpc("http://ckb.test", txHash, dataHex)).toMatchObject({ ok: true, status: "COMMITTED", dataMatches: true });
  });

  it("does not accept a pending transaction", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ tx_status: { status: "pending" }, transaction: { outputs_data: [dataHex] } })));
    expect(await inspectAnchorRpc("http://ckb.test", txHash, dataHex)).toMatchObject({ ok: false, status: "TX_NOT_COMMITTED" });
  });

  it("does not accept committed transaction with wrong commitment", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ tx_status: { status: "committed" }, transaction: { outputs_data: ["0x00"] } })));
    expect(await inspectAnchorRpc("http://ckb.test", txHash, dataHex)).toMatchObject({ ok: false, status: "COMMITMENT_NOT_FOUND" });
  });
});
