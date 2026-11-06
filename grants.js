/**
 * pluginlet — grant store.
 *
 * A grant is bound to a capability **and a path scope**:
 *
 *   { root: { grants: { "/abs/editor": { hash, scopes: { "fs:read": ["notes/a.md"] }, at } } } }
 *
 * Scopes are workspace-relative POSIX paths:
 *   - `notes/a.md`  one exact file
 *   - `notes/`      that directory and everything below it
 *   - `**`          the whole workspace (only when the source's paths cannot be
 *                   resolved statically, and the person approved that)
 *
 * The hash pins the content, so editing an editor revokes its approval; the
 * scopes pin the reach, so approving "read notes/a.md" never means "read the
 * repository". Grants live in the plugin's own directory under `$DSH_HOME`,
 * never in the workspace: a repository must not be able to ship its approval.
 *
 * Development mode is not stored here: it is part of the plugin configuration
 * and is passed into `authorize`. Writes are serialized through one promise
 * chain and published with temp + rename, so a crash never leaves a half-written
 * grant file.
 */
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const GRANTABLE = Object.freeze(['fs:read', 'net:fetch', 'write:request'])

/**
 * Does one capability's scope list cover a workspace-relative target?
 * @param {Record<string, string[]>} scopes - granted scopes by capability.
 * @param {string} capability - `fs:read` or `write:request`.
 * @param {string} target - workspace-relative path ('' for the root itself).
 * @returns {boolean} whether the target sits inside the granted scopes.
 */
export function scopeAllows(scopes, capability, target) {
  const list = scopes?.[capability]
  if (!Array.isArray(list) || list.length === 0) return false
  const path = String(target ?? '')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
  if (path === '' || path === '.') return list.includes('**')
  for (const scope of list) {
    if (scope === '**') return true
    if (scope.endsWith('/')) {
      const directory = scope.slice(0, -1)
      if (path === directory || path.startsWith(scope)) return true
      continue
    }
    if (path === scope) return true
  }
  return false
}

/**
 * @param {{ dshHome: string }} options - resolved DSH home directory.
 */
export function createGrantStore(options) {
  const dir = join(options.dshHome, 'pluginlet')
  const file = join(dir, 'grants.json')
  const auditFile = join(dir, 'audit.jsonl')
  /** @type {{ key: string, data: any } | null} */
  let cache = null
  let queue = Promise.resolve()

  async function ensureDir() {
    await mkdir(dir, { recursive: true, mode: 0o700 })
  }

  async function load() {
    try {
      const info = await stat(file)
      const key = `${info.mtimeMs}-${info.size}`
      if (cache !== null && cache.key === key) return cache.data
      const text = await readFile(file, 'utf8')
      const parsed = JSON.parse(text)
      const data = parsed && typeof parsed === 'object' && parsed.version === 1 ? parsed : { version: 1, workspaces: {} }
      cache = { key, data }
      return data
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        const data = { version: 1, workspaces: {} }
        cache = { key: 'empty', data }
        return data
      }
      if (error instanceof SyntaxError) {
        // A corrupt grant file must fail closed, never open.
        const data = { version: 1, workspaces: {}, corrupt: true }
        cache = { key: 'corrupt', data }
        return data
      }
      throw error
    }
  }

  function enqueue(operation) {
    const next = queue.then(operation, operation)
    queue = next.then(() => undefined, () => undefined)
    return next
  }

  async function save(data) {
    await ensureDir()
    const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, file)
    cache = null
  }

  function workspaceOf(data, root, create) {
    const existing = data.workspaces[root]
    if (existing !== undefined) return existing
    if (!create) return undefined
    const created = { grants: {} }
    data.workspaces[root] = created
    return created
  }

  /** Old records stored a bare capability list; treat those as whole-workspace. */
  function scopesOf(record) {
    if (record === undefined) return {}
    if (record.scopes !== undefined && record.scopes !== null && typeof record.scopes === 'object') return record.scopes
    if (Array.isArray(record.capabilities)) {
      const migrated = {}
      for (const capability of record.capabilities) migrated[capability] = ['**']
      return migrated
    }
    return {}
  }

  async function state(root) {
    const data = await load()
    const workspace = workspaceOf(data, root, false)
    const grants = {}
    for (const [path, record] of Object.entries(workspace?.grants ?? {})) {
      grants[path] = { hash: record.hash, scopes: scopesOf(record), at: record.at }
    }
    return { root, grants, corrupt: data.corrupt === true }
  }

  /**
   * Record an approval. `merge` unions the new scopes into the existing record
   * for the same content — that is how a running editor widens its own access
   * without losing what it already had. A different hash always replaces.
   */
  async function grant(root, path, hash, scopes, merge = false) {
    return enqueue(async () => {
      const data = await load()
      const workspace = workspaceOf(data, root, true)
      const clean = {}
      for (const capability of GRANTABLE) {
        const list = scopes?.[capability]
        if (!Array.isArray(list)) continue
        const paths = Array.from(new Set(list.filter((entry) => typeof entry === 'string' && entry !== '')))
        if (paths.length > 0) clean[capability] = paths
      }
      const previous = workspace.grants[path]
      if (merge === true && previous !== undefined && previous.hash === hash) {
        const unioned = {}
        const previousScopes = scopesOf(previous)
        for (const capability of GRANTABLE) {
          const merged = new Set([...(previousScopes[capability] ?? []), ...(clean[capability] ?? [])])
          if (merged.size > 0) unioned[capability] = Array.from(merged).sort()
        }
        workspace.grants[path] = { hash, scopes: unioned, at: new Date().toISOString() }
        await save(data)
        await audit({ kind: 'grant-merge', root, path, hash, added: clean, scopes: unioned })
        return { root, grants: { [path]: { hash, scopes: unioned } } }
      }
      workspace.grants[path] = { hash, scopes: clean, at: new Date().toISOString() }
      await save(data)
      await audit({ kind: 'grant', root, path, hash, scopes: clean })
      return { root, grants: { [path]: { hash, scopes: clean } } }
    })
  }

  async function revoke(root, path) {
    return enqueue(async () => {
      const data = await load()
      const workspace = workspaceOf(data, root, false)
      if (workspace !== undefined) {
        if (typeof path === 'string' && path !== '') {
          delete workspace.grants[path]
          await audit({ kind: 'revoke', root, path })
        } else {
          workspace.grants = {}
          await audit({ kind: 'revoke-all', root })
        }
        await save(data)
      }
      return { root, grants: workspace?.grants ?? {} }
    })
  }

  /**
   * Has this exact content been approved at all? Loading is gated on this, not
   * on every declared capability: an editor may start with a subset (that is
   * what `api.access.can` and runtime requests are for), and each capability
   * call is still checked on its own.
   * @returns {Promise<{ ok: boolean, devMode: boolean, scopes: Record<string, string[]>, reason?: string }>}
   */
  async function approved(root, path, hash, devMode = false) {
    if (devMode === true) {
      return { ok: true, devMode: true, scopes: { 'fs:read': ['**'], 'net:fetch': ['**'], 'write:request': ['**'] } }
    }
    const data = await load()
    const workspace = workspaceOf(data, root, false)
    const record = workspace?.grants?.[path]
    if (record === undefined) return { ok: false, devMode: false, scopes: {}, reason: 'no-grant' }
    if (record.hash !== hash) return { ok: false, devMode: false, scopes: {}, reason: 'hash-mismatch' }
    return { ok: true, devMode: false, scopes: scopesOf(record) }
  }

  /**
   * Is this exact content approved for this capability? The granted scopes are
   * returned so the caller can then check the individual target path.
   * @returns {Promise<{ ok: boolean, devMode: boolean, scopes: Record<string, string[]>, reason?: string }>}
   */
  async function authorize(root, path, hash, capability, devMode = false) {
    if (!GRANTABLE.includes(capability)) {
      return { ok: false, devMode: false, scopes: {}, reason: 'not-grantable' }
    }
    if (devMode === true) {
      return { ok: true, devMode: true, scopes: { 'fs:read': ['**'], 'net:fetch': ['**'], 'write:request': ['**'] } }
    }
    const data = await load()
    const workspace = workspaceOf(data, root, false)
    if (workspace === undefined) return { ok: false, devMode: false, scopes: {}, reason: 'no-grant' }
    const record = workspace.grants[path]
    if (record === undefined) return { ok: false, devMode: false, scopes: {}, reason: 'no-grant' }
    if (record.hash !== hash) return { ok: false, devMode: false, scopes: {}, reason: 'hash-mismatch' }
    const scopes = scopesOf(record)
    if (!Array.isArray(scopes[capability]) || scopes[capability].length === 0) {
      return { ok: false, devMode: false, scopes, reason: `missing:${capability}` }
    }
    return { ok: true, devMode: false, scopes }
  }

  const AUDIT_MAX_BYTES = 2 * 1024 * 1024

  /** Cap the log at one rotated file: unbounded growth eventually fills the disk. */
  async function rotateAudit() {
    try {
      const info = await stat(auditFile)
      if (info.size < AUDIT_MAX_BYTES) return
      await rm(`${auditFile}.1`, { force: true })
      await rename(auditFile, `${auditFile}.1`)
    } catch {
      // Missing log or a racing rotation: either way, appending still works.
    }
  }

  async function audit(entry) {
    try {
      await ensureDir()
      await rotateAudit()
      const handle = await open(auditFile, 'a', 0o600)
      try {
        await handle.write(`${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`)
      } finally {
        await handle.close()
      }
    } catch {
      // The audit log is best effort: an unwritable log must not break loading.
    }
  }

  async function tail(count) {
    try {
      const text = await readFile(auditFile, 'utf8')
      const rows = text.trim().split('\n').filter(Boolean).slice(-Math.max(1, Math.min(count ?? 50, 200)))
      const out = []
      for (const row of rows) {
        try { out.push(JSON.parse(row)) } catch { /* skip a torn line */ }
      }
      return out
    } catch {
      return []
    }
  }

  return { state, grant, revoke, authorize, approved, audit, tail, dir }
}
