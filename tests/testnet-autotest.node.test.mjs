import assert from 'node:assert/strict';
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

// The receiving address is public, but a signing key must NEVER be committed.
// Reconstruct the canonical CKB full-address encoding from the configured
// standard secp256k1 lock script using Bech32m (CKB address payload type 0x00).
test('configured faucet address is a valid Bech32m encoding of public lock script', () => {
  const config = JSON.parse(readFileSync(new URL('../config/testnet-wallet.json', import.meta.url), 'utf8'));
  const CHARS = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  const polymod = (values) => {
    let chk = 1;
    for (const v of values) {
      const top = chk >>> 25;
      chk = ((chk & 0x1ffffff) << 5) ^ v;
      for (let i = 0; i < 5; i++) if (top & (1 << i)) chk ^= GEN[i];
    }
    return chk >>> 0;
  };
  const convertBits = (bytes) => {
    let acc = 0, bits = 0; const result = [];
    for (const x of bytes) {
      acc = ((acc << 8) | x) & 0xffff;
      bits += 8;
      while (bits >= 5) { bits -= 5; result.push((acc >>> bits) & 31); }
    }
    if (bits) result.push((acc << (5 - bits)) & 31);
    return result;
  };
  const expandHrp = (hrp) => [...hrp].map(c => c.charCodeAt(0) >>> 5).concat([0], [...hrp].map(c => c.charCodeAt(0) & 31));
  assert.equal(config.network, 'CKB Pudge Testnet');
  assert.equal(Object.hasOwn(config, 'privateKey'), false, 'Never commit Testnet private keys');
  assert.match(config.publicKeyCompressed, /^0x0[23][0-9a-f]{64}$/i);
  assert.match(config.lockScript.args, /^0x[0-9a-f]{40}$/i);
  assert.equal(config.lockScript.hash_type, 'type');
  assert.equal(config.lockScript.code_hash, '0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8');
  const raw = Buffer.concat([
    Buffer.from([0]),
    Buffer.from(config.lockScript.code_hash.slice(2), 'hex'),
    Buffer.from([1]),
    Buffer.from(config.lockScript.args.slice(2), 'hex'),
  ]);
  const words = convertBits(raw);
  const check = polymod([...expandHrp('ckt'), ...words, 0, 0, 0, 0, 0, 0]) ^ 0x2bc830a3;
  const suffix = Array.from({length: 6}, (_, i) => CHARS[(check >>> (5 * (5 - i))) & 31]).join('');
  assert.equal(config.address, `ckt1${words.map(x => CHARS[x]).join('')}${suffix}`);
});
