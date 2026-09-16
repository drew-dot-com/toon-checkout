/**
 * The gate: every door in the manifest behind an x402 checkout, for a caller
 * that does not hold a TOON channel (Claude through the MCP shim, or any HTTP
 * client with a Base USDC key). The gate pays the connector over ILP with its
 * own channel, one paid packet per call, and hands the upstream's answer back.
 * x402 is the ingress at the boundary with something that does not speak ILP;
 * TOON is the inside.
 *
 *   GET  /health
 *   GET  /v1/describe        the doors, their prices in USDC and units, payTo, the payer's channel; free
 *   GET  /v1/quote?door=id   one door's price; free
 *   POST /v1/call/:id        JSON body = the upstream request body; x402 priced per door
 *
 * x402 settles only after this process answers 2xx, so a call the upstream
 * refuses (a 402 for credits, a 502) costs the caller nothing; the gate ate
 * the route price, which is what the margin is for.
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { decodePaymentSignatureHeader } from '@x402/core/http';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { ToonClient } from '@toon-protocol/client';
import { type Door, type Manifest, doorAddress, loadManifest } from './doors.js';
import { gatePriceUsdc, microToUsdc, pricingFromEnv } from './price.js';
import { VERSION } from './version.js';

const log = (...a: unknown[]) => console.log('gate:', ...a);

export interface GateEnv {
  DOORS?: string;
  PORT?: string;
  TOON_EDGE?: string;
  /** Override the manifest prefix when the doors hang under another node's address space (the demo on Drew's node). */
  ROUTE_PREFIX?: string;
  GATE_URL?: string;
  PAY_TO?: string;
  X402_FACILITATOR?: string;
  X402_NETWORK?: string;
  GATE_FREE?: string;
  GATE_HOME?: string;
  /** The gate's TOON payer: an EVM key paying on Base, or a Solana keypair (JSON array) when the edge settles there. */
  EVM_PRIVATE_KEY?: string;
  SOLANA_KEYPAIR_JSON?: string;
  BASE_RPC?: string;
  SOLANA_RPC?: string;
  CHANNEL_DEPOSIT?: string;
  MAX_BODY_BYTES?: string;
  /** Per-packet timeout for the ILP call; an Intelligence call runs an LLM upstream. */
  CALL_TIMEOUT_MS?: string;
}

export function startGate(env: GateEnv = process.env as GateEnv) {
  const m: Manifest = loadManifest(env.DOORS ?? 'examples/colour-memory/doors.json');
  const PORT = Number(env.PORT ?? 3701);
  const MAX_BODY = Number(env.MAX_BODY_BYTES ?? 256 * 1024);
  const FREE = env.GATE_FREE === '1';
  const NETWORK = (env.X402_NETWORK ?? 'eip155:8453') as `${string}:${string}`;
  const FACILITATOR = env.X402_FACILITATOR ?? 'https://facilitator.payai.network';
  const EDGE = env.TOON_EDGE ?? 'http://connector:4000';
  const PREFIX = env.ROUTE_PREFIX ?? m.prefix;
  const HOME = env.GATE_HOME ?? '/data/gate';
  const PUBLIC_URL = env.GATE_URL ?? `http://127.0.0.1:${PORT}`;
  const pricing = pricingFromEnv(env as NodeJS.ProcessEnv);
  const PAY_TO = env.PAY_TO ?? (env.EVM_PRIVATE_KEY ? privateKeyToAccount(env.EVM_PRIVATE_KEY as `0x${string}`).address : undefined);
  if (!FREE && !PAY_TO) throw new Error('PAY_TO is not set: where does the x402 revenue land?');

  const priceOf = (d: Door) => gatePriceUsdc(BigInt(d.units), pricing);
  const doorRow = (d: Door) => ({
    id: d.id,
    title: d.title,
    description: d.description,
    method: d.method,
    route: doorAddress(m, d, PREFIX),
    units: d.units,
    usdc: FREE ? '0' : priceOf(d),
    call: `POST ${PUBLIC_URL}/v1/call/${d.id}`,
    input: d.input ?? null,
    ...(d.inputUnverified ? { inputUnverified: true } : {}),
  });

  /** One ToonClient, opened on first use. Which chain it pays on is which key it was given. */
  let client: Promise<ToonClient> | undefined;
  function payer(): Promise<ToonClient> {
    if (!client) {
      mkdirSync(HOME, { recursive: true });
      const common = { connector: EDGE, transport: 'http' as const, channelStore: join(HOME, 'channel-store.json'), autoOpenChannel: true, deposit: BigInt(env.CHANNEL_DEPOSIT ?? '2000000'), timeoutMs: Number(env.CALL_TIMEOUT_MS ?? 180_000) };
      if (env.SOLANA_KEYPAIR_JSON) {
        client = ToonClient.create({
          ...common,
          chain: 'solana',
          rpcUrl: env.SOLANA_RPC ?? 'https://api.mainnet-beta.solana.com',
          solanaSecretKey: Uint8Array.from(JSON.parse(env.SOLANA_KEYPAIR_JSON) as number[]),
          evmPrivateKey: ('0x' + randomBytes(32).toString('hex')) as `0x${string}`,
        });
      } else if (env.EVM_PRIVATE_KEY) {
        client = ToonClient.create({ ...common, chain: 'evm', rpcUrl: env.BASE_RPC ?? 'https://base-rpc.publicnode.com', evmPrivateKey: env.EVM_PRIVATE_KEY });
      } else {
        throw new Error('no TOON payer: set EVM_PRIVATE_KEY (Base) or SOLANA_KEYPAIR_JSON');
      }
    }
    return client;
  }

  function x402PayerOf(req: Request): string | undefined {
    const h = req.get('payment-signature') ?? req.get('x-payment');
    if (!h) return undefined;
    try {
      const p = decodePaymentSignatureHeader(h) as { payload?: { authorization?: { from?: unknown }; from?: unknown } };
      const from = p.payload?.authorization?.from ?? p.payload?.from;
      return typeof from === 'string' ? from : undefined;
    } catch {
      return undefined;
    }
  }

  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    if (req.method !== 'GET') return next();
    res.set('Access-Control-Allow-Origin', '*');
    return next();
  });

  if (!FREE) {
    const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR });
    const server = new x402ResourceServer(facilitator).register(NETWORK, new ExactEvmScheme());
    const routes = Object.fromEntries(
      m.doors.map((d) => [
        `POST /v1/call/${d.id}`,
        {
          accepts: { scheme: 'exact', network: NETWORK, payTo: PAY_TO!, maxTimeoutSeconds: 300, price: priceOf(d) },
          description: `${m.title}: ${d.title}. ${d.description}`,
          mimeType: 'application/json',
          serviceName: m.name,
        },
      ]),
    );
    app.use(paymentMiddleware(routes, server));
  }

  app.get('/health', (_req, res) => {
    res.json({ ok: true, app: 'toon-checkout-gate', version: VERSION, name: m.name, free: FREE, edge: EDGE, network: NETWORK, payTo: PAY_TO ?? null, facilitator: FREE ? null : FACILITATOR, doors: m.doors.length });
  });

  app.get('/v1/describe', async (_req, res) => {
    let channel: unknown = null;
    if (client) {
      try {
        const c = await client;
        const s = await (c as unknown as { channel: { state(): Promise<{ channelId: string; spent: bigint; nonce: number; depositTotal: bigint; status: string } | undefined> } }).channel.state();
        if (s) channel = { channelId: s.channelId, status: s.status, deposit: microToUsdc(s.depositTotal), spent: microToUsdc(s.spent), nonce: s.nonce };
      } catch (e) {
        channel = { error: (e as Error).message };
      }
    }
    res.json({
      app: 'toon-checkout-gate',
      version: VERSION,
      name: m.name,
      title: m.title,
      what: `${m.title} behind a per-call checkout on TOON. Pay this door with USDC on Base over x402; the gate pays the connector over ILP and returns the upstream answer. Prices are per door.`,
      door: { url: PUBLIC_URL, network: NETWORK, payTo: PAY_TO ?? null, facilitator: FREE ? null : FACILITATOR, free: FREE, margin: pricing.margin, floorUsdc: pricing.floorUsdc, maxBodyBytes: MAX_BODY },
      edge: EDGE,
      prefix: PREFIX,
      channel,
      doors: m.doors.map(doorRow),
    });
  });

  app.get('/v1/quote', (req, res) => {
    const d = m.doors.find((x) => x.id === req.query.door);
    if (!d) return res.status(404).json({ error: 'no such door', doors: m.doors.map((x) => x.id) });
    return res.json({ door: d.id, route: doorAddress(m, d, PREFIX), units: d.units, price: { usdc: FREE ? '0' : priceOf(d), network: NETWORK, payTo: PAY_TO ?? null } });
  });

  app.post('/v1/call/:id', express.raw({ type: () => true, limit: MAX_BODY }), async (req, res, next) => {
    try {
      const d = m.doors.find((x) => x.id === req.params.id);
      if (!d) return res.status(404).json({ error: 'no such door', doors: m.doors.map((x) => x.id) });
      const body = Buffer.isBuffer(req.body) ? (req.body as Buffer) : Buffer.alloc(0);
      if (body.length > 0) {
        try {
          JSON.parse(body.toString('utf8'));
        } catch {
          return res.status(400).json({ error: 'body must be JSON' });
        }
      }
      const route = doorAddress(m, d, PREFIX);
      const t0 = Date.now();
      const c = await payer();
      const r = await c.send(route, { method: d.method, target: '', headers: body.length ? { 'content-type': 'application/json' } : {}, body: body.length ? new Uint8Array(body) : undefined });
      const ms = Date.now() - t0;
      if (!r.fulfilled) {
        log(`${d.id} refused ${r.code} by ${r.refusedBy} in ${ms} ms: ${r.message}`);
        return res.status(502).json({ error: 'the connector refused the packet', code: r.code, refusedBy: r.refusedBy, message: r.message, route });
      }
      const paidUnits = r.claim ? String((r.claim as { amount?: bigint }).amount ?? d.units) : '0';
      const x402Payer = x402PayerOf(req);
      log(`${d.id} ${r.status} ${ms} ms route ${route} paid ${paidUnits} units${x402Payer ? ` door paid by ${x402Payer}` : ''}`);
      res.set('x-toon-route', route);
      res.set('x-toon-units', paidUnits);
      res.status(r.status);
      const ct = r.headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? 'application/json';
      res.set('content-type', ct);
      return res.send(Buffer.from(r.body));
    } catch (e) {
      return next(e);
    }
  });

  app.use((_req, res) => res.status(404).json({ error: 'no such door' }));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const msg = (err as Error).message ?? String(err);
    log('error:', msg);
    if (!res.headersSent) res.status(500).json({ error: msg });
  });

  app.listen(PORT, '0.0.0.0', () => {
    log(`toon-checkout gate ${VERSION} on :${PORT} for ${m.name} (${m.doors.length} doors)${FREE ? ' FREE (no x402)' : ` x402 ${NETWORK} payTo=${PAY_TO} facilitator=${FACILITATOR}`} edge=${EDGE} prefix=${PREFIX} margin=${pricing.margin} floor=${pricing.floorUsdc}`);
  });
  return app;
}

/** Read a key from a file when the env names one, so a compose file never carries a value. */
export function fileEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const file = env[`${name}_FILE`];
  if (file) return readFileSync(file, 'utf8').trim();
  return env[name];
}
