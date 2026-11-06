/**
 * The dynamic-request flow, end to end on the parent side:
 *
 *   approval card -> tick only fs:read -> allow -> the editor loads read-only
 *   -> the frame asks for write:request at runtime -> one more dialog
 *   -> allow -> the grant is MERGED and the answer is pushed back to the frame.
 *
 * Real bundle + real React in jsdom, with a stub Host that implements partial
 * approval and merge. Needs react/react-dom/jsdom:
 *
 *   WE_TEST_MODULES=<node_modules> node test/access-flow.mjs
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const modules = process.env.WE_TEST_MODULES
if (!modules) {
  console.log('  ..  skipped: set WE_TEST_MODULES to a node_modules with react, react-dom and jsdom')
  process.exit(0)
}

const require = createRequire(`${modules}/`)
const { JSDOM } = require('jsdom')
const React = require('react')
const ReactDOMClient = require('react-dom/client')
const { act } = React

const ROOT = '/home/ubuntu'
const EDITOR = `${ROOT}/.dsh/pluginlets/permissions.pluginlet`
const HASH = 'e'.repeat(64)
const TARGET = 'notes/scratch.md'

const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', { url: 'http://127.0.0.1:4001/' })
globalThis.window = dom.window
globalThis.document = dom.window.document
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
globalThis.HTMLElement = dom.window.HTMLElement
globalThis.Element = dom.window.Element
globalThis.Node = dom.window.Node
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window)
globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 0)
globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
globalThis.TextEncoder = TextEncoder
globalThis.IS_REACT_ACT_ENVIRONMENT = true

/* ── stub Host with partial approval + merge ─────────────────────────── */

const grantedScopes = {}
const grantCalls = []
let approved = false

globalThis.fetch = async (url, init) => {
  const route = String(url).split('/').pop()
  const body = init && init.body ? JSON.parse(init.body) : {}
  const reply = (payload, ok = true) => ({ ok, status: ok ? 200 : 403, async json() { return payload } })

  if (route === 'discover') return reply({ ok: true, root: ROOT, items: [{ path: EDITOR, name: 'permissions', relative: '.dsh/pluginlets/permissions.pluginlet', size: 10, hash: HASH }] })
  if (route === 'scan') {
    return reply({
      ok: true, root: ROOT, path: EDITOR, name: 'permissions', hash: HASH, blocked: [],
      capabilities: ['fs:read', 'write:request'],
      scopes: { 'fs:read': [TARGET], 'write:request': [TARGET] },
      dynamic: { 'fs:read': false, 'write:request': false },
      unavailable: [], devMode: false,
    })
  }
  if (route === 'source') {
    // Loading is gated on "approved at all", not on every declared capability.
    if (!approved) return reply({ ok: true, root: ROOT, path: EDITOR, hash: HASH, blocked: [], capabilities: ['fs:read', 'write:request'], denied: true, reason: 'no-grant' })
    return reply({
      ok: true, root: ROOT, path: EDITOR, name: 'permissions', hash: HASH,
      capabilities: ['fs:read', 'write:request'], unavailable: [], scopes: grantedScopes,
      source: "export default function E(api){ return api.h('div', null, 'EDITOR') }\n",
    })
  }
  if (route === 'grant') {
    grantCalls.push(body)
    const merge = body.merge === true
    for (const capability of body.capabilities ?? []) {
      const next = body.scopes?.[capability] ?? []
      const previous = merge && approved ? (grantedScopes[capability] ?? []) : []
      grantedScopes[capability] = Array.from(new Set([...previous, ...next]))
    }
    approved = Object.keys(grantedScopes).length > 0
    return reply({ ok: true, root: ROOT, grants: { [EDITOR]: { hash: HASH, scopes: grantedScopes } } })
  }
  if (route === 'revoke') { approved = false; for (const key of Object.keys(grantedScopes)) delete grantedScopes[key]; return reply({ ok: true }) }
  if (route === 'client-event') return reply({ ok: true })
  return reply({ ok: false, error: { code: 'NO_ROUTE', message: route } }, false)
}

/* ── load the bundle ─────────────────────────────────────────────────── */

let bundle = null
dom.window.__ModuleLoader__ = {
  load({ factory }) {
    bundle = factory((name) => (name === 'react' ? React : (() => { throw new Error(`require(${name})`) })))
  },
}
await import(`${pathToFileURL(new URL('../client.js', import.meta.url).pathname).href}?v=${Date.now()}`)
if (bundle === null) throw new Error('bundle did not register')

const registrations = []
bundle.apply({
  effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
  locale: { register: () => () => {}, bind: () => (key) => key },
  sessions: { list: { getSnapshot: () => ({ byId: { s1: { cwd: ROOT } } }) } },
  slots: {
    inject(name, callback) { callback() },
    register(options, component) { registrations.push({ options, component }); return () => {} },
  },
})

registrations.find((entry) => entry.options.id === 'pluginlet:probe').component({ sessionId: 's1' })
await new Promise((resolve) => setTimeout(resolve, 60))

const tab = registrations.find((entry) => entry.options.id === 'we:.dsh/pluginlets/permissions.pluginlet')
if (tab === undefined) throw new Error('permissions.pluginlet tab did not register')

const container = document.getElementById('host')
const root = ReactDOMClient.createRoot(container)
await act(async () => {
  root.render(React.createElement(tab.component, { ...tab.options.inject('s1'), t: (key) => key }))
  await new Promise((resolve) => setTimeout(resolve, 200))
})

const buttons = () => [...container.querySelectorAll('button')].map((button) => button.textContent)
const text = () => container.textContent.replace(/\s+/g, ' ')

if (!buttons().includes('grantAllow')) throw new Error(`no approval card: ${JSON.stringify(buttons())}`)

// Tick only fs:read: the approval is partial on purpose.
const boxes = [...container.querySelectorAll('input[type=checkbox]')]
if (boxes.length !== 2) throw new Error(`expected two scope checkboxes, got ${boxes.length}`)
let writeIndex = -1
{
  // The dialog alternates capability rows and scope rows.
  const rows = [...container.querySelectorAll('ul.we-caps > li')]
  let current = ''
  for (const row of rows) {
    if (row.classList.contains('we-cap-row')) current = row.textContent.trim()
    else if (current.includes('write:request')) {
      const box = row.querySelector('input[type=checkbox]')
      if (box !== null) { writeIndex = boxes.indexOf(box); break }
    }
  }
}
if (writeIndex < 0) throw new Error('could not find the write:request checkbox')
await act(async () => {
  boxes[writeIndex].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  await new Promise((resolve) => setTimeout(resolve, 50))
})

await act(async () => {
  [...container.querySelectorAll('button')].find((button) => button.textContent === 'grantAllow')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  await new Promise((resolve) => setTimeout(resolve, 500))
})

if (grantCalls.length !== 1) throw new Error(`expected one grant, got ${grantCalls.length}`)
if (JSON.stringify(grantCalls[0].capabilities) !== '["fs:read"]') {
  throw new Error(`the partial approval leaked: ${JSON.stringify(grantCalls[0])}`)
}
if (container.querySelector('iframe') === null) throw new Error('the editor did not load after a partial approval')

/* ── the frame asks for more at runtime ──────────────────────────────── */

const frame = container.querySelector('iframe')
await act(async () => {
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
    data: { __we: 1, t: 'ready' },
    source: frame.contentWindow,
  }))
  await new Promise((resolve) => setTimeout(resolve, 100))
})

const posted = []
frame.contentWindow.postMessage = (message) => posted.push(message)

await act(async () => {
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
    data: { __we: 1, t: 'call', id: 7, method: 'access.request', params: { capability: 'write:request', scopes: [TARGET] } },
    source: frame.contentWindow,
  }))
  await new Promise((resolve) => setTimeout(resolve, 150))
})

if (!text().includes('accessTitle')) throw new Error(`the runtime request did not open a dialog: ${text().slice(-200)}`)

await act(async () => {
  [...container.querySelectorAll('button')].find((button) => button.textContent === 'accessAllow')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  await new Promise((resolve) => setTimeout(resolve, 400))
})

if (grantCalls.length !== 2) throw new Error(`expected a second grant for the runtime request, got ${grantCalls.length}`)
if (grantCalls[1].merge !== true) throw new Error('the runtime request must merge, not replace')
if (grantCalls[1].capabilities[0] !== 'write:request') throw new Error(`unexpected capability: ${JSON.stringify(grantCalls[1].capabilities)}`)
if (JSON.stringify(grantedScopes) !== JSON.stringify({ 'fs:read': [TARGET], 'write:request': [TARGET] })) {
  throw new Error(`the merge did not keep both scopes: ${JSON.stringify(grantedScopes)}`)
}
if (text().includes('accessTitle')) throw new Error('the dialog did not close after allowing')

const reply = posted.find((message) => message.t === 'result' && message.id === 7)
if (reply === undefined || reply.ok !== true) throw new Error('the frame was not answered with the new scopes')
if (!Array.isArray(reply.value.scopes['write:request'])) throw new Error(`the answer lacks scopes: ${JSON.stringify(reply.value)}`)

console.log('  ok  a partial approval grants only what was ticked')
console.log('  ok  the editor still loads with that subset')
console.log('  ok  a runtime request opens its own dialog and merges the grant')
console.log('  ok  the frame is answered with the merged scopes')
console.log('\n4 checks passed')
