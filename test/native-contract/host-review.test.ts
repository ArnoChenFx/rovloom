// 仅核对已发布的 host schema 与静态审核，不将尚未接线的 host 执行路由伪装成成功。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkDispatch, luvusMethod } from '../../src/connector/luvus/contract/index.js'
import { auth, rejects, request, unwrap, validator, view } from './helpers.js'

test('host.info/capabilities 审核为只读幂等，仍需独立 host 传输，不能混入 session 或扩大管理方法', () => {
  const host = view('host')
  const session = view()
  for (const method of ['host.info', 'host.capabilities']) {
    const descriptor = unwrap(validator.describe(host, method))
    assert.equal(descriptor.transport, 'host_stdio_proxy')
    assert.equal(descriptor.schema_status, 'conditional_branch')
    assert.deepEqual(luvusMethod(method), { method, access: 'read', scope: 'read', idempotent: true })
    assert.deepEqual(descriptor.native_contract, luvusMethod(method))
    const candidate = request(host, { id: 'host_review', method, params: {} })
    rejects(checkDispatch(candidate, auth(candidate)), 'unsupported_transport')
    assert.equal(validator.checkRequest(session, { id: 'host_review', method, params: {} }).ok, false)
    assert.equal(
      validator.checkRequest(host, { id: 'host_review', method, params: { shell: 'not_allowed' } }).ok,
      false
    )
  }
  assert.equal(luvusMethod('host.update.install'), undefined)
})
