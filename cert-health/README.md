# @lint/cert-health

A swamp model that audits TLS certificate expiry from two angles:

- **`syncNpm`** — logs into [Nginx Proxy Manager](https://nginxproxymanager.com/)
  via `POST /api/tokens`, fetches every cert from `/api/nginx/certificates`,
  and projects them into a typed inventory + summary. Catches certs NPM is
  *trying* to manage even when nothing is currently routing through them.
- **`probe`** — opens a TLS connection to each hostname via `openssl s_client`,
  pulls the leaf cert, and computes days-until-expiry. Catches what the
  *public* actually sees — important when a CDN edge cert (Cloudflare,
  Bunny, etc.) is the user-facing certificate, not NPM's.

Both methods classify with the same thresholds: `ok` (>30d), `warn` (14–30d),
`critical` (<14d), `expired` (<0d), `error` (probe failed). Probes run in
parallel via `Promise.all` for fan-out.

Read-only — this model never mutates NPM. Feed `worstExpiring` into your
notification stack of choice (Discord, Slack, PagerDuty).

## Install

```bash
swamp extension pull @lint/cert-health
```

Requires `openssl` and `curl` available on the host running swamp.

## Create an instance

```bash
swamp model create @lint/cert-health cert-health \
  --global-arg npmBaseUrl=http://192.168.4.60:81 \
  --global-arg npmEmail='admin@example.com' \
  --global-arg npmPassword='replace-me'
```

For vault-resolved credentials:

```bash
swamp model create @lint/cert-health cert-health \
  --global-arg npmBaseUrl=http://192.168.4.60:81 \
  --global-arg 'npmEmail=${{ vaults.npm.email }}' \
  --global-arg 'npmPassword=${{ vaults.npm.password }}'
```

## Methods

### `syncNpm`

Pull every cert NPM is managing and classify it.

```bash
swamp model method run cert-health syncNpm
```

Emits:

- `npm_inventory` — full cert list with `daysRemaining` per entry.
- `npm_summary` — counts (ok/warn/critical/expired) plus top-10 closest to
  expiry.

### `probe`

Open a TLS handshake to each host, extract the leaf cert.

```bash
swamp model method run cert-health probe \
  --input-file probe.yaml
```

```yaml
# probe.yaml
hosts:
  - sonarr.example.com
  - radarr.example.com
  - portainer.example.com:9443  # override default port
defaultPort: 443
```

Emits:

- `probe_results` — per-host `{ subject, issuer, expiresAt, daysRemaining,
  status, error }`.
- `probe_summary` — counts plus top-10 closest to expiry (errors excluded).

## Wire it: the `cert-health-check` workflow

This package ships a 2-step workflow that combines both methods:

```bash
swamp workflow run cert-health-check
```

The workflow assumes:

| Instance name | Type                 | Purpose                                                      |
|---------------|----------------------|--------------------------------------------------------------|
| `cert-health` | `@lint/cert-health`  | This model                                                   |
| `dns-policy`  | `@lint/dns-policy`   | Source of public hostnames (the `desired_public_records.hostnames` array) |

**If you don't run `@lint/dns-policy`,** edit the `probe-public-hosts` step
after pulling — replace the CEL `hosts:` input with a literal list:

```yaml
inputs:
  hosts:
    - sonarr.example.com
    - radarr.example.com
  defaultPort: 443
```

Or drop the `probe-public-hosts` step entirely if you only want NPM-side
visibility.

### Why both syncNpm and probe?

NPM's API tells you what NPM *thinks* the cert state is — `expires_on`
matches NPM's internal record. But if you front NPM with a CDN tunnel
(Cloudflare Tunnel, Bunny Edge, etc.), users hit the CDN's cert first, not
NPM's. `probe` is the only way to see what's actually presented end-to-end.

A weekly cadence (e.g. cron `0 9 * * 2` = Tuesdays at 09:00) gives you ~3
weeks of lead time on a 30-day cert before things go critical.

## Global args

| Field                   | Type    | Default | Notes                                              |
|-------------------------|---------|---------|----------------------------------------------------|
| `npmBaseUrl`            | string  | —       | NPM base URL (no trailing slash)                   |
| `npmEmail`              | string  | —       | NPM admin email (vault-resolve via `${{ ... }}`)   |
| `npmPassword`           | string  | —       | NPM admin password (vault-resolve via `${{ ... }}`)|
| `warnThresholdDays`     | number  | 30      | Days remaining below which status is `warn`        |
| `criticalThresholdDays` | number  | 14      | Days remaining below which status is `critical`    |
| `requestTimeoutSec`     | number  | 15      | Per-HTTP-request timeout (syncNpm)                 |
| `probeTimeoutSec`       | number  | 10      | Per-host openssl s_client timeout                  |
