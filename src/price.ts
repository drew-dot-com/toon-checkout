/**
 * What the x402 gate charges for a door whose route price is known. Pure:
 * base units in, a USDC decimal string out. Same shape as Lading's gate-price.ts.
 *
 * The gate pays the route price over ILP whatever the upstream answers, and
 * x402 settles only on a 2xx, so the margin covers the calls that fail after
 * the route was paid plus the facilitator's fee. The floor keeps a near-free
 * archive door from pricing under what a Base transfer is worth.
 */

/** 1 base unit on the routes = 1 micro-USDC. */
export const UNITS_PER_USDC = 1_000_000n;

export interface GatePricing {
  /** Multiplier on the route price, e.g. 1.2 for twenty percent over. */
  margin: number;
  /** Lowest price the door ever asks, USDC decimal string. */
  floorUsdc: string;
}

export const DEFAULT_PRICING: GatePricing = { margin: 1.2, floorUsdc: '0.005' };

/** Decimal USDC string to micro-units (six places, truncated). */
export function usdcToMicro(v: string): bigint {
  if (!/^\d+(\.\d+)?$/.test(v)) throw new Error(`not a USDC amount: ${v}`);
  const [i, f = ''] = v.split('.');
  return BigInt(i) * UNITS_PER_USDC + BigInt((f + '000000').slice(0, 6));
}

/** Micro-units to a six-place decimal string, the form x402 takes as a price. */
export function microToUsdc(m: bigint): string {
  const i = m / UNITS_PER_USDC;
  const f = (m % UNITS_PER_USDC).toString().padStart(6, '0');
  return `${i}.${f}`;
}

/** The door price for a route of `units` base units: units × margin, never under the floor, rounded up to the micro-unit. */
export function gatePriceMicro(units: bigint, pricing: GatePricing = DEFAULT_PRICING): bigint {
  if (units < 0n) throw new Error('negative price');
  const m = BigInt(Math.round(pricing.margin * 10_000));
  if (m < 10_000n) throw new Error('margin under 1.0 would sell below cost');
  const scaled = units * m;
  const withMargin = scaled / 10_000n + (scaled % 10_000n === 0n ? 0n : 1n);
  const floor = usdcToMicro(pricing.floorUsdc);
  return withMargin > floor ? withMargin : floor;
}

export const gatePriceUsdc = (units: bigint, pricing: GatePricing = DEFAULT_PRICING) => microToUsdc(gatePriceMicro(units, pricing));

export function pricingFromEnv(env: NodeJS.ProcessEnv = process.env): GatePricing {
  const margin = env.GATE_MARGIN ? Number(env.GATE_MARGIN) : DEFAULT_PRICING.margin;
  if (!Number.isFinite(margin) || margin < 1) throw new Error(`GATE_MARGIN must be a number >= 1, got ${env.GATE_MARGIN}`);
  const floorUsdc = env.GATE_FLOOR_USDC ?? DEFAULT_PRICING.floorUsdc;
  usdcToMicro(floorUsdc);
  return { margin, floorUsdc };
}
