import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { shapeOf } from './schema.js';
import { loadManifest } from './doors.js';

test('a door input schema becomes a zod shape that accepts the documented body', () => {
  const m = loadManifest('examples/colour-memory/doors.json');
  const hex = z.object(shapeOf(m.doors.find((d) => d.id === 'query_hex')!.input).shape);
  assert.deepEqual(hex.parse({ hex: '#D4A829', n_results: 3 }), { hex: '#D4A829', n_results: 3 });
  assert.throws(() => hex.parse({ n_results: 3 }), /hex/);
  assert.throws(() => hex.parse({ hex: '#fff', n_results: 11 }));
  const matrix = z.object(shapeOf(m.doors.find((d) => d.id === 'accessibility_matrix')!.input).shape);
  assert.deepEqual(matrix.parse({ palette: ['#000', '#fff'] }), { palette: ['#000', '#fff'] });
  const open = shapeOf(m.doors.find((d) => d.id === 'brand_collision')!.input);
  assert.equal(open.additionalProperties, true);
});
