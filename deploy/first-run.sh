#!/usr/bin/env bash
# First run on the operator's box: keys, the connector config, ownership.
# Idempotent: existing keys are kept, the config is regenerated from doors.json.
#
#   cp deploy/.env.example .env && $EDITOR .env
#   bash deploy/first-run.sh
#   docker compose -f deploy/docker-compose.yml --env-file .env up -d
set -euo pipefail
cd "$(dirname "$0")/.."
[[ -f .env ]] || { echo "no .env: cp deploy/.env.example .env and edit it" >&2; exit 1; }
set -a; source .env; set +a
: "${PUBLIC_HOST:?set PUBLIC_HOST in .env}"
DOORS="${DOORS:-examples/colour-memory/doors.json}"
IMAGE="toon-checkout:local"

echo "== building the kit image"
docker build -q -t "$IMAGE" . >/dev/null

run() { docker run --rm -v "$PWD:/w" -w /w -e DOORS="$DOORS" "$IMAGE" "$@"; }

echo "== keys (kept if present)"
mkdir -p data secrets config
run keys --data /w/data --secrets /w/secrets

echo "== config/connector.toml from deploy/connector.head.toml + doors.json"
ADDR=$(run routes --addresses)
sed -e "s|__PUBLIC_HOST__|${PUBLIC_HOST}|g" -e "s|__ADDRESSES__|${ADDR}|" deploy/connector.head.toml > config/connector.toml
run routes --handler-host http://forwarder:3700 >> config/connector.toml
echo "wrote   config/connector.toml ($(grep -c '^\[\[routes\]\]' config/connector.toml) routes)"

echo "== ownership: the connector image runs as uid 10001 and mounts data/ read-only"
if command -v sudo >/dev/null && [[ "$(id -u)" != 0 ]]; then SUDO=sudo; else SUDO=; fi
$SUDO chown -R 10001:10001 data
$SUDO chmod 750 data && $SUDO chmod 640 data/*
chmod 700 secrets && chmod 600 secrets/*

echo
echo "Next:"
echo "  docker compose -f deploy/docker-compose.yml --env-file .env up -d"
echo "  curl -s https://${PUBLIC_HOST}/ilp | head -c 600      # the node answers for itself"
echo "  curl -s https://${GATE_HOST:-<GATE_HOST>}/v1/describe  # the doors and their USDC prices"
