// 真实Store/Router/请求作用域验证MCP投影；派发/原Wire端口为标明的组件stub，不替代native SDK回归。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GatewayError } from '../../src/contracts.js'
import { StoreGatewayService } from '../../src/mcp/store-service.js'
import type { ManagementPermission } from '../../src/mcp/management.js'
import { storeFixture, target } from './store-fixture.js'
import { projectionFixture } from './runtime-service-fixture.js'
import { LuvusAdapterError } from '../../src/connector/luvus/types.js'
import { NativeRequestPreflightError } from '../../src/runtime/request-preflight.js'
import { FacadeServiceError, NativeRequestNotDispatchedError } from '../../src/mcp/types.js'
import { RuntimeGatewayService } from '../../src/mcp/runtime-service.js'

test(
  '只有登记前的明确 schema 拒绝投影为 not_dispatched，普通相同错误码不获得此语义',
  /** 原生调用端口均为明确拒绝 stub；不从 code/outcome 自报重建未派发证明。 */ async () => {
    for (const preflight of [false, true]) {
      const f = projectionFixture()
      const service = new RuntimeGatewayService({
        runtime: {
          ...f.runtime,
          /** 精确控制本次准入端口异常，不模拟调用已执行或成功。 */ admit() {
            throw preflight
              ? new NativeRequestPreflightError()
              : new LuvusAdapterError('native_request_invalid', 'outcome_unknown')
          }
        },
        identities: f.identities
      })
      try {
        await assert.rejects(
          /** 每个请求只调用一次原服务，不重试错误意图。 */ () => service.execute('runtime_call', f.args, f.context),
          /** 固定公共码相同，只有明确登记前拒绝类携带未派发语义。 */ (error: unknown) => {
            assert(error instanceof FacadeServiceError)
            assert.equal(error.code, 'native_request_invalid')
            assert.equal(error instanceof NativeRequestNotDispatchedError, preflight)
            return true
          }
        )
      } finally {
        service.close()
        f.close()
      }
    }
  }
)

test('未定调用保留持久契约引用，原连接丢失不重派', async () => {
  const f = projectionFixture()
  try {
    f.override({ attempt_id: 'old_attempt', state: 'outcome_unknown' })
    const view = (await f.service.execute('runtime_call_get', { call_id: 'call_fixture' }, f.context)).data
    assert.equal(view.state, 'outcome_unknown')
    assert.equal(view.contract_ref, 'a'.repeat(64))
    assert.equal(view.result, undefined)
    assert.equal(f.calls.length, 0)
    f.setCaller(null)
    await assert.rejects(f.service.execute('runtime_call_get', { call_id: 'call_fixture' }, f.context), {
      code: 'unauthenticated'
    })
  } finally {
    f.close()
  }
})

test(
  'runtime投影保持原参数/期限，分页绑定主体与大小并逐页重新验权',
  /* 不把stub成功计作原生调用成功。 */ async () => {
    const f = projectionFixture()
    try {
      const call = (await f.service.execute('runtime_call', f.args, f.context)).data
      assert.deepEqual(f.calls[0], {
        target,
        native_request: f.args.native_request,
        options: {
          binding_revision: 1,
          contract_ref: f.args.contract_ref,
          deadline: f.args.deadline
        }
      })
      const result = call.result as { result_id: string; expires_at: number }
      const first = (
        await f.service.execute('runtime_result_read', { result_id: result.result_id, max_bytes: 8 }, f.context)
      ).data
      assert(first.next_cursor)
      assert.equal(first.expires_at, result.expires_at)
      assert.deepEqual(
        (await f.service.execute('runtime_result_read', { result_id: result.result_id, max_bytes: 8 }, f.context)).data,
        first
      )
      await assert.rejects(
        /* 游标不能通过更改页大小重新解释。 */ () =>
          f.service.execute(
            'runtime_result_read',
            {
              result_id: result.result_id,
              cursor: first.next_cursor,
              max_bytes: 16
            },
            f.context
          ),
        { code: 'invalid_cursor' }
      )
      assert.equal(f.calls.length, 1)
      f.setCaller(null)
      await assert.rejects(
        /* 原游标不能保留已撤销身份的读取权限。 */ () =>
          f.service.execute(
            'runtime_result_read',
            {
              result_id: result.result_id,
              cursor: first.next_cursor,
              max_bytes: 8
            },
            f.context
          ),
        { code: 'unauthenticated' }
      )
    } finally {
      f.close()
    }
  }
)

test(
  '最后授权快照统一投影，取消保守报告unknown，关闭和未知错误均不泄露或新准入',
  /* 覆盖组合安全边界。 */ async () => {
    const f = projectionFixture()
    try {
      f.override({ state: 'outcome_unknown', content_status: 'unavailable' })
      const view = (await f.service.execute('runtime_call_get', { call_id: 'call_fixture' }, f.context)).data
      assert.equal(view.state, 'outcome_unknown')
      assert.equal(view.delivery, 'possibly_dispatched')
      assert.equal(view.content_status, 'unavailable')
      assert.equal(view.result, undefined)
      const cancel = (await f.service.execute('runtime_call_cancel', { call_id: 'call_fixture' }, f.context)).data
      assert.equal(cancel.cancellation, 'outcome_unknown')
      assert.equal(f.cancelled(), 1)
      f.readFailure(new GatewayError('SYNTHETIC_SECRET_DO_NOT_PRINT'))
      await assert.rejects(
        /* 未知底层code只能变成固定internal_error。 */ () =>
          f.service.execute(
            'runtime_result_read',
            {
              result_id: 'result_fixture'
            },
            f.context
          ),
        { code: 'internal_error', message: 'Gateway service rejected the request' }
      )
      f.readFailure(new GatewayError('request_key_conflict'))
      await assert.rejects(
        /* 同key不同意图是公开conflict，而不是internal_error。 */ () =>
          f.service.execute('runtime_result_read', { result_id: 'result_fixture' }, f.context),
        { code: 'conflict' }
      )
      f.service.close()
      await assert.rejects(
        /* 关闭门面后不能再进入既有runtime.admit。 */ () => f.service.execute('runtime_call', f.args, f.context),
        { code: 'unavailable' }
      )
      assert.equal(f.calls.length, 0)
    } finally {
      f.close()
    }
  }
)

test(
  '正文句柄失败保留当前可读的真实调用元数据，撤权后不能借错误返回ID',
  /* 参数投影已取得call_id时不重复准入；正文失败与调用登记结果分开。 */ async () => {
    const f = projectionFixture()
    try {
      f.openFailure(/* 模拟实际结果子额不足；不假造结果或改写TTL。 */ () => new GatewayError('result_quota'))
      const view = (await f.service.execute('runtime_call', f.args, f.context)).data
      assert.equal(view.call_id, 'call_fixture')
      assert.equal(view.state, 'responded')
      assert.equal(view.content_delivery, 'unavailable')
      assert.equal(view.content_reason_code, 'storage_exhausted')
      assert.equal(view.result, undefined)
      assert.equal(f.calls.length, 1)
      f.openFailure(
        /* 失败期间同步撤权时，重新读取元数据也必须拒绝。 */ () => {
          f.setCaller(null)
          return new GatewayError('result_quota')
        }
      )
      await assert.rejects(
        /* 不把错误路径变成已撤权主体的call_id旁路。 */ () =>
          f.service.execute(
            'runtime_call_get',
            {
              call_id: 'call_fixture'
            },
            f.context
          ),
        { code: 'unauthenticated' }
      )
    } finally {
      f.close()
    }
  }
)

test(
  '管理提示对实际后端能力和当前grant求交，降级保持拒绝且不执行写入证明',
  /* 仅观察能力来源，无确认/签发/启用副作用。 */ async () => {
    for (const mode of ['active', 'storage_degraded'] as const) {
      const f = storeFixture(mode)
      let capabilities: readonly ManagementPermission[] = ['devices_revoke', 'devices_rename', 'providers_manage']
      let observed = 0
      const service = new StoreGatewayService({
        ...f,
        managementCapabilities: /* 只读已装配能力stub，不调用任何写端口。 */ () => {
          observed++
          return capabilities
        }
      })
      const context = {
        caller: { principal_id: 'alice' },
        management_session_ref: 'admin_session',
        wait_signal: new AbortController().signal
      }
      try {
        const first = await service.management.execute('permissions_get', { machine_id: 'machine_a' }, context)
        assert.equal(observed, 1)
        assert.deepEqual(
          first.decisions.find(/* 精确检查原管理员已有的撤销grant。 */ (item) => item.action === 'devices_revoke'),
          {
            action: 'devices_revoke',
            allowed: mode === 'active',
            reason_code: mode === 'active' ? 'allowed' : 'storage_degraded'
          }
        )
        assert.equal(
          first.decisions.find(/* 后端存在不能补造管理员缺少的改名权限。 */ (item) => item.action === 'devices_rename')!
            .reason_code,
          'forbidden'
        )
        capabilities = []
        const unavailable = await service.management.execute('permissions_get', { machine_id: 'machine_a' }, context)
        assert.equal(
          unavailable.decisions.find(
            /* 没有实际能力继续拒绝，不能因grant存在显示可执行。 */ (item) => item.action === 'devices_revoke'
          )!.allowed,
          false
        )
        const revoked = new StoreGatewayService({
          ...f,
          managementCapabilities: /* 模拟只读来源中的同步撤权，不能返回旧grant的允许提示。 */ () => {
            f.setAdmin(null)
            return ['devices_revoke']
          }
        })
        await assert.rejects(
          /* 能力回调后再次验证同一管理会话。 */ () =>
            revoked.management.execute(
              'permissions_get',
              {
                machine_id: 'machine_a'
              },
              context
            ),
          { code: 'unauthenticated' }
        )
      } finally {
        f.close()
      }
    }
  }
)
