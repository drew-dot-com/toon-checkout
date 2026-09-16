import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redeem } from './redeem.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'redeem-'));
  writeFileSync(join(dir, 'bearer'), 'tok\n');
  writeFileSync(join(dir, 'write.key'), '7a'.repeat(32) + '\n');
  const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
  const claims = [
    { channel_id: 'evm:0xaaa', direction: 'inbound', cumulative_amount: '250000', nonce: 12 },
    { channel_id: 'evm:0xbbb', direction: 'inbound', cumulative_amount: '5000', nonce: 1 },
    { channel_id: 'evm:0xccc', direction: 'outbound', cumulative_amount: '900000', nonce: 3 },
  ];
  const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string> });
    if (u.endsWith('/claims')) return new Response(JSON.stringify(claims), { status: 200 });
    if (u.endsWith('/redeem-latest')) return new Response('{"tx":"0x1"}', { status: 200 });
    return new Response('nope', { status: 404 });
  }) as unknown as typeof fetch;
  return { dir, calls, fakeFetch };
}

test('a dry run reads claims and signs nothing', async () => {
  const { dir, calls, fakeFetch } = setup();
  const r = await redeem({ edge: 'http://edge/', bearerTokenFile: join(dir, 'bearer'), writeKeyFile: join(dir, 'write.key'), stateFile: join(dir, 'state.json'), execute: false, fetch: fakeFetch, log: () => {} });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.authorization, 'Bearer tok');
  assert.deepEqual(r.done, []);
  assert.deepEqual(r.skipped, ['evm:0xbbb'], 'under the threshold; the outbound claim is not ours to redeem');
});

test('armed, it signs redeem-latest for the channel that is due and remembers it', async () => {
  const { dir, calls, fakeFetch } = setup();
  const state = join(dir, 'state.json');
  const opts = { edge: 'http://edge', bearerTokenFile: join(dir, 'bearer'), writeKeyFile: join(dir, 'write.key'), stateFile: state, execute: true, fetch: fakeFetch, log: () => {} };
  const r = await redeem(opts);
  assert.deepEqual(r.done, ['evm:0xaaa 0.250000 USDC']);
  const w = calls.find((c) => c.method === 'POST')!;
  assert.equal(w.url, 'http://edge/channels/0xaaa/redeem-latest');
  assert.match(w.headers['Signature-Input'], /^sig1=\("@method" "@path" "content-digest"\);created=\d+;expires=\d+;keyid="[0-9a-f]{64}";alg="ed25519"$/);
  assert.match(w.headers.Signature, /^sig1=:[A-Za-z0-9+/=]+:$/);
  assert.equal(JSON.parse(readFileSync(state, 'utf8')).redeemed['evm:0xaaa'], '250000');

  const again = await redeem(opts);
  assert.deepEqual(again.done, [], 'nothing new to redeem on the second pass');
});
