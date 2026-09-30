import { ccc } from "@ckb-ccc/shell";
import { buildAnchorDataHex, strip0x } from "@eventmesh/core";

export type AnchorCommitment = {
  sessionId: string;
  transcriptRoot: string;
  finalStateHash: string;
  paymentEvidenceRoot: string;
};

export type PreparedAnchor = {
  txHash: string;
  dataHex: string;
  status: "PREPARED";
  /** Opaque signed CCC transaction. It is intentionally not JSON-serializable. */
  transaction: any;
  /** Client that prepared the transaction; kept only for the immediate broadcast step. */
  client: any;
};

export type AnchorInspection = {
  ok: boolean;
  status: string;
  dataMatches: boolean;
  blockHash?: string;
  blockNumber?: string;
  tipNumber?: string;
  confirmations?: number;
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

  private createClient() {
    return this.rpcUrl
      ? new ccc.ClientPublicTestnet({ url: this.rpcUrl })
      : new ccc.ClientPublicTestnet();
  }

  /**
   * Fully prepare and sign an anchor transaction without broadcasting it.
   * The raw transaction hash is deterministic at this point and can be durably
   * persisted before the irreversible network submission.
   */
  async prepareAnchor(input: AnchorCommitment): Promise<PreparedAnchor> {
    const client = this.createClient();
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

    // prepareTransaction may add cell deps and dummy witnesses. Cell deps are
    // part of the raw tx hash, so hash only after preparation.
    const prepared = await signer.prepareTransaction(tx);
    const signed = await signer.signOnlyTransaction(prepared);
    const txHash = signed.hash();
    return { txHash, dataHex, status: "PREPARED", transaction: signed, client };
  }

  /** Broadcast exactly the transaction whose identity was returned by prepareAnchor(). */
  async broadcastPrepared(prepared: PreparedAnchor) {
    const sentHash = await prepared.client.sendTransaction(prepared.transaction);
    if (String(sentHash).toLowerCase() !== prepared.txHash.toLowerCase()) {
      throw new Error(`CKB_BROADCAST_HASH_MISMATCH:${prepared.txHash}:${String(sentHash)}`);
    }
    return { txHash: prepared.txHash, dataHex: prepared.dataHex, status: "PENDING" as const };
  }

  async anchor(input: AnchorCommitment) {
    const prepared = await this.prepareAnchor(input);
    return this.broadcastPrepared(prepared);
  }
}

async function rpcCall(rpcUrl: string, method: string, params: unknown[]) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json() as any;
  if (body?.error) throw new Error(String(body.error?.message ?? body.error));
  return body?.result;
}

/**
 * Verify the commitment in a transaction and, optionally, require a minimum
 * confirmation depth. minimumConfirmations=0 preserves the original behaviour.
 */
export async function inspectAnchorRpc(
  rpcUrl: string,
  txHash: string,
  expectedDataHex: string,
  minimumConfirmations = 0
): Promise<AnchorInspection> {
  try {
    const result = await rpcCall(rpcUrl, "get_transaction", [txHash]);
    if (!result) return { ok: false, status: "TX_NOT_FOUND", dataMatches: false };

    const chainStatus = String(result.tx_status?.status ?? "unknown").toLowerCase();
    const outputsData = result.transaction?.outputs_data ?? result.transaction?.inner?.outputs_data;
    const dataMatches = Array.isArray(outputsData)
      && outputsData.some((value: unknown) => typeof value === "string" && value.toLowerCase() === expectedDataHex.toLowerCase());
    const blockHash = result.tx_status?.block_hash;
    const blockNumber = result.tx_status?.block_number;

    if (chainStatus !== "committed") {
      return {
        ok: false,
        status: chainStatus === "pending" || chainStatus === "proposed" ? "TX_NOT_COMMITTED" : `TX_${chainStatus.toUpperCase()}`,
        dataMatches,
        blockHash,
        blockNumber
      };
    }
    if (!dataMatches) return { ok: false, status: "COMMITMENT_NOT_FOUND", dataMatches: false, blockHash, blockNumber };

    let confirmations: number | undefined;
    let tipNumber: string | undefined;
    if (minimumConfirmations > 0) {
      if (typeof blockNumber !== "string") {
        return { ok: false, status: "BLOCK_NUMBER_UNAVAILABLE", dataMatches: true, blockHash };
      }
      const tip = await rpcCall(rpcUrl, "get_tip_header", []);
      tipNumber = tip?.number;
      if (typeof tipNumber !== "string") {
        return { ok: false, status: "TIP_NUMBER_UNAVAILABLE", dataMatches: true, blockHash, blockNumber };
      }
      const depth = BigInt(tipNumber) - BigInt(blockNumber) + 1n;
      confirmations = depth > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(depth);
      if (confirmations < minimumConfirmations) {
        return {
          ok: false,
          status: "COMMITTED_UNCONFIRMED",
          dataMatches: true,
          blockHash,
          blockNumber,
          tipNumber,
          confirmations
        };
      }
    }

    return {
      ok: true,
      status: minimumConfirmations > 0 ? "CONFIRMED" : "COMMITTED",
      dataMatches: true,
      blockHash,
      blockNumber,
      tipNumber,
      confirmations
    };
  } catch (error) {
    return { ok: false, status: "RPC_EXCEPTION", dataMatches: false, error: String(error) };
  }
}

export const verifyAnchorRpcDetailed = inspectAnchorRpc;
export async function verifyAnchorRpc(rpcUrl: string, txHash: string, dataHex: string, minimumConfirmations = 0) {
  return (await inspectAnchorRpc(rpcUrl, txHash, dataHex, minimumConfirmations)).ok;
}
