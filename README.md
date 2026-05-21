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
| `@lint/portainer`            | Portainer API wrapper — snapshot endpoints, containers, and stacks across every docker host Portainer manages                      |
| `@lint/radarr`               | Radarr v3 inventory wrapper — snapshot movies, root folders, and tags; parses on-disk IMDb IDs so Radarr metadata drift is visible |
| `@lint/sonarr`               | Sonarr v3 inventory wrapper — snapshot series, root folders, and tags; flattens statistics so ended-but-incomplete queries are trivial |
| `@lint/tautulli`             | Tautulli watch-history wrapper — snapshot per-movie and per-series play counts and last-played timestamps; the never-watched signal for curation |

More to come — see [swamp-club.com/lint](https://swamp-club.com/lint).

## License

MIT — see [LICENSE](./LICENSE).

## Issues

Bug reports and feature requests welcome via GitHub issues, or via
`swamp issue --extension @lint/<name>`.
