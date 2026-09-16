import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadManifest, validateManifest, doorAddress, toolName, findDoor } from './doors.js';

test('the Colour Memory manifest loads and every door is priced', () => {
  const m = loadManifest('examples/colour-memory/doors.json');
  assert.equal(m.name, 'colour-memory');
  assert.equal(m.doors.length, 7);
  for (const d of m.doors) assert.ok(Number.isInteger(d.units));
  assert.equal(doorAddress(m, m.doors[0]), 'g.colourmemory.query_hex');
  assert.equal(doorAddress(m, m.doors[0], 'g.drew.colour'), 'g.drew.colour.query_hex');
  assert.equal(toolName(m, m.doors[0]), 'colour_query_hex');
  assert.equal(findDoor(m, 'post', '/query/hex')?.id, 'query_hex');
  assert.equal(findDoor(m, 'GET', '/query/hex'), undefined);
});

test('one handler at two prices is refused, and so is a bad prefix', () => {
  const base = { name: 'x', title: 'X', upstream: 'https://api.example', prefix: 'g.x' };
  assert.throws(() => validateManifest({ ...base, doors: [{ id: 'a', method: 'POST', path: '/p', units: 1, title: 't', description: 'd' }, { id: 'b', method: 'POST', path: '/p', units: 2, title: 't', description: 'd' }] }), /two doors on POST \/p/);
  assert.throws(() => validateManifest({ ...base, prefix: 'g..x', doors: [] }), /ILP address prefix/);
  assert.throws(() => validateManifest({ ...base, upstream: 'https://api.example/v1', doors: [] }), /origin with no path/);
  assert.throws(() => validateManifest({ ...base, doors: [{ id: 'Bad-Id', method: 'POST', path: '/p', units: 1, title: 't', description: 'd' }] }), /door id/);
});
