/**
 * The MCP shim: the manifest's doors as tools for Claude, over stdio.
 *
 * Claude's own MCP client cannot sign an x402 payment, so this small process
 * runs on the user's machine, holds their Base key (USDC only, no ETH needed)
 * and pays the hosted gate (gate.ts) once per paid tool call. It never talks
 * to a TOON connector; that is the gate's side of the door.
 *
 *   claude mcp add colour -e CHECKOUT_X402_KEY=0x… -- npx -y toon-checkout mcp --gate https://…
 *
 * Every paid call asks the gate's free quote first and refuses over
 * CHECKOUT_MAX_USDC_PER_CALL (default 0.25); the x402 client enforces the
 * same cap on the wire. Without a key the free tools still work.
 *
 * stdout belongs to the MCP transport; every log line here goes to stderr.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { x402Client, wrapFetchWithPayment } from '@x402/fetch';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, erc20Abi, formatUnits, http } from 'viem';
import { base } from 'viem/chains';
import { usdcToMicro } from './price.js';
import { shapeOf } from './schema.js';
import { type Door, type Manifest, validateManifest } from './doors.js';
import { VERSION } from './version.js';

/** USDC on Base mainnet, 6 decimals. */
export const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;

export interface McpOptions {
  gate: string;
  key?: string;
  keyFile?: string;
  autoKey?: boolean;
  maxUsdc: string;
  baseRpc?: string;
}

export function resolveKey(o: Pick<McpOptions, 'key' | 'keyFile' | 'autoKey'>, log: (...a: unknown[]) => void): { key?: `0x${string}`; from: string } {
  const given = o.key?.trim();
  if (given) {
    if (/^0x[0-9a-fA-F]{64}$/.test(given)) return { key: given as `0x${string}`, from: 'env' };
    log(`CHECKOUT_X402_KEY ignored: ${/^\$\{.*\}$/.test(given) ? 'the extension field was left empty' : 'not a 0x 32-byte hex key'}; using the key file`);
  }
  if (!o.keyFile) return { from: 'none' };
  if (existsSync(o.keyFile)) {
    const k = readFileSync(o.keyFile, 'utf8').trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(k)) throw new Error(`${o.keyFile} is not a 32-byte hex key`);
    return { key: k as `0x${string}`, from: o.keyFile };
  }
  if (!o.autoKey) return { from: 'none' };
  const k = generatePrivateKey();
  mkdirSync(dirname(o.keyFile), { recursive: true, mode: 0o700 });
  writeFileSync(o.keyFile, `${k}\n`, { mode: 0o600 });
  log(`generated a new payer key at ${o.keyFile} (address ${privateKeyToAccount(k).address}); fund it with USDC on Base`);
  return { key: k, from: `${o.keyFile} (new)` };
}

export const defaultKeyFile = () => join(process.env.CHECKOUT_HOME ?? join(homedir(), '.toon-checkout'), 'x402.key');

const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });
const fail = (msg: string) => ({ content: [{ type: 'text' as const, text: msg }], isError: true as const });

const decodeReceipt = (h: string): unknown => {
  try {
    return JSON.parse(Buffer.from(h, 'base64').toString('utf8'));
  } catch {
    return h;
  }
};

export async function runMcp(o: McpOptions) {
  const gate = o.gate.replace(/\/+$/, '');
  const maxMicro = usdcToMicro(o.maxUsdc);
  const log = (...a: unknown[]) => console.error('toon-checkout mcp:', ...a);

  let payFetch: typeof fetch | undefined;
  let payer: string | undefined;
  const resolved = resolveKey(o, log);
  if (resolved.key) {
    const signer = privateKeyToAccount(resolved.key);
    payer = signer.address;
    const client = new x402Client();
    registerExactEvmScheme(client, { signer });
    client.setSpendControls({ maxAmountPerPayment: o.maxUsdc });
    payFetch = wrapFetchWithPayment(fetch, client) as typeof fetch;
  }

  const chain = createPublicClient({ chain: base, transport: http(o.baseRpc ?? 'https://mainnet.base.org') });
  async function balance(): Promise<{ address: string; usdc: string } | undefined> {
    if (!payer) return undefined;
    const raw = await chain.readContract({ address: BASE_USDC, abi: erc20Abi, functionName: 'balanceOf', args: [payer as `0x${string}`] });
    return { address: payer, usdc: formatUnits(raw, 6) };
  }
  const fundingNote = (address: string) => `Send USDC on Base (chain id 8453, USDC contract ${BASE_USDC}) to ${address}. No ETH is needed: x402 payments use EIP-3009 and the facilitator pays gas. Do not send USDC on any other chain.`;

  async function getJson(path: string): Promise<unknown> {
    const r = await fetch(`${gate}${path}`);
    const body = (await r.json().catch(() => ({ error: `gate answered ${r.status} with no JSON` }))) as Record<string, unknown>;
    if (!r.ok) throw new Error(`gate ${r.status}: ${String(body.error ?? JSON.stringify(body))}`);
    return body;
  }

  // The tool list is the gate's manifest, read once at start, so the shim needs no copy of doors.json.
  const described = (await getJson('/v1/describe')) as { name: string; title: string; doors: Array<Door & { usdc: string; route: string }> };
  const manifest: Manifest = validateManifest({ name: described.name, title: described.title, upstream: 'https://gate', prefix: 'g.gate', doors: described.doors });
  const prefix = (process.env.CHECKOUT_TOOL_PREFIX ?? manifest.name).replace(/-/g, '_');

  async function guard(door: string): Promise<string> {
    const q = (await getJson(`/v1/quote?door=${encodeURIComponent(door)}`)) as { price?: { usdc?: string } };
    const usdc = q.price?.usdc;
    if (usdc === undefined) throw new Error('gate quote carried no price');
    if (usdcToMicro(usdc) > maxMicro) throw new Error(`${door} would cost ${usdc} USDC, over the ${o.maxUsdc} USDC cap (CHECKOUT_MAX_USDC_PER_CALL)`);
    return usdc;
  }

  async function paid(door: string, body: unknown): Promise<unknown> {
    if (!payFetch) throw new Error(`no CHECKOUT_X402_KEY: this shim can only call ${prefix}_wallet and ${prefix}_describe`);
    const usdc = await guard(door);
    const r = await payFetch(`${gate}/v1/call/${door}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
    const out = (await r.json().catch(() => ({ error: `gate answered ${r.status} with no JSON` }))) as Record<string, unknown>;
    if (r.status === 402) {
      const pr = decodeReceipt(r.headers.get('payment-required') ?? '') as { error?: string } | string;
      const why = typeof pr === 'object' && pr?.error ? pr.error : 'payment refused';
      throw new Error(`payment not accepted: ${why} (asked ${usdc} USDC on Base from ${payer}). ${payer ? fundingNote(payer) : ''}`);
    }
    if (!r.ok) throw new Error(`${door}: upstream answered ${r.status}: ${String(out.error ?? JSON.stringify(out)).slice(0, 400)}`);
    const receipt = r.headers.get('payment-response') ?? r.headers.get('x-payment-response');
    return { ...out, _toon: { route: r.headers.get('x-toon-route'), units: r.headers.get('x-toon-units'), doorUsdc: usdc, ...(receipt ? { x402: decodeReceipt(receipt) } : {}) } };
  }

  const server = new McpServer({ name: `toon-checkout:${manifest.name}`, version: VERSION });

  server.registerTool(
    `${prefix}_wallet`,
    {
      title: `${manifest.title} payer wallet`,
      description: 'Free. The address this shim pays the door from, its USDC balance on Base, where the key is kept, and how to fund it. Call this when a paid tool is refused for balance.',
      inputSchema: {},
    },
    async () => {
      try {
        if (!payer) return text({ payer: null, keyFrom: resolved.from, note: 'No payer key. Set CHECKOUT_X402_KEY, or point CHECKOUT_X402_KEY_FILE at a hex key.' });
        const b = (await balance().catch((e: Error) => ({ address: payer!, usdc: `unavailable (${e.message.slice(0, 60)})` }))) ?? { address: payer, usdc: 'unavailable' };
        return text({ payer: b.address, usdcOnBase: b.usdc, keyFrom: resolved.from, maxUsdcPerCall: o.maxUsdc, network: 'eip155:8453', usdcContract: BASE_USDC, fund: fundingNote(b.address) });
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    `${prefix}_describe`,
    {
      title: `Describe the ${manifest.title} checkout`,
      description: `Free. Every door the hosted ${manifest.title} checkout sells, its USDC price per call, the TOON route behind it, the x402 network and payTo, and this shim's payer and cap.`,
      inputSchema: {},
    },
    async () => {
      try {
        const d = await getJson('/v1/describe');
        const b = await balance().catch(() => undefined);
        return text({ ...(d as object), shim: { payer: payer ?? null, usdcOnBase: b?.usdc ?? null, keyFrom: resolved.from, maxUsdcPerCall: o.maxUsdc, paidToolsEnabled: !!payFetch } });
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  for (const d of described.doors) {
    const { shape } = shapeOf(d.input ?? undefined);
    server.registerTool(
      `${prefix}_${d.id}`,
      {
        title: d.title,
        description: `Paid: ${d.usdc} USDC per call on Base, quoted first and refused over the cap. ${d.description}${d.inputUnverified ? ' Note: the request fields for this door are not yet confirmed by the upstream operator; pass what its documentation asks for.' : ''}`,
        inputSchema: shape,
      },
      async (args: Record<string, unknown>) => {
        try {
          return text(await paid(d.id, args));
        } catch (e) {
          return fail((e as Error).message);
        }
      },
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`${manifest.name} ${VERSION} on stdio, gate ${gate}, ${described.doors.length} doors, payer ${payer ?? 'none'} (${resolved.from}), cap ${o.maxUsdc} USDC/call`);
}
