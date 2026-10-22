import assert from 'node:assert/strict';
import { createECDH } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { commitment, probeTestnet, EXPECTED_DATA, hexSha256, execute } from '../scripts/auto-testnet.mjs';

const key = { capacity: '0x' + (800n * 100000000n).toString(16) };
function response(result) { return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200 }); }
function rpc({ capacity = key.capacity, cells = [], fail = false } = {}) {
  return async (_url, args) => {
    const req = JSON.parse(args.body);
    if (fail) throw Error('network offline');
    if (req.method === 'get_cells_capacity') return response({ capacity });
    if (req.method === 'get_cells') return response({ objects: cells, last_cursor: null });
    throw Error('unexpected ' + req.method);
  };
}
test('synthetic anchor bytes have EventMesh domain, deterministic and no payment assertion', () => {
  const a = commitment(), b = commitment();
  assert.deepEqual(a,b);
  assert.equal(a.dataHex,EXPECTED_DATA);
  assert.equal(Buffer.from(a.dataHex.slice(2),'hex').subarray(0,13).toString(),'EVENTMESH_V02');
  assert.equal(hexSha256('abc'), '0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
test('CKB funding probe uses exact public lock script capacity and lists live cells', async () => {
  const wallet = await probeTestnet({ transport: rpc(),rpc: 'https://rpc.test' });
  assert.equal(wallet.balanceCkb,'800.00000000');
  assert.equal(wallet.previousAnchor,null);
});
test('previous deterministic transaction detected from output data', async () => {
  const wallet = await probeTestnet({ transport: rpc({cells:[{out_point:{tx_hash:'0x'+'11'.repeat(32)},output_data:EXPECTED_DATA}]}), rpc:'https://rpc.test' });
  assert.equal(wallet.previousAnchor.txHash,'0x'+'11'.repeat(32));
});
test('no funds reports waiting and never calls a signer', async () => {
  const result = await execute({ mode:'run', rpc:'https://rpc.test',transport:rpc({capacity:'0x0'}), privateKey:'' });
  assert.equal(result.status,'WAITING_FOR_FUNDS');
});
test('funded wallet with explicitly missing key remains unspent and reports required key', async () => {
  const result = await execute({ mode:'run', rpc:'https://rpc.test', transport:rpc(), privateKey:'' });
  assert.equal(result.status,'MISSING_TESTNET_KEY');
});
test('network failures do not masquerade as unfunded state', async () => {
  const result = await execute({ mode:'run',rpc:'https://rpc.test',transport:rpc({fail:true}),privateKey:'' });
  assert.equal(result.status,'RPC_UNAVAILABLE');
});

// Dedicated public Testnet-only key is deliberately committed for zero-setup CI.
// Ensure the signer key matches the advertised faucet wallet without logging it.
test('hardcoded Testnet key matches configured secp256k1 public identity', () => {
  const config = JSON.parse(readFileSync(new URL('../config/testnet-wallet.json', import.meta.url), 'utf8'));
  assert.equal(config.network, 'CKB Pudge Testnet');
  assert.match(config.address, /^ckt1/);
  assert.match(config.privateKey, /^0x[0-9a-f]{64}$/i);
  const signer = createECDH('secp256k1');
  signer.setPrivateKey(Buffer.from(config.privateKey.slice(2), 'hex'));
  assert.equal(`0x${signer.getPublicKey('hex', 'compressed')}`, config.publicKeyCompressed);
});
