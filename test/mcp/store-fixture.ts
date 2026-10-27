// 为真实 Store/Router 测试建立隔离数据库与合成身份；历史响应仅为人工 fixture，不代表原生执行或真实配对。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { canonical, digest } from '../../src/contracts.js'
import { Store } from '../../src/store.js'
import type { Principal } from '../../src/router.js'
import type { V2Target } from '../../src/wire/types.js'
import { StoreGatewayService, type Administrator, type GatewayIdentitySource } from '../../src/mcp/index.js'
import { syntheticCredential, target, secondTarget, syntheticSecret } from './fixture-values.js'

export { syntheticCredential, target, secondTarget, syntheticSecret } from './fixture-values.js'

// 生成明确的完整tuple政策；只有测试装配使用，生产不能导入这个授权工厂。
export function policy(targets: V2Target[] = [target, secondTarget], revision = 'caller_1'): ProviderPolicy {
  return {
    revision,
    grants: targets.map(
      /* 每条grant保留一个完整目标与精确方法，不扩张为笛卡尔授权。 */ (route) => ({
        target: route,
        methods: ['pane.read'],
        actions: ['dispatch', 'read', 'cancel']
      })
    )
  }
}

// 建立并返回受测真实Store、共享政策来源和清理函数；全部资源均位于新建临时目录。
export function storeFixture(mode: 'active' | 'storage_degraded' = 'active', mutateSeed?: (db: DatabaseSync) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'rovloom-store-service-'))
  const path = join(directory, 'gateway.db')
  let now = 1_000_000
  const initial = new Store(path, /* 使用可单调推进的合成时钟，不依赖宿主真实业务时间。 */ () => now)
  initial.close()
  // 只在Store关闭时写入人工历史和固定hash；不调用签发/兑换、真实transport或native adapter。
  const seed = new DatabaseSync(path)
  const response = canonical({ id: 'synthetic_native', result: { fixture: syntheticSecret } })
  const intent = {
    call_id: 'call_fixture',
    attempt_id: 'attempt_fixture',
    native_request_id: 'synthetic_native',
    target,
    provider_kind: 'luvus',
    binding_revision: 1,
    contract_ref: 'a'.repeat(64),
    registration: {
      deadline: now + 30_000
    }
  }
  try {
    seed.prepare('UPDATE metadata SET mode=?').run(mode)
    for (const [machine, name] of [
      ['machine_a', 'alpha'],
      ['machine_b', 'beta']
    ]) {
      seed
        .prepare('INSERT INTO machines(machine_id,name,status,credential_hash) VALUES(?,?,?,?)')
        .run(machine!, name!, 'offline', digest(syntheticCredential))
    }
    for (const [machine, provider, kind, reference] of [
      ['machine_a', 'luvus_a', 'luvus', 'safe_ref'],
      ['machine_a', 'herdr_a', 'herdr', '/private/SYNTHETIC_SECRET_DO_NOT_PRINT'],
      ['machine_b', 'luvus_b', 'luvus', 'other_ref']
    ]) {
      seed.prepare('INSERT INTO providers VALUES(?,?,?,?,?,?)').run(machine!, provider!, kind!, reference!, 1, 1)
    }
    seed
      .prepare(`INSERT INTO calls(call_id,principal,machine_id,provider_id,binding_revision,provider_kind,
      request_hash,state,identity_json,target_json,method,mode,request_json,response,
      created,deadline,content_expires,metadata_expires,dedup_expires,content_status,response_hash,response_bytes)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        'call_fixture',
        'alice',
        'machine_a',
        'luvus_a',
        1,
        'luvus',
        digest('fixture'),
        'responded',
        canonical(intent),
        canonical(target),
        'pane.read',
        'strict',
        canonical({ method: 'pane.read', params: { fixture: syntheticSecret } }),
        response,
        now,
        now + 30_000,
        now + 60_000,
        now + 120_000,
        now + 120_000,
        'available',
        digest(response),
        Buffer.byteLength(response)
      )
    seed
      .prepare('INSERT INTO results VALUES(?,?,?,?,?)')
      .run('result_fixture', 'call_fixture', Buffer.byteLength(response), digest(response), now + 60_000)
    // 只在真实writer关闭的人工fixture阶段改状态，不给服务暴露私有SQL端口。
    mutateSeed?.(seed)
  } finally {
    seed.close()
  }
  const store = new Store(path, /* 重新打开真实数据库并保留固定fixture内容期限。 */ () => now)
  let caller: Principal | null = { id: 'alice' }
  let admin: Administrator | null = {
    principal_id: 'alice',
    session_ref: 'admin_session',
    assurance: 'administrator',
    policy_revision: 'admin_1',
    grants: [
      { action: 'gateway_read' },
      { action: 'devices_read', machine_id: 'machine_a' },
      { action: 'devices_read', machine_id: 'machine_b' },
      { action: 'permissions_read', machine_id: 'machine_a' },
      // 调用窗口默认只授予 machine_a；machine_b 用于验证越范围拒绝。
      { action: 'calls_read', machine_id: 'machine_a' },
      { action: 'devices_revoke', machine_id: 'machine_a' },
      { action: 'providers_read', machine_id: 'machine_a', provider_id: 'luvus_a' },
      { action: 'providers_read', machine_id: 'machine_a', provider_id: 'herdr_a' },
      { action: 'providers_manage', machine_id: 'machine_a', provider_id: 'luvus_a' }
    ]
  }
  const identities: GatewayIdentitySource = {
    principal: /* 模拟同一身份服务的当前记录，便于测试即时撤权和身份失效。 */ () => caller,
    administrator: /* 仅在合成管理会话仍有效且引用匹配时返回当前管理授权。 */ (_caller, session) =>
      admin?.session_ref === session ? admin : null
  }
  const service = new StoreGatewayService({ store, identities, targets: () => [target, secondTarget] })
  return {
    store,
    service,
    identities,
    targets: () => [target, secondTarget],
    path,
    directory,
    current: /* 读取同一合成身份来源，测试不另造运行时Principal。 */ () => caller!,
    setCaller: /* 替换当前身份或政策，验证每次服务调用重新授权。 */ (next: Principal | null) => {
      caller = next
    },
    setAdmin: /* 撤销或替换独立管理会话，验证MCP身份不能替代管理员会话。 */ (next: Administrator | null) => {
      admin = next
    },
    advance: /* 只向前推进合成时钟，验证固定内容和游标期限。 */ (milliseconds: number) => {
      now += milliseconds
    },
    close: /* 幂等关闭真实Store并清理本测试私有目录，不触碰用户状态。 */ () => {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }
}

import type { ProviderPolicy } from '../legacy-policy.js'
