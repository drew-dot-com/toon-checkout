/**
 * Redeem: turn the claims the node holds into USDC on the settlement key.
 *
 * A claim's value is off-chain until redeemed: the connector banks claims as
 * they arrive and nothing moves on chain by itself. This walks `GET /claims`
 * on the operator surface (bearer read), and for every inbound claim whose
 * cumulative amount is above what was last redeemed, signs
 * `POST /channels/:id/redeem-latest` with the operator write key (RFC 9421).
 * Dry run unless `execute` is set. A state file remembers what was redeemed,
 * because there is no cheap on-chain read of the TokenNetwork watermark.
 *
 * Gas: a redeem is one Base transaction paid by the settlement key, so it
 * needs a little ETH there (about 0.0005 ETH covers many). Redeem on a
 * schedule, not per claim: the chain sees batches, the mesh sees every call.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { readSeed, signWrite } from './rfc9421.js';
import { microToUsdc } from './price.js';

export interface RedeemOptions {
  /** The connector's client edge, where the operator surface is mounted, e.g. `http://connector:4000`. */
  edge: string;
  bearerTokenFile: string;
  writeKeyFile: string;
  stateFile: string;
  /** Redeem only when the unredeemed amount is at least this many base units. Default 10000 (0.01 USDC). */
  minUnits?: bigint;
  execute: boolean;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

interface Claim {
  channel_id: string;
  direction: 'inbound' | 'outbound';
  cumulative_amount: string;
  nonce: number;
}

interface State {
  redeemed: Record<string, string>;
}

const loadState = (p: string): State => (existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as State) : { redeemed: {} });

export async function redeem(o: RedeemOptions) {
  const doFetch = o.fetch ?? fetch;
  const log = o.log ?? ((l: string) => console.log(`redeem: ${l}`));
  const edge = o.edge.replace(/\/+$/, '');
  const bearer = readFileSync(o.bearerTokenFile, 'utf8').trim();
  const seed = readSeed(o.writeKeyFile);
  const min = o.minUnits ?? 10_000n;
  const state = loadState(o.stateFile);
  const done: string[] = [];
  const skipped: string[] = [];

  const r = await doFetch(`${edge}/claims`, { headers: { authorization: `Bearer ${bearer}` } });
  if (!r.ok) throw new Error(`GET /claims answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const claims = (await r.json()) as Claim[];
  log(`${claims.length} claims on the operator surface (${o.execute ? 'ARMED' : 'dry run'})`);

  for (const c of claims) {
    if (c.direction !== 'inbound') continue;
    const id = c.channel_id.replace(/^(evm|solana):/, '');
    const claimed = BigInt(c.cumulative_amount);
    const redeemed = BigInt(state.redeemed[c.channel_id] ?? '0');
    const due = claimed > redeemed ? claimed - redeemed : 0n;
    log(`${c.channel_id}: claimed ${microToUsdc(claimed)} (nonce ${c.nonce}), redeemed ${microToUsdc(redeemed)}, due ${microToUsdc(due)}`);
    if (due < min) {
      skipped.push(c.channel_id);
      continue;
    }
    if (!o.execute) continue;
    const path = `/channels/${id}/redeem-latest`;
    const headers = signWrite(seed, 'POST', path, '', 120);
    const w = await doFetch(`${edge}${path}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' } });
    const text = (await w.text()).slice(0, 300);
    if (!w.ok) {
      log(`redeem-latest on ${id} answered ${w.status}: ${text}`);
      continue;
    }
    log(`redeem-latest on ${id}: ${text}`);
    state.redeemed[c.channel_id] = claimed.toString();
    done.push(`${c.channel_id} ${microToUsdc(due)} USDC`);
    writeFileSync(o.stateFile, JSON.stringify(state, null, 2) + '\n');
  }
  return { done, skipped };
}
