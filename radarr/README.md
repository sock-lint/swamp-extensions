# @lint/radarr

A swamp model that snapshots a [Radarr](https://radarr.video/) v3 instance into
structured swamp resources you can query with CEL or chain into downstream
workflows. Two methods:

- **`sync`** — fetches `/api/v3/movie`, `/api/v3/rootfolder`, and `/api/v3/tag`,
  joins them so tag IDs come back as labels, parses the IMDb tt-id out of the
  on-disk filename (so you can sanity-check Radarr's metadata against the actual
  file), and writes two resources: `inventory` (every movie + fields) and
  `summary` (counts + root folder free space).
- **`delete`** — `DELETE /api/v3/movie/{id}` with the well-known
  `?deleteFiles=true&addImportListExclusion=true` defaults. Emits a
  `delete_result` resource so the outcome (HTTP status, response body)
  is available to downstream workflow steps.

Auth uses Radarr's standard `X-Api-Key` header — find it in
**Settings → General → Security → API Key**.

## Install

```bash
swamp extension pull @lint/radarr
```

## Create an instance

```bash
swamp model create @lint/radarr movies-1080p \
  --global-arg baseUrl=http://192.168.4.50:7878 \
  --global-arg apiKey='replace-me' \
  --global-arg instanceLabel=1080p
```

For production, resolve the key through a vault:

```bash
swamp model create @lint/radarr movies-1080p \
  --global-arg baseUrl=http://192.168.4.50:7878 \
  --global-arg "apiKey={{ vault('radarr', 'api_key') }}" \
  --global-arg instanceLabel=1080p
```

Multi-instance Radarr (e.g. separate 1080p / 4K servers) is the expected
pattern — create one swamp instance per Radarr server and label them
distinctly.

## Snapshot the instance

```bash
swamp model method run movies-1080p sync
swamp data get summary --json | jq '.movieCount, .withFileCount, .rootFolders'
```

The `summary` resource is the cheap thing to read; `inventory` carries the
per-movie detail.

## The IMDb-mismatch trick

Each movie in `inventory` carries two IMDb IDs:

- `imdbId` — what Radarr's catalog thinks the movie is.
- `fileImdbId` — the tt-id parsed out of the on-disk basename (e.g. `tt0084787`
  from `Movie Title [imdb-tt0084787].mkv`).

When they don't agree, Radarr's metadata has drifted from the actual file on
disk — the catalog entry points at a different movie than the bytes it claims
to track. Down-stream tooling (curators, cleaners, dedupe scripts) should
treat those entries as untrusted and refuse destructive operations until a
human re-matches them in Radarr.

Find them with:

```bash
swamp data get inventory --json \
  | jq '.attributes.movies[] | select(.fileImdbId and .imdbId != .fileImdbId) | {title, imdbId, fileImdbId}'
```

## Delete a movie

Use the well-known *arr delete pattern — removes the catalog entry, the
on-disk files, and adds an import-list exclusion so it doesn't get
re-grabbed by automatic imports:

```bash
swamp model method run movies-1080p delete --arg id=1234
```

Both flags default to `true`. Override to keep files on disk, or to allow
the movie back in later via import lists:

```bash
swamp model method run movies-1080p delete \
  --arg id=1234 \
  --arg deleteFiles=false \
  --arg addImportListExclusion=false
```

The outcome lands in `delete_result` (movieId, flags, HTTP status, response
body) so a workflow downstream can verify and continue:

```bash
swamp data get delete_result --json | jq '{movieId, ok, httpStatus, body}'
```

The model uses the `id` from `/api/v3/movie` (the numeric Radarr ID) — not
`tmdbId` or `imdbId`. If you have a tmdbId, look up the matching `id` from
the `inventory` resource first.

## Resources

| Resource        | Lifetime | Description                                                                |
| --------------- | -------- | -------------------------------------------------------------------------- |
| `inventory`     | infinite | Full movie list with IDs, ratings, languages, tag names, parsed file IDs.  |
| `summary`       | infinite | Counts (total / with-file / missing) and root folder free-space.           |
| `delete_result` | infinite | Per-call delete outcome: movieId, flags, HTTP status, response body.       |

## Compatibility

Tested against Radarr v5.x (API v3). Uses only documented `/api/v3/movie`,
`/api/v3/rootfolder`, and `/api/v3/tag` endpoints. Transport is `curl` via
`Deno.Command` — replaying any failing call from a shell takes the URL plus
the `X-Api-Key` header.

## License

MIT — see [LICENSE.txt](./LICENSE.txt).
