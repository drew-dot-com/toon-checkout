/**
 * First run: every key a node needs, generated on the operator's own box, and
 * the addresses printed. The operator is the payee and funds nothing to be
 * paid; the settlement key needs a little ETH on Base only for redeeming
 * claims on chain, and that can wait until there is something to redeem.
 *
 * Files (connector README, "Keys"):
 *   data/signer.key             the node's one identity key (hex, 32 bytes)
 *   data/settlement.key         the EVM key claims redeem to; its address is where USDC lands
 *   data/operator-bearer-token  read authority on the operator surface
 *   data/operator-write-keys    the PUBLIC half of the write key (hex), one per line
 *   secrets/operator-write.key  the PRIVATE write key: signs redeems; never mounted into the node
 *   secrets/gate-payer.key      the gate's TOON payer on Base (0x hex); the gate alone mounts it
 *
 * Nothing here is ever overwritten. The image runs as uid 10001 and mounts
 * data/ read-only, so the operator chowns the files after (first-run.sh does).
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { keyidOf } from './rfc9421.js';

export interface KeySet {
  signerKey: string;
  settlementAddress: string;
  operatorKeyid: string;
  /** The gate's own TOON payer on Base: opens one channel with this node and pays x402 callers' doors over ILP. */
  gatePayerAddress: string;
  written: string[];
  skipped: string[];
}

function put(path: string, content: string, out: KeySet, mode = 0o600) {
  if (existsSync(path)) {
    out.skipped.push(path);
    return false;
  }
  writeFileSync(path, content, { mode });
  out.written.push(path);
  return true;
}

export function generateKeys(dataDir: string, secretsDir: string): KeySet {
  mkdirSync(dataDir, { recursive: true, mode: 0o750 });
  mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  const out: KeySet = { signerKey: join(dataDir, 'signer.key'), settlementAddress: '', operatorKeyid: '', gatePayerAddress: '', written: [], skipped: [] };

  put(join(dataDir, 'signer.key'), randomBytes(32).toString('hex') + '\n', out);

  const settlementPath = join(dataDir, 'settlement.key');
  const settlementHex = existsSync(settlementPath) ? require_hex(settlementPath) : randomBytes(32).toString('hex');
  put(settlementPath, settlementHex + '\n', out);
  out.settlementAddress = privateKeyToAccount(`0x${settlementHex}`).address;

  put(join(dataDir, 'operator-bearer-token'), randomBytes(32).toString('hex') + '\n', out);

  const writeKeyPath = join(secretsDir, 'operator-write.key');
  const writeHex = existsSync(writeKeyPath) ? require_hex(writeKeyPath) : randomBytes(32).toString('hex');
  put(writeKeyPath, writeHex + '\n', out);
  out.operatorKeyid = keyidOf(Buffer.from(writeHex, 'hex'));
  put(join(dataDir, 'operator-write-keys'), out.operatorKeyid + '\n', out, 0o640);

  const gatePath = join(secretsDir, 'gate-payer.key');
  const gateHex = existsSync(gatePath) ? require_hex(gatePath) : randomBytes(32).toString('hex');
  put(gatePath, `0x${gateHex}\n`, out);
  out.gatePayerAddress = privateKeyToAccount(`0x${gateHex}`).address;
  return out;
}

function require_hex(path: string): string {
  const hex = readFileSync(path, 'utf8').replace(/\s+/g, '').replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error(`${path} is not a 64-hex key`);
  return hex.toLowerCase();
}
