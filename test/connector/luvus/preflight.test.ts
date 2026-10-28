import assert from 'node:assert/strict'
import test from 'node:test'
import { NativeRequestPreflightError, luvusValidation } from '../../../src/connector/luvus/preflight.js'

test('Luvus 通用参数方法未指定验证模式时按方法选择 raw-contract', () => {
  const options: { validation?: 'strict' | 'raw-contract'; deadline: number } = { deadline: 1 }
  assert.deepEqual(luvusValidation('luvus', { method: 'workspace.list' }, options), {
    deadline: 1,
    validation: 'raw-contract'
  })
})

test('Luvus 显式给出与方法要求不同的验证模式在登记前被确定拒绝', () => {
  assert.throws(
    () => luvusValidation('luvus', { method: 'workspace.list' }, { validation: 'strict' as const }),
    NativeRequestPreflightError
  )
  const options = { validation: 'raw-contract' as const }
  assert.equal(luvusValidation('luvus', { method: 'workspace.list' }, options), options)
})

test('Herdr 与未审核方法保持调用方给出的选项', () => {
  const options: { validation?: 'strict' | 'raw-contract'; deadline: number } = { deadline: 1 }
  assert.equal(luvusValidation('herdr', { method: 'workspace.list' }, options), options)
  assert.equal(luvusValidation('luvus', { method: 'task.add' }, options), options)
})
