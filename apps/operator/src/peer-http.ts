import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { resolvePeerUrl, type PeerUrlOptions } from "./security.js";

export type PeerHttpResponse = {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
};

/**
 * Peer-only HTTP client. The DNS result used for validation is pinned in the
 * actual socket lookup, preventing DNS rebinding between the check and connect.
 * TLS still authenticates the original DNS hostname (SNI + certificate check).
 * Response bytes and elapsed time are bounded without adding dependencies.
 */
export async function pinnedPeerFetch(
  input: string,
  options: PeerUrlOptions & { timeoutMs: number; maxResponseBytes: number },
  init: { method?: "GET" | "POST"; headers?: Record<string, string>; body?: string } = {}
): Promise<PeerHttpResponse> {
  const url = new URL(input);
  // Validate only the peer origin; app.ts separately allowlists exact API paths.
  const { address, family } = await resolvePeerUrl(url.origin, options);
  if (!Number.isSafeInteger(options.maxResponseBytes) || options.maxResponseBytes < 1) throw new Error("INVALID_PEER_RESPONSE_LIMIT");
  const client = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise<PeerHttpResponse>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fail = (error: Error) => {
      if (!settled) { settled = true; clearTimeout(timer); reject(error); }
    };
    const req = client(url, {
      method: init.method ?? "GET",
      headers: init.headers,
      agent: false,
      // Ignore any subsequent resolver answer, including DNS rebinding.
      lookup(_host: string, _opts: unknown, callback: any) { callback(null, address, family); }
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > options.maxResponseBytes) {
          fail(new Error("PEER_RESPONSE_TOO_LARGE"));
          res.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on("error", fail);
      res.on("end", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const status = res.statusCode ?? 502;
        const body = Buffer.concat(chunks).toString("utf8");
        resolve({
          status,
          ok: status >= 200 && status < 300,
          text: async () => body,
          json: async () => JSON.parse(body) as unknown
        });
      });
    });
    req.on("error", fail);
    timer = setTimeout(() => req.destroy(new Error("PEER_REQUEST_TIMEOUT")), options.timeoutMs);
    timer.unref();
    req.setTimeout(options.timeoutMs, () => req.destroy(new Error("PEER_REQUEST_TIMEOUT")));
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}
