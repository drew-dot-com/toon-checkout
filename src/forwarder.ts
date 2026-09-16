/**
 * The forwarder: what a connector route terminates at.
 *
 * The connector delivers a paid request here as ordinary HTTP (the opened
 * envelope's method, target, headers and body) plus three headers it states
 * itself: X-TOON-Payer, X-TOON-Amount, X-TOON-Chain. Those three are for the
 * log only. They are absent on a forwarded hop and on a free route, and an app
 * that reads them for authorisation is reading nothing (connector ADR 0040):
 * whatever reaches this process was paid at the route's one price, because
 * this port is reachable only from the connector.
 *
 * The forwarder adds the upstream API key, forwards the body and returns the
 * upstream's status and body. It carries exactly the doors in the manifest,
 * nothing else, so the connector can never be paid for a path the operator
 * did not price.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { type Manifest, findDoor } from './doors.js';
import { VERSION } from './version.js';

export interface ForwarderOptions {
  manifest: Manifest;
  port: number;
  /** The upstream credential; read from `manifest.auth.env` when not given. */
  apiKey?: string;
  maxBodyBytes?: number;
  upstreamTimeoutMs?: number;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

/** Headers the connector states; never forwarded, only logged. */
const TOON_HEADERS = ['x-toon-payer', 'x-toon-amount', 'x-toon-chain'] as const;

async function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > max) throw new Error(`body over ${max} bytes`);
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

function json(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

export function createForwarder(o: ForwarderOptions) {
  const m = o.manifest;
  const doFetch = o.fetch ?? fetch;
  const log = o.log ?? ((l: string) => console.log(`forwarder: ${l}`));
  const max = o.maxBodyBytes ?? 1024 * 1024;
  const timeout = o.upstreamTimeoutMs ?? 120_000;
  const apiKey = o.apiKey ?? (m.auth ? process.env[m.auth.env] : undefined);
  if (m.auth && !apiKey) throw new Error(`${m.auth.env} is not set: the forwarder has no upstream credential`);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://forwarder');
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true, app: 'toon-checkout-forwarder', version: VERSION, upstream: m.upstream, name: m.name, doors: m.doors.length });
    }
    const door = findDoor(m, req.method ?? '', url.pathname);
    if (!door) return json(res, 404, { error: 'no such door', method: req.method, path: url.pathname });

    const paid = Object.fromEntries(TOON_HEADERS.map((h) => [h.slice('x-toon-'.length), req.headers[h]]).filter(([, v]) => v !== undefined));
    const t0 = Date.now();
    let body: Buffer;
    try {
      body = await readBody(req, max);
    } catch (e) {
      return json(res, 413, { error: (e as Error).message });
    }

    const headers: Record<string, string> = { accept: 'application/json' };
    const ct = req.headers['content-type'];
    if (body.length > 0) headers['content-type'] = typeof ct === 'string' ? ct : 'application/json';
    if (m.auth && apiKey) headers[m.auth.header] = apiKey;

    const target = `${m.upstream}${door.path}${url.search}`;
    try {
      const r = await doFetch(target, {
        method: door.method,
        headers,
        body: body.length > 0 ? new Uint8Array(body) : undefined,
        signal: AbortSignal.timeout(timeout),
      });
      const out = Buffer.from(await r.arrayBuffer());
      res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'application/json', 'content-length': out.length });
      res.end(out);
      log(`${door.id} ${r.status} ${Date.now() - t0} ms ${body.length} B in ${out.length} B out${paid.payer ? ` paid ${paid.amount} by ${paid.payer} (${paid.chain})` : ''}`);
    } catch (e) {
      const msg = (e as Error).name === 'TimeoutError' ? `upstream did not answer in ${timeout} ms` : (e as Error).message;
      log(`${door.id} upstream error: ${msg}`);
      json(res, 502, { error: 'upstream unreachable', detail: msg });
    }
  });

  return {
    server,
    listen: () =>
      new Promise<number>((resolve) => {
        server.listen(o.port, '0.0.0.0', () => {
          const a = server.address();
          const port = typeof a === 'object' && a ? a.port : o.port;
          log(`toon-checkout forwarder ${VERSION} on :${port} -> ${m.upstream} (${m.doors.length} doors for ${m.name})`);
          resolve(port);
        });
      }),
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
