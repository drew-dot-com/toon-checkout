# Colour Memory on TOON: a per-call checkout you own

This folder is the worked example you asked for, built against Colour Memory
rather than another API. It puts a paid door in front of
`api.colourmemory.com`, one per endpoint, each with its own price, paid per
call in USDC. You change nothing on your side.

## What it does

A small connector sits in front of your API. Each endpoint you sell is a
"door" with a price. A caller pays the door, the connector forwards the
request to your API with your key, and the answer comes back. Payment is a
signed claim, off-chain, one per call; the USDC is redeemed on chain in
batches to a key only you hold. Nobody but you can move it.

Two kinds of caller can pay:

- an agent with a TOON channel pays the connector directly, one claim per call;
- anyone with a USDC balance on Base pays an x402 door in front of the
  connector, per call, no channel. Claude pays this way through a small shim
  (one tool per door).

## Your seven doors

Taken from your docs page, archive and Intelligence already split by path.
Prices are placeholders in micro-USDC; you set them.

| door | path | price |
| --- | --- | --- |
| query_hex | `POST /query/hex` | 0.001 USDC |
| query_conceptual | `POST /query/conceptual` | 0.001 USDC |
| archive_search | `POST /archive/search` | 0.001 USDC |
| accessibility_matrix | `POST /accessibility/matrix` | 0.001 USDC |
| brand_collision | `POST /brand/collision-check` | 0.03 USDC (1 credit) |
| ecommerce_copy | `POST /ecommerce/product-copy` | 0.03 USDC (1 credit) |
| brief_forensic | `POST /brief/forensic` | 0.09 USDC (3 credits) |

The whole definition is [`doors.json`](doors.json). Adding a door is adding a
line; the routes, the forwarder, the checkout and the Claude tools all follow
from that one file.

## What we would like to do

Stand this up on our mainnet node this week, pointed at your API with a
developer key, so you can call your own API from Claude through the door and
watch the meter settle in USDC. Then our call is a demo rather than a
whiteboard. Once you have seen it run, the same kit runs on your own box
(`deploy/` in this repo, a compose file and a first-run script that
generates your keys and prints the address the USDC lands on).

To do that we need:

1. **A developer key**, and your OK to point our node at your API with it.
   The demo traffic is a handful of calls a day at most, nothing automated.
2. **The request bodies** for `/brand/collision-check`,
   `/ecommerce/product-copy` and `/brief/forensic`. Your docs list the fields
   for the archive endpoints but not those three, so the Claude tools for them
   currently accept any object.

## What it is not

Honest framing, because you asked good questions on the thread:

- It is a checkout you own, not new traffic. It works with no other network
  activity at all: one connector, a direct route per door.
- Callers still need a wallet, either a Base USDC key or a TOON channel. Your
  Smithery users inside a chat app mostly cannot pay today, on any rail.
- A call is paid at the door's price whatever your API answers. The x402 door
  hides that from its callers by settling only on a 2xx.
- Nothing on the connector moves on chain by itself. A scheduled redeem turns
  the claims into USDC on your key; until then the on-chain balance sits still.

## Already proven

- The delivery path runs on a laptop with no money: the pinned connector
  image, the forwarder, a stub of your API and the real client.
  `bash deploy/local-e2e/run.sh` prints what the stub saw: your key arrived,
  the body arrived intact, and a 402 from the stub came home as a paid 402.
- The x402 door quotes and refuses unpaid calls with proper terms (USDC on
  Base, chain id 8453).
- The write signature that redeems claims matches the connector's own
  signing script byte for byte.

## Answers to your questions from the thread

- Per-route pricing: yes, one price per door, set in `doors.json`.
- Changes on your side: none. The forwarder adds your API key.
- Who receives: you. The settlement key is generated on your box by
  `first-run.sh` and never leaves it.
- Failure: fail closed. A door not in the manifest is not served.
- Redeem: on a schedule you choose, dry run until you arm it.

The main [README](../../README.md) covers the kit itself: layout, the
manifest format, running it in front of any API, calling it from Claude or
from a TOON client.
