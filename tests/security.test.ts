import { describe, expect, it } from "vitest";
import { adminTokenMatches, isPrivateOrSpecialIp, validatePeerUrl } from "../apps/operator/src/security.js";

describe("peer and admin security helpers", () => {
  it("blocks private, link-local, documentation, multicast and metadata-style addresses", () => {
    for (const ip of [
      "0.0.0.1", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.169.254",
      "172.16.0.1", "192.0.2.1", "192.168.1.1", "198.51.100.1", "203.0.113.1",
      "::1", "fd00::1", "fe80::1", "2001:db8::1"
    ]) expect(isPrivateOrSpecialIp(ip)).toBe(true);
    expect(isPrivateOrSpecialIp("8.8.8.8")).toBe(false);
  });

  it("allows private peers only in explicit development mode", async () => {
    await expect(validatePeerUrl("http://127.0.0.1:4000", {
      publicMode: false,
      allowPrivatePeerUrls: true
    })).resolves.toBeInstanceOf(URL);
    await expect(validatePeerUrl("http://127.0.0.1:4000", {
      publicMode: true,
      allowPrivatePeerUrls: false
    })).rejects.toThrow();
  });

  it("requires HTTPS in public mode", async () => {
    await expect(validatePeerUrl("http://8.8.8.8:4000", {
      publicMode: true,
      allowPrivatePeerUrls: false
    })).rejects.toThrow("PUBLIC_MODE_REQUIRES_HTTPS_PEER");
  });

  it("rejects peer URLs carrying credentials, paths, queries or fragments", async () => {
    const options = { publicMode: false, allowPrivatePeerUrls: true };
    await expect(validatePeerUrl("http://user:pass@127.0.0.1:4000", options)).rejects.toThrow("PEER_URL_CREDENTIALS_NOT_ALLOWED");
    await expect(validatePeerUrl("http://127.0.0.1:4000/admin", options)).rejects.toThrow("PEER_URL_PATH_QUERY_FRAGMENT_NOT_ALLOWED");
    await expect(validatePeerUrl("http://127.0.0.1:4000/?x=1", options)).rejects.toThrow("PEER_URL_PATH_QUERY_FRAGMENT_NOT_ALLOWED");
    await expect(validatePeerUrl("http://127.0.0.1:4000/#x", options)).rejects.toThrow("PEER_URL_PATH_QUERY_FRAGMENT_NOT_ALLOWED");
  });

  it("enforces an optional peer hostname allowlist", async () => {
    await expect(validatePeerUrl("http://127.0.0.1:4000", {
      publicMode: false,
      allowPrivatePeerUrls: true,
      allowedHosts: new Set(["example.com"])
    })).rejects.toThrow("PEER_HOST_NOT_ALLOWLISTED");
  });

  it("compares admin tokens without accepting missing or wrong values", () => {
    expect(adminTokenMatches("abc", "abc")).toBe(true);
    expect(adminTokenMatches("abc", "abd")).toBe(false);
    expect(adminTokenMatches("abc", undefined)).toBe(false);
    expect(adminTokenMatches(undefined, "abc")).toBe(false);
  });
});
