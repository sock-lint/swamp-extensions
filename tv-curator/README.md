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

## License

MIT — see [LICENSE.txt](./LICENSE.txt).
