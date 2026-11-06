# Design — pluginlet

This is the reasoning behind the package, not a user guide (that is `README.md`).

## 1. The unit of extension

A repository is the distribution unit. `*.pluginlet` files travel with the code they serve, so a
checkout, a branch, or an old tag carries the tooling of that exact revision. Nothing here is
published, installed per profile, or versioned separately.

That choice creates the central problem: **a repository is untrusted input**, and we are about to
run its code inside the user's harness. Everything below follows from that sentence.

## 2. One tab per pluginlet

The Conversation View seat is a list: `对话` and `轨迹` are two registrations, and each `*.pluginlet`
in the current workspace is one more. So the tab bar reads `对话 / 轨迹 / hello / schema` — the
workspace decides which pluginlets exist, not the plugin.

The client cannot ask the shell "which session is on screen" and there is no per-session filter on
slot registrations, so the plugin registers a **renderless probe** in
`conversation.session.header.actions`. That probe receives the session id, looks up its `cwd`, and
whenever it changes the plugin disposes the previous tab set and registers one view per pluginlet:

```
probe(sessionId) ──▶ cwd ──▶ discover(cwd) ──▶ register("conversation.view", id = we:<relative>)
                                                 label = <file name without .pluginlet>
                                                 inject(sessionId) = { root, path, name }
```

Disposal and registration are synchronous; discovery is one Host read. A session switch therefore
swaps the whole tab set, and a session without a workspace leaves the bar alone.

Trade-off, stated plainly: registrations are process-wide, so between the session switch and the
discovery reply the previous workspace's tabs are briefly gone, and a file added while a session
stays open appears only after the next session switch or page reload.

## 3. Layering

```
repo/.dsh/pluginlets/*.pluginlet
      │  read (Host, ctx.fs, workspace-contained)
      ▼
[ scanner ]        lexical pass: blocked constructs + declared capabilities + content hash
      │
      ▼
[ grants ]         $DSH_HOME/pluginlet/grants.json, keyed root → path → hash
      │  authorize(hash, requested capabilities) — dev mode comes from plugin Config
      ▼
[ source route ]   serves the bytes once, records the issued hash
      │
      ▼
[ iframe ]         sandbox="allow-scripts" (opaque origin) + CSP default-src 'none'
      │  postMessage capability calls only
      ▼
[ bridge ]         parent checks the issued hash + local budget, then the Host route
      │
      ▼
[ host routes ]    fs reads / network / confirmed writes, audited
```

Two independent fences, deliberately not merged:

- **The sandbox is the boundary.** The frame has an opaque origin, no network, no parent DOM. The
  forbidden constructs are inert because their globals do not exist there. Even a successful scan
  bypass cannot escalate.
- **The scanner is the policy gate.** It decides *what to ask the user for*, and refuses sources
  that are obviously trying to leave the box. It is lexical and honest about that.

## 3.5 Where the two permission surfaces live

Approval is a **moment**: a pluginlet wants to run, the person sees the exact capability and path
scopes, one dialog. That has to happen in the pluginlet's own tab, because only there is the context
present.

Management is a **place**: the plugin's configuration page in the sidebar
(`plugins.row.config`, key `<package>#<row id>`). It lists the workspaces the harness already knows
(via the standard `useWorkspaces` hook — no extra Host route), asks each root's `state`, and can
edit a grant: add or remove a path per capability, or drop the capability by emptying it. Saving
reuses the `grant` route with `merge: false` and the **same hash**, because editing a grant changes
its reach, not the approved bytes; the Host re-validates every path, so the page can never widen a
grant beyond what the scanner's model allows (`**` excepted, which is explicit). Keeping it there means the tab stays a tab: the approval card, then the pluginlet and nothing else —
no title bar, no scope chips, no reload or manage controls — what it may touch belongs to the approval moment and the Plugins page,
and switching away and back already remounts and retries.

## 4. Configuration

There is no settings UI in the plugin. The harness owns plugin configuration: the bundle row's
`config` is validated against `Config` and handed to `apply(ctx, config)`, and the same schema is
what the Plugins page and the `Config` inspect provider project.

`Config` is a dependency-free Standard Schema (`~standard.validate`) with a schemastery marker and a
`toJSON()` JSON Schema — the package ships without `node_modules`, so it must not import the
harness, and the marker is what makes the provider offer a form instead of reporting
`unsupported`.

Config owns: `devMode`, discovery patterns (`extensions`, `directories`, `maxEditors`,
`maxEditorBytes`), the three capability switches (`allowRead`, `allowNetwork`, `allowWrite`) and the
network budget (`net`). The Host reads it on every request, so a config change applies to the next
call without a restart of the plugin logic.

What config does **not** own: approvals. A grant is `(root, path, sha256, capabilities)` and belongs
to the content, not to a preference — storing it in config would mean a repo could be approved once
and stay approved while its bytes change.

## 5. Grant model

- A grant is `(capability, path scopes)` for one content hash. Scopes are workspace-relative:
  `docs/a.md` (one file), `docs/` (a subtree), `**` (everything).
- Scopes are **derived from the source**: `api.fs.read('docs/a.md')` and
  `const T = 'docs/a.md'` resolve statically; a computed argument can only be approved as `**`, and
  the dialog says so. The scanner is still a policy gate, not a parser — a literal that looks safe
  and a path that is not are both priced in the same place: the scope the person approves.
- Approval is **partial by default**: the dialog shows one checkbox per scope, so approving an
  pluginlet never silently approves the whole declared surface. It learns what it got through
  `api.access.can(capability, path)` and renders accordingly.
- A running pluginlet may ask for more: `api.access.request(capability, scopes)` raises one more
  confirmation in the host, and the approval **merges** into the same content's grant (union), so it
  never drops what was already approved and never widens past what was ticked.
- The Host re-checks every call against the approved scope (`OUT_OF_SCOPE` otherwise), so a scope
  mistake fails at the call site, not at review time.
- Changing the file changes the hash, which invalidates the grant. There is no "trust this file
  name" state.
- Old records written before scopes existed (a bare capability list) migrate to `**`.
- Grants live under `$DSH_HOME/pluginlet/`, never in the repository: a repo must never be
  able to ship its own approval.
- The set is per hash, so a new capability requires re-approval even when the author believes the
  content is "the same pluginlet".
- The store fails closed: a corrupt `grants.json` authorizes nothing.
- Writes are serialized and published with temp + rename, mode `0600`.
- Every grant, revoke, load, network call and write is appended to `audit.jsonl`.
- `devMode` (config) skips the hash comparison and grants the grantable set; the blocked constructs
  stay refused before the grant is ever consulted.

## 6. Capabilities

| capability | scope | what it actually enables | enforced at |
| --- | --- | --- | --- |
| `fs:read` | exact file, `dir/`, or `**` | `api.fs.read` / `api.fs.list`, ≤ 1 MiB, UTF-8 only | Host route + issued hash + scope check + config switch |
| `net:fetch` | `**` only (for now) | `api.net.fetch`, http(s), no credentials, no private hosts, 10 s, response cap, per-pluginlet budget | Host route (bucket from config) + parent (local budget) |
| `write:request` | exact file, `dir/`, or `**` | `api.write.request` → **confirmation dialog** → Host write with version guard | parent dialog + `confirmed: true` + scope check + `workspace-write` policy |

Forbidden and never grantable: `eval`, `new Function`, `import` / `require`, bare `fetch`, `XHR`,
`WebSocket`/`Worker`, `window`/`document`, `globalThis`/`parent`, browser storage, `process`,
`postMessage`.

Writes are additionally gated by the harness's read-before-edit policy: the target must be read
through the same capability first, and a stale version is refused with `409 STALE`.

## 7. Runtime (in the frame)

A ~450-line React-shaped runtime: `h`, `Fragment`, hooks, and a positional patcher that keeps
element identity (typing survives a re-render). Three shapes are accepted: a component function,
`{ setup() }`, or `{ mount(el, api) }`.

Why not a real framework: the package installs with no build step, so bundling React or Vue and
shipping JSX would require a compiler either at install time or in the browser. Plain JS plus a
tiny runtime keeps the whole thing auditable — the sandboxed code has no `import`, so the runtime
must be injected, and the smallest auditable injected runtime is this one.

## 8. Deliberate limits

- No JSX, no imports. A repository may precompile to plain JS and commit the result.
- One pluginlet per tab; no split view or pinning.
- A runtime request can only add scopes; it cannot add a capability the config disables, and the
  declaration still bounds what the initial dialog offers.
- The tab set follows the session on screen; a new file needs a session switch or reload.
- `async` components patch their resolved tree; state updates during the pending render are dropped.
- No provenance UI: the hash and path are shown, nothing is fetched about where the repo came from.
- The scanner is lexical: a determined obfuscator can hide intent from it. That is acceptable
  because the sandbox — not the scan — is what makes the constructs harmless.
