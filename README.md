# Gety Sample Connector

This is a minimal runnable Gety custom connector. It emits a small set of fixed
documents that link to <https://gety.ai/>.

## Files

- `manifest.json` declares the connector metadata and uses `dist/main.js` as the
  Gety runtime entry.
- `src/index.ts` contains the connector source code.
- `dist/main.js` is the committed build output loaded by Gety.
- `dist/main.js.map` is committed to make debugging the bundled entry easier.
- `vendor/gety-deno/` is a byte-exact copy of Gety's Deno connector runtime: the
  SDK, the host runner and the manifest JSON Schema (`manifest.schema.json`).
  `@gety-ai/connector-sdk` resolves to `vendor/gety-deno/sdk/src/mod.ts` for
  type checking and tests.
- `src/gen/manifest.d.ts` is generated from `manifest.json` by
  `deno task generate`, `deno task check`, or `deno task build`.

## Build

```bash
deno task verify
deno task build
```

The build keeps `@gety-ai/connector-sdk` external. Gety supplies the real SDK at
runtime through its import map.

`deno task verify` formats code, applies safe lint fixes, checks that
`vendor/gety-deno/` is unmodified, runs type checking and tests, then builds.
`deno task build` only regenerates `dist/main.js` and `dist/main.js.map` for
fast local iteration.

### Updating the SDK

Do not edit `vendor/gety-deno/`: `deno task sync-sdk:check` fails when a file
differs from the hashes in `vendor/gety-deno/SOURCE.json`, which also records
the Gety commit and version the copy comes from. Maintainers refresh it from a
Gety checkout:

```bash
deno task sync-sdk <gety checkout> --ref <rev>
```

## Test

```bash
deno task test
deno task verify
```

Unit tests use Deno's built-in test runner and cover stable connector behavior.
They do not require network access.

## Live Runner

```bash
cp .env.example .env
deno task runner -- --reset-state
```

`dev/runner.ts` is a generic local runner for the Gety connector runtime
contract. It is not sample-specific: it reads `manifest.json`, imports the
manifest `entry` (`dist/main.js` by default), builds config values from `.env`,
injects `config`, `lastState`, and `signal`, then runs `onLoad()` and `poll()`.
Each poll cycle creates a fresh connector instance and runs `onLoad()`, matching
Gety's one-shot Deno runner lifecycle.

Config environment variables are derived from manifest field IDs. For example, a
field named `api_key` can be set as `GETY_CONFIG_API_KEY` or `API_KEY`, and a
nested field named `auth.api_key` can be set as `GETY_CONFIG_AUTH_API_KEY` or
`AUTH_API_KEY`. This sample connector has no config fields, so `.env.example`
only documents that no values are required. Optional fields without `.env`
values use the same implicit defaults as Gety's install form: strings become
`""`, numbers become `0`, and checkboxes become `false`.

Runner output is written outside git:

```text
dev/runs/<timestamp>/
  summary.json
  state.before.json
  state.after.json
  updates.json
  deletes.json
  docs/
    0001-<doc_type>__<doc_id>.md
    0001-<doc_type>__<doc_id>.json
```

The persistent runner state lives at `dev/.runner/state.json`, so repeated runs
exercise incremental sync. Use `--reset-state` to start from an empty state.
Optional flags:

```bash
deno task runner -- --polls 3 --interval 60
deno task runner -- --state dev/.runner/sample-state.json --out-dir dev/runs
```

## Install In Gety

1. Open Gety's Custom Connectors settings page.
2. Install from local folder and select this repository.
3. Wait for the first poll to finish, then search for `Gety Sample Connector`.

After changing `src/index.ts`, run `deno task build`, then use Restart in Gety
to load the new `dist/main.js`.

## Publishing On GitHub

Gety can install a connector from a GitHub Release instead of a local folder. It
never builds from source; it only downloads two Release assets:

- `manifest.json`, byte-for-byte identical to the `manifest.json` inside the
  zip. Gety downloads only this file to show the permissions before the user
  confirms.
- `<id>-<version>.zip`, with `id` and `version` from the manifest. Its root is
  the connector directory (`manifest.json`, the entry, and every other file the
  connector needs, such as the icon), without a wrapping folder or symbolic
  links. Limits: 100 MiB zipped, 20,000 files and 500 MiB unpacked.

The tag must equal the manifest `version`, optionally prefixed with `v`
(`v0.2.0` for `0.2.0`). Gety installs the Release marked Latest by default;
pre-releases (`v0.2.0-beta.1`) install only through their Release link
`https://github.com/<owner>/<repo>/releases/tag/<tag>` or
`gety connector install --github <owner>/<repo> --version <tag>`.

```bash
deno task build
deno task package
```

`deno task package` writes both assets to `release/` and checks them against
these rules. It packages `manifest.json`, the manifest `entry` and its `.map`,
and the manifest `icon`; add other files or directories with `--include <path>`.
Pass `--tag <tag>` to also check the tag against the manifest version.

To publish, bump `version` in `manifest.json`, commit, then push a matching tag:

```bash
git tag v0.2.0
git push origin v0.2.0
```

`.github/workflows/release.yml` then runs `deno task verify` at the tag,
packages the fresh build (a committed `dist/` that differs is ignored), creates
the Release as a draft, uploads the two assets, publishes it (as a pre-release
when the version has a pre-release part), and downloads both assets again to
check them.

Other connector repositories reuse the workflow with
`.github/workflows/release.yml`:

```yaml
name: Release

on:
  push:
    tags: ['v*']

jobs:
  release:
    uses: gety-ai/gety-sample-connector/.github/workflows/release.yml@main
    permissions:
      contents: write
    # with:
    #   build-command: deno task verify # default
    #   include: |
    #     data/
```
