# @lint/portainer

A swamp model that wraps the [Portainer](https://www.portainer.io/) REST API.
Portainer is a popular GUI for managing Docker (and Swarm/Kubernetes) across
multiple hosts; this model snapshots everything Portainer can see in one pass.

Single method, two resources:

- **`sync`** — fetches `/api/endpoints`, then for every endpoint that reports
  status==1 (online), fetches `/api/endpoints/{id}/docker/containers/json?all=true`
  and `/api/stacks`. Emits an `inventory` resource (full payload) and a compact
  `summary` (counts per endpoint + total stacks).

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

## Resources

| Resource    | Lifetime | Description                                              |
| ----------- | -------- | -------------------------------------------------------- |
| `inventory` | infinite | Full snapshot: endpoints, containers per endpoint, stacks. |
| `summary`   | infinite | Per-endpoint container counts and total stack count.     |

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
