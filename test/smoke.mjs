/**
 * Smoke tests for the two pure modules: the scanner and the grant store.
 * Run with `node test/smoke.mjs` from the package directory.
 */
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { scanSource, stripLiterals } from '../scanner.js'
import { createGrantStore, scopeAllows } from '../grants.js'

let checks = 0
function ok(name) {
  checks += 1
  console.log(`  ok  ${name}`)
}

console.log('scanner')

{
  const scan = scanSource("export default function Editor(api) { return api.h('div', null, 'hi') }\n")
  assert.deepEqual(scan.blocked, [])
  assert.equal(scan.hash.length, 64)
  ok('a clean editor reports no blocked construct')
}

{
  const scan = scanSource("export default function E(api){ api.net.fetch('https://x.test'); return api.h('div') }\n")
  assert.deepEqual(scan.blocked, [])
  assert.ok(scan.capabilities.includes('net:fetch'))
  const bad = scanSource("export default function E(){ fetch('https://x.test'); return null }\n")
  assert.equal(bad.blocked[0].rule, 'bare-fetch')
  ok('bare fetch is blocked, api.net.fetch is only a capability')
}

{
  const scan = scanSource("const a = 1\nexport default function E(){ return eval('1') }\n")
  assert.equal(scan.blocked[0].rule, 'eval')
  assert.equal(scan.blocked[0].line, 2)
  assert.ok(scanSource("import x from './x.js'\nexport default 1\n").blocked.some((b) => b.rule === 'esm-import'))
  assert.ok(scanSource("export default () => parent.postMessage('x', '*')\n").blocked.some((b) => b.rule === 'messaging'))
  assert.ok(scanSource('export default () => globalThis.x\n').blocked.some((b) => b.rule === 'global-object'))
  ok('eval, imports and host-realm access are blocked with their line number')
}

{
  const clean = stripLiterals("// we never call fetch here\nconst s = 'eval(' // still code\n")
  assert.equal(/fetch/.test(clean), false)
  assert.equal(/eval/.test(clean), false)
  ok('literals and comments are stripped so prose does not trip rules')
}

{
  const scan = scanSource("export default function E(api){ api.fs.read('a.md'); api.write.request('b.md', 'x'); return null }\n")
  assert.ok(scan.capabilities.includes('fs:read'))
  assert.ok(scan.capabilities.includes('write:request'))
  assert.deepEqual(scan.blocked, [])
  assert.deepEqual(scan.scopes, { 'fs:read': ['a.md'], 'write:request': ['b.md'] })
  ok('capabilities are detected from the wrapped api')
}

{
  const multi = scanSource("api.fs.list('notes'); api.fs.list('docs')")
  assert.deepEqual(multi.scopes, { 'fs:read': ['docs', 'notes'], 'write:request': [] })
  assert.equal(multi.dynamic['fs:read'], false)
  ok('every declared directory becomes its own scope')
}

console.log('scopes')

{
  const scopes = { 'fs:read': ['notes/a.md'] }
  assert.equal(scopeAllows(scopes, 'fs:read', 'notes/a.md'), true)
  assert.equal(scopeAllows(scopes, 'fs:read', 'notes/b.md'), false)
  assert.equal(scopeAllows(scopes, 'fs:read', './notes/a.md'), true)
  assert.equal(scopeAllows({ 'fs:read': ['notes/'] }, 'fs:read', 'notes/b.md'), true)
  assert.equal(scopeAllows({ 'fs:read': ['notes/'] }, 'fs:read', 'notes'), true)
  assert.equal(scopeAllows({ 'fs:read': ['notes/'] }, 'fs:read', 'other/x'), false)
  assert.equal(scopeAllows({ 'fs:read': ['**'] }, 'fs:read', 'anything/at/all'), true)
  assert.equal(scopeAllows({ 'fs:read': ['**'] }, 'fs:read', '.'), true, 'listing the workspace root needs **')
  assert.equal(scopeAllows({ 'fs:read': ['notes/'] }, 'fs:read', '.'), false, 'a directory scope does not cover the root')
  assert.equal(scopeAllows({}, 'fs:read', 'notes/a.md'), false)
  assert.equal(scopeAllows({ 'fs:read': ['notes/a.md'] }, 'write:request', 'notes/a.md'), false, 'capabilities do not leak into each other')
  ok('a scope matches one file, a directory subtree, or the whole workspace')
}

console.log('grants')

const home = await mkdtemp(join(tmpdir(), 'we-home-'))
const root = '/work/repo'
const editor = '/work/repo/demo.editor'
const hashA = 'a'.repeat(64)
const hashB = 'b'.repeat(64)
const scopesA = { 'fs:read': ['notes/a.md'], 'write:request': ['notes/a.md'] }

{
  const store = createGrantStore({ dshHome: home })
  const decision = await store.authorize(root, editor, hashA, 'fs:read')
  assert.equal(decision.ok, false)
  ok('a fresh workspace authorizes nothing')
}

const store = createGrantStore({ dshHome: home })
await store.grant(root, editor, hashA, scopesA)
ok('grant stores capability -> path scopes')

{
  const decision = await store.authorize(root, editor, hashA, 'fs:read')
  assert.equal(decision.ok, true)
  assert.deepEqual(decision.scopes['fs:read'], ['notes/a.md'])
  assert.equal((await store.authorize(root, editor, hashA, 'net:fetch')).ok, false, 'an ungranted capability stays closed')
  assert.equal((await store.authorize(root, editor, hashB, 'fs:read')).ok, false, 'a changed hash invalidates the grant')
  ok('hash change and ungranted capabilities are refused')
}

{
  const decision = await store.authorize(root, editor, hashB, 'fs:read', true)
  assert.equal(decision.ok, true)
  assert.equal(decision.devMode, true)
  assert.deepEqual(decision.scopes['fs:read'], ['**'], 'dev mode widens the scope, it does not hide it')
  assert.equal((await store.authorize(root, editor, hashB, 'exec:run', true)).ok, false, 'even dev mode cannot grant a capability outside the grantable set')
  ok('development mode (from plugin Config) accepts a new hash')
}

{
  const audit = await store.tail(20)
  assert.ok(audit.some((entry) => entry.kind === 'grant'))
  const state = await store.state(root)
  assert.equal(typeof state.devMode, 'undefined')
  assert.deepEqual(state.grants[editor].scopes, scopesA)
  ok('audit records scopes; dev mode is not stored in the grant file')
}

{
  const onDisk = JSON.parse(await readFile(join(home, 'pluginlet', 'grants.json'), 'utf8'))
  assert.equal(onDisk.version, 1)
  assert.deepEqual(onDisk.workspaces[root].grants[editor].scopes['fs:read'], ['notes/a.md'])
  ok('grants.json lives under the plugin home, outside the workspace')
}

{
  // A record written by the previous format (bare capability list) migrates to **.
  const legacyHome = await mkdtemp(join(tmpdir(), 'we-legacy-'))
  await mkdir(join(legacyHome, 'pluginlet'), { recursive: true })
  await writeFile(join(legacyHome, 'pluginlet', 'grants.json'), JSON.stringify({
    version: 1,
    workspaces: { [root]: { grants: { [editor]: { hash: hashA, capabilities: ['fs:read'], at: '2026-01-01T00:00:00.000Z' } } } },
  }), 'utf8')
  const legacy = createGrantStore({ dshHome: legacyHome })
  const decision = await legacy.authorize(root, editor, hashA, 'fs:read')
  assert.equal(decision.ok, true)
  assert.deepEqual(decision.scopes['fs:read'], ['**'])
  await rm(legacyHome, { recursive: true, force: true })
  ok('an old grant without scopes migrates to the whole workspace')
}

await rm(home, { recursive: true, force: true })

console.log(`\n${checks} checks passed`)
