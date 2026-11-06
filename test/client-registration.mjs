/**
 * Loads the client bundle in Node with a stub module loader, a stub fetch and a
 * stub slot service, then drives the session probe to assert that one
 * Conversation View is registered per `*.pluginlet` file of the session's
 * workspace — and that switching sessions replaces that set.
 * Run with `node test/client-registration.mjs`.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = '/work/repo'
const OTHER = '/work/other'

const DISCOVER = {
  [ROOT]: [
    { path: `${ROOT}/.dsh/pluginlets/hello.pluginlet`, name: 'hello', relative: '.dsh/pluginlets/hello.pluginlet', size: 10, hash: 'a'.repeat(64) },
    { path: `${ROOT}/.dsh/pluginlets/app.pluginlet`, name: 'app', relative: '.dsh/pluginlets/app.pluginlet', size: 20, hash: 'b'.repeat(64) },
  ],
  [OTHER]: [
    { path: `${OTHER}/.dsh/pluginlets/x.pluginlet`, name: 'x', relative: '.dsh/pluginlets/x.pluginlet', size: 30, hash: 'c'.repeat(64) },
  ],
}

globalThis.fetch = async (url, init) => {
  const body = init === undefined ? {} : JSON.parse(init.body)
  const route = String(url).split('/').pop()
  const payload = route === 'discover'
    ? { ok: true, root: body.root, items: DISCOVER[body.root] ?? [] }
    : route === 'config'
      ? { ok: true, config: { devMode: false } }
      : { ok: false, error: { code: 'NOT_FOUND', message: route } }
  return { ok: payload.ok !== false, status: 200, async json() { return payload } }
}

let loaded = null
const React = { createElement: (...args) => ({ args }) }
const listeners = []
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      loaded = { id, module: factory((name) => (name === 'react' ? React : (() => { throw new Error(`unexpected require(${name})`) }))) }
    },
  },
  addEventListener: (type, fn) => listeners.push({ type, fn }),
  removeEventListener: () => {},
}

// CLIENT_PATH lets this run against a built copy (e.g. dist-publish/client.js).
const clientPath = process.env.CLIENT_PATH ?? fileURLToPath(new URL('../client.js', import.meta.url))
const clientDir = dirname(clientPath)
const clientPkg = JSON.parse(await readFile(join(clientDir, 'package.json'), 'utf8'))

await import(`${clientPath}?v=${Date.now()}`)

assert.ok(loaded !== null, 'the bundle must register itself with the module loader')
assert.equal(loaded.id, clientPkg.name, 'the client module id must equal the package name')
const { apply, inject } = loaded.module
assert.deepEqual(inject, ['slots', 'sessions', 'locale'])

const registered = []
const disposed = []
const injected = []
let localeRegistered = null

const ctx = {
  effect(fn) {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  locale: {
    register(namespace, dictionaries) {
      localeRegistered = { namespace, dictionaries }
      return () => {}
    },
    bind() {
      return (key) => key
    },
  },
  sessions: {
    list: {
      getSnapshot: () => ({
        byId: {
          's1': { cwd: ROOT },
          's2': { cwd: OTHER },
          's3': {},
        },
      }),
    },
  },
  slots: {
    inject(name, callback) {
      injected.push(name)
      callback()
    },
    register(options, component) {
      const record = { options, component, live: true }
      registered.push(record)
      return () => {
        if (!record.live) return
        record.live = false
        disposed.push(options.id)
      }
    },
  },
}

apply(ctx)

assert.equal(localeRegistered.namespace, 'pluginlet')
assert.ok(Object.keys(localeRegistered.dictionaries.zh).length > 20)
assert.ok(Object.keys(localeRegistered.dictionaries.en).length > 20)
assert.deepEqual(injected, ['conversation.session.header.actions', 'plugins.row.config'])

// The permission manager lives on the plugin row's config page, keyed exactly
// as the bundle patch declares it.
const page = registered.find((entry) => entry.options.name === 'plugins.row.config')
assert.ok(page !== undefined, 'the plugin config page must register')
assert.equal(page.options.key, `${clientPkg.name}#pluginlet`)
assert.equal(typeof page.component, 'function')

const probes = registered.filter((entry) => entry.options.name === 'conversation.session.header.actions')
assert.equal(probes.length, 1)
assert.equal(probes[0].options.id, 'pluginlet:probe')
assert.equal(probes[0].component({ sessionId: 's1' }), null, 'the probe renders nothing')

const settle = () => new Promise((resolve) => setTimeout(resolve, 10))

await settle()

const tabsFor = (root) => registered.filter((entry) => entry.live && entry.options.name === 'conversation.view')

let tabs = tabsFor(ROOT)
assert.equal(tabs.length, 2, 'one Conversation View per editor file')
assert.deepEqual(tabs.map((entry) => entry.options.id), ['we:.dsh/pluginlets/hello.pluginlet', 'we:.dsh/pluginlets/app.pluginlet'])
assert.deepEqual(tabs.map((entry) => entry.options.order), [40, 41])
assert.equal(tabs[0].options.label(), 'hello', 'the tab label is the file name without the suffix')
assert.equal(tabs[1].options.label(), 'app')
assert.equal(tabs[0].options.locale, 'pluginlet')

const injectedProps = tabs[1].options.inject('s1')
assert.deepEqual(injectedProps, {
  sessionId: 's1',
  root: ROOT,
  path: `${ROOT}/.dsh/pluginlets/app.pluginlet`,
  name: 'app',
  hash: 'b'.repeat(64),
})

// Switching sessions swaps the tab set: the previous registrations are disposed.
probes[0].component({ sessionId: 's2' })
await settle()
assert.deepEqual(disposed.sort(), ['we:.dsh/pluginlets/hello.pluginlet', 'we:.dsh/pluginlets/app.pluginlet'].sort())
tabs = tabsFor(OTHER)
assert.equal(tabs.length, 1)
assert.equal(tabs[0].options.id, 'we:.dsh/pluginlets/x.pluginlet')

// A session without a workspace directory leaves the conversation untouched.
probes[0].component({ sessionId: 's3' })
await settle()
assert.equal(tabsFor(OTHER).length, 0)
assert.equal(disposed.filter((id) => id === 'we:.dsh/pluginlets/x.pluginlet').length, 1)

// Re-rendering the probe for the same session is a no-op (no churn).
const before = registered.length
probes[0].component({ sessionId: 's3' })
await settle()
assert.equal(registered.length, before)

console.log('  ok  bundle id and inject list')
console.log('  ok  locale dictionaries registered (zh + en)')
console.log('  ok  one renderless probe in the session header')
console.log('  ok  the permission manager registers on the plugin config page')
console.log('  ok  one conversation.view per *.editor, labelled by file name')
console.log('  ok  session switch disposes the old set and registers the new one')
console.log('  ok  a session without a workspace registers nothing')
console.log('  ok  repeating the same session does not churn registrations')
console.log('\n8 checks passed')
