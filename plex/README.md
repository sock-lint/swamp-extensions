# @lint/plex

A swamp model that triggers library refreshes on a
[Plex Media Server](https://www.plex.tv/). It's the tail end of a media-management
pipeline — once Radarr/Sonarr removes a file on disk, or a curator/cleaner job
reclaims space, this model tells Plex to re-scan so the catalog stops advertising
entries that no longer exist.

- **`refreshLibraries`** — calls `/library/sections/{id}/refresh` for each section.
  If `sectionIds` is omitted, fetches `/library/sections` and refreshes every
  section of type `movie` or `show`. Records per-section HTTP status in a
  `refresh_result` resource so you can verify which scans were accepted.

Plex has no API-key concept — auth is the standard `X-Plex-Token` query
parameter. Find a token using the
[Plex docs](https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/).

## Install

```bash
swamp extension pull @lint/plex
```

## Create an instance

```bash
swamp model create @lint/plex home \
  --global-arg baseUrl=http://192.168.4.61:32400 \
  --global-arg token='replace-me' \
  --global-arg instanceLabel=living-room-plex
```

For production, store the token in a vault and resolve it via expression:

```bash
swamp model create @lint/plex home \
  --global-arg baseUrl=http://192.168.4.61:32400 \
  --global-arg "token={{ vault('plex', 'token') }}" \
  --global-arg instanceLabel=living-room-plex
```

## Refresh all movie + show sections

```bash
swamp model method run home refreshLibraries
swamp data get refresh_result --json | jq '.sectionsRefreshed'
```

## Refresh a specific subset

Pin `sectionIds` per-instance to scope which libraries get touched — for
example, when music/photo libraries are scanned on a different cadence:

```bash
swamp model create @lint/plex movies-only \
  --global-arg baseUrl=http://192.168.4.61:32400 \
  --global-arg token='...' \
  --global-arg instanceLabel=movies-only \
  --global-arg 'sectionIds=[1, 3]'
```

`sectionIds` accepts either a JSON-encoded string (above, the right shape for
CEL wiring) or a native array when set programmatically.

## Wire after a cleanup step

A common pattern is to refresh Plex immediately after a deletion job
finishes — so the catalog is consistent with disk by the time someone next
opens the app. As a workflow step:

```yaml
jobs:
  refresh-after-cleanup:
    dependsOn:
      - job: clean-movies
        condition: { type: succeeded }
    method:
      model: home
      method: refreshLibraries
```

## Resources

| Resource         | Lifetime | Description                                                    |
| ---------------- | -------- | -------------------------------------------------------------- |
| `refresh_result` | infinite | Per-section refresh outcomes (sectionId, httpStatus, ok flag). |

## Compatibility

Tested against Plex Media Server v1.40.x. Uses only documented
`/library/sections` endpoints. Transport is `curl` via `Deno.Command`, so any
failing call can be reproduced as a one-liner from a shell.

## License

MIT — see [LICENSE.txt](./LICENSE.txt).
