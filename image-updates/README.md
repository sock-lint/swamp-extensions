# @lint/image-updates

A swamp model that compares each docker container's local image digest
against the registry's current digest for the same `image:tag`, surfacing
the list of containers with available updates.

This is the read-only sibling to `@lint/image-updater` — `image-updates`
discovers what *could* be updated, `image-updater` actually pulls + restarts.
Splitting them lets you run the discovery weekly + Discord-notify on it
without committing to an apply policy.

Single method:

- **`check`** — reads a docker host inventory (from `@lint/docker-host`),
  deduplicates by `image:tag`, queries the registry's manifest API for each
  unique image to get the current digest, compares against the local digest
  inspected from each container, and emits an `inventory` resource listing
  per-image update availability.

## Install

```bash
swamp extension pull @lint/image-updates
```

You'll typically also want `@lint/docker-host` to produce the inventory input.

## Create an instance

```bash
swamp model create @lint/image-updates updates \
  --global-arg "dockerHostInventory={{ data.latest('@lint/docker-host', 'inventory') }}" \
  --global-arg instanceLabel=homelab
```

The model handles Docker Hub, GHCR, lscr.io, and other registries that follow
the standard `/v2/<name>/manifests/<tag>` schema. Private registries
requiring auth need a per-registry credentials arg (see source for shape).

## Run the check

```bash
swamp model method run updates check
swamp data get inventory --json | jq '.byContainer[] | select(.updateAvailable)'
```

The `inventory` resource lists every container, marking which have updates,
which are pinned (image without a tag is treated as pinned by digest),
and which couldn't be checked.

## Resources

| Resource    | Lifetime | Description                                                |
| ----------- | -------- | ---------------------------------------------------------- |
| `inventory` | infinite | Per-container: image, localDigest, registryDigest, updateAvailable. |

## Compatibility

Works against any registry that exposes the Docker Registry HTTP API V2
manifest endpoint with anonymous reads (Docker Hub, GHCR, quay.io, lscr.io,
etc.). Authenticated registries need a credential helper extension.

## License

MIT — see [LICENSE.txt](./LICENSE.txt).
