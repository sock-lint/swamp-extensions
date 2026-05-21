# swamp-extensions

Swamp extensions published by [@lint](https://swamp-club.com/lint) on the
[Swamp Club](https://swamp-club.com) registry.

Each subdirectory is a self-contained extension package that ships via
`swamp extension push`. The source here is the authoritative mirror — the
published bundle is built from the same files.

## Install one

```bash
swamp extension pull @lint/<name>
```

## Index

| Package         | Description                                                                       |
| --------------- | --------------------------------------------------------------------------------- |
| `@lint/adguard` | AdGuard Home control-API wrapper — snapshot + reconcile DNS rewrites idempotently |

More to come — see [swamp-club.com/lint](https://swamp-club.com/lint).

## License

MIT — see [LICENSE](./LICENSE).

## Issues

Bug reports and feature requests welcome via GitHub issues, or via
`swamp issue --extension @lint/<name>`.
