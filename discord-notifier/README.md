# @lint/discord-notifier

An **opinionated** Discord webhook poster: takes the outputs of the
[`@lint/media-curator`](../media-curator/) / [`@lint/tv-curator`](../tv-curator/)
keep-score pipeline, plus optional disk-monitor and image-updates inventory,
and renders a multi-embed Discord post with top-N drop candidates as CSV
attachments.

If you want a generic Discord poster, this isn't it — embeds are shaped
specifically for the curator vocabulary (`drop_candidates`, `protected_drops`,
`keep-score breakdown`). Use it as a recipe to copy if your data has a
different shape.

## What it sends

A single webhook POST with several embeds:

1. **Weekly summary** — totals scored, drop counts, protected counts.
2. **Movie drops** — top-N candidates, with score breakdown lines.
3. **TV drops** — same shape, for series.
4. **Protected drops** — what your `keep-forever` Radarr/Sonarr tag shielded
   this cycle. Visibility into "the safety net is working."
5. **Disk usage** (optional) — green/yellow/red colored embed if you wired up
   `@lint/disk-monitor`.
6. **Image updates** (optional) — count of updates available if you wired up
   `@lint/image-updates`.

Top-N drop lists are also attached as CSV files for spreadsheet review.

## Install

```bash
swamp extension pull @lint/discord-notifier
```

You'll typically also want `@lint/media-curator` and `@lint/tv-curator` since
this model consumes their outputs.

## Create an instance

The interesting global args are CEL expressions pointing at upstream models'
latest data. A workflow snippet is the easiest way to read this:

```yaml
- id: notify
  model: discord-bot
  method: notify
  globalArgs:
    webhookUrl: "${{ vault('discord', 'webhook') }}"
    username: "Curator Bot"
    topN: 15
    movieSummary: "${{ data.latest('@lint/media-curator', 'summary') }}"
    movieDropCandidates: "${{ data.latest('@lint/media-curator', 'drop_candidates') }}"
    movieProtectedDrops: "${{ data.latest('@lint/media-curator', 'protected_drops') }}"
    tvSummary: "${{ data.latest('@lint/tv-curator', 'summary') }}"
    tvDropCandidates: "${{ data.latest('@lint/tv-curator', 'drop_candidates') }}"
    tvProtectedDrops: "${{ data.latest('@lint/tv-curator', 'protected_drops') }}"
    diskUsage: "${{ data.latest('@lint/disk-monitor', 'disk_usage') }}"
    imageUpdates: "${{ data.latest('@lint/image-updates', 'inventory') }}"
```

The `diskUsage` and `imageUpdates` args are optional — pass `null` (or omit
the wire) and those embeds are silently skipped.

## Resources

| Resource           | Lifetime | Description                                                  |
| ------------------ | -------- | ------------------------------------------------------------ |
| `notification_log` | infinite | One entry per `notify` call: HTTP status, embed count, files. |

## Auth

Webhook URL only — no Discord bot account needed. Treat the URL as a secret;
storing it in a vault and resolving via `vault('discord', 'webhook')` is the
intended pattern.

## License

MIT — see [LICENSE.txt](./LICENSE.txt).
