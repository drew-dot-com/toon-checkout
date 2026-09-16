import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadManifest } from './doors.js';
import { addressesToml, routesToml } from './routes.js';

test('routes TOML has one priced door per manifest door, beneath the handler host', () => {
  const m = loadManifest('examples/colour-memory/doors.json');
  const t = routesToml(m, { handlerHost: 'http://forwarder:3700/' });
  assert.equal((t.match(/^\[\[routes\]\]$/gm) ?? []).length, m.doors.length);
  assert.match(t, /prefix = "g\.colourmemory\.brand_collision"\nhandler_url = "http:\/\/forwarder:3700\/brand\/collision-check"\nprice = 30000/);
  const demo = routesToml(m, { handlerHost: 'http://colour-forwarder:3700', prefix: 'g.drew.colour' });
  assert.match(demo, /prefix = "g\.drew\.colour\.query_hex"/);
  assert.match(addressesToml(m), /^addresses = \["g\.colourmemory\.query_hex", /);
});
