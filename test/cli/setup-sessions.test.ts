/** Luvus 的会话名随运行方式确定并经配对传给 Gateway；只接受程序定义的两个值。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { configDocument, configTemplate, parseConfig } from '../../src/cli/config.js'
import type { ConnectorConfig } from '../../src/cli/config.js'
import { setupSessions, setupSessionsFor, setupTarget } from '../../src/cli/setup-targets.js'

test('Luvus 目标会话：附着为 default，managed 为 rovloom，Herdr 固定 default', () => {
  assert.equal(setupTarget('m1', 'luvus').session, 'rovloom')
  assert.equal(setupTarget('m1', 'luvus', { luvus: 'default' }).session, 'default')
  assert.equal(setupTarget('m1', 'herdr', { luvus: 'rovloom' }).session, 'default')
})

test('Connector 按运行方式选择会话，默认附着 default', () => {
  const base = configDocument(configTemplate('connector', 'linux'))
  const attach = parseConfig(base, 'linux') as ConnectorConfig
  const managed = parseConfig({ ...base, native: { luvus: { mode: 'managed' } } }, 'linux') as ConnectorConfig
  assert.deepEqual(setupSessionsFor(attach), { luvus: 'default' })
  assert.deepEqual(setupSessionsFor(managed), { luvus: 'rovloom' })
})

test('配对授权的 Target 使用所选会话，其它会话名一律拒绝', () => {
  assert.equal(setupTarget('m1', 'luvus', { luvus: 'default' }).session, 'default')
  assert.equal(setupTarget('m1', 'luvus').session, 'rovloom')
  assert.deepEqual(setupSessions(undefined), {})
  for (const bad of [{ luvus: 'other' }, { luvus: 1 }, { herdr: 'default' }, [], 'default', null]) {
    assert.throws(() => setupSessions(bad), { code: 'configuration_required' })
  }
})
