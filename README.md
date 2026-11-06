# pluginlet

> **Status: experimental, source-only for now.** The package is not on npm yet; it installs from
> this repository's git URL. The release tooling (`scripts/release.mjs`, `RELEASING.md`) is in
> place but has deliberately not been run against a registry — see "Releasing" when that changes.

Each `*.pluginlet` file in the workspace becomes **its own Conversation View tab**, so the tabs read
`对话 / 轨迹 / hello`. The repository carries its own pluginlets; whoever checks the
repository out gets them, with no npm publish and no profile install per project.

Settings are not part of the plugin UI: they live in the harness's plugin configuration
(**Plugins → Pluginlet**, or the `config:` block of this bundle's row).

| key | default | meaning |
| --- | --- | --- |
| `devMode` | `false` | accept a changed hash without re-approval (still audited; writes/network/reads still capped) |
| `extensions` | `['.pluginlet']` | which file names count as pluginlets |
| `directories` | `['.dsh/pluginlets']` | where to look, relative to the workspace root |
| `maxEditors` | `64` | discovery cap |
| `maxEditorBytes` | `524288` | per-pluginlet source cap |
| `allowRead` / `allowNetwork` / `allowWrite` | `true` | whether those capabilities may be offered at all |
| `net` | `{ perMinute: 20, perHour: 240, maxBytes: 1048576 }` | network budget per pluginlet |

```
repo/
  .dsh/pluginlets/
    app.pluginlet       ->  a tab named "app"
    schema.pluginlet    ->  a tab named "schema"
    hello.pluginlet     ->  a tab named "hello"
```

Only `.dsh/pluginlets/` is scanned: a stray `*.pluginlet` at the repository root is not a tab.
Add more directories with the `directories` setting if you need them.

## The authoring guide ships with the plugin

Applying the Host half registers one skill, `pluginlet-development`. Once the plugin is installed, any
agent in the profile can load it before writing a pluginlet: it covers the three export shapes, the
`api` surface, every construct the scanner blocks, and the path rules that decide whether the
approval dialog asks for one file or the whole workspace.

The body lives in `skills/pluginlet-development.md`; `node test/skill.mjs` fails if a scanner rule or
a grantable capability is added without the skill documenting it.

## The pluginlet contract

A `.pluginlet` file is plain JavaScript — **no JSX, no imports** (the plugin is installed without a
build step, so there is no compiler in the loop). It exports one of three shapes:

```js
// 1. component (mini React: h + hooks, positional patching keeps input focus)
export default function Editor(api) {
  const [count, setCount] = api.useState(0)
  return api.h('div', { style: { padding: '12px' } },
    api.h('button', { onClick: () => setCount(count + 1) }, '+1'),
    ' ' + count)
}

// 2. setup returning a render function (mini Vue-ish)
export default {
  setup(api) {
    return () => api.h('p', null, 'hello')
  },
}

// 3. imperative escape hatch
export default {
  mount(el, api) { el.textContent = 'hello' },
}
```

`api` is the whole surface:

| member | meaning |
| --- | --- |
| `h`, `Fragment` | create elements |
| `useState`, `useEffect`, `useMemo`, `useRef`, `useCallback` | hooks |
| `fs.read(path)`, `fs.list(path)` | **wrapped** filesystem reads, workspace-contained (capability `fs:read`) |
| `net.fetch(url, init)` | **wrapped** network (capability `net:fetch`), rate-limited and audited |
| `write.request(target, text, version)` | asks the user; **never writes by itself** (capability `write:request`) |
| `ui.toast(message)` | transient message in the host |
| `meta.name`, `meta.path` | this pluginlet's identity |

## Security model

The scanner is a policy gate, not the boundary. The boundary is the sandbox:

- the pluginlet runs in an iframe with `sandbox="allow-scripts"` (opaque origin: no access to the
  app's DOM, storage, or cookies) and a document CSP of `default-src 'none'` (no network, no
  subresources, no fonts, no forms);
- therefore `fs` and `net` exist **only** as `postMessage` calls to the host, which forwards them
  to `/api/pluginlet/*`; every call is budgeted on both sides and written to the audit log;
- a write is impossible without a click in the host's confirmation dialog: the frame's `api` has
  no write primitive, only `write.request`;
- `eval`, `new Function`, `import`/`require`, bare `fetch`, `XMLHttpRequest`, `WebSocket`,
  `process`, `localStorage`, `postMessage`, `navigator` are **blocked by the scan and can never be
  granted**. `document`/`window` are allowed on purpose: inside the frame they are the frame's own
  document, which the imperative `mount(el, api)` form needs, and the opaque origin keeps them away
  from the harness;
- host paths are checked **lexically first and canonically after** (`ctx.fs.contains` on resolved
  targets), so a symlink inside the workspace cannot point a read or a listing outside it;
- the network proxy validates the hostname **and every address it resolves to**, then follows
  redirects by hand so each hop is validated again. A DNS answer that changes between the check and
  the connection (rebinding) is still possible; the proxy is a guard rail, not an egress filter;
- the approval dialog lists each capability with its **path scopes as checkboxes**: you can approve
  a subset, and the pluginlet renders against exactly what it got (`api.access.can`);
- a running pluginlet can ask for more with `api.access.request(capability, scopes)` — one more
  confirmation, and the approval is **merged** into the same content's grant;
- grants bind to the **content hash and a path scope**: a pluginlet that only touches `docs/readme.md`
  is approved for exactly that file, not for the repository. Scopes come from the source itself —
  literals and top-level `const` bindings resolve to exact paths, anything computed at runtime falls
  back to `**` (the whole workspace) and says so in the dialog;
- grants live under `$DSH_HOME/pluginlet/`, never in the repository — a repo cannot ship
  its own approval;
- **development mode** (per workspace, visible banner) accepts new hashes without re-approval and
  grants every grantable capability; blocked constructs stay blocked regardless.

## Host routes

All routes are `POST` under `/api/pluginlet/` and require `x-dsh-plugin: pluginlet`
(a cross-site page cannot send a custom header without a preflight this server never answers).

| route | purpose |
| --- | --- |
| `discover` | list `*.pluginlet` at the root and in `.dsh/pluginlets/`, with content hashes |
| `scan` | static scan: blocked constructs, declared capabilities, notes |
| `source` | serve the source **only** to an authorized hash (records the issued hash) |
| `state` / `grant` / `revoke` / `log` | grants (`capability -> path scopes`), revocation, audit tail |
| `fs/list`, `fs/read` | wrapped reads; the target must sit inside the granted scope, else `OUT_OF_SCOPE` |
| `net/fetch` | wrapped network: http(s) only, no private hosts, 10s timeout, 1 MiB cap, 20/min + 240/h per pluginlet |
| `write` | user-confirmed write, scope-checked, version-guarded (`409 STALE`), explicit `workspace-write` policy |

Every path is resolved inside a registered workspace root; reads go through `ctx.fs`, never raw
`node:fs`.

## Install

```bash
dsh plugin --profile web add github:AlseFum/dsh-pluginlet
```

The full URL (`https://github.com/AlseFum/dsh-pluginlet.git`) works too. The clone is the whole
package, so no build step and no `npm install` are involved.

Config example (profile `cordis.patch.yml`):

```yaml
- id: pluginlet
  config:
    devMode: false
    allowNetwork: false
```

or through the Plugins page (installs as **Pluginlet**). The Host half needs
a `dsh web` restart; the client half takes effect on page refresh.

## Where permissions are managed

Approving still happens in the pluginlet's own tab, at the moment it wants to run: that is the
only moment the person knows what it is about to do, and the dialog lists the exact scopes.

**Managing** happens where plugin configuration lives: the sidebar **Plugins → Pluginlet** row
page (`plugins.row.config`, key `dsh-pluginlet#pluginlet`). For every approved pluginlet it shows the content hash prefix, the approval time, and each capability's paths as
editable chips:

- **×** removes one path; removing a capability's last path drops that capability;
- the input beside a capability adds a path (Enter or **+**) — workspace-relative, `**` for the
  whole workspace, absolute paths and `..` are refused;
- **保存修改** rewrites the grant for the **same content hash**: you are changing its reach, not its
  content, so no re-approval of the bytes is involved; the button stays disabled until something
  actually changed;
- **撤销** removes the grant entirely.

It also refuses to save a grant with no capability left (revoke instead), and the row's summary
view shows how many pluginlets are approved.

The tab itself carries only the approval card and the pluginlet — no title bar, no scope chips,
no reload button, no permission management. What it may touch is visible where you granted it (the
approval card) and editable in the Plugins page. Switching tabs remounts the view, which is the
retry.

## When it does not render

The tab never shows an unexplained blank:

| what you see | meaning | where to look |
| --- | --- | --- |
| 授权卡 | nothing granted for this content yet (or the hash changed) | tick scopes and allow |
| 「正在启动 pluginlet…」 | the frame has been booting for over 400 ms without announcing itself (fast boots show nothing) | wait a beat |
| 「帧没有就绪…」 | the frame never announced within 2.5 s (script blocked or crashed) | `client:frame-stall` in the audit; switch tabs to remount |
| a red line inside the panel | the pluginlet itself threw | the line says what |
| 「12 秒没有响应」 | a Host route stopped answering | `client:host-timeout` in the audit |

Client events land in `$DSH_HOME/pluginlet/audit.jsonl` as `client:*` entries; the tab
reports every phase change there, so a stuck panel says where it stopped.

## Limits (v1)

**Pre-1.0:** the file format (`.pluginlet`), the `api` surface, the grant file and the route shapes
may still change between 0.x releases. Pin a version if you depend on them.

- No JSX: write `api.h(...)`. A repository's own build step can still precompile to plain JS first.
- No imports: a pluginlet is one self-contained file.
- Async components render their resolved tree; state updates during the pending render are dropped.
- Discovery covers the configured `directories` (`['.dsh/pluginlets']` by default). Adding a file
  while a session is open needs a session switch or a page reload before its tab appears.
- Scan results are cached in the browser keyed by `<path>@<content hash>`, so switching tabs away
  and back does not re-scan; the source read is still requested each time because it carries the
  authorization decision.
- The static scan is lexical; it declares intent, it does not prove safety. The sandbox is what
  makes the unsafe constructs inert.

## Tests

```bash
node test/styles.mjs               # 4 checks: every rendered class has a rule, no dead rules,
                                   # colours go through theme tokens
node test/smoke.mjs                # 14 checks: scanner rules, capability detection, hash-bound
                                   # grants, development mode, audit, storage location
node test/config.mjs               # 6 checks: Config defaults, merging, clamping, JSON projection
node test/client-registration.mjs  # 8 checks: one conversation.view per *.pluginlet, labels,
                                   # session switch disposing and re-registering the tab set
node test/host-ops.mjs             # 9 checks driving the Host handlers directly: scopes from a
                                   # const, ** for dynamic paths, merge on runtime requests,
                                   # in/out of scope, write gates, symlink escapes, redirect hops
node test/skill.mjs                # 4 checks: the packaged skill is registered, and its body covers
                                   # every scanner rule and every grantable capability
node test/perm-page.mjs           # 5 checks: the Plugins page lists grants, adds a path to one
                                   # capability and saves it, revokes, empty state
node test/access-flow.mjs          # 4 checks: partial approval -> load with a subset ->
                                   # runtime request -> merged grant -> frame answered
node test/view-flow.mjs            # 6 checks: the real bundle + React in jsdom —
                                   # approval card -> allow -> frame -> ready (regression for
                                   # the "approve does nothing" crash). Needs react/react-dom/jsdom:
                                   #   WE_TEST_MODULES=<node_modules> node test/view-flow.mjs
node test/frame-runtime.mjs        # 7 checks: sandbox runtime against a DOM stub —
                                   # mount, hooks, patch identity, setup()/mount(), errors,
                                   # api.access (read, request, seeded scopes), unmount
```

## A minimal pluginlet

```js
export default function Hello(api) {
  return api.h('div', { style: { padding: '12px' } }, 'hello from ' + api.meta.name)
}
```

Save that as `.dsh/pluginlets/hello.pluginlet`, open a session on the repository, and the tab
appears. Nothing else to configure.

