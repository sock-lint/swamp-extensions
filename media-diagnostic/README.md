# @lint/media-diagnostic

A cross-instance Radarr diagnostic. Compares a default (1080p) Radarr
inventory against a 4K Radarr inventory and surfaces three kinds of waste:

1. **Duplicates** — the same folder exists in both instances. You're paying
   storage twice (1080p + 4K) for the same title; dropping the smaller copy
   reclaims `smallerCopyBytes`.
2. **Missing files** — Radarr-cataloged entries with `hasFile: false`. The
   catalog points at a movie that has no file on disk — usually a download
   that failed to import.
3. **Oversized files** — single-file movies over the configured threshold
   (default 60 GiB). Helpful for spotting the one bad remux that's eating
   your pool.

This model is read-only. It produces `findings` (per-entry detail) and
`summary` (counts + reclaim totals). Pair with `@lint/media-cleaner` to
actually act on the findings.

## Install

```bash
swamp extension pull @lint/media-diagnostic
```

You'll also want two `@lint/radarr` instances — one for 1080p, one for 4K.

## Create an instance

```bash
swamp model create @lint/media-diagnostic diag \
  --global-arg "defaultInventory={{ data.latest('@lint/radarr', 'inventory') }}" \
  --global-arg "fourKInventory={{ data.latest('@lint/radarr-4k', 'inventory') }}" \
  --global-arg oversizedThresholdBytes=64424509440 \
  --global-arg instanceLabel=movies
```

`oversizedThresholdBytes` defaults to 60 GiB. Adjust per your quality
profile — for a 4K-remux library, 80–100 GiB may be a more useful threshold.

## Scan

```bash
swamp model method run diag scan
swamp data get summary --json | jq '.duplicateCount, .reclaimDropSmallerBytes, .oversizedCount'
swamp data get findings --json | jq '.duplicates[:5], .oversized[:5]'
```

The interesting summary fields:

- `reclaimDropSmallerBytes` — bytes you'd reclaim by dropping the smaller
  copy of each duplicate.
- `reclaimDropAll1080pDupsBytes` / `reclaimDropAll4KDupsBytes` — bytes if
  you went all-in on one tier and dropped the duplicates from the other.

## Resources

| Resource   | Lifetime | Description                                                                |
| ---------- | -------- | -------------------------------------------------------------------------- |
| `findings` | infinite | Full per-entry list of `duplicates`, `missingFiles`, `oversized`.          |
| `summary`  | infinite | Counts + reclaim totals across three reclaim strategies.                   |

## Matching rule

Duplicates are matched on the `folderName` field (basename of the Radarr
folder, e.g. `The Thing (1982) [imdb-tt0084787]`). Cross-instance Radarr
typically uses the same folder convention, so this catches the canonical
"same movie, two copies" case without needing TMDb-id matching.

## License

MIT — see [LICENSE.txt](./LICENSE.txt).
