# @lint/adguard

A swamp model that wraps the [AdGuard Home](https://github.com/AdguardTeam/AdGuardHome)
control API. Exposes two methods against a running AdGuard Home instance:

- **`sync`** — fetches `status`, `stats`, filter lists, clients, and DNS rewrites
  in one pass; emits an `inventory` resource (everything) and a compact `summary`
  resource (block rate, list health, counts).
- **`reconcileRewrites`** — converges `/control/rewrite/list` to a desired set of
  `(domain, answer)` pairs. Adds missing entries; `prune=true` removes entries
  not in the desired list. Idempotent.

AdGuard Home has no API-key concept — auth is HTTP Basic against the admin UI
account, passed via `username` / `password` global args.

## Install

```bash
swamp extension pull @lint/adguard
```

## Create an instance

```bash
swamp model create @lint/adguard home \
  --global-arg baseUrl=http://192.168.4.5 \
  --global-arg username=admin \
  --global-arg password='replace-me' \
  --global-arg instanceLabel=homelab-dns
```

For production, store the password in a vault and resolve it via expression:

```bash
swamp model create @lint/adguard home \
  --global-arg baseUrl=http://192.168.4.5 \
  --global-arg username=admin \
  --global-arg "password={{ vault('adguard', 'password') }}" \
  --global-arg instanceLabel=homelab-dns
```

## Snapshot the instance

```bash
swamp model method run home sync
swamp data get summary --json | jq '.blockRatePct, .filterListsStale'
```

The `summary` resource is the cheap thing to read; `inventory` carries the full
payload when you need topQueriedDomains / per-filter detail.

## Reconcile rewrites

The reconcile method takes a `desired` array of `{ domain, answer }` pairs and
makes the live config match. By default it is **additive only** — it never
removes a rewrite you didn't list. Pass `prune: true` to remove drift.

```bash
swamp model method run home reconcileRewrites \
  --arg 'desired=[{"domain":"radarr.lab","answer":"192.168.4.50"}]' \
  --arg 'prune=false'
```

A common pattern is to wire this method downstream of a "build desired" model
via CEL, so a single source of truth (e.g. a list of reverse-proxy vhosts)
drives AdGuard rewrites without imperative scripting.

## Resources

| Resource           | Lifetime | Description                                                    |
| ------------------ | -------- | -------------------------------------------------------------- |
| `inventory`        | infinite | Full snapshot: status, stats, filter lists, clients, rewrites. |
| `summary`          | infinite | Compact roll-up suitable for dashboards and Discord embeds.    |
| `reconcile_result` | infinite | Diff (added/removed/kept/skipped) from the last reconcile.     |

## Compatibility

Tested against AdGuard Home v0.107.x. Uses only documented `/control/*`
endpoints. Transport is `curl` via `Deno.Command`, so the same baseUrl +
credentials can be reproduced from a shell when debugging.

## License

MIT — see [LICENSE.txt](./LICENSE.txt).
