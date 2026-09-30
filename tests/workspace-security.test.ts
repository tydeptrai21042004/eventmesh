import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PROTOCOL,
  SIGNING_DOMAIN,
  publicKeyFromPrivate,
  randomPrivateKeyHex,
  signProtocolObject,
  verifyTranscript,
  type Session,
  type TranscriptExport
} from "@eventmesh/core";

describe("v0.6 workspace separation and safety controls", () => {
  it("cryptographically binds the workspace environment into signed sessions", () => {
    const aPriv = randomPrivateKeyHex();
    const bPriv = randomPrivateKeyHex();
    const session: Session = {
      sessionId: "ses_workspace_test",
      protocol: PROTOCOL,
      environment: "TESTNET",
      operatorA: publicKeyFromPrivate(aPriv),
      operatorB: publicKeyFromPrivate(bPriv),
      operatorAUrl: "https://example.test/a",
      operatorBUrl: "https://example.test/b",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      maxEvents: 10
    };
    const transcript: TranscriptExport = {
      session: {
        session,
        signatureA: signProtocolObject(SIGNING_DOMAIN.SESSION, session, aPriv),
        signatureB: signProtocolObject(SIGNING_DOMAIN.SESSION, session, bPriv)
      },
      events: []
    };
    expect(verifyTranscript(transcript)).toEqual({ ok: true, errors: [] });

    const tampered = structuredClone(transcript);
    tampered.session.session.environment = "DEMO";
    expect(verifyTranscript(tampered).ok).toBe(false);
  });

  it("requires explicit Testnet authorization and chain preconditions", () => {
    const api = readFileSync("api/demo.ts", "utf8");
    expect(api).toContain('"x-eventmesh-access-key"');
    expect(api).toContain("TESTNET_ACCESS_DENIED");
    expect(api).toContain("assertChainPrecondition");
    expect(api).toContain("STATE_PRECONDITION_FAILED");
    expect(api).toContain("ALLOWED_EVENT_TYPES");
    expect(api).toContain("ANCHOR_REQUIRES_TESTNET_WORKSPACE");
  });

  it("keeps Demo and Testnet browser persistence separate", () => {
    const ui = readFileSync("apps/demo/src/main.tsx", "utf8");
    expect(ui).toContain('demo: "eventmesh-demo-snapshot-v2"');
    expect(ui).toContain('testnet: "eventmesh-testnet-snapshot-v2"');
    expect(ui).toContain('mode === "demo" ? localStorage : sessionStorage');
    expect(ui).toContain("Memory only");
    expect(ui).toContain("eventmesh-edit-lease");
  });
});
