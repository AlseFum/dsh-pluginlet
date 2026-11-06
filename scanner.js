/**
 * pluginlet — static scanner.
 *
 * The scanner is NOT the security boundary: editor code runs in a CSP-locked
 * sandboxed iframe with no network, no same-origin access, and no ambient
 * globals. What the scanner does is *declare intent*:
 *
 *   - `blocked`      : constructs the sandbox makes impossible (fetch, eval,
 *                      child_process, import, window/document, ...). Finding one
 *                      means either the author misunderstands the contract or is
 *                      trying to escape it; either way the manager refuses.
 *   - `capabilities` : the wrapped capability calls the source actually uses
 *                      (`api.fs.read`, `api.net.fetch`, `api.write.request`).
 *                      These become the exact permission prompt items.
 *
 * Because the decision is "which capabilities does this ask for", a lexical
 * pass over code with literals stripped is enough and cheap. It is honest about
 * that: `notes` records what the scan could not prove.
 */
import { createHash } from 'node:crypto'

/** Hard limit on a single editor source. */
export const MAX_EDITOR_BYTES = 512 * 1024

/** Constructs that are never allowed, whatever the user grants. */
export const BLOCKED_RULES = [
  { rule: 'eval', re: /\beval\s*\(/, hint: 'eval 在沙箱里没有意义，且无法审计' },
  { rule: 'Function', re: /\bnew\s+Function\b|\bFunction\s*\(\s*["'`]/, hint: '动态构造函数是逃逸手段' },
  { rule: 'module-loading', re: /\bimport\s*\(|\brequire\s*\(/, hint: 'v1 不允许 import / require，pluginlet 必须自包含' },
  { rule: 'esm-import', re: /(^|\n)\s*import\s+[\w{*]/, hint: 'v1 不允许 import，pluginlet 必须自包含' },
  { rule: 'bare-fetch', re: /(?<![.$\w])fetch\s*\(/, hint: '请改用 api.net.fetch（受管、限流、可审计）' },
  { rule: 'xhr', re: /\bXMLHttpRequest\b|\bEventSource\b|\bsendBeacon\b/, hint: '网络只能走 api.net.fetch' },
  { rule: 'websocket', re: /\b(?:WebSocket|SharedWorker|Worker)\b/, hint: '不允许自建连接或线程' },
  { rule: 'global-object', re: /\bglobalThis\b|\bself\s*\.|\btop\s*\.|\bparent\s*\./, hint: '不允许访问全局对象' },
  { rule: 'storage', re: /\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b|\bcookie\b/, hint: '浏览器存储不开放；状态请放组件内' },
  { rule: 'process', re: /\bprocess\s*\.|\bchild_process\b|\bDeno\b|\bBun\s*\./, hint: '不允许触碰进程或运行代码' },
  { rule: 'messaging', re: /\bpostMessage\b|\baddEventListener\s*\(\s*["']message/, hint: '宿主通道是私有的' },
  { rule: 'navigator', re: /\bnavigator\s*\./, hint: '浏览器能力不开放' },
]

/** Wrapped capability calls; each hit becomes a permission item. */
const CAPABILITY_RULES = [
  { capability: 'fs:read', re: /\bapi\s*\.\s*fs\s*\.\s*(read|list|stat)\b/ },
  { capability: 'net:fetch', re: /\bapi\s*\.\s*net\s*\.\s*fetch\b/ },
  { capability: 'write:request', re: /\bapi\s*\.\s*write\s*\.\s*request\b/ },
]

/** Everything below is informational only. */
const NOTE_RULES = [
  { note: 'timer', re: /\bsetInterval\s*\(/, text: '使用了 setInterval：沙箱会把最小间隔抬到 250ms' },
  { note: 'async', re: /\bawait\b|\basync\b/, text: '使用了 async：组件首次渲染是同步的，异步结果请放进 state' },
]

/**
 * Replace string / template / regex / comment bodies with spaces while keeping
 * newlines, so line numbers survive and keywords in prose do not match.
 * Deliberately a lexer, not a parser: it only needs to be good enough that a
 * comment saying "we do not call fetch" does not trip the fetch rule.
 * @param {string} source - raw editor source.
 * @returns {string} same-length-ish sanitized source with line breaks preserved.
 */
export function stripLiterals(source) {
  const out = []
  let i = 0
  const n = source.length
  let mode = 'code' // code | line | block | single | double | template | regex
  while (i < n) {
    const c = source[i]
    const next = source[i + 1]
    if (mode === 'code') {
      if (c === '/' && next === '/') { mode = 'line'; out.push('  '); i += 2; continue }
      if (c === '/' && next === '*') { mode = 'block'; out.push('  '); i += 2; continue }
      if (c === "'") { mode = 'single'; out.push(' '); i += 1; continue }
      if (c === '"') { mode = 'double'; out.push(' '); i += 1; continue }
      if (c === '`') { mode = 'template'; out.push(' '); i += 1; continue }
      out.push(c); i += 1; continue
    }
    if (mode === 'line') {
      if (c === '\n') { mode = 'code'; out.push('\n') } else out.push(' ')
      i += 1; continue
    }
    if (mode === 'block') {
      if (c === '*' && next === '/') { mode = 'code'; out.push('  '); i += 2; continue }
      out.push(c === '\n' ? '\n' : ' '); i += 1; continue
    }
    // string-ish: handle escapes, and `${}` inside templates stays stripped too
    if (c === '\\') { out.push('  '); i += 2; continue }
    if (mode === 'template' && c === '$' && next === '{') {
      // A template hole is code; scanning it as code is stricter than skipping
      // it, so keep the hole and go back to code mode until the matching brace.
      out.push('  '); i += 2
      let depth = 1
      while (i < n && depth > 0) {
        const ch = source[i]
        if (ch === '{') depth += 1
        else if (ch === '}') depth -= 1
        if (depth > 0) out.push(ch === '\n' ? '\n' : ch)
        i += 1
      }
      continue
    }
    const closes = (mode === 'single' && c === "'") || (mode === 'double' && c === '"') || (mode === 'template' && c === '`')
    if (closes) { mode = 'code'; out.push(' '); i += 1; continue }
    out.push(c === '\n' ? '\n' : ' ')
    i += 1
  }
  return out.join('')
}

/**
 * Read the first argument expression of a call, balancing brackets and quotes.
 * @param {string} text - raw source.
 * @param {number} start - index just after the opening parenthesis.
 * @returns {string} the argument text, trimmed, up to a top-level comma or the closing parenthesis.
 */
function readArgument(text, start) {
  let depth = 0
  let quote = null
  let index = start
  while (index < text.length) {
    const char = text[index]
    if (quote !== null) {
      if (char === '\\') { index += 2; continue }
      if (char === quote) quote = null
      index += 1
      continue
    }
    if (char === "'" || char === '"' || char === '`') { quote = char; index += 1; continue }
    if (char === '(' || char === '[' || char === '{') depth += 1
    else if (char === ')' && depth === 0) break
    else if (char === ')' || char === ']' || char === '}') depth -= 1
    else if (char === ',' && depth === 0) break
    index += 1
  }
  return text.slice(start, index).trim()
}

/** Top-level `const NAME = 'literal'` bindings, so `api.fs.read(TARGET)` stays precise. */
function collectConstants(source) {
  const map = new Map()
  const pattern = /(?:^|\n)\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(['"`])([^'"`\n]*)\2\s*(?:;|\n|$)/g
  let match
  while ((match = pattern.exec(source)) !== null) map.set(match[1], match[3])
  return map
}

/**
 * Interpret one argument as a workspace-relative path.
 * @param {string} argument - the argument expression text.
 * @param {Map<string, string>} constants - file-scope literal bindings.
 * @returns {{ kind: 'literal', path: string } | { kind: 'dynamic' } | { kind: 'outside' }}
 */
function interpretPath(argument, constants) {
  const value = argument.trim()
  const quoted = /^(['"])([^'"\n]*)\1$/.exec(value)
  if (quoted !== null) return classifyPath(quoted[2])
  const template = /^`([^`$\n]*)`$/.exec(value)
  if (template !== null) return classifyPath(template[1])
  const identifier = /^[A-Za-z_$][\w$]*$/.exec(value)
  if (identifier !== null && constants.has(identifier[0])) return classifyPath(constants.get(identifier[0]))
  return { kind: 'dynamic' }
}

/**
 * @param {string} raw - a literal argument.
 * @returns {{ kind: 'literal', path: string } | { kind: 'outside' }}
 */
function classifyPath(raw) {
  const path = raw.trim().replace(/^\.\//, '')
  if (path === '') return { kind: 'literal', path: '' }
  if (path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path) || path.split('/').includes('..')) {
    return { kind: 'outside', raw: raw.trim() }
  }
  const segments = path.split('/').filter((segment) => segment !== '' && segment !== '.')
  const directory = path.endsWith('/')
  return { kind: 'literal', path: segments.join('/') + (directory && segments.length > 0 ? '/' : '') }
}

/**
 * Extract the paths a source touches, per capability.
 *
 * Static where possible: literals and top-level `const` bindings resolve to an
 * exact path; anything else falls back to the whole workspace (`**`) and is
 * flagged so the approval dialog can say so out loud.
 *
 * @param {string} source - editor module source.
 * @returns {{ scopes: Record<string, string[]>, dynamic: Record<string, boolean> }}
 */
export function extractPaths(source) {
  const text = String(source)
  const constants = collectConstants(text)
  const scopes = { 'fs:read': [], 'write:request': [] }
  const dynamic = { 'fs:read': false, 'write:request': false }
  const seen = { 'fs:read': new Set(), 'write:request': new Set() }

  const escapes = []
  const lineAt = (index) => String(text).slice(0, index).split('\n').length
  const record = (capability, argument, index) => {
    const result = interpretPath(argument, constants)
    if (result.kind === 'outside') {
      escapes.push({ line: lineAt(index), path: result.raw, capability })
      return
    }
    if (result.kind !== 'literal' || result.path === '') {
      dynamic[capability] = true
      return
    }
    if (seen[capability].has(result.path)) return
    seen[capability].add(result.path)
    scopes[capability].push(result.path)
  }

  const readPattern = /api\s*\.\s*fs\s*\.\s*(?:read|list|stat)\s*\(/g
  let match
  while ((match = readPattern.exec(text)) !== null) {
    record('fs:read', readArgument(text, match.index + match[0].length), match.index)
  }
  const writePattern = /api\s*\.\s*write\s*\.\s*request\s*\(/g
  while ((match = writePattern.exec(text)) !== null) {
    record('write:request', readArgument(text, match.index + match[0].length), match.index)
  }

  for (const capability of Object.keys(scopes)) {
    if (dynamic[capability]) scopes[capability] = ['**']
    scopes[capability].sort()
  }
  return { scopes, dynamic, escapes }
}

/**
 * Describe what an editor source asks for, without running it.
 * @param {string} source - editor module source.
 * @returns {{ hash: string, bytes: number, lines: number, blocked: Array<{rule: string, line: number, excerpt: string, hint: string}>, capabilities: string[], notes: string[] }}
 */
export function scanSource(source) {
  const text = typeof source === 'string' ? source : ''
  const bytes = Buffer.byteLength(text, 'utf8')
  const lines = text.length === 0 ? 0 : text.split('\n').length
  const hash = createHash('sha256').update(text, 'utf8').digest('hex')
  const sanitized = stripLiterals(text)
  const sanitizedLines = sanitized.split('\n')
  const rawLines = text.split('\n')

  /** @type {Array<{rule: string, line: number, excerpt: string, hint: string}>} */
  const blocked = []
  const seen = new Set()
  for (const rule of BLOCKED_RULES) {
    for (let index = 0; index < sanitizedLines.length; index += 1) {
      if (!rule.re.test(sanitizedLines[index])) continue
      const key = `${rule.rule}:${index + 1}`
      if (seen.has(key)) continue
      seen.add(key)
      blocked.push({
        rule: rule.rule,
        line: index + 1,
        excerpt: (rawLines[index] ?? '').trim().slice(0, 160),
        hint: rule.hint,
      })
      break // one hit per rule per file keeps the prompt readable
    }
  }

  const capabilities = []
  for (const rule of CAPABILITY_RULES) {
    if (rule.re.test(sanitized)) capabilities.push(rule.capability)
  }

  const paths = extractPaths(text)
  if (capabilities.includes('net:fetch')) paths.scopes['net:fetch'] = ['**']
  for (const escape of paths.escapes) {
    const key = `path-escape:${escape.line}`
    if (seen.has(key)) continue
    seen.add(key)
    blocked.push({
      rule: 'path-escape',
      line: escape.line,
      excerpt: escape.path,
      hint: '路径只能相对工作区根：不能用绝对路径，也不能用 ..',
    })
  }
  const notes = []
  for (const rule of NOTE_RULES) {
    if (rule.re.test(sanitized)) notes.push(rule.text)
  }
  if (bytes > MAX_EDITOR_BYTES) notes.push(`源码 ${(bytes / 1024).toFixed(0)} KiB，超过 ${MAX_EDITOR_BYTES / 1024} KiB 上限`)
  if (lines > 0 && bytes / lines > 400) notes.push('平均行长很大，可能被压缩过，人工很难审查')

  return { hash, bytes, lines, blocked, capabilities, notes, scopes: paths.scopes, dynamic: paths.dynamic }
}
