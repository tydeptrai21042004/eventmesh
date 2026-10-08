import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { timingSafeEqual } from "node:crypto";

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((value, part) => ((value << 8) | Number(part)) >>> 0, 0) >>> 0;
}

function inV4Cidr(ip: string, base: string, prefix: number): boolean {
  const value = ipv4ToInt(ip);
  const start = ipv4ToInt(base);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (start & mask);
}

export function isPrivateOrSpecialIp(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const blocked: Array<[string, number]> = [
      ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
      ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
      ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
      ["224.0.0.0", 4], ["240.0.0.0", 4]
    ];
    return blocked.some(([base, prefix]) => inV4Cidr(address, base, prefix));
  }
  if (version === 6) {
    const normalized = address.toLowerCase();
    if (normalized === "::" || normalized === "::1") return true;
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
    if (/^fe[89ab]/.test(normalized)) return true;
    if (normalized.startsWith("ff")) return true;
    if (normalized.startsWith("2001:db8:")) return true;
    if (normalized.startsWith("::ffff:")) {
      const mapped = normalized.slice("::ffff:".length);
      return isIP(mapped) === 4 ? isPrivateOrSpecialIp(mapped) : true;
    }
    return false;
  }
  return true;
}

export type PeerUrlOptions = {
  publicMode: boolean;
  allowPrivatePeerUrls?: boolean;
  allowedHosts?: Set<string>;
};

/** DNS is resolved once for the final TCP connection, never only as a precheck. */
export async function resolvePeerUrl(input: string, options: PeerUrlOptions): Promise<{
  url: URL;
  address: string;
  family: 4 | 6;
}> {
  const url = new URL(input);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("PEER_URL_SCHEME_NOT_ALLOWED");
  if (url.username || url.password) throw new Error("PEER_URL_CREDENTIALS_NOT_ALLOWED");
  if (url.hash || url.search || (url.pathname && url.pathname !== "/")) throw new Error("PEER_URL_PATH_QUERY_FRAGMENT_NOT_ALLOWED");
  if (options.publicMode && url.protocol !== "https:") throw new Error("PUBLIC_MODE_REQUIRES_HTTPS_PEER");
  if (options.allowedHosts?.size && !options.allowedHosts.has(url.hostname.toLowerCase())) throw new Error("PEER_HOST_NOT_ALLOWLISTED");

  const literalHost = url.hostname.startsWith("[") && url.hostname.endsWith("]")
    ? url.hostname.slice(1, -1) : url.hostname;
  const literalVersion = isIP(literalHost);
  const addresses = literalVersion
    ? [{ address: literalHost, family: literalVersion as 4 | 6 }]
    : await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length) throw new Error("PEER_DNS_RESOLUTION_EMPTY");
  if (!options.allowPrivatePeerUrls) {
    for (const resolved of addresses) {
      if (isPrivateOrSpecialIp(resolved.address)) throw new Error("PEER_ADDRESS_NOT_PUBLIC");
    }
  }
  return { url, address: addresses[0].address, family: addresses[0].family as 4 | 6 };
}

export async function validatePeerUrl(input: string, options: PeerUrlOptions): Promise<URL> {
  return (await resolvePeerUrl(input, options)).url;
}

export function parseCorsOrigins(raw?: string): string[] {
  return (raw ?? "http://localhost:3000")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function adminTokenMatches(provided: string | undefined, expected: string | undefined): boolean {
  if (!expected || !provided) return false;
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function extractAdminToken(headers: Record<string, unknown>): string | undefined {
  const direct = headers["x-eventmesh-admin-token"];
  if (typeof direct === "string") return direct;
  const authorization = headers.authorization;
  if (typeof authorization === "string" && authorization.startsWith("Bearer ")) return authorization.slice(7);
  return undefined;
}
