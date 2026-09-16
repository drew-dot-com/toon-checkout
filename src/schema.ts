/** The subset of JSON Schema a manifest door uses, as a Zod raw shape for the MCP SDK. */
import { z, type ZodTypeAny } from 'zod';
import type { JsonSchema } from './doors.js';

function one(s: JsonSchema): ZodTypeAny {
  let t: ZodTypeAny;
  if (s.enum) t = z.enum(s.enum as [string, ...string[]]);
  else if (s.type === 'string') t = z.string();
  else if (s.type === 'integer') {
    let n = z.number().int();
    if (s.minimum !== undefined) n = n.min(s.minimum);
    if (s.maximum !== undefined) n = n.max(s.maximum);
    t = n;
  } else if (s.type === 'number') {
    let n = z.number();
    if (s.minimum !== undefined) n = n.min(s.minimum);
    if (s.maximum !== undefined) n = n.max(s.maximum);
    t = n;
  } else if (s.type === 'boolean') t = z.boolean();
  else if (s.type === 'array') t = z.array(s.items ? one(s.items) : z.unknown());
  else if (s.type === 'object') t = shapeOf(s).additionalProperties ? z.object(shapeOf(s).shape).passthrough() : z.object(shapeOf(s).shape);
  else t = z.unknown();
  return s.description ? t.describe(s.description) : t;
}

export function shapeOf(s: JsonSchema | undefined): { shape: Record<string, ZodTypeAny>; additionalProperties: boolean } {
  const shape: Record<string, ZodTypeAny> = {};
  const req = new Set(s?.required ?? []);
  for (const [k, v] of Object.entries(s?.properties ?? {})) {
    const t = one(v);
    shape[k] = req.has(k) ? t : t.optional();
  }
  return { shape, additionalProperties: s?.additionalProperties === true };
}
