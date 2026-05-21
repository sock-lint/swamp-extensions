# @lint/media-diagnostic

Companion model to `@lint/media-curator` — given a single title, expands the
keep-score breakdown into a human-readable report. Useful when you ask "why
did *X* score that low?" and want to see every contributing signal with its
weight.

This is a pure read-only model. It doesn't compute scores from scratch; it
re-reads the curator's `scored` resource and unpacks one title.

Single method:

- **`explain`** — given a title string (case-insensitive, year-optional)
  OR an IMDb ID, find the matching entry in the curator's latest `scored`
  resource and emit a `report` resource detailing every signal that
  contributed to its score: review breakdown, tenure, plays, requests,
  tags, audio language, and any custom penalties.

## Install

```bash
swamp extension pull @lint/media-diagnostic
```

## Run

```bash
swamp model create @lint/media-diagnostic diag \
  --global-arg "scored={{ data.latest('@lint/media-curator', 'scored') }}" \
  --global-arg instanceLabel=movies

swamp model method run diag explain --arg 'title=The Thing'
swamp data get report --json | jq '.score, .breakdown'
```

Or pass an `imdbId` if titles are ambiguous:

```bash
swamp model method run diag explain --arg 'imdbId=tt0084787'
```

## Resources

| Resource | Lifetime | Description                                       |
| -------- | -------- | ------------------------------------------------- |
| `report` | infinite | Detailed score breakdown for one matched title.   |

## License

MIT — see [LICENSE.txt](./LICENSE.txt).
