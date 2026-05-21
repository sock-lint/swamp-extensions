# @lint/image-updater

Auto-applies the image updates discovered by `@lint/image-updates`, with
safety rails: cooling-period gate, deny list, per-run cap, and compose-only
mode.

This is the **write** half of the image update pair. `image-updates` discovers
what could be updated; `image-updater` actually pulls and restarts. Splitting
them lets you `apply: false` for inspection and graduate to `apply: true`
later once you trust the policy.

Single method:

- **`apply`** — read the latest `image-updates.inventory`, filter to
  containers in compose stacks (skipping standalone), skip anything matching
  the deny list, skip anything where the same image was last updated within
  `coolingDays`, take up to `maxPerRun` candidates, then for each: ssh to the
  PVE node, `pct exec <vmid> -- docker compose pull && docker compose up -d`
  for the relevant compose project. Emits an `update_log` resource with full
  per-container outcome.

## Install

```bash
swamp extension pull @lint/image-updater
```

You'll also want `@lint/image-updates` (to produce the inventory input) and
`@lint/docker-host` (transitively, the discovery layer).

## Create an instance

```bash
swamp model create @lint/image-updater apply \
  --global-arg "imageUpdates={{ data.latest('@lint/image-updates', 'inventory') }}" \
  --global-arg apply=false \
  --global-arg coolingDays=3 \
  --global-arg maxPerRun=5 \
  --global-arg "denyList=$(jq -nc '
    [
      "postgres", "mariadb", "mysql",
      "authentik-server", "authentik-worker",
      "plex/", "linuxserver/plex",
      "nginx", "jc21/nginx-proxy-manager",
      "crowdsec"
    ]')" \
  --global-arg instanceLabel=homelab
```

Set `apply: false` to dry-run the policy (writes the log without touching
anything). Flip to `true` once the log looks right.

## What's in the deny list by default

Databases, auth servers, media servers, reverse proxies, and security
tooling — categories where surprise updates can break things. Override
`denyList` with your own set; **the default is intentionally aggressive**.

## Cooling period

`coolingDays` (default 3) prevents the same image from being re-updated too
soon after a previous apply. Useful when image authors push two manifest
updates in a row and you want a buffer to discover problems before
re-applying.

## Resources

| Resource     | Lifetime | Description                                                |
| ------------ | -------- | ---------------------------------------------------------- |
| `update_log` | infinite | Per-container outcome: applied/skipped/failed + reason.    |

## Auth

SSH key to each PVE node (same as `@lint/docker-host`). No registry credentials
needed — `docker compose pull` uses whatever auth the docker host already has
configured.

## License

MIT — see [LICENSE.txt](./LICENSE.txt).
