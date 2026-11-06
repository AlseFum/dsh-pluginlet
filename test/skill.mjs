/**
 * The packaged skill: applying the Host half must publish `pluginlet-development`,
 * and its body must still cover every construct the scanner blocks and every
 * capability it can grant. The second half is the anti-drift check — a new rule
 * in scanner.js without a line in the skill fails here.
 *
 * Run with `node test/skill.mjs`.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const { apply } = await import('../index.js')
const { BLOCKED_RULES } = await import('../scanner.js')
const { GRANTABLE } = await import('../grants.js')
const { ROUTE_NAMES } = await import('../ops.js')

const registered = []
const routes = []
const effects = []

const ctx = {
  logger: { warn: (message) => { throw new Error(`unexpected warning: ${message}`) } },
  get: (name) => (name === 'skills' ? { register: (skill) => { registered.push(skill); return () => {} } } : undefined),
  effect: (produce, label) => { effects.push(label); return produce() },
  webServer: { register: (route) => { routes.push(route); return () => {} } },
  fs: {},
  workspaceRegistry: {},
}

apply(ctx, {})

/* ── the skill is published ──────────────────────────────────────────── */

assert.equal(registered.length, 1, `expected exactly one skill, got ${registered.length}`)
const skill = registered[0]
assert.equal(skill.name, 'pluginlet-development')
assert.ok(skill.description.length > 40, 'the description must be long enough to route a model here')
assert.ok(skill.whenToUse !== undefined && skill.whenToUse.length > 20, 'whenToUse should be set')
assert.ok(skill.content.length > 1500, `the body looks truncated (${skill.content.length} bytes)`)

/* ── the skill covers every blocked construct ────────────────────────── */

const coverage = {
  'eval': ['eval'],
  'Function': ['new Function'],
  'module-loading': ['require()'],
  'esm-import': ['import'],
  'bare-fetch': ['fetch()'],
  'xhr': ['XMLHttpRequest'],
  'websocket': ['WebSocket'],
  'global-object': ['globalThis'],
  'storage': ['localStorage'],
  'process': ['process'],
  'messaging': ['postMessage'],
  'navigator': ['navigator.'],
}

assert.equal(BLOCKED_RULES.length, Object.keys(coverage).length, 'a scanner rule was added or removed: update the skill and this table')

for (const rule of BLOCKED_RULES) {
  const words = coverage[rule.rule]
  assert.ok(Array.isArray(words), `the skill test has no expectation for scanner rule "${rule.rule}"`)
  for (const word of words) {
    assert.ok(skill.content.includes(word), `the skill body never mentions "${word}" (scanner rule ${rule.rule})`)
  }
}

/* ── and every capability it can grant ───────────────────────────────── */

for (const capability of GRANTABLE) {
  assert.ok(skill.content.includes(capability), `the skill body never mentions ${capability}`)
}

/* ── the contract it teaches is the one the frame implements ─────────── */

for (const token of ['export default', 'api.fs.read', 'api.write.request', 'api.net.fetch', 'ownerDocument', '.dsh/pluginlets/']) {
  assert.ok(skill.content.includes(token), `the skill body is missing "${token}"`)
}

/* ── packaging and side effects ──────────────────────────────────────── */

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
assert.ok(pkg.files.includes('skills'), 'the skill body must be shipped (package.json files)')

const onDisk = await readFile(new URL('../skills/pluginlet-development.md', import.meta.url), 'utf8')
assert.equal(onDisk, skill.content, 'the registered body must be the file on disk')

assert.equal(routes.length, ROUTE_NAMES.length, `every route still registers (got ${routes.length} of ${ROUTE_NAMES.length})`)
assert.ok(pkg.files.every((entry) => typeof entry === 'string'), 'files entries are strings')

console.log('  ok  apply publishes pluginlet-development with a description and a body')
console.log(`  ok  the body covers all ${BLOCKED_RULES.length} blocked constructs`)
console.log(`  ok  the body covers all ${GRANTABLE.length} grantable capabilities`)
console.log('  ok  the registered body is the shipped file, and the routes still register')
console.log('\n4 checks passed')
