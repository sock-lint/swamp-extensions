# @lint/tv-cleaner

Executes deletions for the drop candidates surfaced by `@lint/tv-curator`.
Mirrors the movie cleaner pattern: respects `keep-forever` (or configurable
equivalent) Sonarr tags, honors a cooling-period gate, and goes through
Sonarr's `DELETE /api/v3/series/{id}` so the catalog stays consistent.

This is the **write** half of the TV curator pair. Curator scores; cleaner
deletes. Use `apply: false` to dry-run the policy before flipping the
switch.

Single method:

- **`sweep`** — read the latest TV `drop_candidates`, filter by tag
  protection and cooling period, take up to `maxPerRun`, and for each:
  call `DELETE /api/v3/series/{id}?deleteFiles=true&addImportListExclusion=true`
  against Sonarr. Emits `sweep_log` with full per-series outcome.

## Why the Sonarr API?

Same reasoning as `@lint/media-cleaner` for Radarr: deleting the files
directly leaves a Sonarr catalog stub that re-imports on the next scan.
The Sonarr API call with `deleteFiles=true` + `addImportListExclusion=true`
removes the catalog entry AND prevents future import-list pulls from
re-adding it.

## Install

```bash
swamp extension pull @lint/tv-cleaner
```

You'll also want `@lint/tv-curator` (to produce the inputs) and
`@lint/sonarr` (whose API key this model reuses).

## Create an instance

```bash
swamp model create @lint/tv-cleaner sweep \
  --global-arg "candidates={{ data.latest('@lint/tv-curator', 'drop_candidates') }}" \
  --global-arg sonarrUrl=http://192.168.4.50:8989 \
  --global-arg "sonarrApiKey={{ vault('sonarr', 'api_key') }}" \
  --global-arg apply=false \
  --global-arg coolingDays=6 \
  --global-arg maxPerRun=10 \
  --global-arg protectionTag=keep-forever \
  --global-arg instanceLabel=tv
```

## Resources

| Resource    | Lifetime | Description                                                |
| ----------- | -------- | ---------------------------------------------------------- |
| `sweep_log` | infinite | Per-series outcome: deleted / skipped_cooling / skipped_protected_by_tag / failed. |

## License

MIT — see [LICENSE.txt](./LICENSE.txt).
