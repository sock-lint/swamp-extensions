# @lint/sonarr

A swamp model that snapshots a [Sonarr](https://sonarr.tv/) v3 instance into
structured swamp resources you can query with CEL or chain into downstream
workflows. One method:

- **`sync`** — fetches `/api/v3/series`, `/api/v3/rootfolder`, and `/api/v3/tag`,
  joins them so tag IDs come back as labels, flattens the per-series
  `statistics` block into top-level fields (`sizeOnDisk`, `episodeCount`,
  `episodeFileCount`, `percentOfEpisodes`), and writes two resources:
  `inventory` (every series + fields) and `summary` (counts by status + root
  folder free space).

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

## Resources

| Resource    | Lifetime | Description                                                                                |
| ----------- | -------- | ------------------------------------------------------------------------------------------ |
| `inventory` | infinite | Full series list with IDs, statistics, status, genres, network, tag names.                 |
| `summary`   | infinite | Counts by status (ended/continuing/upcoming), total episode files, root folder free-space. |

## Compatibility

Tested against Sonarr v4.x (API v3). Uses only documented `/api/v3/series`,
`/api/v3/rootfolder`, and `/api/v3/tag` endpoints. Transport is `curl` via
`Deno.Command` — replaying any failing call from a shell takes the URL plus
the `X-Api-Key` header.

## License

MIT — see [LICENSE.txt](./LICENSE.txt).
