# @lint/home-assistant

A swamp model that wraps the [Home Assistant](https://www.home-assistant.io/)
REST API. Two slices of functionality, packaged behind a single model so
workflows can read state and actuate the house from one place.

## Methods

- **`sync`** — fetches `/api/states`, projects every `automation.*` entity into
  a typed `inventory` (entity id, alias, state, last_triggered, mode) plus a
  compact `summary` (on/off/unavailable counts + top-5 recently triggered).
  YAML-only automations are surfaced with `id: null` so you can see them but
  the lifecycle methods below won't touch them.

- **`upsertAutomation`** — create-or-update an automation via
  `POST /api/config/automation/config/<id>`. Idempotent; reloads automations
  after a successful write so the new config takes effect immediately.

- **`deleteAutomation`** — remove a UI-created automation via the same config
  endpoint; reloads after delete.

- **`setEnabled`** — toggle a single automation on/off via
  `automation.turn_on` / `automation.turn_off`. Works on YAML-only automations
  too (the toggle is runtime state, not config).

- **`trigger`** — manually fire an automation via `automation.trigger`,
  optionally skipping the automation's `condition:` block (default `true`,
  matching HA's own behavior for service-based triggering).

- **`callService`** — generic actuator. POSTs to
  `/api/services/<domain>/<service>` with any payload you supply, so you can
  turn on lights, push phone notifications, queue media, or create in-HA
  banners from a swamp workflow. See [Targeting](#targeting) below for the
  `target` vs `serviceData` distinction.

Every method writes a row to the `sync_log` resource (kept 30 versions) so you
can audit which workflow fired which service, when, and with what HTTP status.

## Auth

Home Assistant uses a long-lived access token. Generate one from your HA user
profile page (Profile → Security → "Long-lived access tokens" → Create token).
Pass it via the `accessToken` global argument — back it with a vault expression
so the token doesn't sit in plaintext in your repo:

```yaml
globalArguments:
  baseUrl: "http://homeassistant.local:8123"
  accessToken: "${{ vault.get(homeassistant, token) }}"
  requestTimeoutSec: 15
```

## Install

```bash
swamp extension pull @lint/home-assistant
```

## Create an instance

```bash
swamp model create @lint/home-assistant home-assistant \
  --global-arg baseUrl=http://homeassistant.local:8123 \
  --global-arg accessToken='replace-me' \
  --global-arg requestTimeoutSec=15
```

## Targeting

`callService` accepts two complementary input slots so it can drive every HA
service style:

- **`target`** (preferred for entity-aware domains) — a structured block with
  `entity_id`, `area_id`, and/or `device_id`. Each accepts a string or an array
  of strings. Use this for `light.*`, `switch.*`, `climate.*`,
  `media_player.*`, etc.

- **`serviceData`** — an arbitrary object merged at the top level of the request
  body. Use this for services that take flat keys (notably `notify.*` and
  `persistent_notification.create`, which expect `message`/`title` flat, not
  nested under a target).

## Examples

### Turn on a light when the house is dark

```bash
swamp model method run home-assistant callService --input-file - <<'EOF'
domain: light
service: turn_on
target:
  entity_id: light.living_room_lamp
serviceData:
  brightness_pct: 60
  color_name: warm_white
EOF
```

### Push a phone notification (HA Companion app)

```bash
swamp model method run home-assistant callService --input-file - <<'EOF'
domain: notify
service: mobile_app_my_phone
serviceData:
  title: Deploy complete
  message: image-updater applied 3 updates
EOF
```

### Surface a banner inside HA

```bash
swamp model method run home-assistant callService --input-file - <<'EOF'
domain: persistent_notification
service: create
serviceData:
  title: PBS backup stale
  message: 2 guests are >7d behind on snapshots
  notification_id: pbs_stale_warning
EOF
```

### Inventory + recently-triggered list

```bash
swamp model method run home-assistant sync
swamp data get home-assistant summary --json
```

### Create or update an automation

```bash
swamp model method run home-assistant upsertAutomation --input-file - <<'EOF'
id: morning_lights
alias: Morning lights
trigger:
  - platform: time
    at: "06:30:00"
action:
  - service: light.turn_on
    target:
      entity_id: light.kitchen_ceiling
mode: single
EOF
```

## Wiring with other models via CEL

Other workflows can call `home-assistant.callService` to actuate the house —
e.g. after `@lint/image-updater` applies a critical update, queue a phone push:

```yaml
- name: notify-phone-on-update
  model: home-assistant
  method: callService
  input:
    domain: notify
    service: mobile_app_my_phone
    serviceData:
      title: "image-updater"
      message: "${{ data.latest('image-updater', 'apply_run').attributes.appliedCount }} updates applied"
```

## Transport

All HTTP calls go through `curl` via `Deno.Command`, so any failing call can be
replayed as a one-line shell command using the same `baseUrl` + token. The
audit `sync_log` records the HTTP status verbatim, which makes debugging an
HA-side 4xx straightforward.

## Resources

- `inventory` — full list of automations (kept 5 versions).
- `summary` — counts + top-5 recently-triggered (kept 5 versions).
- `sync_log` — per-method audit row, including `callService` invocations
  (kept 30 versions).

## License

MIT. See `LICENSE.txt`.
