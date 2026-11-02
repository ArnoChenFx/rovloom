// 验证专用凭据交付的真实一次性消费、准确确认、超时回收与失败后的持久拒绝。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../../src/store.js'
import { createPairingDelivery, createFileCredentialSink, loadCredential } from '../../src/transport/index.js'
import type { CredentialSink, DeviceCredential } from '../../src/transport/index.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { management } from '../storage/helpers.js'

/** 组合真实内存 Store 与交付服务；账本拒绝与 revision 读取直接落在 Store 事务上。 */
function setup(authorizeChannel: () => CredentialSink, extra: { timeout_ms?: number; concurrency?: number } = {}) {
  const store = new Store(':memory:', () => 1000, { management })
  const delivery = createPairingDelivery({
    backend: {
      /** 复用真实 Store 的一次性兑换事务，不在测试中仿造消费结果。 */
      redeem: (token) => store.redeem(token),
      generation: () => store.generation()
    },
    identities: {
      /** 交付失败后由 Store 事务拒绝精确凭据摘要。 */
      rejectDelivery: (machine, digest) => store.denyDelivery(machine, digest),
      credentialRevision: (machine) => store.credentialRevision(machine)
    },
    authorizeChannel,
    ...extra
  })
  const machine = store.register('mock')
  const token = store.issueEnrollment(machine.machine_id)
  return { store, delivery, machine, token }
}

test(
  '专用配对交付复用真实 Store 一次消费，普通 receipt 不含 secret，交付前已提交凭据',
  /** 组合真实 enrollment 消费和凭据提交，断言普通 receipt 不包含交付的凭据。 */
  async () => {
    let received: DeviceCredential | undefined
    let machineId = ''
    const s = setup(() => ({
      /** 在模拟交付前断言凭据已提交（设备 offline），并返回与本次 delivery 完全匹配的确认。 */
      async deliver(device, _signal, context) {
        assert.equal(device.machine_id, machineId)
        assert.equal(s.store.machine(machineId).status, 'offline')
        received = device
        return { ...context, machine_id: device.machine_id, recovery_generation: device.recovery_generation }
      },
      close() {}
    }))
    machineId = s.machine.machine_id
    try {
      const receipt = await s.delivery.redeem({ registration_id: machineId, enrollment: s.token })
      assert.equal(receipt.state, 'delivered')
      assert.equal(JSON.stringify(receipt).includes(received!.credential), false)
      assert.equal(JSON.stringify(receipt).includes(s.token), false)
      await assert.rejects(
        s.delivery.redeem({ registration_id: machineId, enrollment: s.token }),
        /pairing_delivery_unknown/
      )
      assert.equal(typeof s.store.connect(received!.machine_id, received!.credential), 'string')
    } finally {
      s.delivery.close()
      s.store.close()
    }
  }
)

test(
  '专用渠道拒绝发生于消费前；交付失败拒绝凭据，不自动重发',
  /** 分别注入渠道拒绝与发送失败，断言消费顺序、拒绝和禁止自动重发。 */
  async () => {
    let allow = false
    let leaked: DeviceCredential | undefined
    let sends = 0
    const s = setup(() => {
      if (!allow) {
        throw new Error('mock_channel_denied')
      }
      return {
        /** 记录一次模拟发送并抛出失败，验证凭据失效而不是自动重发。 */
        async deliver(device) {
          sends++
          leaked = device
          throw new Error('mock_sink_failure')
        },
        close() {}
      }
    })
    const id = s.machine.machine_id
    try {
      await assert.rejects(s.delivery.redeem({ registration_id: id, enrollment: s.token }), /pairing_channel_forbidden/)
      assert.equal(s.store.machine(id).status, 'pending')
      allow = true
      await assert.rejects(s.delivery.redeem({ registration_id: id, enrollment: s.token }), /pairing_delivery_unknown/)
      assert.equal(s.store.machine(id).status, 'pending')
      assert.throws(
        /** 交付失败的凭据不能认证。 */
        () => s.store.connect(leaked!.machine_id, leaked!.credential),
        /invalid_device_credential/
      )
      await assert.rejects(s.delivery.redeem({ registration_id: id, enrollment: s.token }), /pairing_delivery_unknown/)
      assert.equal(sends, 1)
    } finally {
      s.delivery.close()
      s.store.close()
    }
  }
)

test(
  '交付超时关闭专用 sink；忽略 abort 的发送仍占额度直到真正结束',
  /** 让专用发送忽略中止并超时，断言关闭和并发额度一直保留到其真实完成。 */
  async () => {
    let finish: (() => void) | undefined
    let closed = 0
    const s = setup(
      () => ({
        /** 保留模拟交付 Promise，只有测试调用完成入口后才给出准确确认。 */
        deliver: (device, _signal, context) =>
          new Promise(
            /** 保存交付完成入口，并把预期身份与 delivery 关联固定在最终确认中。 */
            (resolve) => {
              finish =
                /** 显式完成阻塞的 mock 发送，回显该交付的全部关联轴。 */
                () =>
                  resolve({
                    ...context,
                    machine_id: device.machine_id,
                    recovery_generation: device.recovery_generation
                  })
            }
          ),
        close() {
          closed++
        }
      }),
      { timeout_ms: 10, concurrency: 1 }
    )
    const id = s.machine.machine_id
    try {
      await assert.rejects(s.delivery.redeem({ registration_id: id, enrollment: s.token }), /pairing_delivery_unknown/)
      assert(closed > 0)
      assert.equal(s.delivery.status().pending, 1)
      await assert.rejects(s.delivery.redeem({ registration_id: id, enrollment: s.token }), /pairing_unavailable/)
      finish!()
      await new Promise(
        /** 短暂让出事件循环推进关闭或异步状态，不改变业务执行期限。 */
        (resolve) => setTimeout(resolve, 0)
      )
      assert.equal(s.delivery.status().pending, 0)
      assert.equal(s.store.machine(id).status, 'pending')
    } finally {
      s.delivery.close()
      s.store.close()
    }
  }
)

test(
  '配对凭据只经绑定身份的一次性文件 sink 交付，普通返回只含 receipt',
  /** 将凭据交给固定身份的受限文件，之后验证有效性且普通返回仍不含 secret。 */
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'rovloom-mock-connector-custody-'))
    const path = join(root, 'credential.json')
    const operations: string[] = []
    let machineId = ''
    let generation = ''
    const s = setup((() => {
      operations.push('enroll')
      return createFileCredentialSink(path, { machine_id: machineId, recovery_generation: generation })
    }) as () => CredentialSink)
    machineId = s.machine.machine_id
    generation = s.store.generation()
    try {
      const receipt = await s.delivery.redeem({ registration_id: machineId, enrollment: s.token })
      const credential = loadCredential(path)
      assert.deepEqual(operations, ['enroll'])
      assert.equal(receipt.state, 'delivered')
      assert.equal(JSON.stringify(receipt).includes(credential.credential), false)
      assert.equal(typeof s.store.connect(credential.machine_id, credential.credential), 'string')
      const sink = createFileCredentialSink(join(root, 'wrong.json'), {
        machine_id: 'another_machine',
        recovery_generation: generation
      })
      await assert.rejects(
        sink.deliver(credential, new AbortController().signal, { delivery_id: 'mock_delivery', revision: 1 }),
        /credential_sink_mismatch/
      )
      sink.close()
    } finally {
      s.delivery.close()
      s.store.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
)

test(
  '错误交付确认不能冒充完成，delivery/目标/代次/revision 均独立核对',
  /** 分别破坏四个交付关联轴，断言错误确认均导致对应凭据被拒绝。 */
  async () => {
    for (const field of ['delivery_id', 'revision', 'machine_id', 'recovery_generation'] as const) {
      let delivered: DeviceCredential | undefined
      const s = setup(() => ({
        /** 只破坏当前选定的确认字段，验证每个关联轴都独立受检。 */
        async deliver(credential, _signal, context) {
          delivered = credential
          return {
            ...context,
            machine_id: credential.machine_id,
            recovery_generation: credential.recovery_generation,
            [field]: field === 'revision' ? context.revision - 1 : 'wrong_binding'
          }
        },
        close() {}
      }))
      const id = s.machine.machine_id
      try {
        await assert.rejects(
          s.delivery.redeem({ registration_id: id, enrollment: s.token }),
          /pairing_delivery_unknown/
        )
        assert.equal(s.store.machine(id).status, 'pending')
        assert.throws(
          /** 确认错误的凭据不能取得认证。 */
          () => s.store.connect(delivered!.machine_id, delivered!.credential),
          /invalid_device_credential/
        )
      } finally {
        s.delivery.close()
        s.store.close()
      }
    }
  }
)

test(
  'sink 清理或修改入参不能改变失败拒绝的凭据摘要',
  /** 专用 sink 可清零自己的输入副本；内部拒绝依据必须保持交付前的值。 */
  async () => {
    for (const outcome of ['lost', 'wrong_generation'] as const) {
      let issued: DeviceCredential | undefined
      const s = setup(() => ({
        /** 保存原值再修改收到的入参，分别模拟 custody 清理后丢确认与错误代次确认。 */
        async deliver(credential, _signal, context) {
          issued = { ...credential }
          credential.credential = ''
          credential.recovery_generation = 'wrong_generation'
          if (outcome === 'lost') {
            throw new Error('mock_ack_lost')
          }
          return { ...context, machine_id: credential.machine_id, recovery_generation: credential.recovery_generation }
        },
        close() {}
      }))
      const id = s.machine.machine_id
      try {
        await assert.rejects(
          s.delivery.redeem({ registration_id: id, enrollment: s.token }),
          /pairing_delivery_unknown/
        )
        assert.equal(s.store.machine(id).status, 'pending')
        assert.throws(
          /** 即使 sink 曾保存原始 secret，丢交付后也不得取得许可。 */
          () => s.store.connect(issued!.machine_id, issued!.credential),
          /invalid_device_credential/
        )
      } finally {
        s.delivery.close()
        s.store.close()
      }
    }
  }
)

for (const failure of ['target', 'generation'] as const) {
  test('兑换后' + failure + '失败拒绝实际签发的凭据并关闭渠道', async () => {
    const store = new Store(':memory:', () => 1000, { management })
    const actual = store.register('actual')
    const requested = store.register('requested')
    const token = store.issueEnrollment(actual.machine_id)
    let issued: { machine_id: string; credential: string } | undefined
    let sends = 0
    let closes = 0
    const delivery = createPairingDelivery({
      backend: {
        redeem(enrollment) {
          issued = store.redeem(enrollment)
          return issued
        },
        generation() {
          throw new Error('generation unavailable')
        }
      },
      identities: {
        rejectDelivery: (machine, digest) => store.denyDelivery(machine, digest),
        credentialRevision: (machine) => store.credentialRevision(machine)
      },
      authorizeChannel: () => ({
        async deliver() {
          sends++
          throw new Error('must not deliver')
        },
        close() {
          closes++
        }
      })
    })
    try {
      await assert.rejects(
        delivery.redeem({
          registration_id: failure === 'target' ? requested.machine_id : actual.machine_id,
          enrollment: token
        }),
        /pairing_delivery_unknown/
      )
      assert.equal(sends, 0)
      assert.equal(closes, 1)
      assert.equal(delivery.status().pending, 0)
      assert.equal(store.machine(actual.machine_id).status, 'pending')
      assert.equal(store.machine(requested.machine_id).status, 'pending')
      assert.throws(() => store.connect(actual.machine_id, issued!.credential), /invalid_device_credential/)
      assert.throws(() => store.redeem(token), /invalid_enrollment/)
    } finally {
      delivery.close()
      store.close()
    }
  })
}
