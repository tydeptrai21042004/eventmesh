/**
 * Executable, LOCAL failure comparison with the SAME logical faults:
 *  - duplicate delivery after a lost application response,
 *  - operator restart while delivery is pending,
 *  - a conflicting result for the same request.
 * EventMesh uses two REAL local HTTP servers and separate durable JSON stores.
 * No FNN/payment, no network partition, no external adoption claim.
 * Baselines intentionally have different trust models and are labeled as such.
 */
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOperatorApp } from '../apps/operator/src/app.js';
import { publicKeyFromPrivate, sha256Hex, verifyTranscript } from '@eventmesh/core';
import { acknowledgeApplicationReceipt, createProviderReceipt, verifyApplicationReceipt } from '@eventmesh/adapter-sdk';

const A_PRIV = `0x${'61'.repeat(32)}`;
const B_PRIV = `0x${'62'.repeat(32)}`;
const result1 = sha256Hex('reviewer:result-one');
const result2 = sha256Hex('reviewer:result-two');
const requestId = 'reviewer-local-job';
const faults = ['LOST_RESPONSE_DUPLICATE_RETRY', 'OPERATOR_RESTART_DURING_DELIVERY', 'CONFLICTING_RESULT'];

async function availablePort(): Promise<number> {
  return await new Promise((done, fail) => {
    const server = createServer();
    server.on('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') return fail(new Error('PORT_UNAVAILABLE'));
      server.close((err) => err ? fail(err) : done(addr.port));
    });
  });
}

/** Single authoritative JSON record; countersigned evidence is absent. */
function baselineApi(path: string) {
  const submit = (hash: string) => {
    const data: Record<string, string> = JSON.parse(readFileSync(path, 'utf8'));
    if (!data[requestId]) { data[requestId] = hash; writeFileSync(path, JSON.stringify(data)); }
    return data[requestId];
  };
  writeFileSync(path, '{}');
  const first = submit(result1);
  // Discard the first HTTP-like response. Replay after reading the durable store again.
  const afterLostResponse = submit(result1);
  const afterRestart = submit(result1);
  const conflict = submit(result2);
  return { durableSingleAuthority: true, replayIdempotent: first === afterLostResponse && first === afterRestart,
    refusesConflictingBusinessResult: conflict === result1, portableBilateralProof: false,
    setup: 'single authoritative JSON record, no actual HTTP/database transaction' };
}

function baselineReceipts(path: string) {
  const make = (resultHash: string) => {
    const createdAt = '2026-10-01T01:00:00.000Z';
    const receipt = {
      version: 'eventmesh-app-receipt-v1' as const,
      sessionId: 'reviewer-local-session', requestId, serviceHash: sha256Hex('reviewer-service'), resultHash,
      provider: publicKeyFromPrivate(B_PRIV), consumer: publicKeyFromPrivate(A_PRIV),
      createdAt, expiresAt: '2026-10-01T02:00:00.000Z'
    };
    return acknowledgeApplicationReceipt(createProviderReceipt(receipt, B_PRIV), A_PRIV, 'ACCEPT', '2026-10-01T01:01:00.000Z');
  };
  const first = make(result1);
  writeFileSync(path, JSON.stringify(first));
  const afterRestart = JSON.parse(readFileSync(path, 'utf8'));
  const independentlyVerified = verifyApplicationReceipt(afterRestart, { requireAcceptance: true });
  const second = make(result2);
  const conflictingAccepted = verifyApplicationReceipt(second, { requireAcceptance: true });
  return { replayIdempotentWhenStored: first.receiptHash === afterRestart.receiptHash,
    portableBilateralProof: independentlyVerified.ok && independentlyVerified.acceptedByBoth,
    conflictVisibleGivenBothArtifacts: second.receiptHash !== first.receiptHash && conflictingAccepted.ok,
    resolvesTwoCountersignedConflicts: false,
    setup: 'portable signed receipts with a basic file-backed persistence layer; no network delivery' };
}

export async function runFailureMatrix() {
  const root = mkdtempSync(join(tmpdir(), 'eventmesh-reviewer-matrix-'));
  let a: Awaited<ReturnType<typeof buildOperatorApp>> | undefined;
  let b: Awaited<ReturnType<typeof buildOperatorApp>> | undefined;
  const aPort = await availablePort();
  const bPort = await availablePort();
  const aUrl = `http://127.0.0.1:${aPort}`;
  const bUrl = `http://127.0.0.1:${bPort}`;
  const aOpts = { name: 'review-a', selfUrl: aUrl, dataDir: join(root, 'a'), defaultPeerUrl: bUrl, allowPrivatePeerUrls: true, operatorPrivateKey: A_PRIV, outboxRetryIntervalMs: 100000 };
  const bOpts = { name: 'review-b', selfUrl: bUrl, dataDir: join(root, 'b'), defaultPeerUrl: aUrl, allowPrivatePeerUrls: true, operatorPrivateKey: B_PRIV, outboxRetryIntervalMs: 100000 };
  let local;
  try {
    const api = baselineApi(join(root, 'api.json'));
    const receipts = baselineReceipts(join(root, 'receipts.json'));
    b = await buildOperatorApp(bOpts);
    a = await buildOperatorApp(aOpts);
    await b.app.listen({ host: '127.0.0.1', port: bPort });
    await a.app.listen({ host: '127.0.0.1', port: aPort });

    const sessionResponse = await a.app.inject({ method: 'POST', url: '/admin/sessions', payload: { applicationProfile: 'generic-bilateral-v1' } });
    if (sessionResponse.statusCode !== 201) throw new Error(`MATRIX_SESSION_CREATE_FAILED:${sessionResponse.body}`);
    const sessionId = sessionResponse.json().session.sessionId as string;
    const requestResponse = await a.app.inject({ method: 'POST', url: `/admin/sessions/${sessionId}/events`, payload: { type: 'WORK_REQUEST', payload: { requestId } } });
    if (requestResponse.statusCode !== 201) throw new Error(`MATRIX_REQUEST_FAILED:${requestResponse.body}`);
    const requestHash = requestResponse.json().eventHash as string;
    const acceptedRequest = await b.app.inject({ method: 'POST', url: `/admin/sessions/${sessionId}/events/${requestHash}/ack`, payload: { decision: 'ACCEPT' } });
    if (acceptedRequest.statusCode !== 200) throw new Error(`MATRIX_REQUEST_ACK_FAILED:${acceptedRequest.body}`);

    // Lost application response: replay same ACK endpoint after its durable commit.
    const lostAck = acceptedRequest.json().ackHash as string; // imagine the response was lost to caller
    const replayed = await b.app.inject({ method: 'POST', url: `/admin/sessions/${sessionId}/events/${requestHash}/ack`, payload: { decision: 'ACCEPT' } });
    const duplicateAckSameHash = replayed.json().ackHash === lostAck;

    // Separate durable operator A becomes unreachable; B creates an event.
    await a.app.close();
    a = undefined;
    const resultResponse = await b.app.inject({ method: 'POST', url: `/admin/sessions/${sessionId}/events`, payload: { type: 'WORK_RESULT', payload: { requestId, resultHash: result1 } } });
    if (resultResponse.statusCode !== 202) throw new Error(`MATRIX_EXPECTED_202_OFFLINE:${resultResponse.body}`);
    const resultHash = resultResponse.json().eventHash as string;
    const pendingBefore = b.store.listOutbox('PENDING', sessionId).length;
    a = await buildOperatorApp(aOpts);
    await a.app.listen({ host: '127.0.0.1', port: aPort });
    const repaired = await b.app.inject({ method: 'POST', url: `/admin/sessions/${sessionId}/reconcile`, payload: { repair: true } });
    if (repaired.statusCode !== 200) throw new Error(`MATRIX_RECONCILE_FAILED:${repaired.body}`);
    const resultAck = await a.app.inject({ method: 'POST', url: `/admin/sessions/${sessionId}/events/${resultHash}/ack`, payload: { decision: 'ACCEPT' } });
    if (resultAck.statusCode !== 200) throw new Error(`MATRIX_RESULT_ACK_FAILED:${resultAck.body}`);
    const finalSync = await b.app.inject({ method: 'POST', url: `/admin/sessions/${sessionId}/reconcile`, payload: { repair: true } });
    if (finalSync.statusCode !== 200) throw new Error(`MATRIX_FINAL_RECONCILE_FAILED:${finalSync.body}`);
    const fromA = await a.app.inject({ method: 'GET', url: `/admin/sessions/${sessionId}/transcript` });
    const proof = verifyTranscript(fromA.json());

    // Generic EventMesh by itself DOES NOT enforce one result per business request.
    // Show this as a limitation; the paid-service profile or app idempotency must do so.
    const secondResult = await b.app.inject({ method: 'POST', url: `/admin/sessions/${sessionId}/events`, payload: { type: 'WORK_RESULT', payload: { requestId, resultHash: result2 } } });
    const secondAccepted = secondResult.statusCode === 201;
    local = { replayIdempotentAtAckLayer: duplicateAckSameHash,
      offlineEventWasDurablyQueued: resultResponse.statusCode === 202 && pendingBefore > 0,
      restartReplayedSignedEvent: repaired.json().repairResults?.some((x: any) => x.delivered === true) === true,
      recoveredTranscriptCryptographicallyValid: proof.ok,
      genericProfileRejectsConflictingBusinessResult: !secondAccepted,
      extraResultAcceptedWithoutBusinessIdempotency: secondAccepted,
      pendingOutboxAfterRecovery: b.store.listOutbox('PENDING', sessionId).length,
      setup: 'two local Fastify operator HTTP servers with independent JSON-file stores, graceful shutdown + restart; no Fiber payment' };
    return {
      schema: 'eventmesh-reviewer-fault-matrix-v1',
      executionClass: 'LOCAL_FAULT_INJECTION_NOT_REAL_FNN',
      sameFaultSchedule: faults,
      outcomes: { authoritativeApi: api, countersignedReceipts: receipts, eventMesh: local },
      conclusion: 'Signed receipts suffice for portable one-shot acknowledgement. EventMesh adds durable event/ACK delivery and transcript history but does not enforce application idempotency in the generic profile.',
      limits: ['One local test run, not a benchmark of latency or throughput.', 'API and receipt reference models do not run independent HTTP services.',
        'Offline event delivery is a graceful restart, not a SIGKILL or a network partition.',
        'No two live Fiber nodes or genuine payment were used.', 'The three designs have different trust models.']
    };
  } finally {
    await Promise.allSettled([a?.app.close(), b?.app.close()]);
    rmSync(root, { force: true, recursive: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runFailureMatrix().then((report) => {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    const e = report.outcomes.eventMesh;
    if (!(e.replayIdempotentAtAckLayer && e.offlineEventWasDurablyQueued && e.restartReplayedSignedEvent && e.recoveredTranscriptCryptographicallyValid)) {
      process.exitCode = 1;
    }
  }).catch((error) => { console.error('FAILURE_MATRIX_FAILED', error); process.exitCode = 1; });
}
