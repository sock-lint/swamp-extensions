# @lint/seerr

A swamp model that wraps the [Overseerr](https://overseerr.dev/) /
[Jellyseerr](https://docs.jellyseerr.dev/) request API. Both are popular
request-management UIs for media stacks; they share the same REST surface
under `/api/v1/request`.

This model walks every request page-by-page and emits two resources — useful
as a provenance source for the curator stack (e.g. "this movie was
specifically requested by user X, so its keep-score should be higher").

Single method:

- **`sync`** — pages through `/api/v1/request?take=N&skip=N&sort=added` until
  the result set ends, flattens each request to `{requestId, mediaId,
  mediaType, status, requestedBy, createdAt, ...}`, emits `requests` (full
  list) and `summary` (counts per status, per media type).

## Install

```bash
swamp extension pull @lint/seerr
```

## Create an instance

```bash
swamp model create @lint/seerr requests \
  --global-arg baseUrl=http://192.168.4.50:5055 \
  --global-arg "apiKey={{ vault('seerr', 'api_key') }}"
```

The API key lives under Overseerr/Jellyseerr Settings → General → API Key.

## Snapshot the instance

```bash
swamp model method run requests sync
swamp data get summary --json | jq '.totalRequests, .movieRequests, .tvRequests, .autoRequests'
```

## Wiring downstream

The intended consumer is `@lint/media-curator` / `@lint/tv-curator`, which
read `requests` via CEL to upweight specifically-requested titles:

```yaml
seerrRequests: "${{ data.latest('@lint/seerr', 'requests') }}"
```

## Resources

| Resource   | Lifetime | Description                                                   |
| ---------- | -------- | ------------------------------------------------------------- |
| `requests` | infinite | Full request list flattened: id, media, status, requester.    |
| `summary`  | infinite | Per-status and per-media-type counts.                         |

## Compatibility

Tested against Overseerr 1.33 and Jellyseerr 1.x. Pagination uses
`take`/`skip`/`sort=added` query params. Transport is `curl` via
`Deno.Command`, so the same baseUrl + API key can be reproduced from a shell
when debugging.

## License

MIT — see [LICENSE.txt](./LICENSE.txt).
