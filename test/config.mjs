/**
 * Exercises the plugin Config: defaults, normalization, clamping and the
 * Standard Schema contract the Loader calls.
 * Run with `node test/config.mjs`.
 */
import assert from 'node:assert/strict'
import { Config, DEFAULTS, allowedCapabilities, getConfig, setConfig } from '../config.js'

const validate = Config['~standard'].validate

const empty = validate(undefined)
assert.equal(empty.issues, undefined)
assert.deepEqual(empty.value, DEFAULTS)
assert.equal(empty.value.devMode, false)
assert.equal(empty.value.net.perMinute, 20)

const partial = validate({ devMode: true, extensions: ['pluginlet'], net: { perMinute: 5 } })
assert.equal(partial.value.devMode, true)
assert.deepEqual(partial.value.extensions, ['.pluginlet'], 'a suffix without a dot gains one')
assert.equal(partial.value.net.perMinute, 5)
assert.equal(partial.value.net.perHour, DEFAULTS.net.perHour, 'an omitted nested key keeps its default')

const clamped = validate({ maxEditors: 9999, maxEditorBytes: 1, net: { perHour: 0 } })
assert.equal(clamped.value.maxEditors, 512)
assert.equal(clamped.value.maxEditorBytes, 1024)
assert.equal(clamped.value.net.perHour, 1)

const junk = validate({ extensions: [], directories: ['/ok', 'fine'], devMode: 'yes' })
assert.deepEqual(junk.value.extensions, DEFAULTS.extensions, 'an empty list falls back to the default')
assert.deepEqual(junk.value.directories, ['ok', 'fine'])
assert.equal(junk.value.devMode, false, 'a non-boolean is not coerced into true')

const schema = Config.toJSON()
assert.equal(schema.$schema.includes('2020-12'), true)
assert.equal(schema.properties.devMode.type, 'boolean')
assert.equal(schema.properties.net.properties.perMinute.type, 'integer')
assert.equal(Config[Symbol.for('schemastery')], true, 'schemastery identity lets the Config provider project a form')
assert.equal(Config.type, 'object')

setConfig(clamped.value)
assert.equal(getConfig().maxEditors, 512)
assert.deepEqual(allowedCapabilities(getConfig()), ['fs:read', 'net:fetch', 'write:request'])

setConfig({ ...clamped.value, allowRead: false, allowNetwork: false })
assert.deepEqual(allowedCapabilities(getConfig()), ['write:request'], 'switching a capability off removes it from the offer')

setConfig(DEFAULTS)
console.log('  ok  defaults apply when the row has no config')
console.log('  ok  partial config merges with defaults, suffixes normalize')
console.log('  ok  numeric bounds clamp instead of failing activation')
console.log('  ok  wrong types fall back instead of flipping a switch on')
console.log('  ok  toJSON projects a form and the schemastery marker is set')
console.log('  ok  capability switches gate what the manager may offer')
console.log('\n6 checks passed')
