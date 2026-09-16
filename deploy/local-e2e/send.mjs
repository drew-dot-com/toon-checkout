// Pay (for free) one door through the local connector with the real client, the way the gate does.
import { ToonClient } from '@toon-protocol/client';
const c = await ToonClient.create({ connector: 'http://127.0.0.1:4400', evmPrivateKey: '0x' + 'ab'.repeat(32), chain: 'evm', rpcUrl: 'https://base-rpc.publicnode.com', transport: 'http', autoOpenChannel: false, channelStore: process.env.STORE });
for (const [dest, body] of [['g.test.query_hex', { hex: '#D4A829' }], ['g.test.paid', {}]]) {
  const r = await c.send(dest, { method: 'POST', target: '', headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify(body)) });
  if (!r.fulfilled) { console.log(dest, 'REFUSED', r.code, r.refusedBy, r.message); continue; }
  console.log(dest, 'status', r.status, 'claim', r.claim ?? 'none (free route)'); console.log(' ', r.text());
}
