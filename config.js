/**
 * pluginlet — plugin configuration.
 *
 * The harness already owns plugin configuration: a row's `config` is validated
 * against this `Config` and handed to `apply(ctx, config)`. So the manager has
 * no settings UI of its own — development mode, the discovery patterns, the
 * caps and the network budget all live in the plugin's config (Plugins page or
 * the profile patch).
 *
 * The schema is a Standard Schema (`~standard.validate`) with a schemastery
 * marker and a `toJSON()` JSON Schema, so the Loader validates it and the
 * `Config` inspect provider can project a form. It is dependency-free: this
 * package ships without node_modules and must not import the harness.
 */

const DEFAULTS = {
  devMode: false,
  extensions: ['.pluginlet'],
  directories: ['.dsh/pluginlets'],
  maxEditors: 64,
  maxEditorBytes: 512 * 1024,
  allowRead: true,
  allowNetwork: true,
  allowWrite: true,
  net: { perMinute: 20, perHour: 240, maxBytes: 1024 * 1024 },
}

const CAPS = {
  devMode: '跳过内容哈希复核：改了 pluginlet 也继续用旧授权（每次仍记审计）。写入、网络、读取仍受限。',
  extensions: '被当作 pluginlet 的文件后缀。',
  directories: '除默认的 .dsh/pluginlets/ 外，额外扫描的目录（相对工作区根）。',
  maxEditors: '一次最多发现多少个 pluginlet。',
  maxEditorBytes: '单个 pluginlet 源码的最大字节数。',
  allowRead: '是否允许 pluginlet 申请读取工作区文件（fs:read）。',
  allowNetwork: '是否允许 pluginlet 申请网络（net:fetch）。',
  allowWrite: '是否允许 pluginlet 申请写入（write:request，写入仍需逐次确认）。',
  net: '网络预算：每分钟、每小时请求数与单次响应上限。',
}

function positiveInteger(value, fallback, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const rounded = Math.floor(value)
  if (rounded < min) return min
  if (rounded > max) return max
  return rounded
}

function stringList(value, fallback) {
  if (!Array.isArray(value)) return fallback
  const list = value.filter((entry) => typeof entry === 'string' && entry.trim() !== '')
  return list.length === 0 ? fallback : list
}

function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Validate and normalize one row config.
 * @param {unknown} raw - the row's `config` mapping.
 * @returns {{ value: typeof DEFAULTS }}
 */
function validate(raw) {
  const input = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const netInput = input.net !== null && typeof input.net === 'object' && !Array.isArray(input.net) ? input.net : {}
  const value = {
    devMode: bool(input.devMode, DEFAULTS.devMode),
    extensions: stringList(input.extensions, DEFAULTS.extensions).map((entry) => entry.startsWith('.') ? entry : `.${entry}`),
    directories: stringList(input.directories, DEFAULTS.directories).map((entry) => entry.replace(/^\.?\//, '')),
    maxEditors: positiveInteger(input.maxEditors, DEFAULTS.maxEditors, 1, 512),
    maxEditorBytes: positiveInteger(input.maxEditorBytes, DEFAULTS.maxEditorBytes, 1024, 8 * 1024 * 1024),
    allowRead: bool(input.allowRead, DEFAULTS.allowRead),
    allowNetwork: bool(input.allowNetwork, DEFAULTS.allowNetwork),
    allowWrite: bool(input.allowWrite, DEFAULTS.allowWrite),
    net: {
      perMinute: positiveInteger(netInput.perMinute, DEFAULTS.net.perMinute, 1, 600),
      perHour: positiveInteger(netInput.perHour, DEFAULTS.net.perHour, 1, 10000),
      maxBytes: positiveInteger(netInput.maxBytes, DEFAULTS.net.maxBytes, 1024, 16 * 1024 * 1024),
    },
  }
  return { value }
}

const JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  properties: {
    devMode: { type: 'boolean', default: DEFAULTS.devMode, description: CAPS.devMode },
    extensions: {
      type: 'array',
      default: DEFAULTS.extensions,
      items: { type: 'string' },
      description: CAPS.extensions,
    },
    directories: {
      type: 'array',
      default: DEFAULTS.directories,
      items: { type: 'string' },
      description: CAPS.directories,
    },
    maxEditors: { type: 'integer', minimum: 1, maximum: 512, default: DEFAULTS.maxEditors, description: CAPS.maxEditors },
    maxEditorBytes: { type: 'integer', minimum: 1024, maximum: 8388608, default: DEFAULTS.maxEditorBytes, description: CAPS.maxEditorBytes },
    allowRead: { type: 'boolean', default: DEFAULTS.allowRead, description: CAPS.allowRead },
    allowNetwork: { type: 'boolean', default: DEFAULTS.allowNetwork, description: CAPS.allowNetwork },
    allowWrite: { type: 'boolean', default: DEFAULTS.allowWrite, description: CAPS.allowWrite },
    net: {
      type: 'object',
      additionalProperties: false,
      description: CAPS.net,
      properties: {
        perMinute: { type: 'integer', minimum: 1, maximum: 600, default: DEFAULTS.net.perMinute },
        perHour: { type: 'integer', minimum: 1, maximum: 10000, default: DEFAULTS.net.perHour },
        maxBytes: { type: 'integer', minimum: 1024, maximum: 16777216, default: DEFAULTS.net.maxBytes },
      },
    },
  },
}

/* Schemastery-shaped leaves. The Config inspect provider projects a form from
 * `meta` + `dict` (not from `toJSON`), so each field carries the same node
 * shape the library would build: a type, meta with default/description, and an
 * `inner` for arrays. No dependency is imported; the shapes are plain data. */
const booleanNode = (value, description) => ({
  type: 'boolean',
  meta: { default: value, description },
  toString: () => 'boolean',
})

const integerNode = (value, min, max, description) => ({
  type: 'number',
  meta: { step: 1, min, max, default: value, description },
  toString: () => 'number',
})

const stringArrayNode = (value, description) => ({
  type: 'array',
  meta: { default: value, description },
  inner: { type: 'string', meta: {} },
  toString: () => 'array',
})

const objectNode = (dict, description) => ({
  type: 'object',
  meta: { description },
  dict,
  toString: () => 'object',
})

export const Config = {
  type: 'object',
  meta: { default: {} },
  dict: {
    devMode: booleanNode(DEFAULTS.devMode, CAPS.devMode),
    extensions: stringArrayNode(DEFAULTS.extensions, CAPS.extensions),
    directories: stringArrayNode(DEFAULTS.directories, CAPS.directories),
    maxEditors: integerNode(DEFAULTS.maxEditors, 1, 512, CAPS.maxEditors),
    maxEditorBytes: integerNode(DEFAULTS.maxEditorBytes, 1024, 8 * 1024 * 1024, CAPS.maxEditorBytes),
    allowRead: booleanNode(DEFAULTS.allowRead, CAPS.allowRead),
    allowNetwork: booleanNode(DEFAULTS.allowNetwork, CAPS.allowNetwork),
    allowWrite: booleanNode(DEFAULTS.allowWrite, CAPS.allowWrite),
    net: objectNode({
      perMinute: integerNode(DEFAULTS.net.perMinute, 1, 600, '每分钟请求上限'),
      perHour: integerNode(DEFAULTS.net.perHour, 1, 10000, '每小时请求上限'),
      maxBytes: integerNode(DEFAULTS.net.maxBytes, 1024, 16 * 1024 * 1024, '单次响应字节上限'),
    }, CAPS.net),
  },
  '~standard': { version: 1, vendor: 'pluginlet', validate },
  toJSON() {
    return JSON_SCHEMA
  },
  toString() {
    return 'pluginlet config'
  },
}
// Schemastery identity: lets the Config inspect provider project this schema
// into a form instead of reporting "unsupported".
Config[Symbol.for('schemastery')] = true

/** @type {typeof DEFAULTS} */
let active = { ...DEFAULTS, net: { ...DEFAULTS.net } }

/** Replace the active configuration (called once, from `apply`). */
export function setConfig(config) {
  active = config !== null && typeof config === 'object' && config.net !== undefined
    ? config
    : Config['~standard'].validate(undefined).value
}

/** The configuration the Host routes enforce right now. */
export function getConfig() {
  return active
}

/** Capabilities the configuration still allows. */
export function allowedCapabilities(config) {
  const allowed = []
  if (config.allowRead) allowed.push('fs:read')
  if (config.allowNetwork) allowed.push('net:fetch')
  if (config.allowWrite) allowed.push('write:request')
  return allowed
}

export { DEFAULTS }
