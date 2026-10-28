// 验证请求结束与关闭重入的身份撤销、Gateway 唯一关闭结果，以及同源契约的实例能力冲突。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTrustedRequestScope } from '../../src/runtime/request-scope.js'
import { createGatewayRuntime } from '../../src/runtime/gateway.js'
import { openGatewayState } from '../../src/runtime/state.js'
import type { GatewayRuntimeOptions, RuntimeProvider } from '../../src/runtime/types.js'
import type { GatewayIdentitySource } from '../../src/mcp/management.js'
import type { NativeContractRecord } from '../../src/integration/luvus-wire.js'
import type { ContractSource } from '../../src/wire/types.js'
import { contractRef } from '../../src/wire/index.js'
import { compiled, G, json } from '../native-contract/helpers.js'

/** 只解析本回归的合成 caller，不发放管理员会话或读取任何外部身份。 */
function identities(beforeResolve?: () => void): GatewayIdentitySource {
  return {
    /** 允许测试在真实身份解析边界同步关闭作用域，再返回原有合法主体。 */
    principal(caller) {
      beforeResolve?.()
      return { id: caller.principal_id, policy: { revision: 'isolated_caller1', grants: [] } }
    },
    /** 本文件不建立管理身份，避免将 caller 与管理员混用。 */
    administrator() {
      return null
    }
  }
}

/** 用显式门闩控制异步任务恢复，保证它先继承请求 ALS，再在请求结束后继续执行。 */
function latch() {
  let release!: () => void
  const promise = new Promise<void>(
    /** 保存唯一恢复入口，不使用计时器猜测请求是否已经结束。 */ (resolve) => {
      release = resolve
    }
  )
  return { promise, release }
}

/** 创建仅属于本测试的私有双库及真实生命周期接线，不安装凭据或接入任何 Connector。 */
function gatewayFixture() {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-runtime-lifecycle-'))
  const state = openGatewayState({
    state_directory: root,
    store: {
      /** 只为本隔离账本的注册与 provider 配置生成独立一次性测试确认。 */
      management() {
        return { actor: 'isolated_lifecycle_admin', confirmation_id: randomUUID() }
      }
    },
    /** 没有安装凭据或设备连接，不应发生身份变更通知。 */
    changed() {
      throw new Error('unexpected_identity_change')
    }
  })
  const options: Omit<GatewayRuntimeOptions, 'release'> = {
    lifecycle: state.lifecycle,
    channels: state.channels,
    identities: identities(),
    providers: [],
    listener: { hostname: '127.0.0.1', port: 0, developmentLoopback: true }
  }
  return {
    root,
    state,
    options,
    /** 关闭真实双库并只删除本回归独占创建的目录。 */
    close() {
      try {
        state.close()
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  }
}

test(
  'request scope rejects an inherited async task after its request ends while another caller is active',
  /** Alice 的迟到任务保持自己的 ALS，不能在 Bob 活跃时借用 Bob 或复活 Alice 的身份。 */ async () => {
    const scope = createTrustedRequestScope(identities())
    const resume = latch()
    let escaped!: Promise<string>
    try {
      await scope.runAuthenticated(
        { principal_id: 'alice' },
        /** 在请求内部启动任务后立即返回，让任务在原请求结束时仍然挂起。 */ () => {
          escaped = /** 在 Alice 的 ALS 内启动，门闩恢复后仍继承原上下文。 */ (async () => {
            assert.equal(scope.principal().id, 'alice')
            await resume.promise
            return scope.principal().id
          })()
        }
      )
      await scope.runAuthenticated(
        { principal_id: 'bob' },
        /** 在另一请求中恢复旧任务，拒绝必须源于旧上下文失效而非没有 ALS。 */ async () => {
          assert.equal(scope.principal().id, 'bob')
          const rejected = assert.rejects(escaped, /unauthenticated/)
          resume.release()
          await rejected
          assert.equal(scope.principal().id, 'bob')
        }
      )
    } finally {
      resume.release()
      scope.close()
    }
  }
)

test(
  'request scope does not enter an operation when its identity source closes the scope',
  /** 初次解析身份时同步关闭，不能在回调返回后仍然进入被认证操作。 */ async () => {
    let entered = false
    const scope = createTrustedRequestScope(
      identities(/** 直接从身份源回调撤销整个作用域，复现关闭重入边界。 */ () => scope.close())
    )
    try {
      await assert.rejects(
        scope.runAuthenticated(
          { principal_id: 'alice' },
          /** 任何执行都表明身份解析后的关闭 fence 被绕过。 */ () => {
            entered = true
          }
        ),
        /unauthenticated/
      )
      assert.equal(entered, false)
    } finally {
      scope.close()
    }
  }
)

test(
  'request scope rechecks closure after its identity source returns a valid principal',
  /** 请求已建立后，逐操作解析身份的回调关闭也必须使本次读取失败。 */ async () => {
    let closeDuringResolve = false
    const scope = createTrustedRequestScope(
      identities(
        /** 初次认证保留作用域，只在随后 principal 解析时触发关闭。 */ () => {
          if (closeDuringResolve) {
            scope.close()
          }
        }
      )
    )
    try {
      await scope.runAuthenticated(
        { principal_id: 'alice' },
        /** 先证明请求当前有效，再核对同步关闭不能返回刚刚解析到的主体。 */ () => {
          assert.equal(scope.principal().id, 'alice')
          closeDuringResolve = true
          assert.throws(
            /** 关闭在身份源内部发生，不能只检查进入 principal 前的状态。 */ () => scope.principal(),
            /unauthenticated/
          )
        }
      )
    } finally {
      scope.close()
    }
  }
)

test(
  'Gateway close shares one promise and stops its listener before a reentrant owner release',
  /** 真实 Gateway 关闭时先停止 listener；释放回调重入 close 只能观察同一个结果。 */ async () => {
    const fixture = gatewayFixture()
    let releases = 0
    const runtime = await createGatewayRuntime({
      ...fixture.options,
      /** 通过真实释放入口检查顺序、关闭重入和请求身份撤销。 */
      async release() {
        releases++
        assert.equal(runtime.transport.status().stopped, true)
        assert.equal(runtime.close(), runtime.closed)
        assert.throws(
          /** 释放期间已经关闭准入，不能从任何残留请求取得身份。 */ () => runtime.principal(),
          /runtime_closed/
        )
        fixture.state.close()
      }
    })
    try {
      const first = runtime.close()
      assert.equal(first, runtime.closed)
      assert.equal(runtime.close(), first)
      await first
      assert.equal(runtime.close(), first)
      assert.equal(releases, 1)
      assert.equal(existsSync(join(fixture.root, 'gateway.db.lock')), false)
    } finally {
      try {
        await runtime.close()
      } finally {
        fixture.close()
      }
    }
  }
)

test(
  'Gateway owner release failure rejects the same closed promise without retrying release',
  /** 真实资源已经释放后注入失败，close 与长期观察者必须收到同一个安全错误。 */ async () => {
    const fixture = gatewayFixture()
    let releases = 0
    const runtime = await createGatewayRuntime({
      ...fixture.options,
      /** 先释放独占双库，再模拟宿主后续释放失败，不泄漏原始错误。 */
      async release() {
        releases++
        assert.equal(runtime.transport.status().stopped, true)
        fixture.state.close()
        throw new Error('isolated_release_failure')
      }
    })
    try {
      const first = runtime.close()
      assert.equal(first, runtime.closed)
      assert.equal(runtime.close(), first)
      const results = await Promise.allSettled([first, runtime.closed])
      const [closeResult, observedResult] = results
      assert.equal(closeResult!.status, 'rejected')
      assert.equal(observedResult!.status, 'rejected')
      if (closeResult!.status === 'rejected' && observedResult!.status === 'rejected') {
        assert.equal(closeResult.reason, observedResult.reason)
        assert.equal(closeResult.reason.code, 'gateway_runtime_close_failed')
        assert.equal(closeResult.reason.message, 'gateway_runtime_close_failed')
      }
      await assert.rejects(runtime.close(), /gateway_runtime_close_failed/)
      assert.equal(releases, 1)
      assert.equal(runtime.transport.status().stopped, true)
      assert.equal(existsSync(join(fixture.root, 'gateway.db.lock')), false)
    } finally {
      fixture.close()
    }
  }
)

test(
  'Gateway rejects shared contract references with different live capabilities or capability revisions',
  /** 相同契约来源只可共享完全一致的能力；任何冲突均须在启动失败清理后返回。 */ async () => {
    const source: ContractSource = {
      provider_kind: 'luvus',
      protocol_family: 'uhp',
      binary_version: '0.14.3',
      binary_sha256: compiled.identity.binary_sha256,
      schema_sha256: compiled.identity.schema_sha256,
      schema_origin: 'installed_cli',
      schema_command: 'luvus uhp schema',
      server_version: '0.14.3',
      native_protocol_version: '1.0',
      runtime_generation: G,
      adapter_revision: 'isolated_lifecycle_adapter1',
      classification_revision: 'isolated_review1',
      support_basis: 'live_catalog'
    }
    const capabilities = json('session-capabilities.json')
    capabilities.result.server_generation = G
    capabilities.result.session = 'synthetic'
    const contract: NativeContractRecord = {
      wire: { source, support_status: 'validated' },
      compiled,
      capabilities,
      capability_revision: 'isolated_caps1'
    }
    for (const conflict of ['capabilities', 'revision']) {
      const fixture = gatewayFixture()
      let releases = 0
      let unexpected: Awaited<ReturnType<typeof createGatewayRuntime>> | undefined
      try {
        const machine = fixture.state.store.register('isolated_contract_conflict')
        /** 两个真实持久 provider 分别拥有身份，原生派发端口在此启动回归中绝不应调用。 */
        function provider(providerId: string, record: NativeContractRecord): RuntimeProvider {
          const binding = fixture.state.store.defineProvider({
            machine_id: machine.machine_id,
            provider_id: providerId,
            kind: 'luvus',
            config_ref: 'isolated_' + providerId,
            binding_revision: 1,
            enabled: true
          })
          return {
            binding,
            target: {
              machine_id: machine.machine_id,
              provider_id: providerId,
              profile: 'session',
              session: 'synthetic'
            },
            contract: record,
            /** 没有设备连接，不能为此构造回归生成原生来源。 */
            source() {
              throw new Error('unexpected_native_source')
            },
            /** 没有调用登记，不能询问原生执行权限。 */
            validateAttempt() {
              throw new Error('unexpected_native_authority')
            },
            /** 启动拒绝应发生在 provider 就绪检查之前。 */
            ready() {
              throw new Error('unexpected_provider_readiness')
            }
          }
        }
        const changedCapabilities = structuredClone(capabilities)
        const changed: NativeContractRecord = { ...contract, capabilities: changedCapabilities }
        if (conflict === 'capabilities') {
          changedCapabilities.result.methods.pop()
        } else {
          changed.capability_revision = 'isolated_caps2'
        }
        assert.equal(contractRef(contract.wire.source), contractRef(changed.wire.source))
        const startup = createGatewayRuntime({
          ...fixture.options,
          providers: [provider('first', contract), provider('second', changed)],
          /** 启动拒绝也必须恰好释放一次同一个真实双库所有者。 */
          async release() {
            releases++
            fixture.state.close()
          }
        }).then(
          /** 错误实现若意外启动成功，仍保留真实句柄供 finally 停止 listener。 */ (runtime) => {
            unexpected = runtime
            return runtime
          }
        )
        await assert.rejects(startup, /runtime_provider_conflict/)
        assert.equal(releases, 1)
        assert.equal(existsSync(join(fixture.root, 'gateway.db.lock')), false)
      } finally {
        try {
          await unexpected?.close()
        } finally {
          fixture.close()
        }
      }
    }
  }
)
