# @lint/disk-monitor

A swamp model that SSHes into a target host, runs `df -P`, and classifies
every mount against per-mount warning/critical thresholds. Designed for the
typical homelab NAS / pool monitoring case — surfaces "you're at 92% on
/volume2" before things break.

Single method:

- **`check`** — `ssh user@host df -P`, parse the output, classify each
  filesystem as `ok`, `warn`, or `crit` based on its current usage and
  configured thresholds. Emits `disk_usage` (per-mount details + booleans for
  `anyWarning`/`anyCritical`).

## Install

```bash
swamp extension pull @lint/disk-monitor
```

## Create an instance

```bash
swamp model create @lint/disk-monitor synology \
  --global-arg sshHost=192.168.4.52 \
  --global-arg sshUser=root \
  --global-arg "mountThresholds=$(jq -nc '
    {
      "/volume1": {"warn":80,"crit":90},
      "/volume2": {"warn":85,"crit":92}
    }')" \
  --global-arg instanceLabel=nas
```

`mountThresholds` is a JSON object keyed by mount path. Mounts not listed
fall back to `defaultWarn` / `defaultCrit` (default 80 / 90).

## Run the check

```bash
swamp model method run synology check
swamp data get disk_usage --json | jq '.anyCritical, .mounts[] | select(.bucket != "ok")'
```

Combine with `@lint/discord-notifier` (which has a `diskUsage` optional
global arg) for weekly Discord embeds that show red/yellow/green per mount.

## Auth

SSH key auth — drop your public key in the target host's `~/.ssh/authorized_keys`
before pointing the model at it. The model never touches password auth.

## Resources

| Resource     | Lifetime | Description                                                  |
| ------------ | -------- | ------------------------------------------------------------ |
| `disk_usage` | infinite | Per-mount usage with bucket, plus `anyWarning`/`anyCritical`.|

## Compatibility

Anything with `ssh` + a POSIX-ish `df`. Tested against Synology DSM 7 and
stock Debian/Ubuntu hosts. Transport is `ssh` via `Deno.Command`.

## License

MIT — see [LICENSE.txt](./LICENSE.txt).
