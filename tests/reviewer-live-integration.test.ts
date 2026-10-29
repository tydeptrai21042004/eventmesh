import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FiberRpcClient } from '@eventmesh/fiber';
import { buildOperatorApp } from '../apps/operator/src/app.js';
import { runFailureMatrix } from '../benchmarks/failure-matrix.js';

const originalFetch = globalThis.fetch;
afterEach(() => { vi.stubGlobal('fetch', originalFetch); });

describe('real Fiber invoice API compatibility', () => {
  it('generates a unique 32-byte preimage and includes the signed payment-purpose binding', async () => {
    const inputPayloads: any[] = [];
    const hash = `0x${'ab'.repeat(32)}`;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, opts: RequestInit) => {
      const body = JSON.parse(String(opts.body));
      expect(body.method).toBe('new_invoice');
      inputPayloads.push(body.params[0]);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {
        invoice_address: 'fibt_test_only',
        invoice: { amount: '0x64', currency: 'Fibt', data: { payment_hash: hash } }
      } }), { status: 200 });
    }));
    const fnn = new FiberRpcClient('http://127.0.0.1:8227');
    const a = await fnn.newInvoice({ amount: '100', sessionId: 'ses-123', obligationId: 'job-123', settlesEventHash: `0x${'cd'.repeat(32)}`, currency: 'Fibt' });
    const b = await fnn.newInvoice({ amount: '100', sessionId: 'ses-123', obligationId: 'job-123', settlesEventHash: `0x${'cd'.repeat(32)}`, currency: 'Fibt' });
    expect(a.eventMeshClaim.paymentHash).toBe(hash);
    expect(a.eventMeshClaim.purposeHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(inputPayloads).toHaveLength(2);
    expect(inputPayloads[0].payment_preimage).toMatch(/^0x[0-9a-f]{64}$/);
    expect(inputPayloads[0].payment_preimage).not.toBe(inputPayloads[1].payment_preimage);
    expect(inputPayloads[0].hash_algorithm).toBe('sha256');
    expect(inputPayloads[0].currency).toBe('Fibt');
    expect(JSON.stringify(b)).not.toContain(inputPayloads[1].payment_preimage);
  });

  it('exposes only public Fiber identity through operator admin API', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eventmesh-fnn-node-info-'));
    const fnn = { getNodeInfo: async () => ({ pubkey: '02' + 'ab'.repeat(32), version: 'v0.9.0', privateKey: 'NEVER_EXPOSE' }) } as unknown as FiberRpcClient;
    const op = await buildOperatorApp({ name: 'reviewer', selfUrl: 'http://localhost:49601', dataDir: dir, fiber: fnn, adminToken: 'test-admin-secret' });
    try {
      const unauthorized = await op.app.inject({ method: 'GET', url: '/admin/fiber/node-info' });
      expect(unauthorized.statusCode).toBe(401);
      const response = await op.app.inject({ method: 'GET', url: '/admin/fiber/node-info', headers: { authorization: 'Bearer test-admin-secret' } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ pubkey: '02' + 'ab'.repeat(32), version: 'v0.9.0' });
    } finally {
      await op.app.close();
      rmSync(dir, { force: true, recursive: true });
    }
  });
});

describe('reviewer failure matrix: local, reproducible, no actual FNN', () => {
  it('recovers durable signed evidence after operator restart without claiming business-level deduplication', async () => {
    const report = await runFailureMatrix();
    expect(report.executionClass).toBe('LOCAL_FAULT_INJECTION_NOT_REAL_FNN');
    expect(report.outcomes.authoritativeApi.replayIdempotent).toBe(true);
    expect(report.outcomes.countersignedReceipts.portableBilateralProof).toBe(true);
    expect(report.outcomes.eventMesh.offlineEventWasDurablyQueued).toBe(true);
    expect(report.outcomes.eventMesh.replayIdempotentAtAckLayer).toBe(true);
    expect(report.outcomes.eventMesh.restartReplayedSignedEvent).toBe(true);
    expect(report.outcomes.eventMesh.recoveredTranscriptCryptographicallyValid).toBe(true);
  }, 30000);
});
