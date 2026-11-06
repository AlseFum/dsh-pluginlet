/**
 * Style coverage: every `we-*` class the bundle renders must have a rule in the
 * stylesheet it ships (host page or sandbox frame), and the stylesheets must not
 * carry rules for classes nobody renders. This is the check that would have
 * caught the unstyled permission-page inputs and chips.
 *
 * Run with `node test/styles.mjs`.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')

function classesIn(text) {
  const found = new Set()
  for (const match of text.matchAll(/className\s*[:=]\s*['`]([^'`]+)['`]/g)) {
    for (const name of match[1].split(/\s+/)) if (name.startsWith('we-')) found.add(name)
  }
  return found
}

function rulesIn(css) {
  const found = new Set()
  for (const match of css.matchAll(/\.(we-[a-zA-Z0-9-]+)/g)) found.add(match[1])
  return found
}

/* host page stylesheet */
const hostCssStart = source.indexOf('const CSS = `')
const hostCssEnd = source.indexOf('\n`', hostCssStart + 'const CSS = `'.length)
const hostCss = source.slice(hostCssStart, hostCssEnd)

/* sandbox frame stylesheet */
const frameCssStart = source.indexOf('const FRAME_CSS = [')
const frameCssEnd = source.indexOf('].join', frameCssStart)
const frameCss = source.slice(frameCssStart, frameCssEnd)

// Everything except the two stylesheets and the frame runtime is host markup.
const withoutCss = source.replace(hostCss, '\n')
const runtimeStart = withoutCss.indexOf('function FRAME_RUNTIME')
const runtimeEnd = withoutCss.indexOf('const FRAME_CSS = [')
const hostPart = withoutCss.slice(0, runtimeStart) + withoutCss.slice(runtimeEnd)
const hostClasses = classesIn(hostPart)
const runtimeClasses = classesIn(withoutCss.slice(runtimeStart, runtimeEnd))

const hostRules = rulesIn(hostCss)
const frameRules = rulesIn(frameCss)

/* The runtime's markup lives in the frame; components live on the host page. */
const componentClasses = new Set([...hostClasses].filter((name) => !frameRules.has(name) || name === 'we-frame'))
const missingHost = [...componentClasses].filter((name) => !hostRules.has(name))
assert.deepEqual(missingHost, [], `classes rendered without a host rule: ${missingHost.join(', ')}`)

const missingFrame = [...runtimeClasses].filter((name) => !frameRules.has(name))
assert.deepEqual(missingFrame, [], `classes rendered without a frame rule: ${missingFrame.join(', ')}`)

/* Dead rules: a selector for a class nobody renders suggests a stale design. */
const rendered = new Set([...hostClasses, ...runtimeClasses])
const deadHost = [...hostRules].filter((name) => !rendered.has(name))
const deadFrame = [...frameRules].filter((name) => !rendered.has(name))
assert.deepEqual(deadHost, [], `host rules for classes nobody renders: ${deadHost.join(', ')}`)
assert.deepEqual(deadFrame, [], `frame rules for classes nobody renders: ${deadFrame.join(', ')}`)

/* Every colour must come from a theme token (with a literal fallback), so light
   and dark both work. `rgba(...)` shims are allowed for shadows/overlays. */
const WHITE_ON_BRAND = /#fff(?:fff)?\b/i
const hardcoded = [...hostCss.matchAll(/:[^;{}]*#[0-9a-fA-F]{3,8}/g)]
  .filter((match) => !match[0].includes('var(--dsw-alias-'))
  .filter((match) => !WHITE_ON_BRAND.test(match[0]))
assert.equal(hardcoded.length, 0, `hard-coded colours outside a token fallback: ${hardcoded.length} hit(s)`)

console.log(`  ok  ${componentClasses.size} host classes all have a rule`)
console.log(`  ok  ${runtimeClasses.size} frame classes all have a rule`)
console.log('  ok  no rule targets a class nobody renders')
console.log('  ok  colours go through theme tokens')
console.log('\n4 checks passed')
