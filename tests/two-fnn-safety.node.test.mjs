import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertOperatorEndpoint, validateApproval, markPaymentAttempt,
  newJournal, persist, preflight, runTwoFnn
} from '../scripts/two-fnn-testnet.mjs';

const TESTNET_FLAGS = {
  EVENTMESH_TESTNET_NETWORK_CONFIRM: 'TESTNET_ONLY',
  EVENTMESH_ALLOW_FIBER_PAYMENT: 'YES_ONE_TESTNET_PAYMENT',
  EVENTMESH_MAX_PAYMENT_SHANNONS: '100000000'
};

test('rejects payment without explicit double opt-in and amount cap', () => {
  assert.throws(() => validateApproval({ executePayment: true, env: {}, amount: '1' }), /TESTNET_CONFIRMATION_REQUIRED/);
  assert.throws(() => validateApproval({ executePayment: true, env: { EVENTMESH_TESTNET_NETWORK_CONFIRM: 'TESTNET_ONLY' }, amount: '1' }), /PAYMENT_OPT_IN_REQUIRED/);
  assert.throws(() => validateApproval({ executePayment: true, env: TESTNET_FLAGS, amount: '100000001' }), /AMOUNT_EXCEEDS_CONFIGURED_TESTNET_CAP/);
  assert.throws(() => validateApproval({ executePayment: true, env: TESTNET_FLAGS, amount: '0' }), /AMOUNT_EXCEEDS_CONFIGURED_TESTNET_CAP/);
  assert.doesNotThrow(() => validateApproval({ executePayment: true, env: TESTNET_FLAGS, amount: '100000000' }));
});

test('operator URLs require TLS except local loopback and contain no embedded secrets', () => {
  assert.equal(assertOperatorEndpoint('http://127.0.0.1:4001'), 'http://127.0.0.1:4001');
  assert.throws(() => assertOperatorEndpoint('http://example.org:4001'), /HTTPS_OR_LOCAL_LOOPBACK/);
  assert.throws(() => assertOperatorEndpoint('https://alice:secret@example.org'), /BARE_ORIGIN/);
  assert.throws(() => assertOperatorEndpoint('https://example.org/admin'), /BARE_ORIGIN/);
});

test('journal prohibits duplicate send_payment after a lost response or restart', () => {
  const folder = mkdtempSync(join(tmpdir(), 'eventmesh-run-safety-'));
  try {
    const path = join(folder, 'state.json');
    const state = newJournal('1234', 'test');
    state.step = 'INVOICE';
    state.invoice = { paymentHash: `0x${'12'.repeat(32)}`, invoiceAddress: 'fibtexample' };
    persist(path, state);
    markPaymentAttempt(state);
    persist(path, state);
    const restarted = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(restarted.step, 'PAYMENT_SEND_INTENT');
    assert.equal(restarted.paymentSendAttempts, 1);
    assert.throws(() => markPaymentAttempt(restarted), /PAYMENT_ALREADY_ATTEMPTED/);
  } finally { rmSync(folder, { force: true, recursive: true }); }
});

test('preflight demands two distinct FNN node identities and enabled receiver verification', async () => {
  const fna = '02' + '1a'.repeat(32);
  const fnb = '03' + '2b'.repeat(32);
  const opa = '0x02' + '3a'.repeat(32);
  const opb = '0x03' + '4b'.repeat(32);
  const router = async (uri) => {
    const who = uri.includes(':4001') ? 0 : 1;
    const data = uri.endsWith('/health') ? { fiberEnabled: true }
      : uri.endsWith('/identity') ? { publicKey: who === 0 ? opa : opb, selfUrl: `http://127.0.0.1:${4001 + who}` }
      : uri.endsWith('/admin/fiber/node-info') ? { pubkey: who === 0 ? fna : fnb } : {};
    return new Response(JSON.stringify(data), { status: 200 });
  };
  const report = await preflight('http://127.0.0.1:4001', 'http://127.0.0.1:4002', { a: '', b: '' }, router);
  assert.equal(report.fiberEnabled, true);
  assert.equal(report.testnetIndependentlyVerified, false);
  const badRouter = async (uri) => {
    const response = await router(uri);
    const data = await response.json();
    if (uri.endsWith('/admin/fiber/node-info')) data.pubkey = fna;
    return new Response(JSON.stringify(data));
  };
  await assert.rejects(preflight('http://127.0.0.1:4001', 'http://127.0.0.1:4002', { a: '', b: '' }, badRouter), /FNN_MUST_BE_TWO_DISTINCT/);
});

test('default runner is read-only preflight and never sends payments', async () => {
  const opa = '0x02' + '3a'.repeat(32);
  const opb = '0x03' + '4b'.repeat(32);
  const fna = '02' + '1a'.repeat(32);
  const fnb = '03' + '2b'.repeat(32);
  const calls = [];
  const router = async (uri, opt) => {
    calls.push([uri, opt.method]);
    const who = uri.includes(':4001') ? 0 : 1;
    const data = uri.endsWith('/health') ? { fiberEnabled: true }
      : uri.endsWith('/identity') ? { publicKey: who === 0 ? opa : opb, selfUrl: `http://127.0.0.1:${4001 + who}` }
      : uri.endsWith('/admin/fiber/node-info') ? { pubkey: who === 0 ? fna : fnb } : {};
    return new Response(JSON.stringify(data));
  };
  const report = await runTwoFnn({ env: {}, args: ['--preflight'], transport: router });
  assert.equal(report.status, 'PREFLIGHT_ONLY');
  assert.equal(calls.length, 6);
  assert.ok(calls.every(([,method]) => method === 'GET'));
});

test('injected lost payment response resumes from receiver invoice without resending', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'eventmesh-injected-fiber-'));
  const statePath = join(folder, 'journal.json');
  const pubA = '0x02' + '3a'.repeat(32);
  const pubB = '0x03' + '4b'.repeat(32);
  const fnA = '02' + '1a'.repeat(32);
  const fnB = '03' + '2b'.repeat(32);
  const payHash = '0x' + 'cc'.repeat(32);
  let sent = 0;
  let eventCounter = 0;
  const events = [];
  const transport = async (uri, opt) => {
    const path = new URL(uri).pathname;
    const operatorA = uri.includes(':4001');
    const method = opt.method;
    const body = opt.body ? JSON.parse(opt.body) : {};
    let response = {};
    if (path === '/health') response = { fiberEnabled: true };
    else if (path === '/identity') response = { publicKey: operatorA ? pubA : pubB, selfUrl: operatorA ? 'http://127.0.0.1:4001' : 'http://127.0.0.1:4002' };
    else if (path === '/admin/fiber/node-info') response = { pubkey: operatorA ? fnA : fnB };
    else if (path === '/admin/sessions' && method === 'POST') response = { session: { sessionId: 'ses-injected' } };
    else if (path === '/admin/sessions/ses-injected' && method === 'GET') response = { status: 'ACTIVE', events };
    else if (path.endsWith('/events') && method === 'POST') {
      const eventHash = '0x' + String(++eventCounter).padStart(64, '0');
      const event = { ...body, eventHash, sender: operatorA ? pubA : pubB };
      events.push({ event, status: 'FINAL' });
      response = event;
    }
    else if (path.endsWith('/ack') && method === 'POST') {
      if (events.some((row) => row.event.type === 'SESSION_COMPLETED')) throw Error('STOP_BEFORE_FULL_VERIFICATION');
      response = { ackHash: '0x' + 'ee'.repeat(32), paymentEvidence: { evidenceHash: '0x' + 'ff'.repeat(32), evidence: { verifier: 'RECEIVER_FNN' } } };
    }
    else if (path === '/admin/fiber/new-invoice') response = {
      invoice_address: 'fibt-mock-not-a-real-payment',
      eventMeshClaim: { paymentHash: payHash, sessionId: 'ses-injected', amount: '0x5f5e100', currency: 'Fibt', obligationId: body.obligationId, settlesEventHash: body.settlesEventHash }
    };
    else if (path === '/admin/fiber/invoices/' + payHash) response = { status: sent ? 'Paid' : 'Open' };
    else if (path === '/admin/fiber/send-payment') { sent++; response = { payment_hash: payHash }; }
    else throw Error('UNHANDLED_FAKE_ROUTE:' + method + ':' + path);
    return new Response(JSON.stringify(response), { status: 200 });
  };
  const env = { ...TESTNET_FLAGS, EVENTMESH_RUN_STATE: statePath };
  try {
    await assert.rejects(runTwoFnn({ env, args: ['--run', '--allow-payment', '--inject-lost-payment-response'], transport }), /INJECTED_LOST_PAYMENT_RESPONSE/);
    assert.equal(sent, 1);
    const afterFirst = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(afterFirst.paymentSendAttempts, 1);
    assert.equal(afterFirst.step, 'PAYMENT_SEND_INTENT');
    await assert.rejects(runTwoFnn({ env, args: ['--run', '--allow-payment'], transport }), /STOP_BEFORE_FULL_VERIFICATION/);
    assert.equal(sent, 1, 'a restart MUST NOT send the payment a second time');
    const afterSecond = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(afterSecond.step, 'PAYMENT_SETTLED');
  } finally { rmSync(folder, { force: true, recursive: true }); }
});
