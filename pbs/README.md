# @lint/pbs

A swamp model that wraps the [Proxmox Backup Server](https://www.proxmox.com/en/proxmox-backup-server)
API. Classifies every guest in a PBS datastore as **fresh**, **stale**, or
**missing** against a configurable freshness threshold.

Single method:

- **`check`** — list snapshots in `/api2/json/admin/datastore/<store>/snapshots`
  for both `vm` (QEMU) and `ct` (LXC) backup groups, pick the newest snapshot
  per guest, and tag each guest as:
  - `fresh` — newest snapshot is within `freshHours` (default 36)
  - `stale` — older than that
  - `missing` — no snapshot found at all

Emits `summary` (counts per bucket) and `status` (per-guest details).

## Install

```bash
swamp extension pull @lint/pbs
```

## Create an instance

```bash
swamp model create @lint/pbs backup \
  --global-arg baseUrl=https://192.168.4.40:8007 \
  --global-arg "token={{ vault('pbs', 'token') }}" \
  --global-arg datastore=synology-backups \
  --global-arg expectedGuests='[100,101,102,103,200,201]' \
  --global-arg freshHours=36 \
  --global-arg instanceLabel=homelab
```

`token` is the full `PBSAPIToken=user@realm!token-name:value` string from the
PBS admin UI. `expectedGuests` is a JSON array of VMIDs you expect to see —
guests absent from this list are reported but not counted toward
`missing`.

## Run the check

```bash
swamp model method run backup check
swamp data get summary --json | jq '.fresh, .stale, .missing'
```

If any guest is in `stale` or `missing`, your backup pipeline is silently
broken — wire this method's output into a Discord or PagerDuty notifier.

## Resources

| Resource  | Lifetime | Description                                                |
| --------- | -------- | ---------------------------------------------------------- |
| `summary` | infinite | Counts per bucket + total snapshot count.                  |
| `status`  | infinite | Per-guest `{vmid, type, ageHours, bucket, snapshotTime}`.  |

## Compatibility

Tested against PBS 3.x. Uses the `/api2/json/admin/datastore/*/snapshots`
surface. Transport is `curl` via `Deno.Command` with `-k` (PBS often runs
with a self-signed cert in homelabs). If your PBS is fronted by a real cert,
that's harmless; if not, the model would otherwise refuse to connect.

## License

MIT — see [LICENSE.txt](./LICENSE.txt).
