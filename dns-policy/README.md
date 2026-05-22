# @lint/dns-policy

A swamp model that compiles a single source-of-truth list of DNS rewrites from
three inputs:

1. **Manual vhosts** — bare names you declare in `vhosts` global arg, expanded
   to `<name>.<proxySuffix>` and pointed at `proxyTargetIp`.
2. **Auto-discovered vhosts** — fully-qualified hostnames passed in as
   `discoveredVhosts` (e.g. domains from
   [`@lint/nginx-proxy-manager.sync`](https://github.com/sock-lint/swamp-extensions/tree/main/nginx-proxy-manager)),
   also pointed at `proxyTargetIp`.
3. **Static rewrites** — hand-listed `(domain, answer)` pairs for cases the
   proxy pattern doesn't cover (infra hosts, wildcards, off-proxy targets).

The deduped result is emitted as the `desired_rewrites` resource — feed it to
[`@lint/adguard.reconcileRewrites`](https://github.com/sock-lint/swamp-extensions/tree/main/adguard)
(or any compatible internal-DNS reconciler) to converge AdGuard to it.

A second resource, `desired_public_records`, lists the subset of vhosts that
should also be reachable externally — for a public-DNS reconciler (e.g.
Cloudflare).

## Install

```bash
swamp extension pull @lint/dns-policy
```

## Create an instance

```bash
swamp model create @lint/dns-policy dns-policy \
  --global-arg instanceLabel=homelab \
  --global-arg proxyTargetIp=192.168.4.60 \
  --global-arg proxySuffix=bos.lol \
  --global-arg-file vhosts.yaml
```

…where `vhosts.yaml` is something like:

```yaml
vhosts:
  - sonarr
  - radarr
  - portainer
staticRewrites:
  - domain: nas.bos.lol
    answer: 192.168.4.10
  - domain: pve.bos.lol
    answer: 192.168.4.2
publicVhosts:
  - sonarr
  - radarr
```

`swamp model method run` accepts `--input` for scalars but object/array values
need to come from a file (`--input-file`). The bundled workflow demonstrates
inline CEL inputs.

## Methods

### `build`

Compose vhosts + discovered + statics into a deduped desired list. Idempotent.

```bash
swamp model method run dns-policy build --input-file inputs.yaml
```

```yaml
# inputs.yaml — optional; build runs fine with discoveredVhosts: []
discoveredVhosts:
  - sonarr.bos.lol
  - radarr.bos.lol
```

Emits two resources:

- `desired_rewrites` — `{ entries: [{ domain, answer }, ...], vhostCount,
  discoveredVhostCount, staticCount, duplicateCount, builtAt }`. Feed
  `entries` to `@lint/adguard.reconcileRewrites`.
- `desired_public_records` — `{ hostnames: ["sonarr.bos.lol", ...], builtAt }`.
  Feed `hostnames` to whatever public-DNS reconciler you run.

## Wire it: the `dns-rewrite-sync` workflow

This package ships an example workflow that chains NPM → dns-policy → AdGuard
(and optionally Cloudflare):

```bash
swamp workflow run dns-rewrite-sync
```

The workflow assumes you've created model instances with these names:

| Instance name | Type                              | Purpose                                  |
|---------------|-----------------------------------|------------------------------------------|
| `npm`         | `@lint/nginx-proxy-manager`       | Source of auto-discovered proxy hosts    |
| `dns-policy`  | `@lint/dns-policy`                | This model                               |
| `adguard`     | `@lint/adguard`                   | Internal-DNS reconciler                  |
| `cloudflare`  | (any with a `reconcile` method)   | Optional public-DNS reconciler           |

If you named your instances differently, edit the `modelIdOrName` values in
`dns-rewrite-sync/workflow.yaml` after pulling. The cloudflare step is marked
`allowFailure: true` so it won't block the others if you don't have one.

### Discovered-vhost filter

The workflow's CEL filter only forwards NPM domains ending in `.bos.lol` —
edit the `.endsWith(".bos.lol")` predicate in the `dns-policy-build` step to
match your own suffix, or remove the filter to forward every enabled NPM host.

## Global args

| Field            | Type            | Notes                                                            |
|------------------|-----------------|------------------------------------------------------------------|
| `instanceLabel`  | string          | Human label, e.g. `homelab`                                      |
| `proxyTargetIp`  | string          | Reverse proxy IP — every vhost resolves here                     |
| `proxySuffix`    | string          | Vhost domain suffix, e.g. `bos.lol`                              |
| `vhosts`         | string[]        | Bare vhost names, expanded to `<name>.<proxySuffix>`             |
| `staticRewrites` | `{domain, answer}[]` (default `[]`) | Hand-listed escape hatch                  |
| `publicVhosts`   | string[] (default `[]`) | Subset of `vhosts` to expose externally                  |

## Why use this

Without dns-policy, you keep a spreadsheet of "what should resolve where" in
your head and hand-poke AdGuard. With it, the spreadsheet is global args,
versioned in your repo, and the reconciler keeps AdGuard converged. Adding a
new proxy host in NPM auto-flows to AdGuard on the next workflow run.
