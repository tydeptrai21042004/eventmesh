import { randomBytes } from "node:crypto";

type JsonRpcEnvelope<T> = { jsonrpc: "2.0"; id: number; result?: T; error?: { code: number; message: string; data?: unknown } };

export class FiberRpcClient {
  constructor(private readonly url: string, private readonly token?: string) {}

  private async call<T>(method: string, params: unknown[]): Promise<T> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const response = await fetch(this.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params })
    });
    if (!response.ok) throw new Error(`Fiber HTTP ${response.status}`);
    const body = (await response.json()) as JsonRpcEnvelope<T>;
    if (body.error) throw new Error(`Fiber RPC ${body.error.code}: ${body.error.message}`);
    if (body.result === undefined) throw new Error("Fiber RPC returned no result");
    return body.result;
  }

  async newInvoice(input: {
    amount: string;
    currency?: string;
    description?: string;
    expiry?: string;
    finalCltv?: string;
    udtTypeScript?: { code_hash: string; hash_type: "type" | "data" | "data1" | "data2"; args: string };
  }): Promise<unknown> {
    const paymentPreimage = `0x${randomBytes(32).toString("hex")}`;
    return this.call("new_invoice", [{
      amount: input.amount,
      currency: input.currency ?? "Fibt",
      description: input.description ?? "EventMesh payment",
      expiry: input.expiry ?? "0xe10",
      final_cltv: input.finalCltv ?? "0x28",
      payment_preimage: paymentPreimage,
      hash_algorithm: "sha256",
      ...(input.udtTypeScript ? { udt_type_script: input.udtTypeScript } : {})
    }]);
  }

  async sendPayment(invoice: string): Promise<unknown> {
    return this.call("send_payment", [{ invoice }]);
  }

  async getPayment(paymentHash: string): Promise<unknown> {
    return this.call("get_payment", [{ payment_hash: paymentHash }]);
  }
}
