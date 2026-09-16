import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ed25519FromSeed, keyidOf, readSeed, signWrite } from './rfc9421.js';

const seed = Buffer.from('9f'.repeat(32), 'hex');

test('the signature verifies against the keyid and covers exactly method, path and digest', () => {
  const h = signWrite(seed, 'post', '/channels/abc/redeem-latest', '', 60, 1_700_000_000);
  assert.match(h['Signature-Input'], /^sig1=\("@method" "@path" "content-digest"\);created=1700000000;expires=1700000060;keyid="[0-9a-f]{64}";alg="ed25519"$/);
  const digest = `sha-256=:${createHash('sha256').update('').digest('base64')}:`;
  assert.equal(h['Content-Digest'], digest);
  const params = h['Signature-Input'].slice('sig1='.length);
  const base = `"@method": POST\n"@path": /channels/abc/redeem-latest\n"content-digest": ${digest}\n"@signature-params": ${params}`;
  const sig = Buffer.from(h.Signature.slice('sig1=:'.length, -1), 'base64');
  const { priv } = ed25519FromSeed(seed);
  assert.ok(verify(null, Buffer.from(base), createPublicKey(priv), sig));
  assert.throws(() => signWrite(seed, 'POST', '/x?y=1'), /no query/);
});

test('keyid matches the connector\'s shipped sign-write.sh when openssl is present', () => {
  const script = join(process.env.HOME ?? '', 'src/TOON/upstream/connector/docs/operators/sign-write.sh');
  if (!existsSync(script)) return;
  const dir = mkdtempSync(join(tmpdir(), 'rfc9421-'));
  const keyFile = join(dir, 'k.key');
  writeFileSync(keyFile, seed.toString('hex') + '\n');
  const out = execFileSync('bash', [script, '-k', keyFile, '-X', 'POST', '-p', '/peers', '-b', '{"a":1}'], { encoding: 'utf8' });
  const keyid = out.match(/keyid="([0-9a-f]{64})"/)?.[1];
  assert.equal(keyid, keyidOf(readSeed(keyFile)));
  const digest = out.match(/^Content-Digest: (.*)$/m)?.[1];
  assert.equal(digest, signWrite(seed, 'POST', '/peers', '{"a":1}')['Content-Digest']);
});
