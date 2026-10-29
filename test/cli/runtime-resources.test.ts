// 验证唯一配置到实际出站端点的绑定与错误清理；TLS、凭据和会话均为本例合成fixture。
import { configDocument } from '../../src/cli/config.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { PassThrough } from 'node:stream'
import { createRuntimeCliRuntime, type RuntimeCliConnectorResources } from '../../src/cli/runtime.js'
import { configTemplate, type ConnectorConfig } from '../../src/cli/config.js'
import { runCli, type RunningConnector } from '../../src/cli/run.js'
import type { ConnectorRuntimeOptions } from '../../src/connector/luvus/host/runtime-types.js'
import { createProductionCliRuntime } from '../../src/cli/production.js'
import { runtime as transportRuntime } from '../../src/transport/common.js'
import { saveCredential } from '../../src/transport/index.js'
import { decodeWireFrame } from '../../src/wire/index.js'

test(
  '生产Connector在provider启动前拒绝无效凭据，准备期间撤去凭据仍释放资源并固定诊断',
  /** provider/session为明确清理stub；不启动native或签发真实身份，CLI错误走实际入口。 */ async () => {
    if (process.platform !== 'linux') {
      return
    }
    const directory = mkdtempSync(join(tmpdir(), 'rovloom-cli-credential-preflight-'))
    const refs = join(directory, 'managed')
    mkdirSync(refs, { mode: 0o700 })
    const config = {
      ...configTemplate('connector'),
      state_dir: directory,
      gateway_url: 'ws://127.0.0.1:9443',
      provider_config_refs: ['credential_fixture']
    } as ConnectorConfig
    const configPath = join(directory, 'connector.json')
    const credentialPath = join(refs, 'device.json')
    const synthetic = {
      machine_id: 'preflight_fixture',
      recovery_generation: 'preflight_generation',
      credential: 'SYNTHETIC_PREFLIGHT_CREDENTIAL_NOT_REAL'
    }
    writeFileSync(configPath, JSON.stringify(configDocument(config)), { mode: 0o600 })
    writeFileSync(
      join(refs, 'providers.json'),
      JSON.stringify({
        schema_version: 1,
        role: 'connector',
        providers: [{ reference: 'credential_fixture', value: { kind: 'luvus' } }]
      }),
      { mode: 0o600 }
    )
    let opened = 0
    let released = 0
    const runtime = createProductionCliRuntime({
      connector: /** 只返回启动后立刻失效的资源stub，以验证唯一清理委托。 */ async () => {
        opened++
        unlinkSync(credentialPath)
        return {
          session: /** 本例不得建立认证会话，更不提供原生成功响应。 */ () => {
            assert.fail('fixture session must not open')
          },
          release: /** 仅计数本例资源释放，不冒称实际native进程退出。 */ async () => {
            released++
          }
        }
      }
    })
    try {
      for (const failure of [
        'missing_credential',
        'invalid_credential',
        'unsafe_credential',
        'revoked_during_prepare'
      ]) {
        writeFileSync(credentialPath, JSON.stringify(synthetic), { mode: 0o600 })
        chmodSync(credentialPath, 0o600)
        if (failure === 'missing_credential') {
          unlinkSync(credentialPath)
        }
        if (failure === 'invalid_credential') {
          writeFileSync(credentialPath, '{"credential":"SYNTHETIC_SECRET"}')
        }
        if (failure === 'unsafe_credential') {
          chmodSync(credentialPath, 0o644)
        }
        const stdin = new PassThrough()
        const stdout = new PassThrough()
        const stderr = new PassThrough()
        let output = ''
        let diagnostic = ''
        stdout.on(
          'data',
          /** 收集协议流外的产品stdout以确认启动失败不反射秘密。 */ (bytes) => {
            output += bytes
          }
        )
        stderr.on(
          'data',
          /** 只验证固定诊断，不打印测试中的配置或凭据。 */ (bytes) => {
            diagnostic += bytes
          }
        )
        try {
          const code = await runCli(
            ['connector', '--config', configPath],
            {
              stdin,
              stdout,
              stderr,
              signal: new AbortController().signal
            },
            runtime
          )
          assert.notEqual(code, 0)
          assert.equal(output, '')
          assert.match(
            diagnostic,
            /^(backend_unavailable|invalid_config|config_unreadable|config_not_protected|configuration_required)\n/
          )
          assert.equal(opened, failure === 'revoked_during_prepare' ? 1 : 0)
          assert.equal(released, opened)
        } finally {
          stdin.destroy()
          stdout.destroy()
          stderr.destroy()
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
)

test(
  '生产Connector的快照声明穿过两层CLI并进入真实WS认证帧，未声明时不补广告',
  /** 对端只观察真实Wire协商后拒绝认证；来源和凭据为明确合成fixture，不建立native会话。 */ async () => {
    if (process.platform !== 'linux') {
      return
    }
    const directory = mkdtempSync(join(tmpdir(), 'rovloom-cli-snapshot-'))
    const refs = join(directory, 'managed')
    mkdirSync(refs, { mode: 0o700 })
    let observe!: (capabilities: string[]) => void
    const listener = transportRuntime().serve<null>({
      hostname: '127.0.0.1',
      port: 0,
      fetch: /** 仅本例固定端点接受WebSocket，观察协议不创建Gateway身份。 */ (request, server) =>
        new URL(request.url).pathname === '/connector' && server.upgrade(request, { data: null })
          ? undefined
          : new Response(null, { status: 404 }),
      websocket: {
        maxPayloadLength: 65_536,
        backpressureLimit: 65_536,
        closeOnBackpressureLimit: true,
        perMessageDeflate: false,
        open: /** 链路打开不代表认证或provider就绪。 */ () => {},
        message: /** 复用实际Wire decoder，只交付能力数组，凭据及原帧不进入输出。 */ (socket, message) => {
          const frame = decodeWireFrame(message, { phase: 'preauth', direction: 'connector_to_gateway' })
          assert.equal(frame.type, 'authenticate')
          if (frame.type === 'authenticate') {
            observe([...frame.payload.offer.capabilities])
          }
          socket.close()
        },
        close: /** 测试peer没有持久身份或业务会话可清理。 */ () => {}
      }
    })
    try {
      const config = {
        ...configTemplate('connector'),
        state_dir: directory,
        gateway_url: `ws://127.0.0.1:${listener.port}`,
        provider_config_refs: ['snapshot_fixture']
      } as ConnectorConfig
      writeFileSync(
        join(refs, 'providers.json'),
        JSON.stringify({
          schema_version: 1,
          role: 'connector',
          providers: [{ reference: 'snapshot_fixture', value: { kind: 'luvus' } }]
        }),
        { mode: 0o600 }
      )
      saveCredential(join(refs, 'device.json'), {
        machine_id: 'snapshot_fixture',
        recovery_generation: 'snapshot_generation',
        credential: 'SYNTHETIC_SNAPSHOT_CREDENTIAL_NOT_REAL'
      })
      for (const declared of [true, false]) {
        const received = new Promise<string[]>(
          /** 每轮只观察自己实际收到的认证帧。 */ (resolve) => {
            observe = resolve
          }
        )
        let released = 0
        let sessions = 0
        const runtime = createProductionCliRuntime({
          connector: /** 合成资源只声明已有能力，实际两个CLI组合点和出站transport保持原实现。 */ async () => ({
            ...(declared ? { provider_snapshot: true as const } : {}),
            session: /** peer没有接受认证，任何native会话创建都是本例失败。 */ () => {
              sessions++
              throw new Error('unexpected_fixture_session')
            },
            release: /** 本轮真实runtime只释放一次合成所有者。 */ async () => {
              released++
            }
          })
        })
        const running = await runtime.connector!(config)
        try {
          assert.equal((await received).includes('provider_snapshot'), declared)
        } finally {
          await running.close()
          await running.closed
        }
        assert.equal(released, 1)
        assert.equal(sessions, 0)
      }
    } finally {
      listener.stop(true)
      rmSync(directory, { recursive: true, force: true })
    }
  }
)

test(
  'runtime Connector从唯一配置固定真实WS端点，宿主不重复提供URL',
  /* 真实WS只到本例401服务，不接受认证或建立native session。 */ async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rovloom-runtime-resource-'))
    let observed!: (url: string) => void
    const requested = new Promise<string>(/* 收到真实HTTP请求后才验证路径和关闭。 */ (resolve) => (observed = resolve))
    const server = createServer(
      /* 拒绝WebSocket升级，不接收凭据帧或建立设备会话。 */ (request, response) => {
        response.writeHead(401, { connection: 'close' })
        response.end()
        observed(request.url!)
      }
    )
    server.on(
      'upgrade',
      /* 明确拒绝真实WebSocket升级，只观察请求路径，不接收认证帧。 */ (request, socket) => {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
        observed(request.url!)
      }
    )
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    let released = 0
    let credentials = 0
    let sessions = 0
    let running: RunningConnector | undefined
    try {
      const address = server.address()
      assert(address && typeof address === 'object')
      const config = {
        ...configTemplate('connector'),
        state_dir: directory,
        gateway_url: `ws://127.0.0.1:${address.port}`
      } as ConnectorConfig
      class FixtureResources implements RuntimeCliConnectorResources {
        readonly marker = 'fixture_instance'
        readonly transport = {
          credential: /* Gateway握手拒绝，此fixture不能成为生产身份。 */ () => {
            credentials++
            return {
              machine_id: 'fixture_denied',
              recovery_generation: 'fixture_generation',
              credential: 'SYNTHETIC_CREDENTIAL_NOT_FOR_PRODUCTION'
            }
          }
        }
        // 原型方法仍绑定同一资源实例；401不能创建真实Wire/native会话。
        session(): never {
          assert.equal(this.marker, 'fixture_instance')
          sessions++
          throw new Error('unexpected_fixture_session')
        }
        // 释放需要原型方法和实际this，不能把类实例展开为缺方法的普通对象。
        async release() {
          assert.equal(this.marker, 'fixture_instance')
          released++
        }
      }
      const source = new FixtureResources()
      const runtime = createRuntimeCliRuntime({
        connector: /* 只交付明确合成设备输入，URL由CLI配置拥有。 */ async () => source
      })
      running = await runtime.connector!(config)
      assert.equal(await requested, '/connector')
      await running.close()
      await running.closed
      await running.close()
      assert.equal(released, 1)
      assert.equal(credentials, 1)
      assert.equal(sessions, 0)
    } finally {
      await running?.close()
      const closed = once(server, 'close')
      server.closeAllConnections()
      server.close()
      await closed
      rmSync(directory, { recursive: true, force: true })
    }
  }
)

test(
  'runtime资源夹带冲突URL在凭据读取前拒绝，释放失败也不回显秘密',
  /* 旧完整options只用于模拟结构类型额外字段；不创建任何网络或native资源。 */ async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rovloom-runtime-target-'))
    try {
      const path = join(directory, 'connector.json')
      writeFileSync(
        path,
        JSON.stringify(
          configDocument({ ...configTemplate('connector'), state_dir: directory, gateway_url: 'ws://127.0.0.1:9443' })
        ),
        { mode: 0o600 }
      )
      for (const failRelease of [false, true]) {
        let released = 0
        let credentials = 0
        let sessions = 0
        const legacy: ConnectorRuntimeOptions = {
          transport: {
            url: 'wss://SYNTHETIC_SECRET_DO_NOT_PRINT.invalid/connector',
            credential: /* 冲突校验必须早于实际凭据读取。 */ () => {
              credentials++
              throw new Error('SYNTHETIC_SECRET_DO_NOT_PRINT')
            }
          },
          session: /* 不得把冲突来源交给实际native会话。 */ () => {
            sessions++
            throw new Error('SYNTHETIC_SECRET_DO_NOT_PRINT')
          },
          release: /* 每种失败都回收一次；底层错误原文不得进入CLI诊断。 */ async () => {
            released++
            if (failRelease) {
              throw new Error('SYNTHETIC_SECRET_DO_NOT_PRINT')
            }
          }
        }
        const runtime = createRuntimeCliRuntime({
          connector: /* 结构类型允许旧完整options，其运行时冲突仍须拒绝。 */ async () => legacy
        })
        const stdout = new PassThrough()
        const stderr = new PassThrough()
        let out = ''
        let err = ''
        stdout.on('data', /* 失败不输出配置或来源。 */ (chunk) => (out += chunk))
        stderr.on('data', /* 只允许固定诊断，不泄漏URL/底层释放错误。 */ (chunk) => (err += chunk))
        const code = await runCli(
          ['connector', '--config', path],
          {
            stdin: new PassThrough(),
            stdout,
            stderr,
            signal: new AbortController().signal
          },
          runtime
        )
        assert.equal(code, 1)
        assert.equal(out, '')
        assert.equal(err, 'runtime_failed\n')
        assert.equal(released, 1)
        assert.equal(credentials, 0)
        assert.equal(sessions, 0)
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
)
