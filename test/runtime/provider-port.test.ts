/** 校验 provider 中性端口只登记完整、已冻结且互不覆盖的端口事实；不执行任何原生调用。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { HERDR_PROVIDER_DESCRIPTOR } from '../../src/connector/herdr/descriptor.js'
import { HERDR_RESPONSE_TYPES } from '../../src/connector/herdr/methods.js'
import { requiresTerminalExecution } from '../../src/connector/terminal-execution.js'
import { createProviderPortRegistry, type ProviderPorts } from '../../src/runtime/provider-port.js'

/** 只交付形状合法的端口替身；实际原生调用不参与本文件。 */
function ports(kind = 'herdr', overrides: Partial<ProviderPorts> = {}): ProviderPorts {
  return {
    descriptor: { ...HERDR_PROVIDER_DESCRIPTOR, kind, guarantees: undefined },
    catalog: { resolve: () => undefined },
    session: { session: () => ({}) as never },
    identity: { verify: () => ({}) as never },
    owner: { release: async () => {} },
    ...overrides
  }
}

test('registry accepts one complete port set per kind', () => {
  const registry = createProviderPortRegistry([ports('herdr'), ports('herdr-core')])
  assert.deepEqual(registry.kinds(), ['herdr', 'herdr-core'])
  assert.equal(registry.ports('herdr-core').descriptor.protocol_family, 'herdr-json')
  assert.ok(Object.isFrozen(registry.ports('herdr').descriptor.methods))
})

test('duplicate or incomplete ports cannot register', () => {
  assert.throws(() => createProviderPortRegistry([ports(), ports()]), /provider_kind_duplicate/u)
  assert.throws(() => createProviderPortRegistry([]), /provider_port_registry_empty/u)
  assert.throws(
    () => createProviderPortRegistry([ports('herdr', { catalog: { resolve: undefined as never } })]),
    /provider_port_incomplete/u
  )
  assert.throws(
    () => createProviderPortRegistry([ports('herdr', { identity: {} as never })]),
    /provider_port_incomplete/u
  )
  // kind 必须是稳定标识，不能借空串或带空白的名字注册。
  assert.throws(
    () => createProviderPortRegistry([{ ...ports(), descriptor: { ...HERDR_PROVIDER_DESCRIPTOR, kind: '' } }]),
    /provider_descriptor_kind_invalid/u
  )
  assert.throws(
    () => createProviderPortRegistry([{ ...ports(), descriptor: { ...HERDR_PROVIDER_DESCRIPTOR, kind: 'two words' } }]),
    /invalid_frame_id/u
  )
})

test('unregistered kinds and unlisted methods have no tier', () => {
  const registry = createProviderPortRegistry([ports('herdr')])
  assert.throws(() => registry.ports('luvus'), /provider_kind_unregistered/u)
  assert.throws(() => registry.tier('luvus', 'ping'), /provider_kind_unregistered/u)
  assert.equal(registry.tier('herdr', 'unknown.method'), undefined)
  assert.equal(registry.tier('herdr', 'pane.send_text'), 'control')
  assert.equal(registry.tier('herdr', 'ping'), 'observe')
})

test('descriptor cannot claim an unapproved tier or guarantee', () => {
  assert.throws(
    () =>
      createProviderPortRegistry([
        ports('x', {
          descriptor: {
            ...HERDR_PROVIDER_DESCRIPTOR,
            kind: 'x',
            methods: { ping: 'readonly' as never }
          }
        })
      ]),
    /provider_method_tier_invalid/u
  )
  assert.throws(
    () =>
      createProviderPortRegistry([
        ports('x', {
          descriptor: {
            ...HERDR_PROVIDER_DESCRIPTOR,
            kind: 'x',
            guarantees: { ...HERDR_PROVIDER_DESCRIPTOR.guarantees!, cancel: 'maybe' as never }
          }
        })
      ]),
    /provider_guarantee_invalid/u
  )
  assert.throws(
    () =>
      createProviderPortRegistry([
        ports('x', {
          descriptor: {
            ...HERDR_PROVIDER_DESCRIPTOR,
            kind: 'x',
            guarantees: { event_recovery: 'snapshot_rebuild' } as never
          }
        })
      ]),
    /provider_guarantees_invalid/u
  )
})

test('registration freezes the method table handed in by the provider', () => {
  const methods: Record<string, 'observe'> = { 'terminal.list': 'observe' }
  const registry = createProviderPortRegistry([
    ports('x', { descriptor: { kind: 'x', protocol_family: 'test', methods } })
  ])
  methods['terminal.kill'] = 'observe'
  assert.equal(registry.tier('x', 'terminal.kill'), undefined)
  assert.equal(registry.tier('x', 'terminal.list'), 'observe')
})

test('herdr descriptor is derived from the existing reviewed tables only', () => {
  const methods = HERDR_PROVIDER_DESCRIPTOR.methods
  assert.deepEqual(Object.keys(methods).sort(), Object.keys(HERDR_RESPONSE_TYPES).sort())
  for (const method of Object.keys(methods)) {
    const expected =
      method === 'ping' ? 'observe' : requiresTerminalExecution('herdr', method, {}) ? 'control' : 'conditional'
    assert.equal(methods[method], expected, method)
  }
  // ADR 0004：普通读取也可能改变终端状态，因此除协议探测外不升级为观察档。
  assert.equal(methods['tab.list'], 'conditional')
  assert.deepEqual(HERDR_PROVIDER_DESCRIPTOR.guarantees, {
    event_recovery: 'unavailable',
    terminal_fence: 'unavailable',
    cancel: 'unavailable',
    prompt_completion: 'unavailable'
  })
})

test('the neutral port layer itself names no provider', () => {
  const source = readFileSync(new URL('../../src/runtime/provider-port.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /luvus|herdr/iu)
})
