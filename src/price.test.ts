import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gatePriceUsdc, microToUsdc, usdcToMicro } from './price.js';

test('units to USDC with margin and floor', () => {
  assert.equal(gatePriceUsdc(30000n), '0.036000');
  assert.equal(gatePriceUsdc(90000n), '0.108000');
  assert.equal(gatePriceUsdc(1000n), '0.005000', 'a near-free door prices at the floor');
  assert.equal(gatePriceUsdc(1000n, { margin: 1, floorUsdc: '0' }), '0.001000');
  assert.equal(microToUsdc(usdcToMicro('0.036')), '0.036000');
  assert.throws(() => gatePriceUsdc(1n, { margin: 0.9, floorUsdc: '0' }), /below cost/);
});
