// 官方完整请求根的离线预检，不建立来源、能力视图或执行许可。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validator, rejects, view } from './helpers.js'

test(
  'agent.wait 完整 shape 拒绝 target/until，合法 pane/status 不依赖伪造来源且不改写输入',
  /** 成功只返回 void，不能被当作候选或 DispatchPermit。 */ () => {
    const valid = { id: 'shape_only', method: 'agent.wait', params: { pane: '1', status: 'idle' } }
    const before = structuredClone(valid)
    assert.deepEqual(validator.checkRequestShape(valid), { ok: true, value: undefined })
    assert.deepEqual(valid, before)
    rejects(validator.checkRequestShape({ ...valid, params: { target: '1', until: 'idle' } }), 'native_request_invalid')
    rejects(
      validator.checkRequestShape({ ...valid, params: { pane: '1', status: 'idle', extra: 'not_reflected' } }),
      'native_request_invalid'
    )
    rejects(validator.checkRequestShape({ ...valid, params: { pane: 1, status: 'idle' } }), 'native_request_invalid')
    rejects(
      validator.checkRequestShape({ ...valid, params: { pane: '1', status: 'idle', statuses: ['idle'] } }),
      'native_request_invalid'
    )
  }
)

// 合成目录外方法只验证最小信封，不能因预检成功取得普通执行权限。
test(
  '目录外方法保留 raw 最小信封边界，不把纯结构成功当作普通请求许可',
  /** 成功不创建普通请求候选。 */ () => {
    const future = { id: 'future_shape', method: 'future.synthetic', params: { synthetic: true } }
    assert.deepEqual(validator.checkRequestShape(future), { ok: true, value: undefined })
    rejects(validator.checkRequest(view(), future), 'native_request_invalid')
    rejects(validator.checkRequestShape({ ...future, extra: true }), 'native_request_invalid')
    rejects(validator.checkRequestShape({ ...future, params: [] }), 'native_request_invalid')
    rejects(validator.checkRequestShape({ ...future, auth: '' }), 'native_request_invalid')
  }
)
