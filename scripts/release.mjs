#!/usr/bin/env node
/**
 * Build a publishable copy of this plugin.
 *
 *   node scripts/release.mjs \
 *     --name dsh-pluginlet \
 *     --version 0.1.0 \
 *     --author "You <you@example.com>" \
 *     --repo https://github.com/you/dsh-workspace-editors
 *
 * It copies the shipped files (no tests), rewrites the identifiers that must
 * match the published package name (`@local/workspace-editors` appears in the
 * client module id, the bundle patch row, the config-page key and the README),
 * adds the license and metadata, and leaves a directory you can `npm publish`.
 *
 * The working copy keeps its `@local/` name, so publishing never disturbs the
 * profile that is running it.
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const { values } = parseArgs({
  options: {
    name: { type: 'string', default: '' },
    version: { type: 'string', default: '0.1.0' },
    author: { type: 'string', default: 'workspace-editors contributors' },
    repo: { type: 'string', default: '' },
    out: { type: 'string', default: 'dist-publish' },
    year: { type: 'string', default: String(new Date().getFullYear()) },
  },
})

const currentPkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const localName = currentPkg.name
const name = values.name === '' ? currentPkg.name : values.name
const version = values.version

if (!/^(?:@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(name)) {
  throw new Error(`--name must be a publishable package name, got "${name}"`)
}
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`--version must be semver, got "${version}"`)
}

const oldScope = localName.startsWith('@local/') ? '@local/' : '\u0000none'

const out = resolve(root, values.out)
await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })

const SHIPPED = [
  'index.js',
  'ops.js',
  'config.js',
  'scanner.js',
  'grants.js',
  'client.js',
  'cordis.patch.yml',
  'icon.svg',
  'README.md',
  'CHANGELOG.md',
  'docs/DESIGN.md',
  'skills',
]

for (const file of SHIPPED) {
  const target = join(out, file)
  await mkdir(dirname(target), { recursive: true })
  await cp(join(root, file), target, { recursive: true })
}
for (const locale of ['en.json', 'zh.json']) {
  await cp(join(root, 'locale', locale), join(out, 'locale', locale), {
    force: true,
  }).catch(async () => {
    await mkdir(join(out, 'locale'), { recursive: true })
    await cp(join(root, 'locale', locale), join(out, 'locale', locale))
  })
}

const namesOfConfigPage = (pkgName) => `${pkgName}#pluginlet`

function mustReplace(text, from, to, label) {
  if (!text.includes(from)) throw new Error(`release: could not find ${label}`)
  return text.split(from).join(to)
}

/* identifiers that must equal the published package name */
if (name !== localName) {
  for (const file of ['client.js', 'cordis.patch.yml']) {
    const path = join(out, file)
    const text = await readFile(path, 'utf8')
    await writeFile(path, mustReplace(text, localName, name, `${localName} in ${file}`), 'utf8')
  }
}

/* README: install command, config page key, and a generic examples section */
{
  const path = join(out, 'README.md')
  let text = await readFile(path, 'utf8')
  // Point the install line at the published name; the path may have moved.
  const installLine = /dsh plugin --profile web add [^\n`]+/
  if (!installLine.test(text)) throw new Error('release: could not find the local install command')
  text = text.replace(installLine, `dsh plugin --profile web add ${name}`)
  if (namesOfConfigPage(name) !== namesOfConfigPage(localName)) {
    text = mustReplace(text, namesOfConfigPage(localName), namesOfConfigPage(name), 'the config page key')
  }
  const start = text.indexOf('## Try it')
  if (start >= 0) {
    const next = text.indexOf('\n## ', start + 3)
    const section = `## Examples

Three editors that ship with the author's own workspace (they are not part of the package — drop
your own \`*.editor\` files into a repository and they appear as tabs):

| file | what it shows |
| --- | --- |
| \`notes.editor\` | source + markdown preview, confirmed save, scope pinned to one file |
| \`explorer.editor\` | two directories, tick only one at approval, ask for the other at runtime |
| \`permissions.editor\` | starts read-only when \`write:request\` is not granted, asks for it, then edits |

The smallest possible editor is three lines:

\`\`\`js
export default function E(api) {
  return api.h('div', { style: { padding: '12px' } }, 'hello from ' + api.meta.name)
}
\`\`\`
`
    text = text.slice(0, start) + section + (next >= 0 ? text.slice(next) : '\n')
  }
  await writeFile(path, text, 'utf8')
}

/* package.json */
{
  const path = join(out, 'package.json')
  const source = await readFile(join(root, 'package.json'), 'utf8')
  const pkg = JSON.parse(source)
  pkg.name = name
  pkg.version = version
  pkg.private = false
  delete pkg.private
  pkg.license = 'MIT'
  pkg.author = values.author
  pkg.keywords = [
    'dsh',
    'deepseek-harness',
    'plugin',
    'editor',
    'workspace',
    'sandbox',
    'ide',
  ]
  if (values.repo !== '') {
    pkg.repository = { type: 'git', url: `git+${values.repo}.git` }
    pkg.homepage = `${values.repo}#readme`
    pkg.bugs = { url: `${values.repo}/issues` }
  }
  pkg.files = [
    'index.js',
    'ops.js',
    'config.js',
    'scanner.js',
    'grants.js',
    'client.js',
    'cordis.patch.yml',
    'locale/*.json',
    'icon.svg',
    'README.md',
    'CHANGELOG.md',
    'docs/DESIGN.md',
    'skills',
  ]
  pkg.publishConfig = { access: 'public' }
  delete pkg.scripts
  await writeFile(path, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
}

/* LICENSE */
const license = `MIT License

Copyright (c) ${values.year} ${values.author}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`
await writeFile(join(out, 'LICENSE'), license, 'utf8')

/* verify the copy: no local scope left, ids match, every module parses */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const run = promisify(execFile)

const client = await readFile(join(out, 'client.js'), 'utf8')
const patch = await readFile(join(out, 'cordis.patch.yml'), 'utf8')
if (client.includes(oldScope) || patch.includes(oldScope)) {
  throw new Error(`release: ${oldScope} survived the rewrite`)
}
if (!client.includes(`id: '${name}'`)) throw new Error(`release: client module id is not ${name}`)
if (!client.includes(`key: '${name}#pluginlet'`)) throw new Error('release: config-page key does not match')
if (!patch.includes(`name: '${name}'`)) throw new Error('release: bundle patch row name does not match')

for (const file of ['index.js', 'ops.js', 'config.js', 'scanner.js', 'grants.js', 'client.js']) {
  await run(process.execPath, ['--check', join(out, file)])
}

console.log(`built ${name}@${version} -> ${out}`)
console.log('next:')
console.log(`  cd ${values.out}`)
console.log('  npm publish --access public')
console.log(`  # or hand it over as a tarball: npm pack  ->  ${name}-${version}.tgz`)
