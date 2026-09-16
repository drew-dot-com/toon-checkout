/**
 * An operator write signature (connector ADR 0008): RFC 9421 over exactly
 * `@method`, `@path` and `content-digest`, ed25519, keyid = the public key in
 * hex. A port of the connector's shipped `docs/operators/sign-write.sh`, which
 * is itself held to `crates/connector-operator/src/rfc9421.rs`. Node's crypto
 * signs ed25519 natively, so no openssl and no bash.
 */
import { createHash, createPrivateKey, createPublicKey, sign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** The fixed DER shell every Ed25519 PKCS8 key wears; the 32-byte seed follows it. */
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** A key file as the connector reads it: exactly 32 raw bytes, or 64 hex characters (whitespace ignored). */
export function readSeed(path: string): Buffer {
  const raw = readFileSync(path);
  if (raw.length === 32) return raw;
  const hex = raw.toString('utf8').replace(/\s+/g, '');
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error(`${path} must be 32 raw bytes or 64 hex characters, found ${raw.length} bytes`);
  return Buffer.from(hex, 'hex');
}

export function ed25519FromSeed(seed: Uint8Array): { priv: KeyObject; keyid: string } {
  if (seed.length !== 32) throw new Error('seed must be 32 bytes');
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, Buffer.from(seed)]), format: 'der', type: 'pkcs8' });
  const spki = createPublicKey(priv).export({ format: 'der', type: 'spki' }) as Buffer;
  return { priv, keyid: spki.subarray(spki.length - 32).toString('hex') };
}

/** The public half of an operator write key, hex: what goes on the node's `write_keys`. Same value `connector send --print-keyid` prints. */
export const keyidOf = (seed: Uint8Array) => ed25519FromSeed(seed).keyid;

export interface SignedWrite {
  'Signature-Input': string;
  Signature: string;
  'Content-Digest': string;
}

export function signWrite(seed: Uint8Array, method: string, path: string, body = '', expiresInS = 60, now = Math.floor(Date.now() / 1000)): SignedWrite {
  if (path.includes('?')) throw new Error('path must carry no query: the covered component is @path');
  const { priv, keyid } = ed25519FromSeed(seed);
  const digest = `sha-256=:${createHash('sha256').update(body).digest('base64')}:`;
  const created = now;
  const expires = created + expiresInS;
  const m = method.toUpperCase();
  const params = `("@method" "@path" "content-digest");created=${created};expires=${expires};keyid="${keyid}";alg="ed25519"`;
  const base = `"@method": ${m}\n"@path": ${path}\n"content-digest": ${digest}\n"@signature-params": ${params}`;
  const sig = sign(null, Buffer.from(base), priv).toString('base64');
  return { 'Signature-Input': `sig1=${params}`, Signature: `sig1=:${sig}:`, 'Content-Digest': digest };
}
