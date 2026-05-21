# @lint/sonarr

A swamp model that snapshots a [Sonarr](https://sonarr.tv/) v3 instance into
structured swamp resources you can query with CEL or chain into downstream
workflows. Two methods:

- **`sync`** — fetches `/api/v3/series`, `/api/v3/rootfolder`, and `/api/v3/tag`,
  joins them so tag IDs come back as labels, flattens the per-series
  `statistics` block into top-level fields (`sizeOnDisk`, `episodeCount`,
  `episodeFileCount`, `percentOfEpisodes`), and writes two resources:
  `inventory` (every series + fields) and `summary` (counts by status + root
  folder free space).
- **`delete`** — `DELETE /api/v3/series/{id}` with the well-known
  `?deleteFiles=true&addImportListExclusion=true` defaults. Emits a
  `delete_result` resource so the outcome (HTTP status, response body)
  is available to downstream workflow steps.

Auth uses Sonarr's standard `X-Api-Key` header — find it in
**Settings → General → Security → API Key**.

## Install

```bash
swamp extension pull @lint/sonarr
```

## Create an instance

```bash
swamp model create @lint/sonarr tv \
  --global-arg baseUrl=http://192.168.4.50:8989 \
  --global-arg apiKey='replace-me' \
  --global-arg instanceLabel=tv
```

For production, resolve the key through a vault:

```bash
swamp model create @lint/sonarr tv \
  --global-arg baseUrl=http://192.168.4.50:8989 \
  --global-arg "apiKey={{ vault('sonarr', 'api_key') }}" \
  --global-arg instanceLabel=tv
```

## Snapshot the instance

```bash
swamp model method run tv sync
swamp data get summary --json | jq '.seriesCount, .endedCount, .continuingCount, .rootFolders'
```

The `summary` resource is the cheap thing to read; `inventory` carries the
per-series detail.

## The ended-but-incomplete query

A common TV-curation question is "which series ended before I finished
collecting them?" Because `status` and `percentOfEpisodes` ride on every
series record, that's one `jq` filter away:

```bash
swamp data get inventory --json \
  | jq '.attributes.series[] | select(.status == "ended" and .percentOfEpisodes < 100) | {title, percentOfEpisodes, sizeOnDisk}'
```

Series with a specific tag (e.g. `keep-forever`) — handy as the input to a
protection filter in a downstream cleaner:

```bash
swamp data get inventory --json \
  | jq '.attributes.series[] | select(.tagNames | index("keep-forever")) | .title'
```

## Delete a series

Use the well-known *arr delete pattern — removes the catalog entry, the
on-disk files, and adds an import-list exclusion so it doesn't get
re-added by automatic imports:

```bash
swamp model method run tv delete --arg id=42
```

Both flags default to `true`. Override to keep files on disk, or to allow
the series back in later via import lists:

```bash
swamp model method run tv delete \
  --arg id=42 \
  --arg deleteFiles=false \
  --arg addImportListExclusion=false
```

The outcome lands in `delete_result` (seriesId, flags, HTTP status, response
body) so a workflow downstream can verify and continue:

```bash
swamp data get delete_result --json | jq '{seriesId, ok, httpStatus, body}'
```

The model uses the `id` from `/api/v3/series` (the numeric Sonarr ID) — not
`tvdbId`, `imdbId`, or `tmdbId`. If you have one of those, look up the
matching `id` from the `inventory` resource first.

## Resources

| Resource        | Lifetime | Description                                                                                |
| --------------- | -------- | ------------------------------------------------------------------------------------------ |
| `inventory`     | infinite | Full series list with IDs, statistics, status, genres, network, tag names.                 |
| `summary`       | infinite | Counts by status (ended/continuing/upcoming), total episode files, root folder free-space. |
| `delete_result` | infinite | Per-call delete outcome: seriesId, flags, HTTP status, response body.                      |

## Compatibility

Tested against Sonarr v4.x (API v3). Uses only documented `/api/v3/series`,
`/api/v3/rootfolder`, and `/api/v3/tag` endpoints. Transport is `curl` via
`Deno.Command` — replaying any failing call from a shell takes the URL plus
the `X-Api-Key` header.

## License

MIT — see [LICENSE.txt](./LICENSE.txt).
