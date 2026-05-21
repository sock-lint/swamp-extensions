# @lint/media-cleaner

Executes deletions for the drop candidates surfaced by `@lint/media-curator`.
Safety-first: respects `keep-forever` (or configurable equivalent) Radarr
tags, honors a cooling-period gate so first-time candidates never delete on
the same cycle they're discovered, and goes through Radarr's
`DELETE /api/v3/movie/{id}` so the catalog stays consistent.

This is the **write** half of the curator pair. Curator scores; cleaner
deletes. They're separated so the score+review step can run weekly without
risk, and cleanups happen only when you flip `apply: true`.

Single method:

- **`sweep`** — read the latest `drop_candidates`, filter by tag protection
  and cooling period, take up to `maxPerRun` items, and for each: call
  `DELETE /api/v3/movie/{id}?deleteFiles=true&addImportListExclusion=true`
  against the originating Radarr instance. Emits `sweep_log` with full
  per-movie outcome.

## Why `DELETE` instead of `rm`?

Removing a movie file directly with `rm` leaves a Radarr stub that re-downloads
on the next scan. The Radarr API delete (with `deleteFiles=true` and
`addImportListExclusion=true`) cleans the catalog AND prevents a future
import-list pull from re-adding it. This model uses the API exclusively.

## Install

```bash
swamp extension pull @lint/media-cleaner
```

You'll also want `@lint/media-curator` (to produce the inputs) and
`@lint/radarr` (whose API key this model reuses).

## Create an instance

```bash
swamp model create @lint/media-cleaner sweep \
  --global-arg "candidates={{ data.latest('@lint/media-curator', 'drop_candidates') }}" \
  --global-arg "radarrInstances={{ data.latest('@lint/media-curator', 'summary').radarrInstances }}" \
  --global-arg apply=false \
  --global-arg coolingDays=6 \
  --global-arg maxPerRun=10 \
  --global-arg protectionTag=keep-forever \
  --global-arg instanceLabel=movies
```

`apply: false` writes the log without deleting anything — use this on the
first run to confirm the policy looks right, then flip to `true`.

## Cooling-period gate

`coolingDays` (default 6) means a movie must appear in `drop_candidates`
across two consecutive runs (spanning >= coolingDays) before this cleaner
will actually delete it. First-time candidates are always logged as
`skipped_cooling`. This catches "I just watched it once" or "I just imported
this" — anything where a single weekly snapshot doesn't have the full picture.

## Resources

| Resource    | Lifetime | Description                                                |
| ----------- | -------- | ---------------------------------------------------------- |
| `sweep_log` | infinite | Per-candidate outcome: deleted / skipped_cooling / skipped_protected_by_tag / failed. |

## License

MIT — see [LICENSE.txt](./LICENSE.txt).
