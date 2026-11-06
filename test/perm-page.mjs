/**
 * The permission manager on the plugin's configuration page (sidebar Plugins):
 * it lists every approved pluginlet per workspace and revokes one.
 *
 * Real bundle + real React in jsdom, stub Host. Needs react/react-dom/jsdom:
 *   WE_TEST_MODULES=<node_modules> node test/perm-page.mjs
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
const EDITOR = `${ROOT}/.dsh/pluginlets/notes.pluginlet`

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

const state = {
  grants: {
    [EDITOR]: {
      hash: 'f'.repeat(64),
      scopes: { 'fs:read': ['notes/scratch.md'], 'write:request': ['notes/scratch.md'] },
      at: '2026-11-06T05:00:00.000Z',
    },
  },
}
const revokes = []
const grants = []

globalThis.fetch = async (url, init) => {
  const route = String(url).split('/').pop()
  const body = init && init.body ? JSON.parse(init.body) : {}
  const reply = (payload, ok = true) => ({ ok, status: ok ? 200 : 403, async json() { return payload } })
  if (route === 'state') return reply({ ok: true, root: body.root, grants: state.grants })
  if (route === 'grant') {
    grants.push(body)
    const scopes = {}
    for (const capability of body.capabilities ?? []) scopes[capability] = body.scopes[capability]
    state.grants[body.path] = { hash: body.hash, scopes, at: new Date().toISOString() }
    return reply({ ok: true, root: body.root, grants: state.grants })
  }
  if (route === 'revoke') {
    revokes.push(body)
    delete state.grants[body.path]
    return reply({ ok: true, root: body.root, grants: state.grants })
  }
  if (route === 'client-event') return reply({ ok: true })
  return reply({ ok: false, error: { code: 'NO_ROUTE', message: route } }, false)
}

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
  sessions: { list: { getSnapshot: () => ({ byId: {} }) } },
  slots: {
    inject(name, callback) { callback() },
    register(options, component) { registrations.push({ options, component }); return () => {} },
  },
})

const page = registrations.find((entry) => entry.options.name === 'plugins.row.config')
if (page === undefined) throw new Error('the plugin config page did not register')

const container = document.getElementById('host')
const root = ReactDOMClient.createRoot(container)
const useWorkspaces = (selector) => selector({ items: [{ path: ROOT }] })

// A tiny dictionary: the real one comes from the locale service, and the
// summary uses a {n} placeholder that the identity t() would not carry.
const DICT = {
  permSummary: '已授权 {n} 个 pluginlet',
  permNone: '还没有授权',
  permNote: 'note',
  permEmpty: 'empty',
  permRevoke: 'revoke',
  permWorking: '…',
}
const t = (key) => DICT[key] ?? key

const render = async (props) => {
  await act(async () => {
    root.render(React.createElement(page.component, { t, useWorkspaces, ...props }))
    await new Promise((resolve) => setTimeout(resolve, 200))
  })
}

const text = () => container.textContent.replace(/\s+/g, ' ')

await render({ view: 'summary' })
if (!text().includes('已授权 1 个 pluginlet')) {
  throw new Error(`the summary line is wrong: ${text().slice(0, 120)}`)
}

await render({ view: 'page' })
const rendered = text()
if (!rendered.includes('.dsh/pluginlets/notes.pluginlet')) throw new Error(`the grant row is missing: ${rendered.slice(0, 200)}`)
if (!rendered.includes('fs:read') || !rendered.includes('notes/scratch.md')) throw new Error('the scopes are missing')
if (!rendered.includes('revoke')) throw new Error('the revoke button is missing')

/* ── editing one capability's paths ─────────────────────────────────── */

const inputs = [...container.querySelectorAll('.we-perm-input')]
if (inputs.length !== 2) throw new Error(`expected an input per capability, got ${inputs.length}`)

const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
const firstInput = inputs[0]
await act(async () => {
  setValue.call(firstInput, 'docs')
  firstInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  await new Promise((resolve) => setTimeout(resolve, 40))
})
const plus = [...container.querySelectorAll('.we-perm-plus')][0]
await act(async () => {
  plus.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  await new Promise((resolve) => setTimeout(resolve, 80))
})

const saveButton = () => [...container.querySelectorAll('button')].find((button) => button.textContent === 'permSave')
if (saveButton() === undefined) throw new Error('the save button is missing')
if (saveButton().disabled) throw new Error('adding a path should enable save')

await act(async () => {
  saveButton().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  await new Promise((resolve) => setTimeout(resolve, 300))
})

if (grants.length !== 1) throw new Error(`expected one grant from the editor, got ${grants.length}`)
const edited = grants[0]
if (JSON.stringify(edited.scopes['fs:read']) !== '["notes/scratch.md","docs"]') {
  throw new Error(`the added path did not stick: ${JSON.stringify(edited.scopes)}`)
}
if (JSON.stringify(edited.capabilities) !== '["fs:read","write:request"]') {
  throw new Error(`both capabilities must survive the edit: ${JSON.stringify(edited.capabilities)}`)
}
if (edited.hash !== state.grants[EDITOR].hash) throw new Error('the edit must keep the same content hash')
if (!saveButton().disabled) throw new Error('save should be disabled again after a successful save')

/* ── revoking the whole row ─────────────────────────────────────────── */

const revoke = [...container.querySelectorAll('button')].find((button) => button.textContent === 'revoke')
await act(async () => {
  revoke.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  await new Promise((resolve) => setTimeout(resolve, 300))
})

if (revokes.length !== 1) throw new Error(`expected one revoke, got ${revokes.length}`)
if (revokes[0].root !== ROOT || revokes[0].path !== EDITOR) throw new Error(`wrong revoke target: ${JSON.stringify(revokes[0])}`)
if (text().includes('.dsh/pluginlets/notes.pluginlet')) throw new Error('the row did not disappear after revoking')
if (!text().includes('empty')) throw new Error(`the empty state did not appear: ${text().slice(0, 160)}`)

console.log('  ok  the summary view reports the number of approved editors')
console.log('  ok  the page lists each workspace, editor and its scopes')
console.log('  ok  a path can be added to one capability and saved')
console.log('  ok  revoking calls the host and the row disappears')
console.log('  ok  an empty list explains where approvals come from')
console.log('\n5 checks passed')
