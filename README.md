# swamp-extensions

Swamp extensions published by [@lint](https://swamp-club.com/lint) on the
[Swamp Club](https://swamp-club.com) registry.

Each subdirectory is a self-contained extension package that ships via
`swamp extension push`. The source here is the authoritative mirror — the
published bundle is built from the same files.

## Install

```bash
swamp extension pull @lint/<name>
```

## Index

### Service wrappers

| Package                      | Description                                                              |
| ---------------------------- | ------------------------------------------------------------------------ |
| `@lint/adguard`              | AdGuard Home control-API wrapper — snapshot + reconcile DNS rewrites.    |
| `@lint/nginx-proxy-manager`  | Nginx Proxy Manager admin-API — snapshot inventory + upsert/delete hosts.|
| `@lint/portainer`            | Portainer API — snapshot endpoints, containers, stacks; drive actions.   |
| `@lint/radarr`               | Radarr v3 inventory + IMDb-mismatch drift detection.                     |
| `@lint/sonarr`               | Sonarr v3 inventory — series, episodes, root folders, ratings.           |
| `@lint/seerr`                | Overseerr / Jellyseerr — request inventory plus approve / decline.       |
| `@lint/tautulli`             | Tautulli watch-history snapshot for movies + shows.                      |
| `@lint/plex`                 | Plex library inventory — sections, items, last-played.                   |
| `@lint/pbs`                  | Proxmox Backup Server freshness checker (fresh/stale/missing).           |
| `@lint/home-assistant`       | Home Assistant REST API — automation CRUD + generic `callService` actuator. |
| `@lint/discord-notifier`     | Opinionated Discord weekly report bundler for the curator stack.         |
| `@lint/disk-monitor`         | SSH-based filesystem free-space monitor with thresholds.                 |
| `@lint/docker-host`          | Agentless docker container discovery across LXCs (via PVE `pct exec`).   |
| `@lint/image-updates`        | Docker image update tracker — local digest vs registry, per container.   |
| `@lint/image-updater`        | Auto-applier for image updates — deny list, cooling, per-run cap.        |

### Policy & TLS

| Package             | Description                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------ |
| `@lint/dns-policy`  | DNS policy compiler — merge manual + NPM-discovered + static rewrites into a deduped desired list. Bundles `dns-rewrite-sync` workflow. |
| `@lint/cert-health` | TLS-cert expiry tracker — NPM inventory + openssl probe of public hosts. Bundles `cert-health-check` workflow. |

### Curator suite

| Package                  | Description                                                               |
| ------------------------ | ------------------------------------------------------------------------- |
| `@lint/media-curator`    | Movie keep-score engine (Radarr + Seerr + Tautulli + Plex inputs). Bundles `weekly-media-refresh` workflow. |
| `@lint/media-cleaner`    | Movie deletion executor — drives Radarr DELETE with tag + cooling gates.  |
| `@lint/media-diagnostic` | Cross-instance Radarr diagnostic (duplicates, missing files, oversized).  |
| `@lint/tv-curator`       | TV series keep-score engine with `endedUnwatched` penalty signal. Bundles `weekly-tv-refresh` workflow. |
| `@lint/tv-cleaner`       | Series deletion executor — drives Sonarr DELETE with tag + cooling gates. |

## Pipeline

```
@keeb/proxmox ── cluster snapshot ──┐
                                    │
@lint/docker-host ─── inventory ────┼── @lint/image-updates ── @lint/image-updater
                                    │
@lint/radarr ──── inventory ────────┤
@lint/sonarr ──── inventory ────────┼── @lint/media-curator ── @lint/media-cleaner
@lint/seerr ─── requests ───────────┤   @lint/tv-curator    ── @lint/tv-cleaner
@lint/tautulli ── history ──────────┤
@lint/plex ───── inventory ─────────┘
                                                │
@lint/disk-monitor ── disk_usage ───────────────┤
@lint/pbs ─────── status ───────────────────────┴── @lint/discord-notifier
```

## License

MIT — see [LICENSE](./LICENSE).

## Issues

Bug reports and feature requests via GitHub issues, or via
`swamp issue --extension @lint/<name>`.
