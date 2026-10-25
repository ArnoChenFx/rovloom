/** 验证页面只导航明确目标，不收集身份、秘密或隐式当前机器。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseRoute, routeHref } from '../../src/webui/view.js'
import { unavailableRead } from '../../src/webui/page.js'

test('workspace navigation round-trips separately from explicit device targets', () => {
  for (const section of ['devices', 'pairing', 'connect'] as const) {
    const route = { machineId: null, cursor: null, providerCursor: null, section }
    assert.deepEqual(parseRoute(routeHref(route)), route)
  }
  assert.deepEqual(parseRoute('#machine=a&view=pairing'), { machineId: 'a', cursor: null, providerCursor: null })
  assert.deepEqual(parseRoute('#view=pairing&view=connect'), { machineId: null, cursor: null, providerCursor: null })
  assert.deepEqual(parseRoute('#view=unknown'), { machineId: null, cursor: null, providerCursor: null })
})

// 不透明 machine_id 与 cursor 在片段内安全往返，设备详情不会沿用列表页游标。
test(
  '机器与分页引用编码往返，不隐式继承其它目标',
  /* 不透明 machine_id 与 cursor 在片段内安全往返，设备详情不会沿用列表页游标。 */ () => {
    const route = { machineId: 'machine/a&b #一', cursor: null, providerCursor: 'next?&=' }
    assert.deepEqual(parseRoute(routeHref(route)), route)
    assert.deepEqual(parseRoute('#cursor=next'), { machineId: null, cursor: 'next', providerCursor: null })
    assert.deepEqual(parseRoute('#machine=a&cursor=next'), { machineId: 'a', cursor: null, providerCursor: null })
    const unicodeRoute = { machineId: '机'.repeat(1024), cursor: null, providerCursor: '界'.repeat(1024) }
    assert.deepEqual(parseRoute(routeHref(unicodeRoute)), unicodeRoute)
  }
)

// 重复和超长参数不会被静默选择为一个危险目标。
test(
  '拒绝重复与超限路由参数，未知字段不成为身份',
  /* 重复和超长参数不会被静默选择为一个危险目标。 */ () => {
    const empty = { machineId: null, cursor: null, providerCursor: null }
    assert.deepEqual(parseRoute('#machine=a&machine=b'), empty)
    assert.deepEqual(parseRoute('#cursor=' + 'a'.repeat(1_025)), empty)
    assert.deepEqual(parseRoute('#' + 'a'.repeat(20_001)), empty)
    assert.deepEqual(parseRoute('#principal=admin&approved=true'), empty)
  }
)

// 默认发布入口没有 fixture 回退或浏览器身份授权。
test(
  '未配置共享管理读取时始终明确不可用',
  /* 默认发布入口没有 fixture 回退或浏览器身份授权。 */ async () => {
    await assert.rejects(unavailableRead(), { problem: 'unavailable' })
  }
)
