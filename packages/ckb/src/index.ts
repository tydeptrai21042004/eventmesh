import { ccc } from "@ckb-ccc/shell";
import { buildAnchorDataHex, strip0x } from "@eventmesh/core";

export class CkbAnchorClient {
  constructor(
    private readonly privateKey: string,
    private readonly rpcUrl?: string,
    private readonly capacityCkb = 200
  ) {}

  async anchor(input: { sessionId: string; transcriptRoot: string; finalStateHash: string }): Promise<{ txHash: string; dataHex: string }> {
    const client = this.rpcUrl
      ? new ccc.ClientPublicTestnet({ url: this.rpcUrl })
      : new ccc.ClientPublicTestnet();
    const signer = new ccc.SignerCkbPrivateKey(client, strip0x(this.privateKey));
    await signer.connect();
    const address = await signer.getRecommendedAddress();
    const { script: lock } = await ccc.Address.fromString(address, client);
    const dataHex = buildAnchorDataHex(input.sessionId, input.transcriptRoot, input.finalStateHash);
    const tx = ccc.Transaction.from({
      outputs: [{ capacity: ccc.fixedPointFrom(this.capacityCkb), lock }],
      outputsData: [dataHex]
    });
    await tx.completeInputsByCapacity(signer);
    await tx.completeFeeBy(signer);
    const txHash = await signer.sendTransaction(tx);
    return { txHash, dataHex };
  }
}

export async function verifyAnchorRpc(rpcUrl: string, txHash: string, expectedDataHex: string): Promise<boolean> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "get_transaction", params: [txHash] })
  });
  if (!response.ok) return false;
  const body = await response.json() as any;
  const outputsData = body?.result?.transaction?.outputs_data ?? body?.result?.transaction?.inner?.outputs_data;
  return Array.isArray(outputsData) && outputsData.some((x: string) => x.toLowerCase() === expectedDataHex.toLowerCase());
}
