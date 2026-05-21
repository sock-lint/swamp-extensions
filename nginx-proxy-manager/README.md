# @lint/nginx-proxy-manager

A swamp model that wraps the [Nginx Proxy Manager](https://nginxproxymanager.com/)
admin API. NPM is a popular self-hosted reverse-proxy UI for homelab and small
production setups; this model gives you a programmatic snapshot of what it has
configured.

Three methods:

- **`sync`** — logs in via `POST /api/tokens`, then in parallel fetches
  `/api/nginx/proxy-hosts`, `/api/nginx/redirection-hosts`, and
  `/api/nginx/certificates`. Emits `inventory` (full payload) and `summary`
  (counts + certs expiring soon).
- **`upsertProxyHost`** — declarative proxy-host management: matches existing
  hosts by exact set of `domainNames`. If a host with that set exists,
  `PUT`s the new config to its id; otherwise `POST`s a new host. Idempotent.
- **`deleteProxyHost`** — `DELETE /api/nginx/proxy-hosts/{id}`. Non-throwing
  on HTTP error so the outcome (404 vs 200) lands in `delete_result`.

Auth is email + password against the NPM admin UI account. The bearer token
returned by `/api/tokens` is used only for the duration of the `sync` call —
nothing is persisted to disk.

## Install

```bash
swamp extension pull @lint/nginx-proxy-manager
```

## Create an instance

```bash
swamp model create @lint/nginx-proxy-manager edge \
  --global-arg baseUrl=http://192.168.4.60:81 \
  --global-arg email=admin@example.com \
  --global-arg "password={{ vault('npm', 'password') }}" \
  --global-arg instanceLabel=homelab-edge
```

`baseUrl` should include the admin port (NPM defaults to 81 on docker).

## Snapshot the instance

```bash
swamp model method run edge sync
swamp data get summary --json | jq '.proxyHostCount, .certsExpiringWithin30d'
```

The `summary` resource is the cheap thing for dashboards; `inventory` carries
the full proxy-host config including per-host upstream + cert binding when you
need to drive downstream models (e.g. wiring DNS rewrites off the NPM vhost
list).

## Upsert a proxy host

The headline declarative method — point a domain at an upstream and let the
extension figure out whether to `POST` (new) or `PUT` (update existing):

```bash
swamp model method run edge upsertProxyHost \
  --arg 'domainNames=["radarr.home"]' \
  --arg forwardScheme=http \
  --arg forwardHost=192.168.4.50 \
  --arg forwardPort=7878
```

The match key is the **exact set** of `domainNames`. If a host with
`["radarr.home"]` already exists, this `PUT`s the new fields to its id;
otherwise it `POST`s a new host. Run the same call twice and the second
run is a no-op update (NPM stores defaults silently).

Common production-ish form with SSL forced + HTTP/2 + a specific cert:

```bash
swamp model method run edge upsertProxyHost \
  --arg 'domainNames=["radarr.home", "www.radarr.home"]' \
  --arg forwardScheme=https \
  --arg forwardHost=192.168.4.50 \
  --arg forwardPort=7878 \
  --arg certificateId=4 \
  --arg sslForced=true \
  --arg http2Support=true \
  --arg hstsEnabled=true
```

Look up `certificateId` from `inventory.certificates`. Defaults match NPM's
"sensible" UI defaults (`block_exploits=true`, `allow_websocket_upgrade=true`).

The result lands in `upsert_result`:

```bash
swamp data get upsert_result --json | jq '{domainNames, action, proxyHostId}'
# {"domainNames":["radarr.home"],"action":"created","proxyHostId":42}
```

## Delete a proxy host

Look up the id from `inventory.proxyHosts` first, then:

```bash
swamp data get inventory --json \
  | jq '.attributes.proxyHosts[] | select(.domainNames[] | . == "stale.home") | .id'

swamp model method run edge deleteProxyHost --arg id=42

swamp data get delete_result --json | jq '{proxyHostId, ok, httpStatus}'
```

Non-throwing — a 404 (already deleted) records the outcome rather than
crashing a batched cleanup.

## Resources

| Resource        | Lifetime | Description                                                                  |
| --------------- | -------- | ---------------------------------------------------------------------------- |
| `inventory`     | infinite | Full snapshot: proxy hosts, redirection hosts, certificates.                 |
| `summary`       | infinite | Counts, expiring-cert flag, instance metadata.                               |
| `upsert_result` | infinite | Last `upsertProxyHost` outcome: domain set, action (created/updated), id.    |
| `delete_result` | infinite | Last `deleteProxyHost` outcome: proxyHostId, HTTP status, response body.     |

## Compatibility

Tested against NPM v2.11.x running on Docker. Uses only documented
`/api/*` endpoints. Transport is `curl` via `Deno.Command`, so the same
baseUrl + email + password can be reproduced from a shell when debugging.

## License

MIT — see [LICENSE.txt](./LICENSE.txt).
