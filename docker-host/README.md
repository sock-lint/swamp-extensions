# @lint/docker-host

A swamp model that discovers docker containers running **inside LXCs on a
Proxmox cluster** without requiring an agent inside the LXC. SSHes to each
PVE node and uses `pct exec <vmid> -- docker ps` to enumerate containers on
every LXC tagged `docker` in the Proxmox cluster.

Useful when you have docker workloads distributed across many LXCs — Portainer
edge agents work too, but this model needs zero install inside the guests.

Single method:

- **`sync`** — for every node in the cluster inventory, ssh to it, then for
  every LXC marked with the `docker` tag, run `pct exec <vmid> -- docker ps
  --format json` and `docker inspect` per container. Emits `inventory` (every
  container's host, vmid, image, state, labels, mounts) and `summary` (counts
  per host + total).

## Install

```bash
swamp extension pull @lint/docker-host
```

You'll typically chain this after `@keeb/proxmox` (cluster sync) — its output
gives you the node list + docker-tagged LXC inventory.

## Create an instance

```bash
swamp model create @lint/docker-host fleet \
  --global-arg "nodeIpMap=$(jq -nc '
    {
      "pve1":"192.168.4.11",
      "pve2":"192.168.4.12"
    }')" \
  --global-arg "cluster={{ data.latest('@keeb/proxmox', 'cluster') }}" \
  --global-arg sshUser=root \
  --global-arg instanceLabel=fleet
```

`nodeIpMap` maps PVE node names to their SSH-reachable IPs; `cluster` is the
proxmox cluster resource (or any object with a list of LXCs and their tags).

## Snapshot the fleet

```bash
swamp model method run fleet sync
swamp data get summary --json | jq '.totalContainers, .byHost'
```

## Wiring downstream

The intended consumer is `@lint/image-updates`, which reads the inventory
to compare each container's image digest against the upstream registry.

## Resources

| Resource    | Lifetime | Description                                                |
| ----------- | -------- | ---------------------------------------------------------- |
| `inventory` | infinite | Per-container details: host, vmid, image, state, labels.   |
| `summary`   | infinite | Per-host container count, total, unique image count.       |

## Auth

SSH key auth to each PVE node. Distribute your public key to every PVE
`~/.ssh/authorized_keys` before running.

## Compatibility

Tested against Proxmox VE 8.x with docker installed inside LXCs (privileged
or unprivileged both work as long as docker is functional). Transport is
`ssh` via `Deno.Command`.

## License

MIT — see [LICENSE.txt](./LICENSE.txt).
