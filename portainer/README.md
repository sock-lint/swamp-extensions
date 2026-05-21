# @lint/portainer

A swamp model that wraps the [Portainer](https://www.portainer.io/) REST API.
Portainer is a popular GUI for managing Docker (and Swarm/Kubernetes) across
multiple hosts; this model snapshots everything Portainer can see in one pass.

Three methods:

- **`sync`** — fetches `/api/endpoints`, then for every endpoint that reports
  status==1 (online), fetches `/api/endpoints/{id}/docker/containers/json?all=true`
  and `/api/stacks`. Emits an `inventory` resource (full payload) and a compact
  `summary` (counts per endpoint + total stacks).
- **`containerAction`** — `start` / `stop` / `restart` / `kill` / `pause` /
  `unpause` a docker container on any Portainer-managed endpoint. Outcome
  lands in an `action_result` resource (HTTP status + body) so it's
  inspectable from downstream workflow steps.
- **`pullImage`** — pull a docker image on a Portainer endpoint
  (`POST /api/endpoints/{id}/docker/images/create?fromImage=…`). Also
  records its outcome in `action_result`.

Auth is a Portainer API key (User settings → Access tokens) sent via the
`X-API-Key` header — no session cookies, no CSRF, just one header per request.

## Install

```bash
swamp extension pull @lint/portainer
```

## Create an instance

```bash
swamp model create @lint/portainer homelab \
  --global-arg baseUrl=http://192.168.4.66:9000 \
  --global-arg "apiKey={{ vault('portainer', 'api_key') }}" \
  --global-arg instanceLabel=homelab
```

## Snapshot the instance

```bash
swamp model method run homelab sync
swamp data get summary --json | jq '.endpointCount, .containerCount, .stackCount'
```

`inventory` is the heavy resource (every container's labels, image, state,
ports, mounts); `summary` is the cheap roll-up suitable for dashboards.

## Restart a container

```bash
# look up endpointId + containerId from the inventory first
swamp data get inventory --json \
  | jq '.attributes.containers[] | select(.name == "radarr") | {endpointId, id}'

# then act
swamp model method run homelab containerAction \
  --arg endpointId=2 \
  --arg containerId=abc123def456 \
  --arg action=restart
```

`action` must be one of `start`, `stop`, `restart`, `kill`, `pause`,
`unpause`. The handler is non-throwing — an HTTP 404 (e.g. the container
was already removed) records the failure in `action_result` rather than
aborting a batch.

## Pull an image

```bash
swamp model method run homelab pullImage \
  --arg endpointId=2 \
  --arg image=ghcr.io/user/foo:latest
```

Useful as the "fetch latest" half of an "update by re-create" workflow:
`pullImage` → `containerAction stop` → `containerAction start` against the
same container, ordered with `dependsOn` in a workflow file.

## Verify the outcome

```bash
swamp data get action_result --json | jq '{action, target, ok, httpStatus, body}'
```

## Resources

| Resource        | Lifetime | Description                                                                                       |
| --------------- | -------- | ------------------------------------------------------------------------------------------------- |
| `inventory`     | infinite | Full snapshot: endpoints, containers per endpoint, stacks.                                        |
| `summary`       | infinite | Per-endpoint container counts and total stack count.                                              |
| `action_result` | infinite | Last containerAction / pullImage outcome: endpointId, action, target, HTTP status, response body. |

## Endpoints with agents

Containers on remote endpoints reached via Portainer Agent are included
transparently — the model walks every online endpoint regardless of type
(direct docker, agent, etc.). Offline endpoints are listed in `summary` but
their container set is left empty rather than failing the whole `sync`.

## Compatibility

Tested against Portainer Community Edition 2.39.x. Uses only documented
`/api/*` endpoints. Transport is `curl` via `Deno.Command`, so the same
baseUrl + API key can be reproduced from a shell when debugging.

## License

MIT — see [LICENSE.txt](./LICENSE.txt).
