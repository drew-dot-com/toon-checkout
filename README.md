# toon-checkout

A per-call USDC checkout in front of any HTTP API, on TOON. You keep your API
exactly as it is. A connector sits in front of it, prices each endpoint, and is
paid off-chain per call; the USDC lands on a key you hold and is redeemed on
chain in batches.

Status: v0.1.0, built for Colour Memory as the first API behind it. The
Colour Memory manifest is in `examples/colour-memory/doors.json`; the kit
itself knows nothing about colour.

## What you get

One file, `doors.json`, lists the endpoints you sell (a door: method, path, a
price in base units, a title and an input schema). From it the kit derives:

| piece | what it is | who runs it |
| --- | --- | --- |
| `[[routes]]` | one priced connector route per door, `toon-checkout routes` | you, once, into the connector's TOML |
| forwarder | 100 lines of Node: receives the paid request from the connector, adds your API key, forwards to your API, returns the answer. Carries only the doors in the manifest. | you, next to the connector |
| gate | an x402 door in front of the connector, so a caller with a Base USDC key and no channel pays per call; the gate pays the connector over ILP with its own channel | you, or any operator fronting your node |
| MCP shim | one tool per door for Claude, paying the gate per call from the user's own key | the caller, on their machine |
| `keys` and `redeem` | first-run key generation; a scheduled redeem of the claims the node holds | you |

A caller with a TOON channel pays the connector directly: `POST` to the door's
ILP address with a covering claim, and the forwarder never sees a wallet. A
caller without one pays the gate in USDC on Base per call.

## Honest framing

This is a per-call checkout you own, not traffic. It works with zero other
network activity: one connector, one direct route per door, no hops. Callers
still need a wallet, either a TOON channel or a Base USDC key at the gate; an
agent inside a chat app with no wallet cannot pay, whatever the rail. Peers
routing strangers to your doors is a second story, and needs peers.

Every call is paid at the route's one price whatever your API answers. The
connector delivers, the app's answer rides home, and a 402 from your API is a
paid 402 (connector ADR 0020 and 0051). The gate hides that from x402 callers
by settling only on a 2xx, and carries the route price for a failed call,
which is what its margin is for.

## Run it in front of your API

You need a box with Docker, a hostname that resolves to it (sslip.io works on
day one), and about 0.001 ETH on Base for the first redeem. You fund nothing to
be paid.

```bash
git clone https://github.com/drew-dot-com/toon-checkout && cd toon-checkout
cp examples/colour-memory/doors.json doors.json     # edit: your upstream, your doors, your prices
cp deploy/.env.example .env                          # edit: hosts, API key, payTo
bash deploy/first-run.sh                             # keys, config/connector.toml, ownership
docker compose -f deploy/docker-compose.yml --env-file .env up -d
```

`first-run.sh` prints two addresses. The **payee** is the settlement key's Base
address: USDC redeemed from claims lands there. The **gate payer** is the gate's
own key: it opens one channel with your connector and pays every x402 caller's
door over ILP, so give it a couple of USDC and a little ETH. Both are files
under `data/` and `secrets/` that never leave the box; `secrets/` is never
mounted into the connector.

Then:

```bash
curl -s https://$PUBLIC_HOST/ilp | jq .            # the node's self-description: routes, prices, settlement
curl -s https://$GATE_HOST/v1/describe | jq .       # the doors and their USDC prices
```

Prices are base units of the settlement token. On Base USDC that is
micro-USDC: `30000` is 0.03 USDC. `price = 0` is a deliberate free door.

### Getting paid

A claim's value is off-chain until redeemed, and nothing on a connector moves
on chain by itself. The `redeem` container walks the node's claims once a day
(`REDEEM_EVERY_HOURS`), and for every inbound channel with at least
`REDEEM_MIN_UNITS` unredeemed signs `POST /channels/:id/redeem-latest` with the
operator write key. It is a dry run until `REDEEM_EXECUTE=1`. Each redeem is
one Base transaction paid by the settlement key. Until then an unmoved on-chain
balance is normal, not a broken door.

## Call it from Claude

```bash
claude mcp add colour -e CHECKOUT_X402_KEY=0x… -- npx -y toon-checkout mcp --gate https://pay.example
```

Without a key the shim generates one at `~/.toon-checkout/x402.key` on first
run; ask for `colour_wallet` and fund the address with USDC on Base (no ETH
needed). The tool list is read from the gate, one tool per door, plus
`colour_wallet` and `colour_describe`. Every paid tool asks the gate's free
quote first and refuses over `CHECKOUT_MAX_USDC_PER_CALL` (default 0.25).

## Call it from a TOON client

```ts
import { ToonClient } from '@toon-protocol/client';
const c = await ToonClient.create({ connector: 'https://api.example', evmPrivateKey, chain: 'evm', rpcUrl, channelStore: './channel.json' });
const r = await c.send('g.colourmemory.query_hex', { body: { hex: '#D4A829' } });
if (r.fulfilled) console.log(r.status, r.json());
```

The first `send` opens a channel with the connector (default deposit 0.1 USDC,
set `deposit`); every later call is one signed claim, no chain round trip.

## The manifest

```jsonc
{
  "name": "colour-memory",            // tool prefix and service name
  "upstream": "https://api.colourmemory.com",
  "auth": { "header": "X-Api-Key", "env": "UPSTREAM_API_KEY" },
  "prefix": "g.colourmemory",         // ILP address prefix; door address = prefix.id
  "doors": [
    { "id": "query_hex", "method": "POST", "path": "/query/hex", "units": 1000,
      "title": "…", "description": "…", "input": { /* JSON Schema for the body */ } }
  ]
}
```

Rules the connector enforces and the loader checks first: one price per
handler path (two doors on one path are refused), a price on every door,
absolute paths with no query, ids in `[a-z0-9_]`.

## Proof on a laptop

`bash deploy/local-e2e/run.sh` runs the pinned connector image with two doors
priced at zero, the forwarder, a stub upstream and the real client, and prints
what the upstream saw: the API key, no TOON headers, the body intact, and an
upstream 402 riding home as a paid 402. No chain is touched.

## Layout

```
src/doors.ts      the manifest: load, validate, addresses, tool names
src/forwarder.ts  the app behind the routes
src/gate.ts       the x402 door; pays the connector with @toon-protocol/client
src/mcp.ts        the shim for Claude (stdio)
src/routes.ts     [[routes]] TOML from the manifest
src/keys.ts       first-run keys, the payee address, the operator write keyid
src/redeem.ts     redeem-latest over every inbound claim, RFC 9421 signed
src/rfc9421.ts    the operator write signature, held to the connector's sign-write.sh
deploy/           compose, Caddyfile, connector.head.toml, first-run.sh
deploy/drew-node/ the same kit as a demo on Drew's mainnet node
```

MIT. Built by Drew Pierson, the first third-party TOON operator, on top of the
Lading gate and shim.
