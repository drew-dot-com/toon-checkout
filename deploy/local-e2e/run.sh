#!/usr/bin/env bash
# The delivery path, proven on a laptop with no money: the pinned connector
# image with the manifest's two doors priced at ZERO (no claim, no channel),
# the forwarder holding a stub API key, a stub upstream that echoes what it
# saw, and the real @toon-protocol/client sending the same raw HTTP envelope
# the gate sends. Proven 2026-09-16: the upstream saw the key and no X-TOON
# headers, the body arrived intact, and an upstream 402 rode home as a
# FULFILL carrying 402 (a paid refusal, connector ADR 0051).
#
#   bash deploy/local-e2e/run.sh
set -euo pipefail
cd "$(dirname "$0")"
[[ -d ../../node_modules ]] || (cd ../.. && npm ci)
docker image inspect toon-checkout:local >/dev/null 2>&1 || (cd ../.. && docker build -t toon-checkout:local .)
mkdir -p data && [[ -f data/signer.key ]] || openssl rand -hex 32 > data/signer.key
[[ -f data/settlement.key ]] || openssl rand -hex 32 > data/settlement.key
chmod 644 data/*.key
ln -sfn ../../node_modules node_modules
docker compose up -d
trap 'docker compose down -v >/dev/null' EXIT
for i in $(seq 1 90); do curl -sf http://127.0.0.1:4400/ilp 2>/dev/null | grep -q settlements && break; sleep 1; done
echo "== GET /ilp"; curl -s http://127.0.0.1:4400/ilp; echo
echo "== send"; STORE="$PWD/store.json" node send.mjs
rm -f store.json
