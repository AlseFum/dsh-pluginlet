/**
 * pluginlet — Host operations.
 *
 *   POST /api/pluginlet/discover   { root }                       -> { items }
 *   POST /api/pluginlet/scan       { root, path }                 -> scan + hash
 *   POST /api/pluginlet/source     { root, path, hash }            -> { source, ... }
 *   POST /api/pluginlet/state      { root }                        -> grants
 *   POST /api/pluginlet/config     {}                              -> effective config
 *   POST /api/pluginlet/grant      { root, path, hash, capabilities }
 *   POST /api/pluginlet/revoke     { root, path? | all }
 *   POST /api/pluginlet/log        { root }                        -> audit tail
 *   POST /api/pluginlet/fs/list    { root, path, hash, file }
 *   POST /api/pluginlet/fs/read    { root, path, hash, file }
 *   POST /api/pluginlet/net/fetch  { root, path, hash, url, init }
 *   POST /api/pluginlet/write      { root, path, hash, target, text, version, confirmed }
 *
 * Contract:
 *   - every request carries `x-dsh-plugin: pluginlet` (CSRF fence; the
 *     server answers no preflight);
 *   - `root` must be a registered workspace and every path must resolve inside
 *     it, so an editor cannot wander the host filesystem;
 *   - reads go through `ctx.fs` and every write carries an explicit
 *     `workspace-write` policy with the root;
 *   - writes require `confirmed: true`, which only the confirmation dialog
 *     sends: an editor cannot write on its own;
 *   - `net/fetch` is the only network path, bounded by the plugin config and
 *     audited;
 *   - patterns, caps, dev mode and budgets come from the plugin `Config`, never
 *     from the workspace.
 */
import { lookup } from 'node:dns/promises'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path'
import { allowedCapabilities, getConfig } from './config.js'
import { createGrantStore, scopeAllows } from './grants.js'
import { scanSource } from './scanner.js'

const PREFIX = '/api/pluginlet'
const PLUGIN_HEADER = 'x-dsh-plugin'
const PLUGIN_HEADER_VALUE = 'pluginlet'

/** Capability read ceiling for `fs/read`. */
const MAX_READ_BYTES = 1024 * 1024
/** Request body ceiling. */
const MAX_BODY_BYTES = 8 * 1024 * 1024

class OpsError extends Error {
  constructor(statusCode, code, message) {
    super(message)
    this.statusCode = statusCode
    this.code = code
  }
}

function sendJson(res, status, body) {
  if (res.writableEnded) return
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        reject(new OpsError(413, 'BODY_TOO_LARGE', '请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') return resolve({})
      try {
        const data = JSON.parse(text)
        if (data === null || typeof data !== 'object' || Array.isArray(data)) {
          return reject(new OpsError(400, 'INVALID_BODY', '请求体必须是 JSON 对象'))
        }
        resolve(data)
      } catch {
        reject(new OpsError(400, 'INVALID_BODY', '请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

function requireAbsolute(value, code = 'INVALID_PATH') {
  if (typeof value !== 'string' || value.trim() === '') throw new OpsError(400, code, '缺少路径')
  if (!isAbsolute(value)) throw new OpsError(400, code, '路径必须是绝对路径')
  const path = resolvePath(value)
  if (path.length > 4096) throw new OpsError(400, code, '路径过长')
  return path
}

/** Registered workspace root containing `absolute`, most specific first. */
function workspaceRootOf(ctx, absolute) {
  let roots = []
  try {
    roots = (ctx.workspaceRegistry.list() ?? [])
      .map((workspace) => workspace?.path)
      .filter((root) => typeof root === 'string' && root !== '')
  } catch {
    roots = []
  }
  const matches = roots.filter((root) => {
    const rel = relative(resolvePath(root), absolute)
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  })
  if (matches.length === 0) throw new OpsError(403, 'OUTSIDE_WORKSPACE', '只能访问已注册工作区内的文件')
  return resolvePath(matches.sort((a, b) => b.length - a.length)[0])
}

/** `root` must be a registered workspace; returns its canonical form. */
function requireRoot(ctx, value) {
  const root = requireAbsolute(value, 'INVALID_ROOT')
  try {
    const known = (ctx.workspaceRegistry.list() ?? []).some((workspace) => resolvePath(workspace.path) === root)
    if (known) return root
  } catch {
    // fall through to containment check
  }
  workspaceRootOf(ctx, root)
  return root
}

function relativeTo(root, absolute) {
  const rel = relative(root, absolute)
  return rel === '' ? '.' : rel.split(sep).join('/')
}

/** `hello.editor`, `hello.editor.js` → `hello`; the longest configured suffix wins. */
function editorName(absolute, extensions) {
  const base = absolute.slice(absolute.lastIndexOf('/') + 1)
  const match = extensions
    .filter((suffix) => base.endsWith(suffix))
    .sort((left, right) => right.length - left.length)[0]
  if (match === undefined) return base
  return base.slice(0, base.length - match.length) || base
}

/* ── state ───────────────────────────────────────────────────────────── */

/** @type {ReturnType<typeof createGrantStore> | null} */
let store = null
/** `${root}|${path}` -> { hash, at }: hashes this process actually served. */
const issued = new Map()
/** `${root}|${path}` -> { windowStart, windowCount, hourStart, hourCount } */
const netBudget = new Map()

function storeFor() {
  if (store === null) {
    const dshHome = process.env.DSH_HOME && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
    store = createGrantStore({ dshHome })
  }
  return store
}

function issueHash(root, path, hash) {
  issued.set(`${root}|${path}`, { hash, at: Date.now() })
}

function issuedHash(root, path) {
  const record = issued.get(`${root}|${path}`)
  if (record === undefined) return undefined
  if (Date.now() - record.at > 30 * 60_000) {
    issued.delete(`${root}|${path}`)
    return undefined
  }
  return record.hash
}

function takeNetBudget(key, config) {
  const now = Date.now()
  let record = netBudget.get(key)
  if (record === undefined || now - record.hourStart > 3_600_000) {
    record = { windowStart: now, windowCount: 0, hourStart: now, hourCount: 0 }
  }
  if (now - record.windowStart > 60_000) {
    record.windowStart = now
    record.windowCount = 0
  }
  record.windowCount += 1
  record.hourCount += 1
  netBudget.set(key, record)
  if (record.windowCount > config.net.perMinute) {
    throw new OpsError(429, 'NET_RATE_WINDOW', `每个 pluginlet 每分钟最多 ${config.net.perMinute} 次网络请求`)
  }
  if (record.hourCount > config.net.perHour) {
    throw new OpsError(429, 'NET_RATE_HOUR', `每个 pluginlet 每小时最多 ${config.net.perHour} 次网络请求`)
  }
}

/* ── filesystem helpers ──────────────────────────────────────────────── */

/**
 * Resolve `path` and require the canonical target to stay inside `root`.
 *
 * The lexical containment check (`workspaceRootOf`) runs on the path as
 * written; `ctx.fs.resolve` normalises and realpaths, so a symlink inside the
 * workspace could otherwise point the read outside it. `ctx.fs.contains`
 * compares canonical targets, which is the only check that survives aliases.
 */
async function targetInside(ctx, root, path) {
  const rootTarget = await ctx.fs.resolve(root)
  const target = await ctx.fs.resolve(path)
  if (typeof ctx.fs.contains === 'function' && !ctx.fs.contains(rootTarget, target)) {
    throw new OpsError(403, 'OUTSIDE_WORKSPACE', '解析后不在工作区内（符号链接指向了外面？）')
  }
  return target
}

/** Keep only the directory entries whose canonical target is inside `root`. */
async function listInside(ctx, root, path) {
  const entries = await ctx.fs.listDir(await targetInside(ctx, root, path))
  if (typeof ctx.fs.contains !== 'function') return entries
  const rootTarget = await ctx.fs.resolve(root)
  return entries.filter((entry) => entry?.target === undefined || ctx.fs.contains(rootTarget, entry.target))
}

async function readEditorSource(ctx, absolute) {
  const config = getConfig()
  const target = await targetInside(ctx, workspaceRootOf(ctx, absolute), absolute)
  const info = await ctx.fs.stat(target)
  if (info === undefined) throw new OpsError(404, 'NOT_FOUND', '文件不存在')
  if (info.type !== 'file') throw new OpsError(415, 'NOT_A_FILE', '不是普通文件')
  if (typeof info.size === 'number' && info.size > config.maxEditorBytes) {
    throw new OpsError(413, 'TOO_LARGE', `pluginlet 源码超过 ${config.maxEditorBytes / 1024} KiB（配置 maxEditorBytes）`)
  }
  const bytes = await ctx.fs.readBytes(target, undefined, config.maxEditorBytes)
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new OpsError(415, 'NOT_UTF8', 'pluginlet 源码必须是 UTF-8')
  }
  return { text, size: bytes.byteLength }
}

async function listEditors(ctx, root) {
  const config = getConfig()
  const items = []
  const seen = new Set()
  // Only the configured directories: a pluginlet lives in .dsh/pluginlets/, so a
  // stray *.pluginlet at the repository root never becomes a tab by accident.
  const directories = config.directories.map((directory) => join(root, directory))
  for (const directory of directories) {
    let entries
    try {
      entries = await listInside(ctx, root, directory)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.type !== 'file') continue
      if (!config.extensions.some((suffix) => entry.name.endsWith(suffix))) continue
      const absolute = join(directory, entry.name)
      if (seen.has(absolute)) continue
      seen.add(absolute)
      if (items.length >= config.maxEditors) break
      let source
      try {
        source = await readEditorSource(ctx, absolute)
      } catch {
        continue
      }
      const hash = createHash('sha256').update(source.text, 'utf8').digest('hex')
      items.push({
        path: absolute,
        name: editorName(absolute, config.extensions),
        file: entry.name,
        relative: relativeTo(root, absolute),
        size: source.size,
        hash,
      })
    }
  }
  items.sort((left, right) => left.name.localeCompare(right.name) || left.relative.localeCompare(right.relative))
  return items
}

/** True when the granted scopes cover one workspace-relative path. */
function requireScope(decision, capability, target) {
  if (capability === 'net:fetch') return
  if (target === undefined) return
  if (!scopeAllows(decision.scopes, capability, target)) {
    throw new OpsError(403, 'OUT_OF_SCOPE', `${capability} 没有覆盖 ${target}（授权范围：${(decision.scopes[capability] ?? []).join(', ') || '无'}）`)
  }
}

/**
 * Verify the editor that is asking was granted `capability` for its exact hash,
 * and — when a target is supplied — that the target is inside the granted scope.
 */
async function authorizeCapability(ctx, root, editorPath, hash, capability, target) {
  const config = getConfig()
  if (!allowedCapabilities(config).includes(capability)) {
    throw new OpsError(403, 'DISABLED', `${capability} 已被插件配置禁用`)
  }
  const path = requireAbsolute(editorPath)
  workspaceRootOf(ctx, path)
  const expected = issuedHash(root, path)
  if (expected === undefined) throw new OpsError(409, 'NOT_LOADED', 'pluginlet 尚未加载')
  if (typeof hash !== 'string' || hash !== expected) {
    throw new OpsError(409, 'STALE_HASH', 'pluginlet 内容已变化，请重新加载')
  }
  const decision = await storeFor().authorize(root, path, expected, capability, config.devMode)
  if (!decision.ok) throw new OpsError(403, 'NOT_GRANTED', `这个 pluginlet 没有 ${capability} 能力`)
  requireScope(decision, capability, target)
  return { path, hash: expected, devMode: decision.devMode, scopes: decision.scopes }
}

/** Reject scopes that could mean something other than the workspace. */
function validateScopes(raw) {
  const clean = {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return clean
  for (const [capability, list] of Object.entries(raw)) {
    if (!Array.isArray(list)) continue
    const paths = []
    for (const entry of list) {
      if (typeof entry !== 'string' || entry === '') continue
      if (entry === '**') { paths.push('**'); continue }
      if (entry.startsWith('/') || entry.includes('..')) continue
      paths.push(entry.replace(/^\.\//, ''))
    }
    if (paths.length > 0) clean[capability] = Array.from(new Set(paths))
  }
  return clean
}

/* ── handlers ────────────────────────────────────────────────────────── */

async function discover(ctx, body) {
  const root = requireRoot(ctx, body.root)
  const items = await listEditors(ctx, root)
  return { root, items }
}

async function scan(ctx, body) {
  const config = getConfig()
  const root = requireRoot(ctx, body.root)
  const path = requireAbsolute(body.path)
  workspaceRootOf(ctx, path)
  const { text } = await readEditorSource(ctx, path)
  const result = scanSource(text)
  const allowed = allowedCapabilities(config)
  const capabilities = result.capabilities.filter((capability) => allowed.includes(capability))
  const unavailable = result.capabilities.filter((capability) => !allowed.includes(capability))
  return {
    root,
    path,
    name: editorName(path, config.extensions),
    relative: relativeTo(root, path),
    blocked: result.blocked,
    notes: result.notes,
    hash: result.hash,
    bytes: result.bytes,
    lines: result.lines,
    capabilities,
    unavailable,
    scopes: filterScopes(result.scopes, capabilities),
    dynamic: result.dynamic,
    devMode: config.devMode,
  }
}

async function source(ctx, body) {
  const config = getConfig()
  const root = requireRoot(ctx, body.root)
  const path = requireAbsolute(body.path)
  workspaceRootOf(ctx, path)
  const { text } = await readEditorSource(ctx, path)
  const result = scanSource(text)
  if (typeof body.hash === 'string' && body.hash !== '' && body.hash !== result.hash) {
    throw new OpsError(409, 'STALE_HASH', 'pluginlet 在扫描后被改动，请重新扫描')
  }
  const allowed = allowedCapabilities(config)
  const capabilities = result.capabilities.filter((capability) => allowed.includes(capability))
  const unavailable = result.capabilities.filter((capability) => !allowed.includes(capability))
  const scopes = filterScopes(result.scopes, capabilities)
  if (result.blocked.length > 0) {
    return { root, path, hash: result.hash, blocked: result.blocked, capabilities, unavailable, scopes, dynamic: result.dynamic, denied: true }
  }
  const decision = await storeFor().approved(root, path, result.hash, config.devMode)
  if (!decision.ok) {
    return {
      root,
      path,
      hash: result.hash,
      blocked: [],
      capabilities,
      unavailable,
      scopes,
      dynamic: result.dynamic,
      denied: true,
      reason: decision.reason ?? 'not-granted',
    }
  }
  issueHash(root, path, result.hash)
  await storeFor().audit({ kind: 'load', root, path, hash: result.hash, devMode: decision.devMode })
  return {
    root,
    path,
    name: editorName(path, config.extensions),
    hash: result.hash,
    source: text,
    capabilities,
    unavailable,
    granted: decision.scopes,
    devMode: decision.devMode,
    scopes: filterScopes(decision.scopes, capabilities),
    dynamic: result.dynamic,
    notes: result.notes,
  }
}

async function state(ctx, body) {
  const root = requireRoot(ctx, body.root)
  return storeFor().state(root)
}

async function effectiveConfig() {
  const config = getConfig()
  return {
    config: {
      devMode: config.devMode,
      extensions: config.extensions,
      directories: config.directories,
      maxEditors: config.maxEditors,
      maxEditorBytes: config.maxEditorBytes,
      allowRead: config.allowRead,
      allowNetwork: config.allowNetwork,
      allowWrite: config.allowWrite,
      net: config.net,
    },
  }
}

async function grant(ctx, body) {
  const config = getConfig()
  const root = requireRoot(ctx, body.root)
  const path = requireAbsolute(body.path)
  workspaceRootOf(ctx, path)
  if (typeof body.hash !== 'string' || !/^[0-9a-f]{64}$/.test(body.hash)) {
    throw new OpsError(400, 'INVALID_HASH', '缺少内容哈希')
  }
  const allowed = allowedCapabilities(config)
  const requested = Array.isArray(body.capabilities) ? body.capabilities.map(String) : []
  const capabilities = requested.filter((capability) => allowed.includes(capability))
  const scopes = validateScopes(body.scopes)
  const grantedScopes = {}
  for (const capability of capabilities) {
    grantedScopes[capability] = scopes[capability] ?? ['**']
  }
  const value = await storeFor().grant(root, path, body.hash, grantedScopes, body.merge === true)
  await storeFor().audit({
    kind: body.merge === true ? 'granted-merge' : 'granted',
    root,
    path,
    hash: body.hash,
    scopes: grantedScopes,
    devMode: config.devMode,
  })
  return value
}

async function revoke(ctx, body) {
  const root = requireRoot(ctx, body.root)
  if (body.all === true) {
    for (const key of issued.keys()) if (key.startsWith(`${root}|`)) issued.delete(key)
    return storeFor().revoke(root)
  }
  const path = requireAbsolute(body.path)
  issued.delete(`${root}|${path}`)
  return storeFor().revoke(root, path)
}

/** Client-side diagnostics: the page reports its own failures into the audit log. */
async function clientEvent(ctx, body) {
  let root
  try {
    root = body.root === undefined || body.root === null || body.root === '' ? undefined : requireRoot(ctx, body.root)
  } catch {
    root = undefined
  }
  const kind = typeof body.kind === 'string' ? body.kind.slice(0, 40) : 'client'
  const message = typeof body.message === 'string' ? body.message.slice(0, 2000) : ''
  await storeFor().audit({ kind: `client:${kind}`, root, path: typeof body.path === 'string' ? body.path : undefined, message })
  return { ok: true }
}

async function log(ctx, body) {
  const root = requireRoot(ctx, body.root)
  const entries = await storeFor().tail(typeof body.count === 'number' ? body.count : 40)
  return { root, entries }
}

async function fsList(ctx, body) {
  const root = requireRoot(ctx, body.root)
  const path = body.file === undefined || body.file === null || body.file === '' ? root : requireAbsolute(body.file)
  workspaceRootOf(ctx, path)
  await authorizeCapability(ctx, root, body.path, body.hash, 'fs:read', relativeTo(root, path))
  const entries = await listInside(ctx, root, path)
  return {
    path,
    entries: entries
      .map((entry) => ({ name: entry.name, type: entry.type, size: typeof entry.size === 'number' ? entry.size : null }))
      .sort((left, right) => (left.type === right.type ? left.name.localeCompare(right.name) : left.type === 'directory' ? -1 : 1)),
  }
}

async function fsRead(ctx, body) {
  const root = requireRoot(ctx, body.root)
  const path = requireAbsolute(body.file)
  workspaceRootOf(ctx, path)
  await authorizeCapability(ctx, root, body.path, body.hash, 'fs:read', relativeTo(root, path))
  const target = await targetInside(ctx, root, path)
  const info = await ctx.fs.stat(target)
  if (info === undefined) throw new OpsError(404, 'NOT_FOUND', '文件不存在')
  if (info.type !== 'file') throw new OpsError(415, 'NOT_A_FILE', '不是普通文件')
  if (typeof info.size === 'number' && info.size > MAX_READ_BYTES) {
    throw new OpsError(413, 'TOO_LARGE', `文件超过 ${MAX_READ_BYTES / 1024} KiB`)
  }
  const bytes = await ctx.fs.readBytes(target, undefined, MAX_READ_BYTES)
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new OpsError(415, 'NOT_UTF8', '不是 UTF-8 文本')
  }
  if (text.includes('\u0000')) throw new OpsError(415, 'BINARY', '看起来是二进制文件')
  return { path, text, size: bytes.byteLength, version: String(info.version) }
}

/** Loopback, link-local, ULA and the RFC1918 blocks. */
function isPrivateAddress(raw) {
  const address = String(raw ?? '').toLowerCase()
  if (address === '' ) return true
  if (address === '::1' || address === '::' || address === '0.0.0.0') return true
  if (address.startsWith('fe80:') || address.startsWith('fc') || address.startsWith('fd')) return true
  if (address.startsWith('::ffff:')) return isPrivateAddress(address.slice('::ffff:'.length))
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address)
  if (v4 === null) return false
  const [a, b] = [Number(v4[1]), Number(v4[2])]
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)      // carrier NAT
    || (a === 169 && b === 254)                // link-local (cloud metadata)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
}

/**
 * Accept only https/http URLs whose host is public.
 *
 * Literal addresses are checked directly; a name is resolved first and every
 * address it yields must be public. The lookup still races the connection
 * (DNS rebinding), so callers re-run this for every redirect hop.
 */
async function assertPublicUrl(raw) {
  let url
  try {
    url = new URL(String(raw))
  } catch {
    throw new OpsError(400, 'INVALID_URL', '不是合法 URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new OpsError(400, 'INVALID_URL', '只允许 http / https')
  }
  if (url.username !== '' || url.password !== '') {
    throw new OpsError(400, 'INVALID_URL', 'URL 中不允许携带凭据')
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === '' || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new OpsError(403, 'PRIVATE_HOST', '本机 / 内网地址不开放')
  }
  if (isPrivateAddress(host)) throw new OpsError(403, 'PRIVATE_HOST', '内网地址不开放')
  let addresses
  try {
    addresses = await lookup(host, { all: true })
  } catch {
    throw new OpsError(502, 'DNS_FAILED', `无法解析 ${host}`)
  }
  if (addresses.length === 0) throw new OpsError(502, 'DNS_FAILED', `无法解析 ${host}`)
  if (addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new OpsError(403, 'PRIVATE_HOST', `${host} 解析到内网地址`)
  }
  return url
}

async function netFetch(ctx, body) {
  const config = getConfig()
  const root = requireRoot(ctx, body.root)
  const { path } = await authorizeCapability(ctx, root, body.path, body.hash, 'net:fetch')
  const url = await assertPublicUrl(body.url)
  takeNetBudget(`${root}|${path}`, config)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const init = {
      method: typeof body.init?.method === 'string' ? body.init.method.toUpperCase() : 'GET',
      headers: {},
      redirect: 'follow',
      signal: controller.signal,
    }
    if (body.init?.headers !== null && typeof body.init?.headers === 'object') {
      for (const [key, value] of Object.entries(body.init.headers)) {
        if (typeof value !== 'string') continue
        if (/^(cookie|authorization|host)$/i.test(key)) continue
        init.headers[key] = value
      }
    }
    if (typeof body.init?.body === 'string' && init.method !== 'GET') init.body = body.init.body
    // Redirects are followed by hand so every hop is validated again.
    let current = url
    let response
    for (let hop = 0; ; hop += 1) {
      response = await fetch(current.href, { ...init, redirect: 'manual' })
      if (response.status < 300 || response.status > 399) break
      if (hop >= 5) throw new OpsError(403, 'TOO_MANY_REDIRECTS', '重定向次数过多')
      const location = response.headers.get('location')
      if (!location) break
      const next = new URL(location, current)
      current = await assertPublicUrl(next.href)
      if (response.status === 303) {
        init.method = 'GET'
        delete init.body
      }
    }
    const declared = Number(response.headers.get('content-length') ?? '0')
    if (Number.isFinite(declared) && declared > config.net.maxBytes) {
      throw new OpsError(413, 'RESPONSE_TOO_LARGE', `响应超过 ${config.net.maxBytes} 字节`)
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.byteLength > config.net.maxBytes) throw new OpsError(413, 'RESPONSE_TOO_LARGE', '响应过大')
    const headers = {}
    response.headers.forEach((value, key) => { headers[key] = value })
    await storeFor().audit({ kind: 'net', root, path, url: current.href, status: response.status, bytes: buffer.byteLength })
    return {
      url: current.href,
      status: response.status,
      ok: response.ok,
      headers,
      body: buffer.toString('utf8'),
    }
  } catch (error) {
    if (error instanceof OpsError) throw error
    if (error?.name === 'AbortError') throw new OpsError(504, 'TIMEOUT', '请求超时')
    throw new OpsError(502, 'FETCH_FAILED', String(error?.message ?? error))
  } finally {
    clearTimeout(timer)
  }
}

async function write(ctx, body) {
  const root = requireRoot(ctx, body.root)
  if (body.confirmed !== true) {
    throw new OpsError(403, 'NOT_CONFIRMED', '写入必须由用户确认')
  }
  const target = requireAbsolute(body.target)
  workspaceRootOf(ctx, target)
  const { path } = await authorizeCapability(ctx, root, body.path, body.hash, 'write:request', relativeTo(root, target))
  if (typeof body.text !== 'string') throw new OpsError(400, 'INVALID_TEXT', '缺少 text')
  if (Buffer.byteLength(body.text, 'utf8') > MAX_READ_BYTES) throw new OpsError(413, 'TOO_LARGE', '内容超过 1 MiB')

  const resolved = await targetInside(ctx, root, target)
  const info = await ctx.fs.stat(resolved)
  if (info === undefined) throw new OpsError(404, 'NOT_FOUND', '目标文件不存在')
  if (info.type !== 'file') throw new OpsError(415, 'NOT_A_FILE', '目标不是普通文件')
  const guarded = typeof body.version === 'string' && body.version !== ''
  let outcome
  try {
    outcome = await ctx.fs.writeText(
      resolved,
      body.text,
      guarded ? { kind: 'replaceIfVersion', version: body.version } : undefined,
      undefined,
      { mode: 'workspace-write', workspaceRoot: root },
    )
  } catch (error) {
    const code = String(error?.code ?? '')
    if (code === 'FS_STALE_VERSION' || code === 'FS_NOT_OBSERVED') {
      throw new OpsError(409, 'STALE', '文件在读取后被改动过，未写入')
    }
    if (code === 'FS_SANDBOX_DENIED') throw new OpsError(403, 'SANDBOX_DENIED', '文件系统沙箱拒绝写入')
    throw new OpsError(500, 'WRITE_FAILED', String(error?.message ?? error))
  }
  await storeFor().audit({ kind: 'write', root, path, target, bytes: Buffer.byteLength(body.text, 'utf8') })
  return { path: target, version: String(outcome.version), operation: outcome.operation }
}

/** Keep only the scopes of capabilities that survived the config filter. */
function filterScopes(scopes, capabilities) {
  const filtered = {}
  for (const capability of capabilities) {
    const list = scopes?.[capability]
    if (Array.isArray(list) && list.length > 0) filtered[capability] = list
  }
  return filtered
}

const ROUTES = {
  discover,
  scan,
  source,
  state,
  config: effectiveConfig,
  grant,
  revoke,
  log,
  'client-event': clientEvent,
  'fs/list': fsList,
  'fs/read': fsRead,
  'net/fetch': netFetch,
  write,
}

export const ROUTE_NAMES = Object.keys(ROUTES)

/**
 * Serve one request for a named route.
 * @param {*} ctx - Host plugin context.
 * @param {string} route - route key from {@link ROUTE_NAMES}.
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {import('node:http').ServerResponse} res - response.
 */
export async function serve(ctx, route, req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: { code: 'METHOD', message: '只接受 POST' } })
    return
  }
  if (req.headers[PLUGIN_HEADER] !== PLUGIN_HEADER_VALUE) {
    sendJson(res, 403, { ok: false, error: { code: 'FORBIDDEN', message: '缺少插件请求头' } })
    return
  }
  const handler = ROUTES[route]
  if (handler === undefined) {
    sendJson(res, 404, { ok: false, error: { code: 'NO_ROUTE', message: `未知路由 ${route}` } })
    return
  }
  try {
    const body = await readBody(req)
    const data = await handler(ctx, body)
    sendJson(res, 200, { ok: true, ...data })
  } catch (error) {
    const status = error instanceof OpsError ? error.statusCode : 500
    const code = error instanceof OpsError ? error.code : 'INTERNAL'
    sendJson(res, status, { ok: false, error: { code, message: String(error?.message ?? error) } })
  }
}

export { PREFIX }
