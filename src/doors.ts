/**
 * The manifest: every door this checkout sells, and the one upstream they open onto.
 *
 * One file drives four things, so they cannot drift from each other:
 *   - the connector's `[[routes]]` (routes.ts): one prefix, one handler URL, one price per door;
 *   - the forwarder (forwarder.ts): which method+path pairs it will carry upstream;
 *   - the x402 gate (gate.ts): the USDC price of each door for a caller without a channel;
 *   - the MCP shim (mcp.ts): one tool per door, with the door's input schema.
 *
 * `units` are the settlement token's base units, the same figure the connector's
 * `price` takes. On Base USDC (6 decimals) 1 unit = 1 micro-USDC.
 */
import { readFileSync } from 'node:fs';

export interface JsonSchema {
  type?: string;
  description?: string;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  additionalProperties?: boolean;
}

export interface Door {
  /** Stable id: a tool name segment and an ILP address segment, so `[a-z0-9_]` only. */
  id: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  /** The upstream path this door opens onto; also the forwarder's own path for it. */
  path: string;
  /** The connector's price for the route, base units. 0 is a deliberate free door. */
  units: number;
  title: string;
  description: string;
  /** JSON Schema for the request body (POST/PUT/PATCH) or the query (GET). */
  input?: JsonSchema;
  /** Set when the upstream's documented body for this door has not been confirmed by its operator. */
  inputUnverified?: boolean;
}

export interface Manifest {
  name: string;
  title: string;
  /** Prefix for MCP tool names; default `name` with `-` folded to `_`. */
  toolPrefix?: string;
  /** Upstream origin, no trailing slash. */
  upstream: string;
  /** How the forwarder authenticates upstream: the header it sets, and the env var holding the value. */
  auth?: { header: string; env: string };
  /** ILP address prefix every door hangs under: `${prefix}.${door.id}`. */
  prefix: string;
  doors: Door[];
}

const ID_RE = /^[a-z0-9_]+$/;
const PREFIX_RE = /^[a-zA-Z0-9_~-]+(\.[a-zA-Z0-9_~-]+)*$/;

export function validateManifest(m: unknown): Manifest {
  if (!m || typeof m !== 'object') throw new Error('manifest is not an object');
  const x = m as Manifest;
  for (const k of ['name', 'title', 'upstream', 'prefix'] as const) {
    if (typeof x[k] !== 'string' || !x[k]) throw new Error(`manifest.${k} must be a non-empty string`);
  }
  if (!/^https?:\/\/[^/]+$/.test(x.upstream)) throw new Error(`manifest.upstream must be an origin with no path, got ${x.upstream}`);
  if (!PREFIX_RE.test(x.prefix)) throw new Error(`manifest.prefix is not an ILP address prefix: ${x.prefix}`);
  if (x.auth && (typeof x.auth.header !== 'string' || typeof x.auth.env !== 'string')) throw new Error('manifest.auth needs header and env');
  if (!Array.isArray(x.doors) || x.doors.length === 0) throw new Error('manifest.doors must be a non-empty array');
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const d of x.doors) {
    if (!ID_RE.test(d.id)) throw new Error(`door id must match ${ID_RE}: ${d.id}`);
    if (ids.has(d.id)) throw new Error(`duplicate door id ${d.id}`);
    ids.add(d.id);
    if (!['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(d.method)) throw new Error(`door ${d.id}: bad method ${d.method}`);
    if (typeof d.path !== 'string' || !d.path.startsWith('/') || d.path.includes('..') || d.path.includes('?')) throw new Error(`door ${d.id}: path must be absolute, no query, no ..: ${d.path}`);
    const key = `${d.method} ${d.path}`;
    if (keys.has(key)) throw new Error(`two doors on ${key}: the connector refuses one handler at two prices`);
    keys.add(key);
    if (!Number.isInteger(d.units) || d.units < 0) throw new Error(`door ${d.id}: units must be a non-negative integer`);
    if (typeof d.title !== 'string' || typeof d.description !== 'string') throw new Error(`door ${d.id}: title and description required`);
  }
  return x;
}

export function loadManifest(path: string): Manifest {
  return validateManifest(JSON.parse(readFileSync(path, 'utf8')));
}

/** The ILP address a door is sold at. */
export const doorAddress = (m: Pick<Manifest, 'prefix'>, d: Pick<Door, 'id'>, prefix = m.prefix) => `${prefix}.${d.id}`;

/** The MCP tool name for a door. */
export const toolName = (m: Manifest, d: Door) => `${(m.toolPrefix ?? m.name).replace(/-/g, '_')}_${d.id}`;

export const findDoor = (m: Manifest, method: string, path: string) => m.doors.find((d) => d.method === method.toUpperCase() && d.path === path);
