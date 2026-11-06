# Writing a pluginlet

A pluginlet is **one JavaScript file** at `<repo>/.dsh/pluginlets/<name>.pluginlet`. The harness
mounts each one as its own tab beside Chat and Trajectory. Nothing is installed and nothing is
published: the file travels with the repository, so whoever checks the repository out gets the tab.

```
<repo>/.dsh/pluginlets/hello.pluginlet   ->  tab named "hello"
```

Only `.dsh/pluginlets/` is scanned. A `*.pluginlet` anywhere else is ignored.

## Rules the scanner enforces

These are checked **before** the file is ever loaded, by stripping literals and comments and matching
the remaining code. Any hit means the pluginlet can never be approved, so don't ship one:

| blocked | use instead |
| --- | --- |
| `import`, `require()`, dynamic `import()` | keep everything in the one file |
| `eval`, `new Function` | plain code |
| bare `fetch()`, `XMLHttpRequest`, `EventSource`, `sendBeacon` | `api.net.fetch(url, init)` |
| `WebSocket`, `Worker`, `SharedWorker` | nothing — no connections, no threads |
| `localStorage`, `sessionStorage`, `indexedDB`, `cookie` | component state |
| `process`, `Deno`, `Bun` | nothing |
| `globalThis`, `self.`, `top.`, `parent.` | nothing |
| `postMessage`, `addEventListener('message')` | the host channel is private |
| `navigator.` | nothing |

There is no JSX and no compiler: build nodes with `api.h`.

## Export shapes

Exactly one `export default`, one of three shapes.

### 1. Component function (the usual choice)

```js
export default function Notes(api) {
  const [text, setText] = api.useState('')
  const [file, setFile] = api.useState(null)
  api.useEffect(() => {
    api.fs.read('notes/scratch.md').then(setFile, (error) => api.ui.toast(error.message))
  }, [])
  return api.h('textarea', { value: text, onChange: (e) => setText(e.target.value) })
}
```

`api` is the only prop. Hooks: `useState`, `useEffect`, `useMemo`, `useRef`, `useCallback`.
Initial render is synchronous — put anything awaited into state.

### 2. Setup returning a render function

```js
export default function Counter(api) {
  let count = 0
  return { setup: () => () => api.h('button', { onClick: () => { count += 1 } }, String(count)) }
}
```

### 3. Imperative `mount`

```js
export default {
  mount(rootEl, api) {
    const doc = rootEl.ownerDocument          // the frame's own document
    const canvas = doc.createElement('canvas')
    rootEl.appendChild(canvas)
    const ctx2d = canvas.getContext('2d')
    // draw here; nothing re-renders for you
  },
}
```

Use it when you need a real DOM node (`canvas`, measurements, drag). Reach the frame's `document`
through `rootEl.ownerDocument`, not the `document` global.

## The `api` object

| call | returns | notes |
| --- | --- | --- |
| `api.h(tag, props, ...children)` | node | `className`, `style` object, `onClick`/`onChange`, `value`, `checked`, `disabled` are supported |
| `api.Fragment` | fragment tag | |
| `api.useState(v)` / `useEffect` / `useMemo` / `useRef` / `useCallback` | as React | positional patching keeps input focus |
| `api.fs.read(path)` | `{ text, path, version, size }` | one file |
| `api.fs.list(path?)` | `{ entries: [{ name, path, kind, size }] }` | a directory; omit for the workspace root |
| `api.write.request(path, text, version)` | `{ path, version, operation }` | shows a confirmation dialog; `409 STALE` if the file changed since `version` |
| `api.net.fetch(url, init)` | `{ status, ok, text, ... }` | rate-limited, private networks refused |
| `api.ui.toast(message)` | `true` | transient notification |
| `api.access.scopes()` | `{ capability: [paths] }` | what is approved right now |
| `api.access.can(capability, target)` | boolean | would this call be allowed? |
| `api.access.request(capability, paths)` | `{ granted, scopes }` | asks the user for more reach at runtime |
| `api.meta` | `{ name, path }` | this file |
| `api.version` | `1` | api version |

Paths are **relative to the workspace root**; `''` or `'.'` is the root, `'notes/scratch.md'` is a
file. Absolute paths and `..` are refused by the host.

## Permissions

The same scan extracts capabilities from your calls: `api.fs.read` / `api.fs.list` → `fs:read`,
`api.net.fetch` → `net:fetch`, `api.write.request` → `write:request`.

Each capability carries **path scopes**, and a grant is bound to the **sha256 of the source**. So:

- a literal `api.fs.read('notes/scratch.md')` asks for exactly that file;
- a top-level `const TARGET = 'notes/scratch.md'` used in the call asks for the same;
- a template without `${}` is fine;
- anything computed at runtime (a variable, concatenation, an absolute path, `..`) degrades to
  `**` — the whole workspace — and the approval dialog says so;

**Write down your paths as literals or top-level constants.** That is the difference between
"may read this one file" and "may read the whole workspace".

Editing the file changes the hash and asks again, unless the profile enables `devMode`. Writes always
need a click, whatever the grant says.

Ask for more at runtime only when you must:

```js
const need = 'docs/'
if (!api.access.can('fs:read', need)) {
  const answer = await api.access.request('fs:read', [need])
  if (!answer.granted) return api.h('p', null, 'no access to ' + need)
}
```

## Gotchas

- **Save with the version you read.** `api.write.request(file.path, text, file.version)` — passing
  `undefined` writes blind and loses concurrent edits.
- **Errors are invisible if you swallow them.** Render the message; the user cannot see the console.
- `setInterval` is throttled to ≥ 250 ms.
- The source is capped (`maxEditorBytes`, 512 KB by default). Keep it lean.
- The frame has no same-origin access to the harness page, no cookies, no storage, and no network
  except the proxy. That is the security boundary, not an inconvenience.
- Styling: read theme tokens with `var(--dsw-alias-label-primary, #1b1b1b)` etc. so light and dark
  both work, and give every token a literal fallback.
- The tab shows **only your UI** — no title bar, no permission chips. If something should be
  visible (a file name, a dirty marker), render it yourself.

## Checklist before you open the tab

1. One file, `export default`, no `import`.
2. Every path a literal or a top-level `const`.
3. All `api.*` promises handled and their errors rendered.
4. Save path passes `version`.
5. Reload after editing: saving the file re-scans it, and a changed hash asks for approval again.
