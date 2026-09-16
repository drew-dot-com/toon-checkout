// A stub of the upstream API: echoes what it saw so the test can check the key arrived and nothing else did.
import { createServer } from 'node:http';
createServer(async (req, res) => {
  let body = ''; for await (const c of req) body += c;
  const seen = { method: req.method, url: req.url, apiKey: req.headers['x-api-key'] ?? null, toon: Object.keys(req.headers).filter(h => h.startsWith('x-toon')), body: body ? JSON.parse(body) : null };
  if (req.url === '/paid') { res.writeHead(402, {'content-type':'application/json'}); return res.end(JSON.stringify({ error: 'Insufficient Intelligence credits', seen })); }
  res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify({ name: 'Ra Gold Divine Flesh', seen }));
}).listen(3900, '0.0.0.0', () => console.log('upstream stub on :3900'));
