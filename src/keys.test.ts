import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeys } from './keys.js';
import { keyidOf, readSeed } from './rfc9421.js';

test('first run writes every key once, prints the payee, and a second run keeps them all', () => {
  const root = mkdtempSync(join(tmpdir(), 'keys-'));
  const data = join(root, 'data');
  const secrets = join(root, 'secrets');
  const k = generateKeys(data, secrets);
  assert.equal(k.written.length, 6);
  assert.match(k.settlementAddress, /^0x[0-9a-fA-F]{40}$/);
  assert.match(k.gatePayerAddress, /^0x[0-9a-fA-F]{40}$/);
  assert.notEqual(k.settlementAddress, k.gatePayerAddress);
  assert.match(k.operatorKeyid, /^[0-9a-f]{64}$/);
  assert.equal(readFileSync(join(data, 'operator-write-keys'), 'utf8').trim(), k.operatorKeyid);
  assert.equal(keyidOf(readSeed(join(secrets, 'operator-write.key'))), k.operatorKeyid, 'the public half on the node matches the private half off it');
  assert.equal(statSync(join(data, 'signer.key')).mode & 0o777, 0o600);
  assert.match(readFileSync(join(data, 'signer.key'), 'utf8'), /^[0-9a-f]{64}\n$/);

  const again = generateKeys(data, secrets);
  assert.equal(again.written.length, 0);
  assert.equal(again.skipped.length, 6);
  assert.equal(again.settlementAddress, k.settlementAddress);
  assert.equal(again.gatePayerAddress, k.gatePayerAddress);
  assert.equal(again.operatorKeyid, k.operatorKeyid);
});
