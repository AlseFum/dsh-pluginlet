/**
 * Regression for the Conversation View flow, rendered with the real bundle and
 * real React inside jsdom: mount -> approval card -> click allow -> the frame
 * appears -> the frame says "ready" -> the mount payload is accepted and the
 * "starting" note goes away.
 *
 * This is the test that would have caught the `setFrameReady is not defined`
 * crash in the ready branch (the approval appeared to do nothing).
 *
 * React/jsdom are not plugin dependencies. Point WE_TEST_MODULES at a
 * node_modules that has them; without it the test skips with exit 0:
 *
 *   WE_TEST_MODULES=/home/ubuntu/.tmp-pw/node_modules node test/view-flow.mjs
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
const HASH = 'd'.repeat(64)

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

const errors = []
dom.window.addEventListener('error', (event) => errors.push(String(event?.message ?? 'error')))
process.on('unhandledRejection', (reason) => errors.push(String(reason?.message ?? reason)))

/* A stub Host, shaped like the version that was running when the bug showed. */
const state = { granted: false }
const calls = { scan: 0, source: 0 }
globalThis.fetch = async (url, init) => {
  const route = String(url).split('/').pop()
  const body = init && init.body ? JSON.parse(init.body) : {}
  const reply = (payload, ok = true) => ({ ok, status: ok ? 200 : 403, async json() { return payload } })
  if (route === 'discover') return reply({ ok: true, root: ROOT, items: [{ path: EDITOR, name: 'notes', relative: '.dsh/pluginlets/notes.pluginlet', size: 10, hash: HASH }] })
  if (route === 'scan') { calls.scan += 1; return reply({ ok: true, root: ROOT, path: EDITOR, name: 'notes', hash: HASH, blocked: [], capabilities: ['fs:read'], unavailable: [], devMode: false }) }
  if (route === 'source') {
    calls.source += 1
    if (!state.granted) return reply({ ok: true, root: ROOT, path: EDITOR, hash: HASH, blocked: [], capabilities: ['fs:read'], denied: true, reason: 'no-grant' })
    return reply({ ok: true, root: ROOT, path: EDITOR, name: 'notes', hash: HASH, capabilities: ['fs:read'], unavailable: [], source: "export default function E(api){ return api.h('div', null, 'X') }\n" })
  }
  if (route === 'grant') { state.granted = true; return reply({ ok: true, root: ROOT, grants: {} }) }
  if (route === 'revoke') { state.granted = false; return reply({ ok: true, root: ROOT, grants: {} }) }
  if (route === 'client-event') return reply({ ok: true })
  return reply({ ok: false, error: { code: 'NO_ROUTE', message: route } }, false)
}

let bundle = null
globalThis.window.__ModuleLoader__ = {
  load({ factory }) {
    bundle = factory((name) => (name === 'react' ? React : (() => { throw new Error(`require(${name})`) })))
  },
}

const clientUrl = pathToFileURL(new URL('../client.js', import.meta.url).pathname).href
await import(`${clientUrl}?v=${Date.now()}`)
if (bundle === null) throw new Error('the client bundle did not register')

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

const probe = registrations.find((entry) => entry.options.id === 'pluginlet:probe')
probe.component({ sessionId: 's1' })
await new Promise((resolve) => setTimeout(resolve, 50))

const tab = registrations.find((entry) => entry.options.name === 'conversation.view' && String(entry.options.id).startsWith('we:'))
if (tab === undefined) throw new Error('no editor tab was registered')

const container = document.getElementById('host')
const root = ReactDOMClient.createRoot(container)
const props = tab.options.inject('s1')
await act(async () => {
  root.render(React.createElement(tab.component, { ...props, t: (key) => key }))
  await new Promise((resolve) => setTimeout(resolve, 200))
})

const buttons = () => [...container.querySelectorAll('button')].map((button) => button.textContent)
const hasFrame = () => container.querySelector('iframe') !== null
const hasNote = () => container.querySelector('.we-frame-note') !== null

if (!buttons().some((label) => label === 'grantAllow')) throw new Error(`no approval button: ${JSON.stringify(buttons())}`)
if (hasFrame()) throw new Error('the frame must not exist before approval')

const allow = [...container.querySelectorAll('button')].find((button) => button.textContent === 'grantAllow')
await act(async () => {
  allow.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  await new Promise((resolve) => setTimeout(resolve, 400))
})

if (!hasFrame()) throw new Error('the editor frame did not appear after approval')
// jsdom may already have fired the iframe's `load`, which is itself a readiness
// signal; either way the pane must be live rather than stuck on the card.
// The tab no longer carries a reload control: switching tabs remounts it.
if (buttons().some((label) => label === 'reload' || label === 'permRevoke')) {
  throw new Error(`the toolbar should be chrome-free: ${JSON.stringify(buttons())}`)
}

const frame = container.querySelector('iframe')
await act(async () => {
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
    data: { __we: 1, t: 'ready' },
    source: frame.contentWindow,
  }))
  await new Promise((resolve) => setTimeout(resolve, 200))
})

if (hasNote()) throw new Error('the ready message was not accepted (frame never mounted)')
// The tab no longer carries a reload control: switching tabs remounts it.
if (buttons().some((label) => label === 'reload' || label === 'permRevoke')) {
  throw new Error(`the toolbar should be chrome-free: ${JSON.stringify(buttons())}`)
}
if (errors.length > 0) throw new Error(`runtime errors: ${errors.join(' | ')}`)

console.log('  ok  the tab renders the approval card before anything is granted')
console.log('  ok  clicking allow replaces it with the editor frame')
/* ── switching away and back must not rescan the same content ─────────── */

const before = { ...calls }
await act(async () => {
  root.render(null)
  await new Promise((resolve) => setTimeout(resolve, 50))
})
await act(async () => {
  root.render(React.createElement(tab.component, { ...props, t: (key) => key }))
  await new Promise((resolve) => setTimeout(resolve, 200))
})

if (calls.scan !== before.scan) throw new Error(`remount rescanned: ${before.scan} -> ${calls.scan}`)
if (calls.source !== before.source + 1) throw new Error(`remount must still ask the host for the source (${before.source} -> ${calls.source})`)
if (container.querySelector('iframe') === null) throw new Error('the remounted tab did not come back live')

console.log('  ok  remounting the same content reuses the scan and re-asks only for the source')
console.log('  ok  the tab shows no reload/manage controls once live')
console.log('  ok  the ready message is accepted and the note clears')
console.log('  ok  no runtime errors')
console.log('\n6 checks passed')
