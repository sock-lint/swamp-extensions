# @lint/media-curator

Computes a **keep score** for every movie in your Radarr library by fusing
signals from Radarr (catalog + ratings + tags), Overseerr/Jellyseerr
(request provenance), Tautulli (play history), and Plex (library
membership). Emits `drop_candidates` for low-scoring titles so a downstream
cleaner can prune storage with confidence — and a `protected_drops` view of
what your `keep-forever` tag shielded.

Read-only by design. Nothing about this model mutates Radarr or deletes
anything; that's the cleaner's job (`@lint/media-cleaner`).

## Why a keep score?

A library inevitably accumulates: stuff you requested for one movie night,
stuff that scored badly, stuff nobody ever watched. The keep score lets you
ask "what 50 titles would I delete first if disk were full" without manually
reviewing every entry — and gives you a per-title reason breakdown so any
"why did this score badly" answer is auditable.

Signals it considers (configurable weights):

- **Tenure** — older entries get a bonus (library-as-collection philosophy).
- **Play count** — recent plays push score up.
- **Review scores** — IMDb / TMDb / RT / Metacritic, with a vote-count
  threshold to discount low-vote outliers (default 50).
- **Watched ages ago vs never** — a movie watched 3 years ago is different
  from one never watched.
- **Requested by a user** — Seerr request provenance is a positive.
- **Tags** — `keep-forever` adds +200 (shield); user-defined penalty/bonus
  tags layer on top.
- **Size on disk** — too-large-for-quality penalty applies modestly.

## Install

```bash
swamp extension pull @lint/media-curator
```

You'll typically also want `@lint/radarr`, `@lint/seerr`, `@lint/tautulli`,
and `@lint/plex` to produce the inputs.

## Create an instance

```bash
swamp model create @lint/media-curator score \
  --global-arg "radarrInventories=[{{ data.latest('@lint/radarr', 'inventory') }}]" \
  --global-arg "seerrRequests={{ data.latest('@lint/seerr', 'requests') }}" \
  --global-arg "tautulliHistory={{ data.latest('@lint/tautulli', 'history') }}" \
  --global-arg "plexInventory={{ data.latest('@lint/plex', 'inventory') }}" \
  --global-arg dropThreshold=20 \
  --global-arg minReviewVotesPerSource=50 \
  --global-arg instanceLabel=movies
```

`radarrInventories` is a CEL-built array so you can pass multiple Radarr
instances (e.g. one for 1080p, one for 4K) — the curator merges them and
treats matched titles consistently across instances.

## Score the library

```bash
swamp model method run score score
swamp data get summary --json | jq '.totalScored, .dropCandidateCount, .protectedDropCount'
swamp data get drop_candidates --json | jq '.candidates[:10]'
```

## Resources

| Resource            | Lifetime | Description                                                  |
| ------------------- | -------- | ------------------------------------------------------------ |
| `scored`            | infinite | Every movie with its score + reasons breakdown.              |
| `summary`           | infinite | Totals, distribution, threshold, weights snapshot.           |
| `drop_candidates`   | infinite | Subset below `dropThreshold`, sorted by reclaim potential.   |
| `protected_drops`   | infinite | Would-be drops that the `keep-forever` tag shielded.         |

## License

MIT — see [LICENSE.txt](./LICENSE.txt).
