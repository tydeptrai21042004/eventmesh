import { ccc } from "@ckb-ccc/shell";
import { buildAnchorDataHex, strip0x } from "@eventmesh/core";

export type AnchorCommitment = {
  sessionId: string;
  transcriptRoot: string;
  finalStateHash: string;
  paymentEvidenceRoot: string;
};

export type AnchorInspection = {
  ok: boolean;
  status: string;
  dataMatches: boolean;
  blockHash?: string;
  error?: string;
};

export function minimumStandardSecpOutputCapacityCkb(dataHex: string) {
  // A standard secp256k1-blake160 cell occupies 61 CKB before output data.
  // Each output-data byte consumes one additional CKByte of occupied capacity.
  const dataBytes = strip0x(dataHex).length / 2;
  return 61 + dataBytes;
}

export class CkbAnchorClient {
  constructor(private privateKey: string, private rpcUrl?: string, private capacityCkb = 220) {}

  async anchor(input: AnchorCommitment) {
    const client = this.rpcUrl
      ? new ccc.ClientPublicTestnet({ url: this.rpcUrl })
      : new ccc.ClientPublicTestnet();
    const signer = new ccc.SignerCkbPrivateKey(client, strip0x(this.privateKey));
    await signer.connect();
    const address = await signer.getRecommendedAddress();
    const { script: lock } = await ccc.Address.fromString(address, client);
    const dataHex = buildAnchorDataHex(
      input.sessionId,
      input.transcriptRoot,
      input.finalStateHash,
      input.paymentEvidenceRoot
    );
    const minimumCapacityCkb = minimumStandardSecpOutputCapacityCkb(dataHex);
    const outputCapacityCkb = Math.max(this.capacityCkb, minimumCapacityCkb);
    const tx = ccc.Transaction.from({
      outputs: [{ capacity: ccc.fixedPointFrom(outputCapacityCkb), lock }],
      outputsData: [dataHex]
    });
    await tx.completeInputsByCapacity(signer);
    await tx.completeFeeBy(signer);
    return { txHash: await signer.sendTransaction(tx), dataHex, status: "PENDING" as const };
  }
}

export async function inspectAnchorRpc(rpcUrl: string, txHash: string, expectedDataHex: string): Promise<AnchorInspection> {
  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "get_transaction", params: [txHash] }),
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) return { ok: false, status: "RPC_HTTP_ERROR", dataMatches: false, error: `HTTP ${response.status}` };
    const body = await response.json() as any;
    if (body?.error) return { ok: false, status: "RPC_ERROR", dataMatches: false, error: String(body.error?.message ?? body.error) };
    const result = body?.result;
    if (!result) return { ok: false, status: "TX_NOT_FOUND", dataMatches: false };

    const chainStatus = String(result.tx_status?.status ?? "unknown").toLowerCase();
    const outputsData = result.transaction?.outputs_data ?? result.transaction?.inner?.outputs_data;
    const dataMatches = Array.isArray(outputsData)
      && outputsData.some((value: unknown) => typeof value === "string" && value.toLowerCase() === expectedDataHex.toLowerCase());

    if (chainStatus !== "committed") {
      return {
        ok: false,
        status: chainStatus === "pending" || chainStatus === "proposed" ? "TX_NOT_COMMITTED" : `TX_${chainStatus.toUpperCase()}`,
        dataMatches,
        blockHash: result.tx_status?.block_hash
      };
    }
    if (!dataMatches) return { ok: false, status: "COMMITMENT_NOT_FOUND", dataMatches: false, blockHash: result.tx_status?.block_hash };
    return { ok: true, status: "COMMITTED", dataMatches: true, blockHash: result.tx_status?.block_hash };
  } catch (error) {
    return { ok: false, status: "RPC_EXCEPTION", dataMatches: false, error: String(error) };
  }
}

export const verifyAnchorRpcDetailed = inspectAnchorRpc;
export async function verifyAnchorRpc(rpcUrl: string, txHash: string, dataHex: string) {
  return (await inspectAnchorRpc(rpcUrl, txHash, dataHex)).ok;
}
