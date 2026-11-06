/**
 * Drives the Host route handlers directly (no HTTP server) with a small fake
 * `ctx`, so the scope logic can be verified before the running `dsh web` has
 * loaded a fresh module generation.
 *
 * Run with `node test/host-ops.mjs`.
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { realpath, symlink } from 'node:fs/promises'
import { readdir } from 'node:fs/promises'
import { DEFAULTS, setConfig } from '../config.js'

const home = await mkdtemp(join(tmpdir(), 'we-ops-'))
process.env.DSH_HOME = home

const ROOT = join(home, 'repo')
await mkdir(join(ROOT, '.dsh/pluginlets'), { recursive: true })
await mkdir(join(ROOT, 'notes'), { recursive: true })
await mkdir(join(ROOT, 'docs'), { recursive: true })
await writeFile(join(ROOT, 'docs', 'readme.md'), '# docs\n', 'utf8')
await writeFile(join(ROOT, '.dsh/pluginlets', 'notes.pluginlet'), "const T = 'notes/scratch.md'\nexport default function E(api){ api.fs.read(T); api.write.request(T, 'x'); return null }\n", 'utf8')
await writeFile(join(ROOT, '.dsh/pluginlets', 'loose.pluginlet'), "export default function E(api){ api.fs.read(maybe()); return null }\n", 'utf8')
await writeFile(join(ROOT, 'notes', 'scratch.md'), '# note\n', 'utf8')
await writeFile(join(ROOT, '.npmrc'), 'registry=x\n', 'utf8')
await writeFile(join(ROOT, '.dsh/pluginlets', 'net.pluginlet'), "const U = 'https://example.com/x'\nexport default function E(api){ api.net.fetch(U); return null }\n", 'utf8')

// A symlink inside the workspace that points outside it.
const outsideDir = join(home, 'outside')
await mkdir(outsideDir, { recursive: true })
await writeFile(join(outsideDir, 'secret.txt'), 'top secret\n', 'utf8')
await symlink(join(outsideDir, 'secret.txt'), join(ROOT, 'notes', 'link.txt'))
await mkdir(join(ROOT, 'linked'), { recursive: true })
await symlink(outsideDir, join(ROOT, 'linked', 'escape'))

setConfig(DEFAULTS)

/* ── a `ctx` good enough for ops.js ──────────────────────────────────── */

const fs = {
  // The real provider normalises and realpaths; that is what makes `contains`
  // meaningful (a symlink resolves to its target, not to its own path).
  async resolve(path) { return { path: await realpath(path).catch(() => path) } },
  contains(parent, child) {
    const rel = relative(parent.path, child.path)
    return rel === '' || (!rel.startsWith('..') && !rel.startsWith('..' + '/'))
  },
  async stat(target) {
    try {
      const info = await stat(target.path)
      return { type: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other', size: info.size, version: `${info.size}:${info.mtimeMs}` }
    } catch {
      return undefined
    }
  },
  async readBytes(target, _signal, max) {
    const bytes = await readFile(target.path)
    if (bytes.byteLength > max) throw new Error('too large')
    return new Uint8Array(bytes)
  },
  async listDir(target) {
    const entries = await readdir(target.path, { withFileTypes: true })
    return Promise.all(entries.map(async (entry) => {
      const full = join(target.path, entry.name)
      return {
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
        target: { path: await realpath(full).catch(() => full) },
      }
    }))
  },
  async writeText(target, text, expected) {
    const before = await stat(target.path)
    const version = `${before.size}:${before.mtimeMs}`
    if (expected !== undefined && expected.kind === 'replaceIfVersion' && expected.version !== version) {
      throw Object.assign(new Error('stale'), { code: 'FS_STALE_VERSION' })
    }
    await writeFile(target.path, text, 'utf8')
    const after = await stat(target.path)
    return { version: `${after.size}:${after.mtimeMs}`, operation: 'update', after: text }
  },
}

const ctx = {
  fs,
  workspaceRegistry: { list: () => [{ path: ROOT }] },
  webServer: { register: () => () => {} },
}

/* ── request plumbing ────────────────────────────────────────────────── */

const { serve } = await import('../ops.js')

function request(route, body) {
  const req = new EventEmitter()
  req.method = 'POST'
  req.headers = { 'x-dsh-plugin': 'pluginlet', 'content-type': 'application/json' }
  const res = {
    statusCode: 0,
    body: '',
    writableEnded: false,
    writeHead(status) { this.statusCode = status },
    end(chunk) { this.body = String(chunk ?? ''); this.writableEnded = true },
  }
  setImmediate(() => {
    req.emit('data', Buffer.from(JSON.stringify(body ?? {})))
    req.emit('end')
  })
  return serve(ctx, route, req, res).then(() => ({ status: res.statusCode, ...JSON.parse(res.body) }))
}

const editor = join(ROOT, '.dsh/pluginlets', 'notes.pluginlet')

/* ── the flow ────────────────────────────────────────────────────────── */

const discover = await request('discover', { root: ROOT })
assert.deepEqual(discover.items.map((item) => item.name), ['loose', 'net', 'notes'])

const scan = await request('scan', { root: ROOT, path: editor })
assert.deepEqual(scan.blocked, [])
assert.deepEqual(scan.capabilities, ['fs:read', 'write:request'])
assert.deepEqual(scan.scopes, { 'fs:read': ['notes/scratch.md'], 'write:request': ['notes/scratch.md'] })
assert.deepEqual(scan.dynamic, { 'fs:read': false, 'write:request': false })

const loose = await request('scan', { root: ROOT, path: join(ROOT, '.dsh/pluginlets', 'loose.pluginlet') })
assert.deepEqual(loose.scopes['fs:read'], ['**'], 'an unresolvable path falls back to the whole workspace')
assert.equal(loose.dynamic['fs:read'], true)

const denied = await request('source', { root: ROOT, path: editor, hash: scan.hash })
assert.equal(denied.denied, true)
assert.equal(denied.reason, 'no-grant')
assert.deepEqual(denied.scopes['fs:read'], ['notes/scratch.md'], 'the dialog knows the scope before approval')

await request('grant', {
  root: ROOT,
  path: editor,
  hash: scan.hash,
  capabilities: scan.capabilities,
  scopes: scan.scopes,
})

const source = await request('source', { root: ROOT, path: editor, hash: scan.hash })
assert.notEqual(source.denied, true)
const hash = source.hash

const inside = await request('fs/read', { root: ROOT, path: editor, hash, file: join(ROOT, 'notes', 'scratch.md') })
assert.equal(inside.ok, true)
assert.equal(inside.text, '# note\n')

const outside = await request('fs/read', { root: ROOT, path: editor, hash, file: join(ROOT, '.npmrc') })
assert.equal(outside.ok, false)
assert.equal(outside.error.code, 'OUT_OF_SCOPE', 'a declared-scope editor cannot read the rest of the repo')

const listOutside = await request('fs/list', { root: ROOT, path: editor, hash, file: ROOT })
assert.equal(listOutside.ok, false)
assert.equal(listOutside.error.code, 'OUT_OF_SCOPE', 'nor list the workspace root')

// A runtime request merges into the same content's grant instead of replacing it.
const merged = await request('grant', {
  root: ROOT,
  path: editor,
  hash,
  merge: true,
  capabilities: ['fs:read'],
  scopes: { 'fs:read': ['docs/'] },
})
assert.deepEqual(merged.grants[editor].scopes['fs:read'].sort(), ['docs/', 'notes/scratch.md'])
const docsRead = await request('fs/read', { root: ROOT, path: editor, hash, file: join(ROOT, 'docs', 'readme.md') })
assert.equal(docsRead.ok, true, 'the newly approved directory is readable immediately')
const stillInside = await request('fs/read', { root: ROOT, path: editor, hash, file: join(ROOT, 'notes', 'scratch.md') })
assert.equal(stillInside.ok, true, 'merging does not drop the previous scope')
const stillOutside = await request('fs/read', { root: ROOT, path: editor, hash, file: join(ROOT, '.npmrc') })
assert.equal(stillOutside.error.code, 'OUT_OF_SCOPE', 'and does not widen beyond what was approved')

const written = await request('write', {
  root: ROOT,
  path: editor,
  hash,
  target: join(ROOT, 'notes', 'scratch.md'),
  text: '# note\n\nedited\n',
  version: (await request('fs/read', { root: ROOT, path: editor, hash, file: join(ROOT, 'notes', 'scratch.md') })).version,
  confirmed: true,
})
assert.equal(written.ok, true)
assert.equal(await readFile(join(ROOT, 'notes', 'scratch.md'), 'utf8'), '# note\n\nedited\n')

const writeOutside = await request('write', {
  root: ROOT,
  path: editor,
  hash,
  target: join(ROOT, '.npmrc'),
  text: 'pwned',
  confirmed: true,
})
assert.equal(writeOutside.ok, false)
assert.equal(writeOutside.error.code, 'OUT_OF_SCOPE', 'the write scope is the same file, nothing else')

const unconfirmed = await request('write', {
  root: ROOT,
  path: editor,
  hash,
  target: join(ROOT, 'notes', 'scratch.md'),
  text: 'x',
})
assert.equal(unconfirmed.ok, false)
assert.equal(unconfirmed.error.code, 'NOT_CONFIRMED', 'a write without the dialog confirmation is refused')

const headerless = await (async () => {
  const req = new EventEmitter()
  req.method = 'POST'
  req.headers = {}
  const res = { writableEnded: false, writeHead(status) { this.statusCode = status }, end(chunk) { this.body = String(chunk ?? ''); this.writableEnded = true } }
  setImmediate(() => { req.emit('data', Buffer.from('{}')); req.emit('end') })
  await serve(ctx, 'discover', req, res)
  return { status: res.statusCode, ...JSON.parse(res.body) }
})()
assert.equal(headerless.ok, false)
assert.equal(headerless.error.code, 'FORBIDDEN')

const grantFile = JSON.parse(await readFile(join(home, 'pluginlet', 'grants.json'), 'utf8'))
assert.deepEqual(grantFile.workspaces[ROOT].grants[editor].scopes, {
  'fs:read': ['docs/', 'notes/scratch.md'],
  'write:request': ['notes/scratch.md'],
}, 'the merged scope is what is on disk')
assert.equal(grantFile.workspaces[ROOT].grants[editor].hash, hash)

/* ── a symlink cannot walk out of the workspace ──────────────────────── */

// Widen the grant so the read reaches the containment check rather than the scope check.
await request('grant', {
  root: ROOT,
  path: editor,
  hash,
  capabilities: ['fs:read'],
  scopes: { 'fs:read': ['notes/link.txt', 'notes/', 'linked/'] },
})

const linkedRead = await request('fs/read', { root: ROOT, path: editor, hash, file: join(ROOT, 'notes', 'link.txt') })
assert.equal(linkedRead.ok, false, 'a symlink pointing outside must not be readable')
assert.equal(linkedRead.error.code, 'OUTSIDE_WORKSPACE')

const linkedList = await request('fs/list', { root: ROOT, path: editor, hash, file: join(ROOT, 'linked') })
assert.equal(linkedList.ok, true)
assert.deepEqual(linkedList.entries, [], 'a symlinked directory is filtered out of the listing')

const notesList = await request('fs/list', { root: ROOT, path: editor, hash, file: join(ROOT, 'notes') })
assert.deepEqual(notesList.entries.map((entry) => entry.name), ['scratch.md'], 'the escaping symlink is not listed either')

/* ── net: private targets, and every redirect hop ────────────────────── */

const netEditor = join(ROOT, '.dsh/pluginlets', 'net.pluginlet')
const netScan = await request('scan', { root: ROOT, path: netEditor })
assert.deepEqual(netScan.capabilities, ['net:fetch'])
await request('grant', { root: ROOT, path: netEditor, hash: netScan.hash, capabilities: netScan.capabilities, scopes: netScan.scopes })
const netSource = await request('source', { root: ROOT, path: netEditor, hash: netScan.hash })
assert.notEqual(netSource.denied, true)

const privateTarget = await request('net/fetch', { root: ROOT, path: netEditor, hash: netScan.hash, url: 'http://127.0.0.1:4001/api/x' })
assert.equal(privateTarget.ok, false)
assert.equal(privateTarget.error.code, 'PRIVATE_HOST', 'loopback is refused before any request is made')

const requests = []
const realFetch = globalThis.fetch
globalThis.fetch = async (url) => {
  requests.push(url)
  if (url === 'http://93.184.216.34/redirect') {
    return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:9/secret' } })
  }
  return new Response('hello', { status: 200, headers: { 'content-type': 'text/plain' } })
}
const redirected = await request('net/fetch', { root: ROOT, path: netEditor, hash: netScan.hash, url: 'http://93.184.216.34/redirect' })
assert.equal(redirected.ok, false)
assert.equal(redirected.error.code, 'PRIVATE_HOST', 'the redirect target is validated again')
assert.equal(requests.length, 1, 'the private hop is never requested')

const plain = await request('net/fetch', { root: ROOT, path: netEditor, hash: netScan.hash, url: 'http://93.184.216.34/ok' })
assert.equal(plain.ok, true)
assert.equal(plain.body, 'hello')
globalThis.fetch = realFetch

await rm(home, { recursive: true, force: true })

console.log('  ok  discover + scan: exact scopes from a top-level const, ** for a dynamic path')
console.log('  ok  denied source carries the scope for the approval dialog')
console.log('  ok  grant persists capability -> path scopes')
console.log('  ok  a runtime request merges scopes without dropping or widening them')
console.log('  ok  in-scope read works, out-of-scope read and root listing are refused')
console.log('  ok  confirmed write lands, out-of-scope and unconfirmed writes are refused')
console.log('  ok  a symlink cannot read or list outside the workspace')
console.log('  ok  net refuses loopback and re-validates every redirect hop')
console.log('  ok  the plugin header fence still holds')
console.log('\n9 checks passed')
