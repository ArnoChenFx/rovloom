// 验证CLI确实组合现有transport及关闭资源；身份、原生回调和历史全部是隔离fixture，不证明native闭环。
import { configDocument } from '../../src/cli/config.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  configTemplate,
  createTransportCliRuntime,
  runCli,
  type GatewayConfig,
  type GatewayTransportPorts,
  type GatewayTransportResources,
  type ConnectorConfig
} from '../../src/cli/index.js'
import { FacadeServiceError, StoreGatewayService, type ServiceContext } from '../../src/mcp/index.js'
import { storeFixture } from '../mcp/store-fixture.js'
import { httpFixture, syntheticHeaders } from '../mcp/http-fixture.js'

// 测试信号使用显式Promise握手，不以sleep推测角色已经启动或关闭。
function notification() {
  let resolve!: () => void
  const promise = new Promise<void>(
    /* 保存测试私有通知函数，不创建业务请求或授权。 */ (done) => {
      resolve = done
    }
  )
  return { promise, resolve }
}

// 默认拒绝所有设备，只开放真实listener测试；没有认证或native会话可被这套fixture接受。
function resources(f: ReturnType<typeof storeFixture>): GatewayTransportResources {
  return {
    store: f.store,
    identities: f.identities,
    authentication: { authenticate: /* 此合成caller仅用于测试已有Store授权查询。 */ () => ({ principal_id: 'alice' }) },
    transport: {
      hostname: '127.0.0.1',
      port: 0,
      developmentLoopback: true,
      identity: {
        generation: /* 读取实际测试Store的恢复代次，不从设备帧建立代次。 */ () => f.store.generation(),
        authenticate: /* 不签发或接受任何凭据，认证必定拒绝。 */ () => {
          throw new Error('mock_denied')
        },
        assert: /* 未认证连接不能通过后续复验。 */ () => {
          throw new Error('mock_denied')
        },
        disconnect: /* 拒绝fixture从未建立连接，因此没有可断开的持久epoch。 */ () => {}
      },
      session: /* 拒绝身份后不应创建native会话；到达此处即测试失败。 */ () => {
        throw new Error('unexpected_mock_session')
      }
    },
    close: /* 资源所有权交给runtime，关闭真实Store而不删除测试断言所需目录。 */ async () => f.store.close()
  }
}

test(
  '两角色宿主同步重入close仍共用原Promise且只释放一次资源',
  /* 复现Promise赋值前执行清理的重入条件，直接验证真实transport宿主的资源所有权。 */ async () => {
    const f = storeFixture()
    let nestedGateway: Promise<void> | undefined
    let nestedConnector: Promise<void> | undefined
    let gatewayCloses = 0
    let connectorCloses = 0
    const runtime = createTransportCliRuntime({
      gateway: /* 真实listener只使用测试Store，清理时同步重入当前Gateway关闭接口。 */ async () => ({
        ...resources(f),
        close: /* 不等待自身关闭，验证同步重入取得同一Promise且不再释放一次Store。 */ async () => {
          gatewayCloses++
          nestedGateway = gateway.close()
          f.store.close()
        }
      }),
      connector: /* 只创建实际Connector生命周期；凭据读取拒绝，不建立socket或设备身份。 */ async () => ({
        transport: {
          credential: /* 拒绝本例的凭据读取，使客户端保持未连接路径，不提供任何设备身份。 */ () => {
            throw new Error('unexpected_credential')
          },
          session: /* 本例不应建立认证会话。 */ () => {
            throw new Error('unexpected_session')
          },
          nativeInput: /* 本例不应进入原生输入。 */ () => {
            throw new Error('unexpected_native')
          },
          execute: /* 本例不应执行原生调用。 */ async () => {
            throw new Error('unexpected_native')
          }
        },
        close: /* 同步重入当前Connector关闭，清理只允许进入一次。 */ async () => {
          connectorCloses++
          nestedConnector = connector.close()
        }
      })
    })
    const gateway = await runtime.gateway!({ ...configTemplate('gateway'), state_dir: f.directory } as GatewayConfig)
    const connector = await runtime.connector!({
      ...configTemplate('connector'),
      gateway_url: 'wss://127.0.0.1:1'
    } as ConnectorConfig)
    try {
      const firstGateway = gateway.close()
      const firstConnector = connector.close()
      await Promise.all([firstGateway, firstConnector, connector.closed])
      assert.equal(nestedGateway, firstGateway)
      assert.equal(nestedConnector, firstConnector)
      assert.equal(gatewayCloses, 1)
      assert.equal(connectorCloses, 1)
    } finally {
      await gateway.close()
      await connector.close()
      f.close()
    }
  }
)

test(
  'CLI transport宿主打开实际listener，stdin EOF持续运行，终止时先停网络再释放一次Store资源',
  /* 运行实际runCli/HTTP/Store/transport；不以角色stub替代网络生命周期。 */ async () => {
    const f = storeFixture()
    let ports: GatewayTransportPorts | undefined
    let closes = 0
    const runtime = createTransportCliRuntime({
      gateway: /* 只交付本测试已持有的隔离Store和拒绝所有设备的身份来源。 */ async () => ({
        ...resources(f),
        service: /* 复用同一Router构造真实Store服务并观察所属transport。 */ (value) => {
          ports = value
          return new StoreGatewayService({ ...resources(f), router: value.router, targets: f.targets })
        },
        close: /* 必须先停止真实listener再释放Store，重复关闭不得多次进入。 */ async () => {
          closes++
          assert.equal(ports!.transport.status().stopped, true)
          f.store.close()
        }
      })
    })
    const config = { ...configTemplate('gateway'), state_dir: f.directory } as GatewayConfig
    const path = join(f.directory, 'gateway.json')
    writeFileSync(path, JSON.stringify(configDocument(config)), { mode: 0o600 })
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const started = notification()
    const stop = new AbortController()
    const opening = runtime.gateway!
    runtime.gateway = /* 明确等待实际listener创建后再发EOF，避免伪造启动成功。 */ async (value) => {
      const running = await opening(value)
      started.resolve()
      return running
    }
    const running = runCli(
      ['gateway', '--config', path],
      {
        stdin,
        stdout,
        stderr,
        signal: stop.signal
      },
      runtime
    )
    try {
      await started.promise
      assert.equal(ports!.resolveOriginalRead, ports!.transport.resolveOriginalRead)
      assert.equal(ports!.resolveOriginalRead('call_fixture'), undefined)
      assert.equal((await fetch(ports!.transport.url.replace('ws:', 'http:'))).status, 400)
      assert.equal(ports!.transport.status().stopped, false)
    } finally {
      stdin.end()
      await new Promise(/* 等待EOF事件被消费，确认它没有停止Gateway。 */ (resolve) => setImmediate(resolve))
      assert.equal(ports!.transport.status().stopped, false)
      stop.abort()
      assert.equal(await running, 0)
      f.close()
    }
    assert.equal(closes, 1)
    assert.equal(stdout.read(), null)
    assert.equal(stderr.read(), null)
  }
)

test(
  '并发异步服务的dispatch保持所属caller且每次重读身份，无请求作用域时拒绝',
  /* 使用明确的探针服务stub，仅检查真实Router与transport拒绝，不伪装native业务成功。 */ async () => {
    const f = storeFixture()
    const gates = { alice: notification(), bob: notification() }
    let pending: ReturnType<typeof notification> | undefined
    let aliceActive = true
    const readers: string[] = []
    let ports!: GatewayTransportPorts
    const runtime = createTransportCliRuntime({
      gateway: /* 交付同一真实Store及两个合成身份，二者不共享调用归属。 */ async () => ({
        ...resources(f),
        identities: {
          principal: /* 只按受信caller返回对应合成身份；未知身份仍拒绝。 */ (caller) =>
            ['alice', 'bob'].includes(caller.principal_id) && (caller.principal_id !== 'alice' || aliceActive)
              ? { id: caller.principal_id }
              : null,
          administrator: /* 此测试不提供管理员会话。 */ () => null
        },
        service: /* 仅保存实际transport并创建故意交错的探针服务。 */ (value) => {
          ports = value
          return {
            execute: /* 等待caller独立门后尝试实际dispatch，所有分支都应拒绝而不发送。 */ async (
              _name,
              _args,
              context
            ) => {
              await (pending ?? gates[context.caller.principal_id as keyof typeof gates]).promise
              readers.push(ports.principal().id)
              ports.originalAttempt('call_fixture', 'attempt_fixture')
              ports.transport.dispatch('call_fixture')
              throw new Error('unexpected_dispatch')
            }
          }
        }
      })
    })
    const running = await runtime.gateway!({ ...configTemplate('gateway'), state_dir: f.directory } as GatewayConfig)
    const context = /* 只为测试显式构造宿主上下文，不来自MCP业务参数。 */ (id: string): ServiceContext => ({
      caller: { principal_id: id },
      wait_signal: new AbortController().signal
    })
    try {
      assert.throws(
        /* 无所属请求作用域不能为结果模块借用最近身份或读取原请求。 */ () =>
          ports.originalAttempt('call_fixture', 'attempt_fixture'),
        new FacadeServiceError('unauthenticated')
      )
      assert.throws(
        /* 在服务上下文外派发，即使调用归属已存在也不能借用最近caller。 */ () =>
          ports.transport.dispatch('call_fixture'),
        /Gateway service rejected/
      )
      const alice = running.service.execute('runtime_call_get', { call_id: 'call_fixture' }, context('alice'))
      const bob = running.service.execute('runtime_call_get', { call_id: 'call_fixture' }, context('bob'))
      const aliceRejected = assert.rejects(alice, { code: 'connection_unavailable' })
      const bobRejected = assert.rejects(bob, { code: 'call_not_found' })
      gates.bob.resolve()
      gates.alice.resolve()
      await Promise.all([aliceRejected, bobRejected])
      assert.deepEqual([...readers].sort(), ['alice', 'bob'])
      aliceActive = false
      await assert.rejects(running.service.execute('runtime_call_get', { call_id: 'call_fixture' }, context('alice')), {
        code: 'unauthenticated'
      })
      aliceActive = true
      pending = notification()
      const late = running.service.execute('runtime_call_get', { call_id: 'call_fixture' }, context('alice'))
      await running.close()
      pending.resolve()
      await assert.rejects(late, { code: 'unavailable' })
      await assert.rejects(running.service.execute('runtime_call_get', { call_id: 'call_fixture' }, context('alice')), {
        code: 'unavailable'
      })
      await running.close()
    } finally {
      await running.close()
      f.close()
    }
  }
)

test(
  'CLI Wire模式Connector复用本地WS且终止后关闭，启动失败也释放宿主资源',
  /* 真实WS socket只进入拒绝认证路径，无配对、凭据签发、native执行或用户会话。 */ async () => {
    const f = storeFixture()
    const authentication = notification()
    const stop = new AbortController()
    let gatewayPorts!: GatewayTransportPorts
    let connectorCloses = 0
    let invalidCloses = 0
    const base = resources(f)
    const runtime = createTransportCliRuntime({
      gateway: /* 真实listener仅信任本地回环地址；设备认证保持拒绝。 */ async () => ({
        ...base,
        transport: {
          ...base.transport,
          identity: {
            ...base.transport.identity,
            authenticate: /* 到达此回调证明Connector走过实际WS与认证握手，随后必定拒绝。 */ () => {
              authentication.resolve()
              throw new Error('mock_denied')
            }
          }
        },
        service: /* 保存真实listener端点并复用实际Store服务，不开放native工具。 */ (ports) => {
          gatewayPorts = ports
          return f.service
        }
      }),
      connector: /* 专用回调只返回不可用于生产的固定mock输入，不从argv或URL读取秘密。 */ async () => ({
        transport: {
          credential: /* mock握手会被Gateway拒绝，不执行任何凭据安装或签发动作。 */ () => ({
            machine_id: 'mock_denied',
            recovery_generation: f.store.generation(),
            credential: 'MOCK_ONLY_NOT_A_REAL_DEVICE_CREDENTIAL'
          }),
          session: /* Wire模式在认证通过后才创建executeWire；本例认证拒绝，不能建立会话或回退执行。 */ () => {
            throw new Error('unexpected_mock_session')
          }
        },
        close: /* 只统计已停止的Connector本地资源，不能宣称原生取消。 */ async () => {
          connectorCloses++
        }
      })
    })
    const gateway = await runtime.gateway!({ ...configTemplate('gateway'), state_dir: f.directory } as GatewayConfig)
    const config = {
      ...configTemplate('connector'),
      state_dir: f.directory,
      gateway_url: new URL(gatewayPorts.transport.url).origin
    } as ConnectorConfig
    const path = join(f.directory, 'connector.json')
    writeFileSync(path, JSON.stringify(configDocument(config)), { mode: 0o600 })
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const running = runCli(['connector', '--config', path], { stdin, stdout, stderr, signal: stop.signal }, runtime)
    try {
      await authentication.promise
      stop.abort()
      assert.equal(await running, 0)
      assert.equal(connectorCloses, 1)
      assert.equal(stdout.read(), null)
      assert.equal(stderr.read(), null)
      const invalid = createTransportCliRuntime({
        gateway: /* 非法端口的真实transport启动必须拒绝并清理。 */ async () => ({
          ...resources(f),
          transport: { ...base.transport, port: -1 },
          close: /* 此失败宿主只计数，不提前关闭仍由上方Gateway持有的同一测试Store。 */ async () => {
            invalidCloses++
          }
        })
      })
      await assert.rejects(invalid.gateway!({ ...configTemplate('gateway'), state_dir: f.directory } as GatewayConfig))
      assert.equal(invalidCloses, 1)
    } finally {
      stop.abort()
      await running
      await gateway.close()
      f.close()
    }
  }
)

// 实际HTTP作用域必须跨过service的await，再进入同一个transport-runtime身份作用域。
test(
  '两HTTP会话逆序恢复后ports.principal仍属于各自caller，当前身份撤销继续拒绝',
  /* 复用实际Store/Router/transport；服务仅为检查异步身份的阻塞探针，不执行native。 */ async () => {
    const f = storeFixture()
    const started = { alice: notification(), bob: notification() }
    const resume = { alice: notification(), bob: notification() }
    const readers: string[] = []
    let aliceActive = true
    let ports!: GatewayTransportPorts
    const runtime = createTransportCliRuntime({
      gateway: /* 所有设备认证仍拒绝；HTTP认证仅提供合成Alice/Bob用于隔离测试。 */ async () => ({
        ...resources(f),
        authentication: {
          authenticate: /* 每HTTP请求验证固定合成header，不从参数或sessionID选择身份。 */ (request) => {
            const token = request.headers.get('authorization')
            return token === syntheticHeaders.authorization
              ? { principal_id: 'alice' }
              : token === 'Bearer BOB_TEST_ONLY'
                ? { principal_id: 'bob' }
                : null
          }
        },
        identities: {
          principal: /* ports.principal在await后必须重新读取本例当前身份，而非缓存HTTP初始化结果。 */ (caller) =>
            ['alice', 'bob'].includes(caller.principal_id) && (caller.principal_id !== 'alice' || aliceActive)
              ? { id: caller.principal_id }
              : null,
          administrator: /* MCP的合成身份不能取得管理员会话。 */ () => null
        },
        service: /* 同一真实transport向探针交付其私有principal接口，不另造Router。 */ (value) => {
          ports = value
          return {
            execute: /* 两会话同时挂起并逆序恢复，之后才读取当前transport caller。 */ async (_name, _args, context) => {
              const id = context.caller.principal_id as keyof typeof resume
              started[id].resolve()
              await resume[id].promise
              readers.push(ports.principal().id)
              throw new FacadeServiceError('unavailable')
            }
          }
        }
      })
    })
    const gateway = await runtime.gateway!({ ...configTemplate('gateway'), state_dir: f.directory } as GatewayConfig)
    const http = httpFixture(gateway.service, { authentication: gateway.authentication })
    const bob = new Client({ name: 'bob-http-scope-test', version: '1' })
    const bobTransport = new StreamableHTTPClientTransport(new URL(http.running.url), {
      requestInit: { headers: { authorization: 'Bearer BOB_TEST_ONLY' } }
    })
    try {
      await Promise.all([
        http.client.connect(http.transport, { timeout: 5000 }),
        bob.connect(bobTransport, { timeout: 5000 })
      ])
      const aliceReply = http.client.callTool({ name: 'machines_list', arguments: {} }, undefined, { timeout: 5000 })
      const bobReply = bob.callTool({ name: 'machines_list', arguments: {} }, undefined, { timeout: 5000 })
      const aliceObserved = aliceReply.then(
        /* 提前观察成功，避免等待另一个会话时留下未处理拒绝。 */ (reply) => ({ reply }),
        /* 异常仍作为测试失败证据保留。 */ (error: unknown) => ({ error })
      )
      const bobObserved = bobReply.then(
        /* 独立观察Bob请求，不让Alice的等待拥有它。 */ (reply) => ({ reply }),
        /* Bob的意外拒绝不能被清理吞掉。 */ (error: unknown) => ({ error })
      )
      await Promise.all([started.alice.promise, started.bob.promise])
      resume.bob.resolve()
      const second = await bobObserved
      assert('reply' in second && second.reply.isError)
      assert.deepEqual(readers, ['bob'])
      resume.alice.resolve()
      const first = await aliceObserved
      assert('reply' in first && first.reply.isError)
      assert.deepEqual(readers, ['bob', 'alice'])
      aliceActive = false
      const revoked = await http.client.callTool({ name: 'machines_list', arguments: {} }, undefined, { timeout: 5000 })
      assert.deepEqual(revoked.structuredContent, { gateway_error: { code: 'unauthenticated' } })
      assert.deepEqual(readers, ['bob', 'alice'])
    } finally {
      resume.alice.resolve()
      resume.bob.resolve()
      await bob.close()
      await http.close()
      await gateway.close()
      f.close()
    }
  }
)
