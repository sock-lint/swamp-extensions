# swamp-extensions

Swamp extensions published by [@lint](https://swamp-club.com/lint) on the
[Swamp Club](https://swamp-club.com) registry.

Each subdirectory is a self-contained extension package that ships via
`swamp extension push`. The source here is the authoritative mirror — the
published bundle is built from the same files.

## Install one

```bash
swamp extension pull @lint/<name>
```

## Index

| Package                      | Description                                                                                                                        |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `@lint/adguard`              | AdGuard Home control-API wrapper — snapshot + reconcile DNS rewrites idempotently                                                  |
| `@lint/nginx-proxy-manager`  | Nginx Proxy Manager API wrapper — snapshot proxy hosts, redirection hosts, and certificates                                        |
| `@lint/plex`                 | Plex Media Server control-API wrapper — trigger library refreshes on demand                                                        |
| `@lint/portainer`            | Portainer API wrapper — snapshot endpoints/containers/stacks and drive container actions (start/stop/restart/…) plus image pulls    |
| `@lint/radarr`               | Radarr v3 wrapper — snapshot inventory (with on-disk IMDb parsing for drift detection) and delete movies via the standard *arr API |
| `@lint/seerr`                | Overseerr / Jellyseerr request inventory — paginated requests with status, requester, target id; feeds the media curator                |
| `@lint/sonarr`               | Sonarr v3 wrapper — snapshot inventory (statistics flattened for ended-but-incomplete queries) and delete series via the standard *arr API |
| `@lint/tautulli`             | Tautulli watch-history wrapper — snapshot per-movie and per-series play counts and last-played timestamps; the never-watched signal for curation |

More to come — see [swamp-club.com/lint](https://swamp-club.com/lint).

## License

MIT — see [LICENSE](./LICENSE).

## Issues

Bug reports and feature requests welcome via GitHub issues, or via
`swamp issue --extension @lint/<name>`.
