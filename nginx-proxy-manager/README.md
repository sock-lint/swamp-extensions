# @lint/nginx-proxy-manager

A swamp model that wraps the [Nginx Proxy Manager](https://nginxproxymanager.com/)
admin API. NPM is a popular self-hosted reverse-proxy UI for homelab and small
production setups; this model gives you a programmatic snapshot of what it has
configured.

Single method, two resources:

- **`sync`** — logs in via `POST /api/tokens`, then in parallel fetches
  `/api/nginx/proxy-hosts`, `/api/nginx/redirection-hosts`, and
  `/api/nginx/certificates`. Emits `inventory` (full payload) and `summary`
  (counts + certs expiring soon).

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

## Resources

| Resource    | Lifetime | Description                                                  |
| ----------- | -------- | ------------------------------------------------------------ |
| `inventory` | infinite | Full snapshot: proxy hosts, redirection hosts, certificates. |
| `summary`   | infinite | Counts, expiring-cert flag, instance metadata.               |

## Compatibility

Tested against NPM v2.11.x running on Docker. Uses only documented
`/api/*` endpoints. Transport is `curl` via `Deno.Command`, so the same
baseUrl + email + password can be reproduced from a shell when debugging.

## License

MIT — see [LICENSE.txt](./LICENSE.txt).
