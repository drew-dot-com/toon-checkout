# Demo on Drew's node

Same kit, other operator: the existing edge connector sells the seven Colour
Memory doors under `g.drew.colour.*`, the forwarder holds a Colour Memory dev
key, and the gate at `colour.167-233-221-236.sslip.io` takes USDC on Base.

Order of operations on the box (`ssh -i ~/.ssh/toon_node root@167.233.221.236`):

1. `rsync` this repo to `/opt/toon-relay/colour` (`--exclude .env`, never `--delete`).
2. `cp deploy/drew-node/.env.example deploy/drew-node/.env` and fill in the dev key, payTo and the gate keypair.
3. Regenerate `routes.toml` if `doors.json` changed:
   `docker run --rm -v $PWD:/w -w /w toon-checkout:local routes --prefix g.drew.colour --handler-host http://colour-forwarder:3700 > deploy/drew-node/routes.toml`
4. Back up the edge TOML (`connector-rust.toml.bak-<date>-precolour`), append `routes.toml`, and add the seven addresses to `[node] addresses`.
5. `docker compose -p colour -f deploy/drew-node/docker-compose.yml --env-file deploy/drew-node/.env up -d --build`
6. Append `Caddyfile.colour` to the node's Caddyfile and reload Caddy.
7. Recreate the edge: `docker compose -f docker-compose.yml -f docker-compose.caddy.yml -f docker-compose.rust.yml -f docker-compose.storexl.yml -f docker-compose.connstore.yml up -d --force-recreate --no-deps connector-rust`
8. Prove: `GET /ilp/routes/price?destination=g.drew.colour.query_hex` answers 1000; `GET https://colour.167-233-221-236.sslip.io/v1/describe` lists the doors; one paid `colour_query_hex` from Claude through the shim; the edge's claim nonce moves.
