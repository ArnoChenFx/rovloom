/** 合成 Connector 通过真实认证通道验证错误参数不会破坏同 epoch 的合法调用；不运行 Herdr 或模型。 */
import assert from 'node:assert/strict'
import { writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { createHerdrGatewayResources } from '../../../src/connector/herdr/provider.js'
import { createProviderGatewayRuntime } from '../../../src/runtime/gateway.js'
import { boundedJson, contractRef, object } from '../../../src/wire/index.js'
import type { JsonObject } from '../../../src/wire/types.js'
import { fixture as transportFixture, rawConnect, until } from '../../transport/helpers.js'
import { responseFrame } from '../../storage/helpers.js'
import { raw, source } from './helpers.js'
import { privateHerdrTestRoot } from './private-root.js'

test(
  'native frame boundary is independent of the trusted anchor and oversize rejection preserves key and epoch',
  /** 合法大文本走完真实派发和回包；超出原生帧一字节的请求在登记前拒绝。 */ async () => {
    const { root, base, target, runtime, client } = await admissionFixture(['ping', 'pane.send_text'])
    try {
      await until(/** 等待真实认证结果，后续所有调用共用该 epoch。 */ () => Boolean(client.epoch))
      const epoch = client.epoch
      const good = await runtime.runAuthenticated(
        { principal_id: base.principal.id },
        /** 挂起独立 ping，用于观察其它请求是否错误关闭共享连接。 */ () =>
          runtime.admit({
            target,
            native_request: { method: 'ping', params: {} },
            options: { binding_revision: 1, contract_ref: contractRef(source), deadline: base.now + 10_000 }
          })
      )
      await until(
        /** ping 必须先抵达对端，才能证明它在后续边界检查期间仍在途。 */ () =>
          client.frames.some(/** 只统计实际请求，不把 welcome 当作执行。 */ (frame) => object(frame).type === 'request')
      )
      const original = base.store.attempt(good.call.call_id, good.call.attempt_id!)!
      const nativeLimit = 65_536
      const overhead = Buffer.byteLength(
        boundedJson({
          id: original.binding.native_request_id,
          method: 'pane.send_text',
          params: { pane_id: 'p', text: '' }
        }) + '\n'
      )
      const maximumText = nativeLimit - overhead
      const key = 'oversize_text_not_registered'
      await assert.rejects(
        runtime.runAuthenticated(
          { principal_id: base.principal.id },
          /** 多出的一字节必须连同真实 native ID 与 LF 计量，不能消耗 key。 */ () =>
            runtime.admit({
              target,
              native_request: { method: 'pane.send_text', params: { pane_id: 'p', text: 'x'.repeat(maximumText + 1) } },
              options: {
                binding_revision: 1,
                contract_ref: contractRef(source),
                deadline: base.now + 10_000,
                client_request_key: key
              }
            })
        ),
        /** 保留原生字节门禁的固定错误，不接受派发后失联替代准入拒绝。 */ (error: unknown) =>
          error instanceof Error && 'code' in error && error.code === 'json_size_limit'
      )
      assert.equal(base.store.call(base.principal.id, good.call.call_id).state, 'dispatching')
      assert.equal(client.ws.readyState, WebSocket.OPEN)
      assert.equal(client.epoch, epoch)
      let expectedRequests = 1
      for (const length of [65_000, maximumText]) {
        const large = await runtime.runAuthenticated(
          { principal_id: base.principal.id },
          /** 第一条合法文本复用刚被拒绝的 key，第二条覆盖完整原生帧上界。 */ () =>
            runtime.admit({
              target,
              native_request: { method: 'pane.send_text', params: { pane_id: 'p', text: 'x'.repeat(length) } },
              options: {
                binding_revision: 1,
                contract_ref: contractRef(source),
                deadline: base.now + 10_000,
                ...(length === 65_000 ? { client_request_key: key } : {})
              }
            })
        )
        assert.equal(large.created, true)
        expectedRequests++
        await until(
          /** 同时观察旧缺陷的断连结果，让失败直接暴露而非等到测试超时。 */ () =>
            client.frames.filter(/** 只累计已发送请求。 */ (frame) => object(frame).type === 'request').length ===
              expectedRequests ||
            client.ws.readyState !== WebSocket.OPEN ||
            base.store.call(base.principal.id, good.call.call_id).state === 'outcome_unknown'
        )
        assert.equal(client.ws.readyState, WebSocket.OPEN)
        assert.equal(base.store.call(base.principal.id, good.call.call_id).state, 'dispatching')
        const attempt = base.store.attempt(large.call.call_id, large.call.attempt_id!)!
        const nativeBytes = Buffer.byteLength(
          boundedJson({ ...attempt.native_request, id: attempt.binding.native_request_id }) + '\n'
        )
        assert.equal(nativeBytes, length + overhead)
        assert(nativeBytes <= nativeLimit)
        assert(Buffer.byteLength(boundedJson(attempt)) > nativeLimit)
        assert.equal(attempt.binding.connection_epoch, epoch)
        client.ws.send(JSON.stringify(responseFrame(attempt.binding, { result: { type: 'ok' } })))
        await until(
          /** 合法边界文本必须能完成响应，不能只登记或写出请求后失联。 */ () =>
            base.store.call(base.principal.id, large.call.call_id).state === 'responded'
        )
      }
      assert.equal(
        client.frames.filter(/** 超限拒绝没有生成额外 Wire 请求。 */ (frame) => object(frame).type === 'request')
          .length,
        3
      )
      client.ws.send(
        JSON.stringify(responseFrame(original.binding, { result: { type: 'pong', version: '0.9.5', protocol: 22 } }))
      )
      await until(
        /** 最初的合法在途调用在同一 epoch 正常结算。 */ () =>
          base.store.call(base.principal.id, good.call.call_id).state === 'responded'
      )
      assert.equal(client.epoch, epoch)
      base.store.assertConnection(original.binding)
    } finally {
      client.ws.close()
      await runtime.close()
      base.stop()
      rmSync(root, { recursive: true, force: true })
    }
  }
)

/** 为参数与帧边界回归复用真实 Store、资源工厂和认证通道；对端仅模拟结果。 */
async function admissionFixture(methods: readonly string[], approved = source) {
  const root = privateHerdrTestRoot('.herdr-admission-')
  const base = transportFixture()
  const paired = base.pair('owned_herdr_admission')
  base.gateway.stop()
  const target = {
    machine_id: paired.machine_id,
    provider_id: 'herdr',
    profile: 'session' as const,
    session: 'owned'
  }
  const schemaPath = join(root, 'schema.json')
  writeFileSync(schemaPath, raw, { mode: 0o600 })
  const resources = await createHerdrGatewayResources({
    config: {
      version: 1,
      target,
      binding_revision: 1,
      config_ref: 'owned-herdr-admission',
      expected_source: approved,
      schema_path: schemaPath
    }
  })
  base.store.defineProvider(resources.providers[0]!.binding)
  base.principal.policy.grants.push({ target, methods: [...methods], actions: ['dispatch', 'read'] })
  const provider = resources.providers[0]!
  const preflightRequests: JsonObject[] = []
  const offer = { major: 2, minor: 0, capabilities: ['rpc'], required: ['rpc'] }
  const runtime = await createProviderGatewayRuntime({
    lifecycle: { store: base.store, identityHost: base.credentials },
    identities: {
      principal: /** 仅本测试已配对宿主的合成 caller 有效。 */ (caller) =>
        caller.principal_id === base.principal.id ? base.principal : null,
      administrator: /** 本测试没有管理员会话。 */ () => null
    },
    providers: [
      {
        ...provider,
        preflightRequest: /** 只观察完整根使用的实际 ID，原工厂验证仍原样执行。 */ (request: JsonObject) => {
          preflightRequests.push(structuredClone(request))
          provider.preflightRequest!(request)
        }
      }
    ],
    session: resources.session,
    listener: { hostname: '127.0.0.1', port: 0, developmentLoopback: true, offer },
    release: /** 运行时只释放本轮资源；Store 最后由 fixture 关闭。 */ () => resources.release()
  })
  const client = rawConnect(runtime.transport.url, paired.credential, offer)
  return { root, base, target, preflightRequests, runtime, client }
}

test(
  'invalid Herdr prompt parameters preserve the same authenticated epoch and another pending call',
  /** 实际 Store、资源工厂、Wire 与 loopback socket 保持生产路径；对端只模拟有界 pong。 */ async () => {
    const { root, base, target, preflightRequests, runtime, client } = await admissionFixture(['ping', 'agent.prompt'])
    try {
      await until(/** 等待真实 welcome，不能由测试自行给连接指定 epoch。 */ () => Boolean(client.epoch))
      const epoch = client.epoch
      const good = await runtime.runAuthenticated(
        { principal_id: base.principal.id },
        /** 先派发合法 ping 并保留其原请求等待，制造同 epoch 的并发工作。 */ () =>
          runtime.admit({
            target,
            native_request: { method: 'ping', params: {} },
            options: { binding_revision: 1, contract_ref: contractRef(source), deadline: base.now + 10_000 }
          })
      )
      await until(
        /** 合法请求已经实际到达对端，尚未返回任何合成结果。 */ () =>
          client.frames.some(/** 仅识别本测试原请求帧。 */ (frame) => object(frame).type === 'request')
      )
      const original = base.store.attempt(good.call.call_id, good.call.attempt_id!)!
      assert.equal(preflightRequests[0]!.id, original.binding.native_request_id)
      const key = 'invalid_prompt_not_registered'
      let invalidError: unknown
      let invalidAdmitted = false
      try {
        await runtime.runAuthenticated(
          { principal_id: base.principal.id },
          /** 缺少官方必填 text，不能生成第二个派发锚点或影响原合法请求。 */ () => {
            runtime.admit({
              target,
              native_request: { method: 'agent.prompt', params: { target: 'owned-agent' } },
              options: {
                binding_revision: 1,
                contract_ref: contractRef(source),
                deadline: base.now + 10_000,
                client_request_key: key
              }
            })
            invalidAdmitted = true
          }
        )
      } catch (error) {
        invalidError = error
      }
      const stateBeforeReply = base.store.call(base.principal.id, good.call.call_id).state
      const open = client.ws.readyState === WebSocket.OPEN
      if (open) {
        client.ws.send(
          JSON.stringify(
            responseFrame(original.binding, {
              result: { type: 'pong', version: '0.9.5', protocol: 22 }
            })
          )
        )
      }
      await until(
        /** 原调用必须能结算；旧缺陷造成的 unknown 也直接记录，不把等待超时掩盖根因。 */ () =>
          ['responded', 'outcome_unknown'].includes(base.store.call(base.principal.id, good.call.call_id).state)
      )
      const observed = {
        invalidAdmitted,
        invalidError:
          invalidError && typeof invalidError === 'object' && 'code' in invalidError ? invalidError.code : null,
        stateBeforeReply,
        legalCallState: base.store.call(base.principal.id, good.call.call_id).state,
        sameEpoch: client.epoch === epoch,
        requestFrames: client.frames.filter(
          /** 错误参数不应额外写出请求或导致合法请求重放。 */ (frame) => object(frame).type === 'request'
        ).length
      }
      assert.deepEqual(observed, {
        invalidAdmitted: false,
        // 登记前的参数拒绝收敛为与 Luvus 预检同一公共码，携带确定未派发语义（issue #283 修复）。
        invalidError: 'native_request_invalid',
        stateBeforeReply: 'dispatching',
        legalCallState: 'responded',
        sameEpoch: true,
        requestFrames: 1
      })
      base.store.assertConnection(original.binding)
      const recovered = await runtime.runAuthenticated(
        { principal_id: base.principal.id },
        /** 错误登记必须完全回滚，原 key 仍可首次用于不同的合法意图。 */ () =>
          runtime.admit({
            target,
            native_request: { method: 'ping', params: {} },
            options: {
              binding_revision: 1,
              contract_ref: contractRef(source),
              deadline: base.now + 10_000,
              client_request_key: key
            }
          })
      )
      assert.equal(recovered.created, true)
      assert.equal(recovered.call.epoch, epoch)
      await until(
        /** 第二个合法请求也只发送一次，错误 prompt 没有占用发送或历史槽。 */ () =>
          client.frames.filter(/** 只统计请求，不把 welcome 当作执行。 */ (frame) => object(frame).type === 'request')
            .length === 2
      )
      const retry = base.store.attempt(recovered.call.call_id, recovered.call.attempt_id!)!
      client.ws.send(
        JSON.stringify(responseFrame(retry.binding, { result: { type: 'pong', version: '0.9.5', protocol: 22 } }))
      )
      await until(
        /** 同一未断开的 epoch 能正常完成后续合法工作。 */ () =>
          base.store.call(base.principal.id, recovered.call.call_id).state === 'responded'
      )
    } finally {
      client.ws.close()
      await runtime.close()
      base.stop()
      rmSync(root, { recursive: true, force: true })
    }
  }
)

test(
  'admission accepts the contract of the approved measured source, whichever Herdr build that is, and nothing else',
  /** 契约不绑定某个固定发行：新版本/其它平台的二进制经批准后即为其契约，旧的固定引用反而被拒。 */ async () => {
    const other = { ...source, binary_version: '0.9.6', server_version: '0.9.6', binary_sha256: 'a'.repeat(64) }
    const { root, base, target, runtime, client } = await admissionFixture(['ping'], other)
    try {
      await until(/** 等待真实认证结果。 */ () => Boolean(client.epoch))
      const call = (contract_ref: string) =>
        runtime.runAuthenticated(
          { principal_id: base.principal.id },
          /** 同一目标、同一请求，只改变契约引用。 */ () =>
            runtime.admit({
              target,
              native_request: { method: 'ping', params: {} },
              options: { binding_revision: 1, contract_ref, deadline: base.now + 10_000 }
            })
        )
      await assert.rejects(
        /** 固定的 0.9.5 引用不是这台设备批准的来源。 */ async () => call(contractRef(source)),
        (error: unknown) => error instanceof Error && 'code' in error && error.code === 'contract_unavailable'
      )
      assert.equal((await call(contractRef(other))).created, true)
    } finally {
      client.ws.close()
      await runtime.close()
      base.stop()
      rmSync(root, { recursive: true, force: true })
    }
  }
)
