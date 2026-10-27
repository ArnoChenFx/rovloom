// 真实Store/Router与请求作用域共用组件fixture；派发及原Wire结果端口明确为stub，不代表原生执行。
import type { DatabaseSync } from 'node:sqlite'
import { canonical, digest } from '../../src/contracts.js'
import { Router } from '../../src/router.js'
import { createTrustedRequestScope } from '../../src/runtime/request-scope.js'
import { RuntimeGatewayService, type RuntimeGateway, type RuntimeGatewayPort } from '../../src/mcp/runtime-service.js'
import type { ServiceContext, ToolArguments } from '../../src/mcp/types.js'
import type { JsonObject } from '../../src/wire/types.js'
import { storeFixture, target, syntheticCredential } from './store-fixture.js'

export type ProjectionFixtureOptions = {
  pending?: boolean
  response?: JsonObject
  mutateSeed?(db: DatabaseSync): void
}

// 此stub只测试参数/回执投影，原生结果权限仍须由runtime-sdk.test.ts中的实际Wire验证。
export function projectionFixture(settings: ProjectionFixtureOptions = {}) {
  const f = storeFixture(
    'active',
    /** 只在真实writer关闭时准备组件历史，不提供运行期SQL端口。 */ (db) => {
      if (settings.response) {
        const response = canonical(settings.response)
        const bytes = Buffer.byteLength(response)
        const hash = digest(response)
        db.prepare('UPDATE calls SET response=?, response_hash=?, response_bytes=?').run(response, hash, bytes)
        db.prepare('UPDATE results SET bytes=?, hash=?').run(bytes, hash)
      }
      settings.mutateSeed?.(db)
    }
  )
  if (settings.pending) {
    // 仅为组件人工hash模拟设备在线；没有真实配对或原生通道，不产生派发许可。
    f.store.connect(target.machine_id, syntheticCredential)
  }
  const scope = createTrustedRequestScope(f.identities)
  const router = new Router(f.store)
  const calls: Parameters<RuntimeGateway['admit']>[0][] = []
  const registered: string[] = []
  let admitted!: () => void
  const admission = new Promise<void>(
    /** 只由准入stub实际进入后推进本例握手。 */ (resolve) => {
      admitted = resolve
    }
  )
  let cancelled = 0
  let override: Partial<ReturnType<RuntimeGateway['get']>> = {}
  let readFailure: Error | undefined
  let openFailure: (() => Error) | undefined
  const runtime: RuntimeGatewayPort = {
    targets: f.targets,
    store: f.store,
    router,
    runAuthenticated: scope.runAuthenticated,
    principal: scope.principal,
    get: /* 返回真实授权元数据；override只用于模拟两次快照间的状态推进。 */ (id: string) => ({
      ...router.get(scope.principal(), id),
      ...override
    }),
    admit: /* pending模式只经真实Router登记而不派发；其它投影使用人工历史，均不假称native执行。 */ (
      input: Parameters<RuntimeGateway['admit']>[0]
    ) => {
      calls.push(input)
      const result = settings.pending
        ? router.admit(scope.principal(), input.target, input.native_request, input.options)
        : { call: router.get(scope.principal(), 'call_fixture'), created: true }
      registered.push(result.call.call_id)
      admitted()
      return result
    },
    cancel: /* 调用实际Router取消授权，再返回本例指定的保守监管状态。 */ (id: string) => {
      cancelled++
      return { ...router.cancel(scope.principal(), id), ...override }
    },
    results: {
      open: /* 人工历史的Store句柄仅供分页投影，不代表真实原生读取许可。 */ (id: string) => {
        if (openFailure) {
          throw openFailure()
        }
        return router.saveResult(scope.principal(), id)
      },
      read: /* 记录后的页仍由真实Router/Store检查主体、期限与当前双端ACL。 */ (
        id: string,
        offset = 0,
        bytes = 65_536
      ) => {
        if (readFailure) {
          throw readFailure
        }
        return router.readResult(scope.principal(), id, offset, bytes)
      },
      discard: /* 明确使用实际专门discard权限，不把读权限当删除权限。 */ (id: string) =>
        router.discardResponse(scope.principal(), id)
    }
  }
  const service = new RuntimeGatewayService({ runtime, identities: f.identities })
  const context: ServiceContext = { caller: { principal_id: 'alice' }, wait_signal: new AbortController().signal }
  const args: ToolArguments['runtime_call'] = {
    target,
    expected_binding_revision: 1,
    contract_ref: 'a'.repeat(64),
    native_request: { method: 'pane.read', params: { value: 'fixture' } },
    deadline: f.store.clock() + 20_000
  }
  return {
    ...f,
    runtime,
    service,
    context,
    args,
    calls,
    admission,
    registered,
    cancelled: /* 观察显式取消调用数，取消前端等待不能增加该计数。 */ () => cancelled,
    override: /* 模拟真实宿主后来观察到的新元数据，不修改Store生产状态机。 */ (value: typeof override) => {
      override = value
    },
    readFailure: /* 注入未知宿主错误，确认固定公共映射不会回显原文。 */ (value: Error) => {
      readFailure = value
    },
    openFailure: /* 模拟正文句柄失败而不改动真实Store准入/状态机。 */ (failure: () => Error) => {
      openFailure = failure
    },
    close: /* 回收门面、作用域及本例真实临时库。 */ () => {
      service.close()
      scope.close()
      f.close()
    }
  }
}
