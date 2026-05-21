# @lint/tautulli

A swamp model that snapshots watch-history from a [Tautulli](https://tautulli.com/)
instance — the `play_count` + `last_played` signal that turns "what's in my Plex
library?" into "what have I actually watched?" Two methods:

- **`sync`** — per-movie play counts and last-played timestamps for movie
  sections; writes `history` (every movie + counts) and `summary` (top-line
  watched / never-watched aggregates).
- **`syncShows`** — per-series aggregated play counts for show sections;
  writes a `show_history` resource.

Both methods auto-detect Plex sections by `section_type` unless you pin the
list with `movieSectionIds` / `showSectionIds`, and paginate Tautulli's
`get_library_media_info` in batches of 1000.

Auth uses Tautulli's standard `apikey` query parameter — find it in
**Settings → Web Interface → API**.

## Install

```bash
swamp extension pull @lint/tautulli
```

## Create an instance

```bash
swamp model create @lint/tautulli home \
  --global-arg baseUrl=http://192.168.4.50:8181 \
  --global-arg apiKey='replace-me'
```

For production, resolve the key through a vault:

```bash
swamp model create @lint/tautulli home \
  --global-arg baseUrl=http://192.168.4.50:8181 \
  --global-arg "apiKey={{ vault('tautulli', 'api_key') }}"
```

## Snapshot watch-history

```bash
swamp model method run home sync
swamp model method run home syncShows
swamp data get summary --json | jq '.totalMovies, .watchedAtLeastOnce, .neverWatched, .totalPlays'
```

The `summary` resource is the cheap thing to read; `history` and `show_history`
carry the per-item detail.

## The "never watched" query

The whole point of the integration. After running `sync`, every movie carries
its watch state — finding the ones that have been sitting unwatched is one
`jq` filter away:

```bash
# Movies you've never played, by file size (cleanup candidates)
swamp data get history --json \
  | jq '.attributes.movies | map(select(.playCount == 0))
        | sort_by(-(.fileSize // 0))
        | .[0:20]
        | map({title, year, sizeGB: ((.fileSize // 0) / 1e9 | round * 100 / 100)})'
```

Or scoped to "added > 1y ago and still never watched" by pairing with a
Radarr-derived `added` timestamp in a downstream curator model.

## Resources

| Resource       | Lifetime | Description                                                                                |
| -------------- | -------- | ------------------------------------------------------------------------------------------ |
| `history`      | infinite | Per-movie play_count + last_played + fileSize for the selected sections.                   |
| `show_history` | infinite | Per-series aggregated play_count + last_played for the selected show sections.             |
| `summary`      | infinite | Top-line totals (movies / watchedAtLeastOnce / neverWatched / totalPlays) + section index. |

## Compatibility

Tested against Tautulli v2.13+. Uses the documented `/api/v2` RPC interface
(`cmd=get_libraries`, `cmd=get_library_media_info`). Transport is `curl` via
`Deno.Command` — replaying any failing call from a shell takes the URL plus
`apikey=...&cmd=...`.

## License

MIT — see [LICENSE.txt](./LICENSE.txt).
