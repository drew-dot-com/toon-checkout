#!/usr/bin/env node
/**
 * toon-checkout <command>
 *
 *   forwarder                       serve the manifest's doors for the connector (default in the image)
 *   gate                            serve the x402 checkout in front of the connector
 *   mcp --gate URL                  the MCP shim for Claude (stdio)
 *   routes [--handler-host H] [--prefix P]   print the connector's [[routes]] for the manifest
 *   keys [--data DIR] [--secrets DIR]        generate a node's keys and print the payee address
 *   redeem [--execute]              redeem every inbound claim on chain (dry run by default)
 *
 * The manifest is DOORS (default examples/colour-memory/doors.json).
 */
import { resolve } from 'node:path';
import { loadManifest } from './doors.js';
import { VERSION } from './version.js';

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string) => args.includes(`--${name}`);
const DOORS = flag('doors') ?? process.env.DOORS ?? 'examples/colour-memory/doors.json';

async function main() {
  switch (cmd) {
    case 'forwarder': {
      const { createForwarder } = await import('./forwarder.js');
      const f = createForwarder({ manifest: loadManifest(DOORS), port: Number(process.env.PORT ?? 3700), maxBodyBytes: Number(process.env.MAX_BODY_BYTES ?? 1024 * 1024) });
      await f.listen();
      return;
    }
    case 'gate': {
      const { startGate, fileEnv } = await import('./gate.js');
      const env = { ...process.env, DOORS, EVM_PRIVATE_KEY: fileEnv(process.env, 'EVM_PRIVATE_KEY'), SOLANA_KEYPAIR_JSON: fileEnv(process.env, 'SOLANA_KEYPAIR_JSON') };
      startGate(env);
      return;
    }
    case 'mcp': {
      const { runMcp, defaultKeyFile } = await import('./mcp.js');
      const gate = flag('gate') ?? process.env.CHECKOUT_GATE;
      if (!gate) throw new Error('mcp needs --gate URL (or CHECKOUT_GATE)');
      await runMcp({
        gate,
        key: process.env.CHECKOUT_X402_KEY,
        keyFile: process.env.CHECKOUT_X402_KEY_FILE ?? defaultKeyFile(),
        autoKey: process.env.CHECKOUT_X402_AUTOKEY !== '0',
        maxUsdc: process.env.CHECKOUT_MAX_USDC_PER_CALL ?? '0.25',
        baseRpc: process.env.BASE_RPC,
      });
      return;
    }
    case 'routes': {
      const { routesToml, addressesToml } = await import('./routes.js');
      const m = loadManifest(DOORS);
      const prefix = flag('prefix');
      if (has('addresses')) process.stdout.write(addressesToml(m, prefix) + '\n');
      else process.stdout.write(routesToml(m, { handlerHost: flag('handler-host') ?? 'http://forwarder:3700', prefix }));
      return;
    }
    case 'keys': {
      const { generateKeys } = await import('./keys.js');
      const k = generateKeys(resolve(flag('data') ?? 'data'), resolve(flag('secrets') ?? 'secrets'));
      for (const p of k.written) console.log(`wrote   ${p}`);
      for (const p of k.skipped) console.log(`kept    ${p} (already there, not touched)`);
      console.log('');
      console.log(`payee (settlement key, Base):   ${k.settlementAddress}`);
      console.log(`gate payer (Base):              ${k.gatePayerAddress}`);
      console.log(`operator write keyid (public):  ${k.operatorKeyid}`);
      console.log('');
      console.log('USDC redeemed from claims lands on the payee. Give it a little ETH on Base before the first redeem (about 0.0005 ETH covers many).');
      console.log('The gate payer opens one channel with this node and pays x402 callers\' doors over ILP: fund it with a couple of USDC and a little ETH.');
      console.log('secrets/ never goes on the node: operator-write.key signs redeems, gate-payer.key pays; data/operator-write-keys holds only the public half.');
      return;
    }
    case 'redeem': {
      const { redeem } = await import('./redeem.js');
      const r = await redeem({
        edge: flag('edge') ?? process.env.TOON_EDGE ?? 'http://connector:4000',
        bearerTokenFile: flag('bearer-file') ?? process.env.OPERATOR_BEARER_FILE ?? '/app/data/operator-bearer-token',
        writeKeyFile: flag('write-key-file') ?? process.env.OPERATOR_WRITE_KEY_FILE ?? '/app/secrets/operator-write.key',
        stateFile: flag('state') ?? process.env.REDEEM_STATE ?? '/data/redeem-state.json',
        minUnits: BigInt(flag('min-units') ?? process.env.REDEEM_MIN_UNITS ?? '10000'),
        execute: has('execute') || process.env.REDEEM_EXECUTE === '1',
      });
      console.log(`redeemed: ${r.done.length ? r.done.join(', ') : 'nothing'}; below threshold: ${r.skipped.length}`);
      return;
    }
    case 'version':
      console.log(VERSION);
      return;
    default:
      console.error(`toon-checkout ${VERSION}\nusage: toon-checkout forwarder | gate | mcp --gate URL | routes [--handler-host H] [--prefix P] [--addresses] | keys [--data DIR] [--secrets DIR] | redeem [--execute]`);
      process.exit(cmd ? 2 : 0);
  }
}

main().catch((e) => {
  console.error(`toon-checkout: ${(e as Error).message}`);
  process.exit(1);
});
