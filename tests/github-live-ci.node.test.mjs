import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, chmodSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { executeLive, verifyDurableDirectory } from '../scripts/github-live-fiber.mjs';

function setup() {
  const outer = mkdtempSync(join(resolve('.'), '.em-live-ci-'));
  const dir = join(outer, 'persistent');
  mkdirSync(dir, { mode: 0o700 }); chmodSync(dir, 0o700);
  return { outer, dir };
}
const env = { OPERATOR_A_URL: 'https://a.example.org', OPERATOR_B_URL: 'https://b.example.org', OPERATOR_A_TOKEN: 'private-a', OPERATOR_B_TOKEN: 'private-b' };
test('durable state cannot live in GitHub workspace or runner temp', () => {
  const { outer, dir } = setup();
  try {
    assert.throws(() => verifyDurableDirectory('relative/path'), /ABSOLUTE_DURABLE/);
    assert.throws(() => verifyDurableDirectory(dir, { GITHUB_WORKSPACE: outer }), /JOURNAL_INSIDE_EPHEMERAL/);
    assert.equal(verifyDurableDirectory(dir, {}), dir);
    chmodSync(dir, 0o755);
    assert.throws(() => verifyDurableDirectory(dir, {}), /MUST_BE_PRIVATE/);
  } finally { rmSync(outer, { recursive: true, force: true }); }
});
test('live payment requires exact manual approval BEFORE any network request', async () => {
  let calls = 0;
  await assert.rejects(executeLive({ mode:'run', env, run: () => { calls++; } }), /EXPLICIT_MANUAL_LIVE_APPROVAL_REQUIRED/);
  assert.equal(calls, 0);
});
test('reconcile mode never starts from an INVOICE or payment-intent journal', async () => {
  const { outer, dir } = setup();
  writeFileSync(join(dir,'two-fnn-state.json'), JSON.stringify({ step:'INVOICE', paymentSendAttempts:0 }));
  try {
    let calls = 0;
    await assert.rejects(executeLive({mode:'reconcile',env:{...env,EVENTMESH_DURABLE_STATE_DIR:dir},run:()=>{calls++}}),/RECONCILE_REQUIRES_ALREADY_CLOSED_PAYMENT_JOURNAL/);
    assert.equal(calls,0);
  } finally { rmSync(outer,{recursive:true,force:true}); }
});
test('preflight uses read requests without approving payment', async () => {
  let calls = 0;
  const run = async ({args}) => {calls++;assert.deepEqual(args,['--preflight']);return {status:'PREFLIGHT_ONLY',fnnPubkeys:['a','b']};};
  const transport = async (url) => ({ok:true,status:200,json:async()=>({ ckbAnchorEnabled:true })});
  const r=await executeLive({mode:'preflight',env,run,transport});
  assert.equal(r.status,'PREFLIGHT_ONLY'); assert.equal(calls,1);
});

test('mocked verified payment allows exactly one anchor and a confirmed report', async () => {
  const { outer, dir } = setup();
  try {
    let paymentRuns=0, anchors=0;
    const hash='0x'+'a'.repeat(64);
    const resultState={ckb:{anchorStatus:'NONE',txHash:null}};
    const run=async ({args}) => {
      if (args[0]==='--preflight') return {status:'PREFLIGHT_ONLY',fnnPubkeys:['node-a','node-b']};
      paymentRuns++;
      return {status:'DUAL_SIGNED_RECEIVER_VERIFIED',paymentSendAttempts:1,paymentHash:hash,receiverEvidenceHash:hash,sessionId:'session-example'};
    };
    const transport=async (url,{method}) => {
      const pathname=new URL(url).pathname;
      let data={};
      if(pathname==='/health') data={ckbAnchorEnabled:true,ckbVerificationEnabled:true};
      if(pathname.endsWith('/evidence-summary')) data={status:'CLOSED',close:{dualSigned:true},payments:{evidenceComplete:true},ckb:resultState.ckb,readiness:{ckbConfirmed:resultState.ckb.anchorStatus==='CONFIRMED'}};
      if(pathname.endsWith('/anchor')) { anchors++; resultState.ckb={anchorStatus:'PENDING',txHash:hash};data={anchor:{txHash:hash,status:'PENDING'}}; }
      if(pathname.endsWith('/anchor/reconcile')) { resultState.ckb={anchorStatus:'CONFIRMED',txHash:hash};data={verification:{status:'CONFIRMED'}}; }
      return {ok:true,status:200,json:async()=>data};
    };
    const result=await executeLive({ mode:'run',env:{...env,EVENTMESH_LIVE_APPROVAL:'RUN_ONE_TESTNET_PAYMENT_AND_ANCHOR',EVENTMESH_DURABLE_STATE_DIR:dir,EVENTMESH_CKB_RECONCILE_POLLS:'1'},run,transport });
    assert.equal(result.stage,'LIVE_FIBER_AND_CKB_CONFIRMED');
    assert.equal(result.txHash,hash); assert.equal(paymentRuns,1); assert.equal(anchors,1);
  } finally { rmSync(outer,{recursive:true,force:true}); }
});

test('mocked incomplete payment evidence cannot trigger CKB anchor request', async () => {
  const { outer, dir } = setup();
  try {
    let anchorRequests=0;
    const run=async ({args}) => args[0]==='--preflight'
      ? {status:'PREFLIGHT_ONLY',fnnPubkeys:['node-a','node-b']}
      : {status:'PREFLIGHT_ONLY',paymentSendAttempts:0};
    const transport=async (url) => {
      if(url.endsWith('/anchor')) anchorRequests++;
      return {ok:true,status:200,json:async()=>({ckbAnchorEnabled:true,ckbVerificationEnabled:true})};
    };
    await assert.rejects(executeLive({mode:'run',env:{...env,EVENTMESH_LIVE_APPROVAL:'RUN_ONE_TESTNET_PAYMENT_AND_ANCHOR',EVENTMESH_DURABLE_STATE_DIR:dir},run,transport}),/REAL_FIBER_EVIDENCE_INCOMPLETE/);
    assert.equal(anchorRequests,0);
  } finally {rmSync(outer,{recursive:true,force:true});}
});
