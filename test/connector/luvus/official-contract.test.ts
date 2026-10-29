/** 固定官方 fixture 的真实验收参数与 strict 缺口，防止以原生 scope 代替 schema 派发许可。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkDispatch } from '../../../src/connector/luvus/contract/index.js'
import { auth, request, validator, view } from './contract/helpers.js'

test(
  '官方大结果验收的有界 task.add/update 参数具有完整 strict 分支',
  /** 这些参数只在显式验收脚本中用于新建自有会话。 */ () => {
    const from = view()
    const paths = Array.from(
      { length: 64 },
      /** 每个唯一字符串恰好 1024 字节；原生只将其保存到任务账本。 */
      (_, index) => 'synthetic-' + String(index).padStart(2, '0') + '-' + 'p'.repeat(1011)
    )
    const note = '页🌍'.repeat(585)
    for (const native of [
      {
        method: 'task.add',
        params: { title: 'Rovloom owned synthetic pagination acceptance', prompt: '合成🌍'.repeat(2457), paths }
      },
      { method: 'task.update', params: { id: 't1', note, output: note } },
      { method: 'task.update', params: { id: 't1' } }
    ]) {
      const description = validator.describe(from, native.method)
      assert(description.ok)
      assert.equal(description.value.schema_status, 'conditional_branch')
      const candidate = request(from, { id: 'strict-preflight', ...native })
      assert(checkDispatch(candidate, auth(candidate)).ok)
    }
  }
)

test(
  '官方 automation.list 空参数有完整 strict 分支且拒绝额外参数',
  /** 第二族只是只读投影；离线 schema 检查不冒称真实 native 执行。 */ () => {
    const from = view()
    const description = validator.describe(from, 'automation.list')
    assert(description.ok)
    assert.equal(description.value.schema_status, 'conditional_branch')
    const allowed = request(from, { id: 'automation-strict-preflight', method: 'automation.list', params: {} })
    assert(checkDispatch(allowed, auth(allowed)).ok)
    const result = validator.checkRequest(from, {
      id: 'automation-strict-preflight',
      method: 'automation.list',
      params: { extra: true }
    })
    assert(!result.ok)
    assert.equal(result.error.code, 'native_request_invalid')
  }
)

test(
  '原生允许 task.list/get/delete 的 scope 不能扩大 strict schema 覆盖',
  /** 保留当前官方 schema 的 fail closed 行为，不启用 raw 或 Owner。 */ () => {
    const from = view()
    for (const native of [
      { method: 'task.list', params: {} },
      { method: 'task.get', params: { id: 't1' } },
      { method: 'task.delete', params: { id: 't1' } }
    ]) {
      const candidate = request(from, { id: 'strict-preflight', ...native })
      const result = checkDispatch(candidate, auth(candidate))
      assert(!result.ok)
      assert.equal(result.error.code, 'parameter_schema_incomplete')
    }
  }
)
