/**
 * pluginlet — Host half.
 *
 * Loopback routes under `/api/pluginlet/*`, all POST, all
 * carrying the plugin header. The work lives in `./ops.js`; this file owns the
 * registrations, the plugin `Config`, and the one thing Config cannot express:
 * nothing. Every setting the manager enforces comes from `config`.
 *
 * It also publishes one skill (`pluginlet-development`) so an agent working in a repository with
 * `.dsh/pluginlets/` knows the contract without reading this package.
 *
 * The pluginlet sources never run here. The browser half evaluates them inside a
 * CSP-locked, cross-origin sandboxed iframe; the Host only reads files, keeps
 * content-bound grants, and proxies the capabilities the iframe cannot reach.
 */
import { readFileSync } from 'node:fs'

import { Config, setConfig } from './config.js'
import { PREFIX, ROUTE_NAMES, serve } from './ops.js'

export const name = 'pluginlet'
export const inject = ['webServer', 'fs', 'workspaceRegistry']
export { Config }

const SKILL_URL = new URL('./skills/pluginlet-development.md', import.meta.url)
const SKILL_NAME = 'pluginlet-development'

/** Publish the authoring guide; a profile without a skill catalog still gets the routes. */
function registerSkill(ctx) {
  const skills = typeof ctx.get === 'function' ? ctx.get('skills') : undefined
  if (skills === undefined || skills === null || typeof skills.register !== 'function') return
  let content
  try {
    content = readFileSync(SKILL_URL, 'utf8')
  } catch (error) {
    ctx.logger?.warn?.(`pluginlet: cannot read the skill body: ${error?.message ?? error}`)
    return
  }
  ctx.effect(
    () =>
      skills.register({
        name: SKILL_NAME,
        description:
          'Author a pluginlet: the single-file, sandboxed UI a repository ships in .dsh/pluginlets/. Covers the export shapes, the api surface, the constructs the scanner blocks, and the capability/path rules that decide what the approval dialog asks for.',
        whenToUse:
          'Use when writing, editing or debugging a *.pluginlet file in a repository, or when asked to add a tab, panel or small tool to the harness from inside a workspace.',
        content,
      }),
    'pluginlet: skill',
  )
}

export function apply(ctx, config) {
  setConfig(config)
  registerSkill(ctx)

  for (const route of ROUTE_NAMES) {
    ctx.effect(
      () =>
        ctx.webServer.register({
          kind: 'exact',
          path: `${PREFIX}/${route}`,
          handler: (req, res) => {
            serve(ctx, route, req, res).catch((error) => {
              if (res.writableEnded) return
              res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
              res.end(JSON.stringify({ ok: false, error: { code: 'PLUGIN', message: String(error?.message ?? error) } }))
            })
          },
        }),
      `pluginlet: ${route} route`,
    )
  }
}
