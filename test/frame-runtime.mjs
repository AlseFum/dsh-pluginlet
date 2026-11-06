/**
 * Exercises the sandbox runtime (the code that is stringified into the iframe)
 * against a minimal DOM stub: mount, hooks, patch identity, events, unmount.
 * Run with `node test/frame-runtime.mjs`.
 */
import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
const start = source.indexOf('function FRAME_RUNTIME() {')
const end = source.indexOf('\n    const FRAME_CSS = [')
assert.ok(start > 0 && end > start, 'FRAME_RUNTIME can be located in client.js')
const runtimeSource = source.slice(start, end).trim()
assert.ok(runtimeSource.endsWith('}'), 'runtime source is a complete function')

/* ── minimal DOM ─────────────────────────────────────────────────────── */

let nodeId = 0
function makeElement(tag) {
  const el = {
    id: ++nodeId,
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    childNodes: [],
    style: {},
    attributes: {},
    listeners: {},
    value: '',
    checked: false,
    disabled: false,
    ownerDocument: null,
    get firstChild() { return this.childNodes[0] ?? null },
    appendChild(child) {
      child.parentNode = this
      this.childNodes.push(child)
      return child
    },
    insertBefore(child, reference) {
      const index = reference === null ? this.childNodes.length : this.childNodes.indexOf(reference)
      child.parentNode = this
      this.childNodes.splice(index < 0 ? this.childNodes.length : index, 0, child)
      return child
    },
    removeChild(child) {
      const index = this.childNodes.indexOf(child)
      if (index >= 0) this.childNodes.splice(index, 1)
      child.parentNode = null
      return child
    },
    replaceChild(next, previous) {
      const index = this.childNodes.indexOf(previous)
      if (index >= 0) {
        this.childNodes[index] = next
        next.parentNode = this
        previous.parentNode = null
      }
      return previous
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value)
      if (name === 'class') this.className = String(value)
      if (name === 'value') this.value = String(value)
      if (name === 'checked') this.checked = true
      if (name === 'disabled') this.disabled = true
    },
    removeAttribute(name) {
      delete this.attributes[name]
      if (name === 'value') this.value = ''
    },
    addEventListener(type, fn) {
      (this.listeners[type] ||= []).push(fn)
    },
    removeEventListener(type, fn) {
      const list = this.listeners[type] || []
      const index = list.indexOf(fn)
      if (index >= 0) list.splice(index, 1)
    },
    set innerHTML(value) {
      if (String(value) !== '') throw new Error('stub innerHTML only supports clearing')
      this.childNodes = []
    },
    get innerHTML() {
      return ''
    },
    set textContent(value) {
      this.childNodes = []
      if (value !== '') this.appendChild(makeText(String(value)))
    },
    get textContent() {
      return this.childNodes.map((child) => child.textContent).join('')
    },
  }
  return el
}
function makeText(data) {
  return {
    id: ++nodeId,
    nodeType: 3,
    get textContent() { return this.data },
    set innerHTML(value) {
      if (String(value) !== '') throw new Error('stub innerHTML only supports clearing')
      this.childNodes = []
    },
    get innerHTML() {
      return ''
    },
    set textContent(value) { this.data = String(value) },
    data: String(data),
    parentNode: null,
  }
}
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (node.nodeType === 3) return node.data
  return node.childNodes.map(textOf).join('')
}
function walk(node, visit) {
  visit(node)
  for (const child of node.childNodes ?? []) walk(child, visit)
}

const root = makeElement('div')
const posted = []
let onPost = null
const documentStub = {
  documentElement: { style: { setProperty() {} } },
  getElementById: (id) => (id === 'root' ? root : null),
  createElement: (tag) => makeElement(tag),
  createTextNode: (text) => makeText(text),
}

const listeners = []
const windowStub = {
  addEventListener(type, fn) { if (type === 'message') listeners.push(fn) },
  postMessage() {},
  document: documentStub,
}

/* ── run the runtime in that fake page ───────────────────────────────── */

const factory = new Function(
  'window',
  'document',
  'parent',
  'Promise',
  'setTimeout',
  'clearTimeout',
  `(${runtimeSource})();\n`,
)
const parentStub = {
  postMessage(message) {
    posted.push(message)
    if (typeof onPost === 'function') onPost(message)
  },
}

factory(
  windowStub,
  documentStub,
  parentStub,
  Promise,
  setTimeout,
  clearTimeout,
)

assert.deepEqual(posted[0], { __we: 1, t: 'ready' })

function send(message) {
  for (const listener of listeners) listener({ data: { __we: 1, ...message } })
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

const editor = `
export default function Editor(api) {
  const [count, setCount] = api.useState(0)
  const [name, setName] = api.useState('')
  return api.h('div', { className: 'panel' },
    api.h('button', { id: 'inc', onClick: () => setCount(count + 1) }, '+1'),
    api.h('input', { value: name, onInput: (event) => setName(event.target.value) }),
    api.h('span', { id: 'label' }, 'count=' + count))
}
`

send({ t: 'init', theme: { '--x': '1' } })
send({ t: 'mount', source: editor, meta: { name: 'demo', path: '/repo/demo.editor' } })
await tick()

assert.equal(root.childNodes.length, 1)
assert.equal(root.childNodes[0].attributes.class, 'panel')
assert.match(textOf(root), /count=0/)

let button = null
let input = null
let label = null
walk(root, (node) => {
  if (node.attributes?.id === 'inc') button = node
  if (node.tagName === 'INPUT') input = node
  if (node.attributes?.id === 'label') label = node
})
assert.ok(button && input && label, 'the tree contains the button, input and label')

// Typing must survive a state change: the input element keeps its identity.
input.value = 'hello'
button.listeners.click[0]()
await tick()
assert.equal(label.childNodes[0].data, 'count=1')
let inputAfter = null
walk(root, (node) => { if (node.tagName === 'INPUT') inputAfter = node })
assert.equal(inputAfter, input, 'patch keeps the same input element')
assert.equal(inputAfter.value, 'hello', 'typing is preserved through the re-render')

// A second click keeps patching the same tree.
button.listeners.click[0]()
await tick()
assert.match(textOf(root), /count=2/)

// setup()-style editors render too.
send({ t: 'mount', source: "export default { setup(api) { return () => api.h('p', null, 'setup ok') } }" })
await tick()
assert.equal(textOf(root).includes('setup ok'), true)

// mount()-style editors take the element imperatively.
send({ t: 'mount', source: "export default { mount(el, api) { el.textContent = 'mounted' } }" })
await tick()
assert.equal(textOf(root), 'mounted')

// A broken editor reports instead of taking the page down.
send({ t: 'mount', source: "export default function Broken() { return api.h('div') }" })
await tick()
assert.ok(posted.some((message) => message.t === 'error'), 'runtime errors are reported to the host')

// api.access: read what is granted now, ask for more, and see the new answer.
onPost = (message) => {
  if (message.t === 'call' && message.method === 'access.request') {
    send({ t: 'result', id: message.id, ok: true, value: { granted: true, scopes: { 'fs:read': ['docs/'] } } })
  }
}
const accessEditor = `
export default function Access(api) {
  const [ok, setOk] = api.useState(api.access.can('fs:read', 'docs/a.md'))
  return api.h('button', { id: 'ask', onClick: function () {
    api.access.request('fs:read', ['docs/']).then(function () { setOk(api.access.can('fs:read', 'docs/a.md')) })
  } }, ok ? 'yes' : 'no')
}
`
send({ t: 'mount', source: accessEditor, scopes: {} })
await tick()
let ask = null
walk(root, (node) => { if (node.attributes?.id === 'ask') ask = node })
assert.equal(textOf(ask), 'no', 'nothing granted yet')

ask.listeners.click[0]()
await tick()
await tick()
let after = null
walk(root, (node) => { if (node.attributes?.id === 'ask') after = node })
assert.equal(textOf(after), 'yes', 'the approved scope is visible to the editor')

// The mount payload seeds the same answer for a fresh frame.
send({ t: 'mount', source: accessEditor, scopes: { 'fs:read': ['docs/'] } })
await tick()
let seeded = null
walk(root, (node) => { if (node.attributes?.id === 'ask') seeded = node })
assert.equal(textOf(seeded), 'yes', 'a mount payload carries the current scopes')

// Unmount clears the surface.
send({ t: 'unmount' })
assert.equal(root.childNodes.length, 0)

console.log('  ok  runtime boots and reports ready')
console.log('  ok  component + hooks mount and re-render')
console.log('  ok  patch keeps input identity and typed value')
console.log('  ok  setup() and mount() shapes work')
console.log('  ok  runtime errors are reported to the host')
console.log('  ok  api.access reads scopes, requests more, and re-evaluates')
console.log('  ok  unmount clears the surface')
console.log('\n7 checks passed')
