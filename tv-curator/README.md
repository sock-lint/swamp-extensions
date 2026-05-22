# @lint/tv-curator

The TV/series analog to `@lint/media-curator`. Computes a **keep score**
per Sonarr series by fusing signals from Sonarr (catalog + ratings +
tags), Overseerr/Jellyseerr (request provenance), Tautulli (play history),
and Plex (library membership). Surfaces low-scoring series as
`drop_candidates` and reports `protected_drops` shielded by your
`keep-forever` tag.

The main signal that distinguishes this from the movie curator is the
**`endedUnwatched` penalty**: completed series (Sonarr `ended: true`) that
have zero plays in Tautulli get a configurable negative score. The
intuition: an ended show that nobody ever watched is a much stronger
delete-candidate than an ongoing show that just hasn't been touched yet.

## Install

```bash
swamp extension pull @lint/tv-curator
```

You'll also want `@lint/sonarr`, `@lint/seerr`, `@lint/tautulli`, and
`@lint/plex` to produce the inputs.

## Create an instance

```bash
swamp model create @lint/tv-curator score \
  --global-arg "sonarrInventory={{ data.latest('@lint/sonarr', 'inventory') }}" \
  --global-arg "seerrRequests={{ data.latest('@lint/seerr', 'requests') }}" \
  --global-arg "tautulliHistory={{ data.latest('@lint/tautulli', 'history') }}" \
  --global-arg "plexInventory={{ data.latest('@lint/plex', 'inventory') }}" \
  --global-arg dropThreshold=20 \
  --global-arg endedUnwatchedPenalty=-30 \
  --global-arg instanceLabel=series
```

`endedUnwatchedPenalty` defaults to 0 so the penalty is opt-in. In typical
homelab libraries (where a high % of ended series were never played), -30
is enough to surface a long tail of "remove these and reclaim a lot of
disk" candidates.

## Score the library

```bash
swamp model method run score score
swamp data get summary --json | jq '.totalScored, .dropCandidateCount, .endedUnwatchedShare'
swamp data get drop_candidates --json | jq '.candidates[:10]'
```

## Resources

| Resource          | Lifetime | Description                                                  |
| ----------------- | -------- | ------------------------------------------------------------ |
| `scored`          | infinite | Every series with its score + reasons breakdown.             |
| `summary`         | infinite | Totals, distribution, threshold, weights snapshot.           |
| `drop_candidates` | infinite | Subset below `dropThreshold`, sorted by reclaim potential.   |
| `protected_drops` | infinite | Would-be drops that the `keep-forever` tag shielded.         |

## Wire it: the `weekly-tv-refresh` workflow

This package ships an example weekly pipeline:

```bash
swamp workflow run weekly-tv-refresh
```

Three jobs in sequence:

1. **sync** — `sonarr.sync`, `seerr.sync`, `tautulli.syncShows` in parallel.
   Note `syncShows` (not `sync`) — TV watch history is a separate Tautulli
   endpoint from movie watch history.
2. **score** — `tv-curator.score` over the fresh data.
3. **clean** — `tv-cleaner.applyDrops` in **dry-run** by default
   (`apply: false`). Flip to `apply: true` after a bake period reviewing the
   candidate list, and the cleaner's internal cooling-period gate will only
   delete candidates that have persisted across multiple weeks.

Expected model **instance names**: `sonarr`, `seerr`, `tautulli`,
`tv-curator`, `tv-cleaner`.

Pair with [`@lint/tv-cleaner`](https://github.com/sock-lint/swamp-extensions/tree/main/tv-cleaner)
for the cleaner side.

## License

MIT — see [LICENSE.txt](./LICENSE.txt).
