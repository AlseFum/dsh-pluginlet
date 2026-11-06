# Releasing

The package is already named `dsh-pluginlet`, so there is nothing to rename at release time. The
build copies the shipped files into `dist-publish/`, adds `LICENSE`, drops the test tree and verifies
the identifiers; the install this profile runs from stays untouched.

## 1. Build the publishable copy

```bash
node scripts/release.mjs --version 0.1.0 \
  --author "Your Name <you@example.com>" \
  --repo https://github.com/AlseFum/dsh-pluginlet
```

`dsh-pluginlet` is free on npm (checked 2026-11). The build writes `dist-publish/` and:

- copies the shipped files, **without** `test/` and without `scripts/`;
- writes `package.json` (drops `private`, keeps name/version/files, adds `publishConfig`);
- writes `LICENSE`;
- verifies the copy: the client module id, the patch row name and the config-page key equal the
  package name, the README's install line points at the npm name, and every module passes
  `node --check`.

It ends with `built … -> dist-publish`. `--name` is only needed to publish under a different name.

## 2. Check the artifact

```bash
cd dist-publish
npm pack --dry-run            # 14 files, ~47 kB, no tests
CLIENT_PATH=$PWD/client.js node ../test/client-registration.mjs   # the real registration check
```

## 3. Publish

```bash
npm login                     # once per machine
cd dist-publish
npm publish --access public   # publishes dsh-pluginlet@0.1.0
```

`--access public` is only needed for scoped names, but it is harmless to pass and makes the intent
explicit. If your account has 2FA, npm asks for the one-time code.

### Without npm (three alternatives)

| route | how | when |
| --- | --- | --- |
| tarball | `npm pack` in `dist-publish`, hand over the `.tgz`, users run `dsh plugin --profile web add ./dsh-pluginlet-0.1.0.tgz` | a few people, no registry |
| git | push `dist-publish/` as its own repo, users run `dsh plugin --profile web add github:AlseFum/dsh-pluginlet` | you want the source public but have no npm account |
| marketplace listing | submit the npm name to the community catalogs (see below) | after the package exists |

For the git route the committed `package.json` must already carry the final name — that is exactly
what `dist-publish/package.json` is.

## 4. After publishing

Test from a clean profile before announcing:

```bash
dsh --profile scratch plugin add dsh-pluginlet@0.1.0
dsh --profile scratch web --port 4002
```

Open a session on a repository containing `.dsh/pluginlets/*.pluginlet` and confirm the tab appears, the
approval dialog lists the paths, and the plugin page shows the grant.

Then list it where people look:

- **awesome-dsh-plugin** (the catalog behind `dsh-plugin-catalog` and the Plugins → Discover index):
  open a PR against `github.com/awesome-dsh-plugin/awesome-dsh-plugin`.
- **dsh-market** (`dshmarket` package): it reads the published npm metadata, so a good
  `description`, `keywords` and `README` are what make the listing useful.
- Announce with the security model in the first paragraph: this plugin runs repository code inside a
  sandboxed iframe, reads workspace files through a host proxy, and every write needs a click.

## What counts as a breaking change

Pre-1.0 the format is still moving; every one of these is worth a minor bump and a CHANGELOG line.

| change | effect |
| --- | --- |
| a new required entry in `Config` | users keep defaults, not breaking |
| renaming/removing a `Config` key | silently falls back to the default |
| changing the grant file schema | old grants must keep loading — the store migrates, keep it that way |
| changing `/api/pluginlet/*` request/response shapes | host and client ship together, so only matters if someone calls the routes directly |
| changing the row id (`pluginlet`) | breaks the `plugins.row.config` key and clashes with an existing install |
| dropping a `*.pluginlet` capability | editors that use it stop loading; document it |

Bump `version` in the build command; the working copy's own version does not matter.

## Known collision

The row id is `pluginlet` for both the `@local/` package and the published one. Installing
both into one profile puts two bundle layers that insert the same row: remove one first.

```bash
dsh plugin --profile web remove dsh-pluginlet
dsh plugin --profile web add dsh-pluginlet@0.1.0
```

then restart `dsh web` so the host half reloads.

## Checklist

- [ ] `npm test` passes (smoke, styles, config, skill, client-registration, frame-runtime, host-ops)
- [ ] the UI tests pass if you changed the client (`WE_TEST_MODULES=… node test/view-flow.mjs`,
      `access-flow.mjs`, `perm-page.mjs`) — they stub the host, so no live server is needed
- [ ] `node scripts/release.mjs --name … --version …` prints `built …` with no verification error
- [ ] `npm pack --dry-run` shows no `test/` and no absolute paths
- [ ] README install command and config-page key mention the published name
- [ ] the security section of the README is accurate for what the release actually does
- [ ] `CHANGELOG.md` has an entry for the version being published
- [ ] `npm test` and the four jsdom UI tests pass
