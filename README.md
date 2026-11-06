# Gety Sample Connector

This is a minimal runnable Gety custom connector for Gety 0.6.6 or later. It
runs in Gety's sandbox without any permissions and emits a small set of fixed
documents that link to <https://gety.ai/>.

## Files

- `manifest.json` declares the connector metadata and uses `dist/main.js` as the
  Gety runtime entry.
- `src/index.ts` contains the connector source code.
- `dist/main.js` is the committed build output loaded by Gety.
- `dist/main.js.map` is committed to make debugging the bundled entry easier.
- `package.json` publishes the connector on npm. `deno task sync` derives its
  `version`, `description`, `files` and `gety` from `manifest.json`.
- `CHANGELOG.md` holds the release notes Gety shows for each npm version.
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

`deno task verify` updates `package.json` from `manifest.json`, formats code,
applies safe lint fixes, checks that `vendor/gety-deno/` is unmodified, runs
type checking and tests, then builds. `deno task build` only regenerates
`dist/main.js` and `dist/main.js.map` for fast local iteration.

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

Unit tests use Deno's built-in test runner and cover stable connector behavior
and the live runner (`dev/`). They do not require network access.

## Live Runner

```bash
cp .env.example .env
deno task runner -- --reset-state
```

`dev/runner.ts` runs the connector the way Gety does. It is not sample-specific:
it reads `manifest.json`, builds config values from `.env`, and starts Gety's
own runner (`vendor/gety-deno/host/runner.ts`) in a separate Deno process with
the sandbox arguments Gety derives from the manifest `permissions`
(`dev/sandbox.ts`; a manifest without `permissions` runs with full access, as in
Gety). Each poll is a fresh process that imports the manifest `entry`
(`dist/main.js` by default), creates the connector with its `config`,
`lastState`, `signal`, `dataDir` and `homeDir`, then runs `onLoad()` and
`poll()`.

An access that the manifest does not grant fails the poll with the message Gety
shows, for example:

```text
permission denied: net access to "example.com:443" is not granted by the connector's manifest
```

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

`summary.json` also records each poll's outcome and the Deno arguments the
runner used.

The state is committed as in Gety: only when the poll finishes successfully, and
then saved to `dev/.runner/state.json` before the next poll starts. A failed or
cancelled poll leaves it unchanged, so repeated runs exercise incremental sync
and replays. Use `--reset-state` to start from an empty state. `this.dataDir` is
`dev/.runner/data/` (also the working directory) and is kept between runs; the
temporary folder is created for each poll and deleted after it. Ctrl+C cancels a
poll: like Gety, the runner closes the connector process's stdin, which aborts
`this.signal`, and kills the process if it has not exited 5 seconds later (a
Ctrl+C in the terminal also interrupts the connector process directly).

Optional flags (`deno task runner -- --help` lists them all):

```bash
deno task runner -- --polls 3 --interval 60
deno task runner -- --state dev/.runner/sample-state.json --out-dir dev/runs
deno task runner -- --permissions '{"net":["api.example.com"]}'
deno task runner -- --full-access
```

`--permissions` tries another `permissions` value without editing the manifest,
and `--full-access` runs without the sandbox. The runner uses the `deno` on your
`PATH` (or `--deno <path>`, or `DENO_BIN`); Gety runs connectors with the Deno
it bundles.

## Permissions

`permissions` in `manifest.json` decides what the connector's process may do,
and Gety shows it to the user before every install. This sample only builds
documents from constants, so it declares `"permissions": {}`: Gety runs it in
its sandbox with only the base access every sandboxed connector has (its data
folder `this.dataDir`, a temporary folder that is deleted after each sync, basic
system information and its own code). Declare only what your connector needs,
for example:

```json
{
	"permissions": {
		"net": ["api.example.com"],
		"read": ["~/Documents/notes"]
	}
}
```

Without `permissions` (or with `"unrestricted"`), a connector runs with full
access to everything the user can do. Broad grants such as `"*"` in `net`, `"~"`
in `read` or any `run` entry make the user confirm the install a second time.
The sandbox needs Gety 0.6.6 or later, so the manifest sets
`min_gety_app_version` to `0.6.6` and older versions refuse to install it.

Gety does not open a document link that points into a connector's own folders or
to a file that does not exist, so link documents to the upstream service (as
this sample does with `metadata.url`) or to the user's own files.

All entries (`net`, `read`, `env`, `run` and values taken from config fields),
the base access and the errors are described in the
[connector reference](https://docs.gety.ai/connector-reference#permissions).

## Sync Lifecycle

`src/index.ts` follows the rules every connector must follow:

- **Replay-safe state.** Gety saves the `state` a poll yields only after the
  whole poll succeeds, and it may already have indexed part of the updates of a
  poll that then fails. The next poll starts again from the previous state, so
  derive updates from `lastState` and stable document ids so that a replay ends
  with the same documents.
- **Cooperative cancellation.** Check `this.signal` between units of work and
  pass it to `fetch()` and other long calls. Gety kills a connector that has not
  stopped 5 seconds after cancelling it.
- **Heartbeats.** Gety cancels a poll that yields no batch and logs nothing for
  10 minutes. During long operations, yield batches or log a low-frequency
  progress line with `console.info()`; console output goes to Gety's log.

## Install In Gety

1. Open Gety's settings and go to Connectors.
2. Choose **Install from local folder** and select this repository.
3. Gety shows the permissions to review ("This connector declares no
   permissions."). Choose **Install**.
4. Wait for the first sync to finish, then search for `Gety Sample Connector`.

After changing `src/index.ts`, run `deno task build`, then use **Restart** in
Gety to load the new `dist/main.js`. **Rebuild index** in the connector's menu
deletes its documents and syncs again from an empty state.

## Make It Your Own

Before publishing a connector built from this sample, give it its own identity:

- `id` in `manifest.json`: prefix it with your own name (`acme-notes`, not
  `notes`). Gety identifies an installed connector by its `id`, so a connector
  with the same `id` cannot be installed next to yours, and changing it after
  publishing makes users install a second copy.
- `name`, `description` and `author` in `manifest.json`.
- `name`, `homepage`, `bugs` and `repository` in `package.json`, then run
  `deno task sync`.
- On npmjs.com, a trusted publisher for your package, so that pushing a tag
  publishes it ([Publishing On npm](#publishing-on-npm)).

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
`gety connector install --github <owner>/<repo> --version <tag>`. The **View
documentation** link in Gety's install review, and in the **Configure** dialog
of a connector installed from GitHub, opens the Release's page.

```bash
deno task build
deno task package
```

`deno task package` writes both assets to `release/` and checks them against
these rules. It packages `manifest.json`, the manifest `entry` and its `.map`,
and the manifest `icon`; add other files or directories with `--include <path>`.
Pass `--tag <tag>` to also check the tag against the manifest version.

To publish, bump `version` in `manifest.json`, run `deno task verify`, commit,
then push a matching tag:

```bash
git tag v0.2.0
git push origin v0.2.0
```

`.github/workflows/release.yml` then runs `deno task verify` at the tag,
packages the fresh build (a committed `dist/` that differs is ignored), creates
the Release as a draft, uploads the two assets, publishes it (as a pre-release
when the version has a pre-release part), and downloads both assets again to
check them. The same tag also publishes the npm package
([Publishing On npm](#publishing-on-npm)).

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

## Publishing On npm

Users can also install the connector from npm: **Install from remote** in Gety's
Connectors settings with the package name (`gety-sample-connector`) or its
npmjs.com link, or `gety connector install --npm gety-sample-connector`. Gety
reads the manifest from the `gety` object in `package.json`, not from a
`manifest.json` in the package. `deno task sync` (part of `deno task verify`)
keeps `manifest.json` the single source:

- `gety` is the complete manifest, and `version` equals `gety.version`.
- `files` lists the entry, its source map, the manifest `icon` if there is one,
  and `CHANGELOG.md`; npm packs only these, `package.json` and the README. Add
  any other file the connector loads at run time in `scripts/sync-package.ts`.
- `description` is the first line of the manifest `description`.

Set `homepage` to an http(s) link to the connector's documentation, such as its
README: the **View documentation** link in Gety's install review, and in the
**Configure** dialog once the connector is installed, opens it. Without an
http(s) `homepage`, the link opens the version's page on npmjs.com.

To publish, bump `version` in `manifest.json`, add a section for it to
`CHANGELOG.md`, run `deno task verify`, commit, then push the tag `v<version>`
as in [Publishing On GitHub](#publishing-on-github).
`.github/workflows/npm-publish.yml` then runs `deno task verify` at the tag,
checks the tag against the package `version` and runs `npm publish` with npm
trusted publishing, so the repository needs no npm token. The workflow is
separate from `release.yml`, which other repositories call.

npm accepts a trusted publisher only for a package that already exists, so
publish the first version by hand, then add the trusted publisher on the
package's settings page on npmjs.com (GitHub Actions, this repository, workflow
`npm-publish.yml`). The workflow skips a version that is already on npm.

```bash
deno task verify
npm publish
```

`npm publish` first runs `deno task sync:check`, which fails when `package.json`
is out of date or a file it lists is missing.

- Gety installs the version the `latest` dist-tag points to, or the exact
  version a user names (`gety-sample-connector@0.3.0-beta.1`, its npmjs.com
  version page, or `--version`). npm requires a dist-tag for a pre-release; the
  workflow publishes pre-releases under `next` (by hand:
  `npm publish --tag next`).
- Gety offers a version as an update when it is higher than the installed one,
  not a pre-release, not deprecated and runs on the user's Gety; the `latest`
  dist-tag plays no part in this.
- The release notes are the `CHANGELOG.md` section whose heading is the version
  (`## 0.2.0`). Keep the sections of older versions.
- A published version cannot be changed or republished, so its permissions are
  fixed. Withdraw a broken version with
  `npm deprecate gety-sample-connector@0.2.0 "<reason>"`: Gety never offers a
  deprecated version as an update.
- When a release cannot continue from what an older release synced (the `state`
  changes shape or document ids change), increase `sync_version` in
  `manifest.json` (1 when absent). Gety then deletes the connector's documents
  and syncs from scratch on upgrade.
- When the system region is mainland China, Gety reads from npmmirror first,
  which usually picks up a new version within a few minutes.

More rules (tarball limits, version switching, what carries over):
[Publish on npm](https://docs.gety.ai/build-a-connector#publish-on-npm).

To list a published connector under **Featured connectors** > **Community** in
Gety, register it as described in the
[gety-connectors contribution guide](https://github.com/gety-ai/gety-connectors/blob/main/CONTRIBUTING.md).
A listed connector needs a manifest `icon`, which this sample does not have: add
one before registering (`deno task sync` adds it to `files`).
