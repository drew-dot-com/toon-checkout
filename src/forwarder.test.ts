import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createForwarder } from './forwarder.js';
import { validateManifest } from './doors.js';

async function stubUpstream() {
  const seen: Array<{ method: string; url: string; headers: Record<string, string | string[] | undefined>; body: string }> = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
    if (req.url === '/paid') {
      res.writeHead(402, { 'content-type': 'application/json' });
      return res.end('{"error":"Insufficient Intelligence credits"}');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, echo: body ? JSON.parse(body) : null }));
  });
  const port = await new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as { port: number }).port)));
  return { seen, port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test('the forwarder adds the key, drops the TOON headers and returns the upstream answer', async () => {
  const up = await stubUpstream();
  const manifest = validateManifest({
    name: 't', title: 'T', upstream: `http://127.0.0.1:${up.port}`, prefix: 'g.t', auth: { header: 'X-Api-Key', env: 'T_KEY' },
    doors: [
      { id: 'hex', method: 'POST', path: '/query/hex', units: 1000, title: 'h', description: 'd' },
      { id: 'paid', method: 'POST', path: '/paid', units: 30000, title: 'p', description: 'd' },
    ],
  });
  const logs: string[] = [];
  const f = createForwarder({ manifest, port: 0, apiKey: 'cm_secret', log: (l) => logs.push(l) });
  const port = await f.listen();
  try {
    const r = await fetch(`http://127.0.0.1:${port}/query/hex`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-toon-payer': 'evm:0xabc', 'x-toon-amount': '1000', 'x-toon-chain': 'evm', authorization: 'Bearer leaked' }, body: '{"hex":"#D4A829"}' });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, echo: { hex: '#D4A829' } });
    const u = up.seen[0];
    assert.equal(u.headers['x-api-key'], 'cm_secret');
    assert.equal(u.headers['x-toon-payer'], undefined);
    assert.equal(u.headers.authorization, undefined);
    assert.equal(u.method, 'POST');
    assert.match(logs.at(-1)!, /hex 200 .* paid 1000 by evm:0xabc \(evm\)/);

    const p = await fetch(`http://127.0.0.1:${port}/paid`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(p.status, 402, 'an upstream refusal rides home unchanged');

    const missing = await fetch(`http://127.0.0.1:${port}/brief/forensic`, { method: 'POST', body: '{}' });
    assert.equal(missing.status, 404, 'a path not in the manifest is not a door');
    const wrongMethod = await fetch(`http://127.0.0.1:${port}/query/hex`);
    assert.equal(wrongMethod.status, 404);
    const h = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(((await h.json()) as { doors: number }).doors, 2);
  } finally {
    await f.close();
    await up.close();
  }
});

test('the forwarder refuses to start without its upstream credential', () => {
  const manifest = validateManifest({ name: 't', title: 'T', upstream: 'http://127.0.0.1:1', prefix: 'g.t', auth: { header: 'X-Api-Key', env: 'T_KEY_UNSET' }, doors: [{ id: 'a', method: 'POST', path: '/a', units: 1, title: 'a', description: 'd' }] });
  assert.throws(() => createForwarder({ manifest, port: 0 }), /T_KEY_UNSET is not set/);
});
