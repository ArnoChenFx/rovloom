// 一机一码账本与 join 命令解析：生成/作废/消费/终结/重置语义，以及 CLI 参数形态。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openGatewayState } from '../../src/runtime/state.js'
import { PairingCodes } from '../../src/cli/pairing-codes.js'
import { parseJoinValue } from '../../src/cli/join-connector.js'
import { parseCommand } from '../../src/cli/index.js'

function ledger() {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-codes-'))
  mkdirSync(join(root, 'managed'), { recursive: true })
  const state = openGatewayState({ state_directory: root, changed: () => {} })
  return {
    root,
    codes: new PairingCodes(state.store, root),
    close() {
      state.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

test('一机一码账本：生成/列表/兑换/终结，明文只在未使用条目上', () => {
  const f = ledger()
  try {
    const first = f.codes.create('workstation')
    const [machine, code_id, secret] = first.code.split('.') as [string, string, string]
    assert.match(machine, /^m_/)
    assert.match(code_id, /^[0-9a-f-]{36}$/)
    assert.match(secret, /^[A-Za-z0-9_-]{43}$/)
    assert.equal(first.entry.name, 'workstation')
    assert.equal(first.entry.machine_id, machine)
    // 未使用码带明文，可重显完整命令。
    assert.equal(f.codes.list().length, 1)
    assert.equal(f.codes.list()[0]!.secret, secret)
    // 秘密摘要核验：正确秘密通过，错误秘密拒绝且不推进状态。
    f.codes.verify(machine, code_id, secret)
    assert.throws(() => f.codes.verify(machine, code_id, 'wrong-secret-wrong-secret-wrong'), /pairing_code_invalid/)
    assert.equal(f.codes.list()[0]!.status, 'unused')
    // 兑换成功后终结：明文抹掉，同码不能二次核验。
    f.codes.settle(code_id, true)
    const settled = f.codes.list()[0]!
    assert.equal(settled.status, 'used')
    assert.equal(settled.secret, undefined)
    assert.throws(() => f.codes.verify(machine, code_id, secret), /pairing_code_used/)
  } finally {
    f.close()
  }
})

test('一机一码账本：作废删除 pending 设备并拒绝兑换；失败兑换标记 failed', () => {
  const f = ledger()
  try {
    const revoked = f.codes.create('old-laptop')
    f.codes.revoke(revoked.entry.code_id)
    assert.equal(f.codes.list()[0]!.status, 'revoked')
    assert.equal(f.codes.list()[0]!.secret, undefined)
    assert.throws(
      () => f.codes.verify(revoked.entry.machine_id, revoked.entry.code_id, revoked.code.split('.')[2]!),
      /pairing_code_revoked/
    )
    // 已终结的码不能重复作废；未知码同样拒绝。
    assert.throws(() => f.codes.revoke(revoked.entry.code_id), /pairing_code_not_found/)
    assert.throws(() => f.codes.revoke('not-a-code-id?'), Error)
    const failed = f.codes.create('broken')
    f.codes.settle(failed.entry.code_id, false)
    assert.equal(f.codes.list().find((entry) => entry.name === 'broken')!.status, 'failed')
  } finally {
    f.close()
  }
})

test('join 命令值解析：ws/wss origin + #machine.attempt.secret；其余形态拒绝', () => {
  const secret = 's'.repeat(43)
  const parsed = parseJoinValue('ws://192.0.2.10:9443#m_abc.def.' + secret)
  assert.equal(parsed.url, 'ws://192.0.2.10:9443')
  assert.equal(parsed.machine, 'm_abc')
  assert.equal(parsed.attempt, 'def')
  assert.equal(parsed.secret, secret)
  const secure = parseJoinValue('wss://example.com#m.a.' + secret)
  assert.equal(secure.url, 'wss://example.com')
  for (const value of [
    'http://host#m.a.' + secret,
    'ws://host/path#m.a.' + secret,
    'ws://host#m.a',
    'ws://host#m.a.b.c',
    'ws://user:pass@host#m.a.' + secret,
    'ws://host?q=1#m.a.' + secret,
    'ws://host#' + secret,
    'm.a.' + secret
  ]) {
    assert.throws(() => parseJoinValue(value), { code: 'invalid_arguments' }, value)
  }
})

test('CLI 解析：connector --join 与 gateway --issue-code；旧旗标不再接受', () => {
  const join = 'ws://127.0.0.1:9443#m.a.' + 's'.repeat(43)
  const command = parseCommand(['connector', '--join', join])
  assert.equal(command.action, 'connector')
  assert.equal(command.join, join)
  const issued = parseCommand(['gateway', '--issue-code'])
  assert.equal(issued.action, 'gateway')
  assert.equal(issued.issueCode, true)
  const unattended = parseCommand(['gateway', '--issue-code', '--non-interactive'])
  assert.equal(unattended.action, 'gateway')
  assert.equal('issueCode' in unattended && unattended.issueCode, true)
  // join 值形态非法时参数错误，不进入角色启动。
  assert.throws(() => parseCommand(['connector', '--join', 'not-a-join-value']), { code: 'invalid_arguments' })
  assert.throws(() => parseCommand(['connector', '--join']), { code: 'invalid_arguments' })
  // 旧旗标已随配对流程一并移除。
  assert.throws(() => parseCommand(['connector', '--claim']), { code: 'invalid_arguments' })
  assert.throws(() => parseCommand(['gateway', '--repair-device']), { code: 'invalid_arguments' })
  assert.throws(() => parseCommand(['gateway', '--add-device']), { code: 'invalid_arguments' })
  assert.throws(() => parseCommand(['connector', '--repair']), { code: 'invalid_arguments' })
})
