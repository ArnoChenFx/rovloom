// 设备注册、配对、凭据认证、撤销与同 ID 重配：每一步都是 Store writer 的单个事务，凭据摘要与设备状态同行同库。
import type { DatabaseSync } from 'node:sqlite'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { canonical, digest, GatewayError } from '../contracts.js'
import { boundedJson, id as validateId, validateDevicePlatform } from '../wire/index.js'
import type { DevicePlatformPayload } from '../wire/types.js'
import type { LedgerInvalidation, Machine, Row } from './model.js'

// 为本地账本实体生成带类别前缀的随机标识，避免顺序 ID 产生关联。
const id = (prefix: string) => `${prefix}_${randomUUID()}`
// 生成一次性注册或设备凭据的随机原文，持久化路径只保存其摘要。
const secret = () => randomBytes(32).toString('base64url')

/** Store 提供给设备账本的受限能力：同一连接、同一 writer 事务、同一审计与失效通知。 */
export interface DeviceHost {
  readonly db: DatabaseSync
  /** 在 Store 的 writer 事务内运行，固定时钟、预算与提交后通知。 */
  transaction<T>(fn: (now: number) => T, admission?: boolean): T
  /** 消费受保护宿主的独立管理确认并写审计。 */
  manage(action: string, target: string, fence: string, now: number): void
  audit(action: string, actor: string, now: number, row?: Row, extra?: Record<string, unknown>): void
  generation(): string
  /** 把设备下未完成的调用收敛为未派发或结果未知。 */
  stopWhere(where: string, values: string[], reason: string, now: number): void
  invalidateWhere(where: string, values: (string | number)[], kind: 'content' | 'fence'): void
  /** 提交后发布的设备级失效通知。 */
  invalidate(event: LedgerInvalidation): void
}

/** 在线配对认领的公开状态；秘密只以摘要留在账本行内，不进入本读模型。 */
export type PairingClaim = Readonly<{
  claim_id: string
  pairing_id: string
  machine_id: string
  user_code: string
  status: 'pending' | 'approved' | 'delivered' | 'activated' | 'failed' | 'cancelled'
  expires: number
  created: number
  // 批准该认领的管理员主体：在线原生激活以它为授权主体，批准前为空。
  approved_by: string | null
  // 在线原生激活完成时记录的清单指纹；未激活为空，只用于重入核对，不作凭据。
  native_fingerprint: string | null
}>

export class DeviceLedger {
  constructor(private readonly host: DeviceHost) {}
  private get db(): DatabaseSync {
    return this.host.db
  }
  private transaction<T>(fn: (now: number) => T, admission = true): T {
    return this.host.transaction(fn, admission)
  }
  private manage(action: string, target: string, fence: string, now: number): void {
    this.host.manage(action, target, fence, now)
  }
  private audit(action: string, actor: string, now: number, row?: Row, extra: Record<string, unknown> = {}): void {
    this.host.audit(action, actor, now, row, extra)
  }
  private generation(): string {
    return this.host.generation()
  }
  private stopWhere(where: string, values: string[], reason: string, now: number): void {
    this.host.stopWhere(where, values, reason, now)
  }
  private invalidateWhere(where: string, values: (string | number)[], kind: 'content' | 'fence'): void {
    this.host.invalidateWhere(where, values, kind)
  }
  // 规范化设备名称并限制字符与长度，拒绝不可作为稳定设备名的输入。
  private name(value: string): string {
    const normalized = value.normalize('NFKC').trim().toLowerCase()
    if (!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(normalized)) {
      throw new GatewayError('invalid_name')
    }
    return normalized
  }
  // 创建待注册设备并记录审计，注册本身不授予在线或执行能力。
  register(name: string): Machine {
    return this.transaction(
      // 原入口保留其受保护宿主确认；共享管理服务另在同一 writer 事务消费持久确认。
      (now) => {
        const result = this.applyRegister(name, now)
        this.audit('machine_registered', 'local', now, undefined, { machine_id: result.machine_id })
        return result
      }
    )
  }
  // 同一事务内使用的生命周期原语，调用者必须先完成独立管理授权与 fence 核对。
  applyRegister(name: string, _now: number): Machine {
    const machine = id('m')
    this.db.prepare("INSERT INTO machines(machine_id,name,status) VALUES(?,?,'pending')").run(machine, this.name(name))
    return this.machine(machine)
  }
  // 按设备 ID 查询公开状态，缺失设备返回稳定错误。
  machine(machine_id: string): Machine {
    return this.storedMachine(machine_id)
  }
  // 返回设备已签发凭据的序号（每次一次性兑换递增），供交付与确认关联；不含任何凭据信息。
  credentialRevision(machine: string): number {
    const row = this.db.prepare('SELECT credential_revision FROM machines WHERE machine_id=?').get(machine)
    if (!row) {
      throw new GatewayError('machine_not_found')
    }
    return Number(row.credential_revision)
  }
  // 当前连接 epoch（离线为 null），供管理确认绑定精确 fence；不含任何凭据信息。
  deviceEpoch(machine: string): string | null {
    const row = this.db.prepare('SELECT epoch FROM machines WHERE machine_id=?').get(machine)
    if (!row) {
      throw new GatewayError('machine_not_found')
    }
    return typeof row.epoch === 'string' ? row.epoch : null
  }
  /**
   * 记录当前认证连接上报的平台，语义是"最近一次上报"：离线后保留旧值，是否仍然新鲜由读取方判定。
   * 只写已校验的形状，按 machine_id 与当前 epoch 双重限定，不接受别的连接代写。
   */
  recordPlatform(machine: string, epoch: string, platform: DevicePlatformPayload): void {
    this.transaction(
      // 平台是观测数据，不推进 resource_revision，也不改变设备状态或凭据。
      (_now) => {
        const row = this.db.prepare('SELECT status,epoch FROM machines WHERE machine_id=?').get(machine)
        if (!row || row.status !== 'online' || row.epoch !== epoch) {
          throw new GatewayError('connection_unavailable')
        }
        this.db.prepare('UPDATE machines SET platform_json=? WHERE machine_id=?').run(boundedJson(platform), machine)
      },
      false
    )
  }
  /** 读取最近一次上报的平台；从未上报或内容不可解析时返回 null，不补造任何平台。 */
  storedPlatform(machine_id: string): DevicePlatformPayload | null {
    const row = this.db.prepare('SELECT platform_json FROM machines WHERE machine_id=?').get(machine_id)
    if (!row || typeof row.platform_json !== 'string') {
      return null
    }
    try {
      const value: unknown = JSON.parse(row.platform_json)
      validateDevicePlatform(value)
      return value
    } catch {
      // 账本里出现不合规内容时按"未记录"处理，不把原始文本交给调用方。
      return null
    }
  }
  /** 私有读取设备行，批观察不经可由宿主覆盖的公开入口。 */
  storedMachine(machine_id: string): Machine {
    const row = this.db.prepare('SELECT machine_id,name,status FROM machines WHERE machine_id=?').get(machine_id)
    if (!row) {
      throw new GatewayError('machine_not_found')
    }
    return row as Machine
  }
  // 在事务中规范化并更新设备名，同时保留管理审计。
  rename(machine: string, name: string): Machine {
    return this.transaction(
      // 原入口保留其受保护宿主确认；共享管理服务另在同一 writer 事务消费持久确认。
      (now) => {
        const result = this.applyRename(machine, name, now)
        this.audit('machine_renamed', 'local', now, undefined, { machine_id: machine })
        return result
      }
    )
  }
  // 同一事务内使用的生命周期原语，调用者必须先完成独立管理授权与 fence 核对。
  applyRename(machine: string, name: string, _now: number): Machine {
    this.machine(machine)
    this.db
      .prepare('UPDATE machines SET resource_revision=resource_revision+1,name=? WHERE machine_id=?')
      .run(this.name(name), machine)
    return this.machine(machine)
  }
  // 旧受保护本机注册入口仅供尚未建立管理配对申请的设备使用，不能绕过已有申请策略。
  issueEnrollment(machine: string, ttlMs = 600_000): string {
    return this.issueEnrollmentFor(machine, ttlMs)
  }
  // 精确管理申请的秘密签发只供受保护custody调用；普通管理DTO/MCP/HTTP不暴露此方法。
  issuePairingEnrollment(machine: string, pairingId: string, policyRef: string, ttlMs = 600_000): string {
    validateId(pairingId)
    validateId(policyRef)
    return this.issueEnrollmentFor(machine, ttlMs, { pairing_id: pairingId, policy_ref: policyRef })
  }
  // 同库绑定申请、目标、策略、恢复代次和截止；一份申请最多签发一次，丢响应不能续发。
  private issueEnrollmentFor(
    machine: string,
    ttlMs: number,
    pairing?: { pairing_id: string; policy_ref: string }
  ): string {
    return this.transaction(
      /* 秘密签发、精确独立确认、申请issued标记与审计同事务提交，失败不交付secret。 */ (now) =>
        this.issueEnrollmentTx(now, machine, ttlMs, pairing)
    )
  }
  // 签发事务体：与认领批准等组合流程共用同一 writer 事务，调用方负责开启事务。
  private issueEnrollmentTx(
    now: number,
    machine: string,
    ttlMs: number,
    pairing?: { pairing_id: string; policy_ref: string },
    confirmedClaim = false
  ): string {
    if (this.machine(machine).status !== 'pending') {
      throw new GatewayError('invalid_machine_state')
    }
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 600_000) {
      throw new GatewayError('invalid_ttl')
    }
    let expires = now + ttlMs
    if (pairing) {
      const application = this.db
        .prepare(
          "SELECT expires,issued FROM admin_pairings WHERE pairing_id=? AND machine_id=? AND policy_ref=? AND status='pending' AND expires>?"
        )
        .get(pairing.pairing_id, machine, pairing.policy_ref, now)
      if (!application || application.issued !== 0) {
        throw new GatewayError('invalid_pairing_issuance')
      }
      expires = Math.min(expires, Number(application.expires))
      if (!confirmedClaim) {
        this.manage(
          'pairing_enrollment_issue',
          machine + '/' + pairing.pairing_id,
          canonical({ recovery_generation: this.generation(), policy_ref: pairing.policy_ref, expires_at: expires }),
          now
        )
      }
      this.db.prepare('UPDATE admin_pairings SET issued=1 WHERE pairing_id=?').run(pairing.pairing_id)
    } else if (this.db.prepare('SELECT 1 FROM admin_pairings WHERE machine_id=? LIMIT 1').get(machine)) {
      throw new GatewayError('protected_pairing_issuance_required')
    }
    if (
      this.db.prepare('SELECT needs_confirmation FROM machines WHERE machine_id=?').get(machine)!.needs_confirmation ===
      1
    ) {
      if (!confirmedClaim) {
        this.manage('device_reenroll', machine, this.generation(), now)
      }
      this.db
        .prepare('UPDATE machines SET resource_revision=resource_revision+1,needs_confirmation=0 WHERE machine_id=?')
        .run(machine)
    }
    this.db.prepare('UPDATE machines SET resource_revision=resource_revision+1 WHERE machine_id=?').run(machine)
    const token = secret()
    this.db
      .prepare(
        'INSERT INTO enrollments(token_hash,machine_id,expires,pairing_id,pairing_policy_ref,pairing_generation) VALUES(?,?,?,?,?,?)'
      )
      .run(
        digest(token),
        machine,
        expires,
        pairing?.pairing_id ?? null,
        pairing?.policy_ref ?? null,
        pairing ? this.generation() : null
      )
    this.audit('enrollment_issued', 'local', now, undefined, {
      machine_id: machine,
      pairing_id: pairing?.pairing_id ?? null
    })
    return token
  }
  // 仅消费原申请有效期内且目标、策略、代次均匹配的材料，不能把旧申请兑换补到新申请。
  redeem(token: string): { machine_id: string; credential: string } {
    return this.transaction(
      /* 精确核验先于凭据生成，消费/设备授权/原申请状态/审计同事务提交。 */ (now) => this.redeemTx(now, token)
    )
  }
  // 兑换事务体：与认领批准共用同一 writer 事务，签发与消费原子完成，调用方负责开启事务。
  private redeemTx(now: number, token: string): { machine_id: string; credential: string } {
    const row = this.db
      .prepare(`SELECT e.machine_id,e.expires,e.pairing_id,e.pairing_policy_ref,e.pairing_generation
      FROM enrollments e JOIN machines m USING(machine_id)
      WHERE token_hash=? AND expires>? AND consumed=0 AND m.status='pending'`)
      .get(digest(token), now) as
      | {
          machine_id: string
          expires: number
          pairing_id: string | null
          pairing_policy_ref: string | null
          pairing_generation: string | null
        }
      | undefined
    if (!row) {
      throw new GatewayError('invalid_enrollment')
    }
    if (row.pairing_id) {
      const application = this.db
        .prepare(
          "SELECT expires FROM admin_pairings WHERE pairing_id=? AND machine_id=? AND policy_ref=? AND issued=1 AND status='pending' AND expires>?"
        )
        .get(row.pairing_id, row.machine_id, row.pairing_policy_ref, now)
      if (!application || row.pairing_generation !== this.generation() || row.expires > Number(application.expires)) {
        throw new GatewayError('invalid_enrollment')
      }
    } else if (this.db.prepare('SELECT 1 FROM admin_pairings WHERE machine_id=? LIMIT 1').get(row.machine_id)) {
      throw new GatewayError('invalid_enrollment')
    }
    const credential = secret()
    this.db.prepare('UPDATE enrollments SET consumed=1 WHERE machine_id=?').run(row.machine_id)
    this.db
      .prepare(
        "UPDATE machines SET resource_revision=resource_revision+1,credential_hash=?,credential_revision=credential_revision+1,status='offline' WHERE machine_id=?"
      )
      .run(digest(credential), row.machine_id)
    if (row.pairing_id) {
      this.db
        .prepare(
          "UPDATE admin_pairings SET status='paired' WHERE pairing_id=? AND machine_id=? AND policy_ref=? AND status='pending' AND expires>?"
        )
        .run(row.pairing_id, row.machine_id, row.pairing_policy_ref, now)
    }
    this.audit('enrollment_consumed', 'local', now, undefined, {
      machine_id: row.machine_id,
      pairing_id: row.pairing_id
    })
    return { machine_id: row.machine_id, credential }
  }

  // 在线配对认领的公开读模型：不含认领秘密摘要，核对码只用于双边人工比对、不作凭据。
  pairingClaim(claimId: string): PairingClaim {
    const row = this.db
      .prepare(
        'SELECT claim_id,pairing_id,machine_id,user_code,status,expires,created,approved_by,native_fingerprint FROM pairing_claims WHERE claim_id=?'
      )
      .get(claimId)
    if (!row) {
      throw new GatewayError('pairing_claim_not_found')
    }
    return row as PairingClaim
  }
  // 按申请 ID 读取管理申请行，供在线认领面定位目标设备；不存在时返回 undefined。
  pairingApplication(
    pairingId: string
  ): { machine_id: string; policy_ref: string; status: string; expires: number; issued: number } | undefined {
    const row = this.db
      .prepare('SELECT machine_id,policy_ref,status,expires,issued FROM admin_pairings WHERE pairing_id=?')
      .get(pairingId)
    return row as
      | { machine_id: string; policy_ref: string; status: string; expires: number; issued: number }
      | undefined
  }
  // 列出全部已批准待交付认领，供网关启动时收敛内存 custody 已丢失的孤儿批准。
  approvedPairingClaims(): PairingClaim[] {
    return this.db
      .prepare(
        "SELECT claim_id,pairing_id,machine_id,user_code,status,expires,created,approved_by,native_fingerprint FROM pairing_claims WHERE status='approved'"
      )
      .all() as PairingClaim[]
  }
  // 读取设备当前凭据摘要，供交付失败收敛时精确拒绝未送达凭据；从未签发时为 null。
  credentialDigest(machine: string): string | null {
    const row = this.db.prepare('SELECT credential_hash FROM machines WHERE machine_id=?').get(machine)
    if (!row) {
      throw new GatewayError('machine_not_found')
    }
    return typeof row.credential_hash === 'string' ? row.credential_hash : null
  }
  // 按申请读取当前活动认领（pending/approved），供管理面展示与批准定位；没有时返回 undefined。
  activePairingClaim(pairingId: string): PairingClaim | undefined {
    const row = this.db
      .prepare(
        "SELECT claim_id,pairing_id,machine_id,user_code,status,expires,created,approved_by,native_fingerprint FROM pairing_claims WHERE pairing_id=? AND status IN ('pending','approved') ORDER BY created DESC LIMIT 1"
      )
      .get(pairingId)
    return row as PairingClaim | undefined
  }
  // 设备端发起认领：申请必须仍 pending 且未签发；同一申请同时只允许一个活动认领，秘密只存摘要。
  startPairingClaim(
    machine: string,
    pairingId: string,
    secretHash: string,
    userCode: string,
    ttlMs = 600_000
  ): PairingClaim {
    validateId(pairingId)
    if (!/^[0-9a-f]{64}$/.test(secretHash)) {
      throw new GatewayError('invalid_pairing_claim')
    }
    if (!/^[A-Z0-9]{4,16}$/.test(userCode)) {
      throw new GatewayError('invalid_pairing_claim')
    }
    return this.transaction((now) => {
      if (this.machine(machine).status !== 'pending') {
        throw new GatewayError('invalid_machine_state')
      }
      if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 600_000) {
        throw new GatewayError('invalid_ttl')
      }
      const application = this.db
        .prepare(
          "SELECT expires,issued FROM admin_pairings WHERE pairing_id=? AND machine_id=? AND status='pending' AND expires>?"
        )
        .get(pairingId, machine, now)
      if (!application) {
        throw new GatewayError('pairing_not_found')
      }
      if (application.issued !== 0) {
        throw new GatewayError('invalid_pairing_issuance')
      }
      if (this.activePairingClaim(pairingId)) {
        throw new GatewayError('pairing_claim_conflict')
      }
      const claim: PairingClaim = {
        claim_id: id('claim'),
        pairing_id: pairingId,
        machine_id: machine,
        user_code: userCode,
        status: 'pending',
        expires: Math.min(now + ttlMs, Number(application.expires)),
        created: now,
        approved_by: null,
        native_fingerprint: null
      }
      this.db
        .prepare(
          'INSERT INTO pairing_claims(claim_id,pairing_id,machine_id,secret_hash,user_code,status,expires,created) VALUES(?,?,?,?,?,?,?,?)'
        )
        .run(
          claim.claim_id,
          claim.pairing_id,
          claim.machine_id,
          secretHash,
          claim.user_code,
          claim.status,
          claim.expires,
          claim.created
        )
      this.audit('pairing_claim_started', 'local', now, undefined, {
        machine_id: machine,
        pairing_id: pairingId,
        claim_id: claim.claim_id
      })
      return claim
    })
  }
  // 核对设备端出示的认领秘密原文：摘要定长比对，不匹配与不存在使用同一错误，避免枚举认领状态。
  verifyPairingClaimSecret(claimId: string, secretPlaintext: string): PairingClaim {
    const row = this.db.prepare('SELECT secret_hash FROM pairing_claims WHERE claim_id=?').get(claimId)
    if (!row || !timingSafeEqual(Buffer.from(String(row.secret_hash)), Buffer.from(digest(secretPlaintext)))) {
      throw new GatewayError('invalid_pairing_claim')
    }
    return this.pairingClaim(claimId)
  }
  // 管理员核对双边核对码后批准认领：同一事务内完成签发与兑换，凭据只回调用方的受保护 custody，不落库不入回执。
  approvePairingClaim(claimId: string, userCode: string, actor: string): { machine_id: string; credential: string } {
    return this.transaction((now) => this.approvePairingClaimTx(now, claimId, userCode, actor))
  }
  // 批准事务体：管理账本在同一 writer 事务内组合调用，调用方必须先完成管理员授权与确认。
  approvePairingClaimTx(
    now: number,
    claimId: string,
    userCode: string,
    actor: string,
    confirmedClaim = false
  ): { machine_id: string; credential: string } {
    validateId(actor)
    const claim = this.pairingClaim(claimId)
    if (claim.status !== 'pending' || claim.expires <= now) {
      throw new GatewayError('invalid_pairing_claim')
    }
    if (claim.user_code !== userCode) {
      throw new GatewayError('pairing_claim_code_mismatch')
    }
    const application = this.db
      .prepare(
        "SELECT policy_ref FROM admin_pairings WHERE pairing_id=? AND machine_id=? AND status='pending' AND expires>?"
      )
      .get(claim.pairing_id, claim.machine_id, now)
    if (!application) {
      throw new GatewayError('pairing_not_found')
    }
    const token = this.issueEnrollmentTx(
      now,
      claim.machine_id,
      600_000,
      {
        pairing_id: claim.pairing_id,
        policy_ref: String(application.policy_ref)
      },
      confirmedClaim
    )
    const result = this.redeemTx(now, token)
    this.db.prepare("UPDATE pairing_claims SET status='approved', approved_by=? WHERE claim_id=?").run(actor, claimId)
    this.audit('pairing_claim_approved', 'local', now, undefined, {
      machine_id: claim.machine_id,
      pairing_id: claim.pairing_id,
      claim_id: claimId,
      approved_by: actor
    })
    return result
  }
  // 凭据经 custody 确认送达后完成认领；重复完成与未知认领都拒绝，避免把未交付误报为已交付。
  completePairingClaim(claimId: string): void {
    this.transaction((now) => {
      const claim = this.pairingClaim(claimId)
      if (claim.status !== 'approved') {
        throw new GatewayError('invalid_pairing_claim')
      }
      this.db.prepare("UPDATE pairing_claims SET status='delivered' WHERE claim_id=?").run(claimId)
      this.audit('pairing_claim_delivered', 'local', now, undefined, {
        machine_id: claim.machine_id,
        pairing_id: claim.pairing_id,
        claim_id: claimId
      })
    })
  }
  // 在线原生激活完成落账：只有已交付认领可激活，指纹只用于重入核对；已激活且指纹一致时幂等，不同指纹拒绝。
  activatePairingClaim(claimId: string, fingerprint: string): PairingClaim {
    return this.transaction((now) => this.activatePairingClaimTx(now, claimId, fingerprint))
  }
  // Store 在定义所有实例的同一事务内调用，不允许半数 provider 已定义但认领未落账。
  activatePairingClaimTx(now: number, claimId: string, fingerprint: string): PairingClaim {
    const claim = this.pairingClaim(claimId)
    if (claim.status === 'activated') {
      if (claim.native_fingerprint !== fingerprint) {
        throw new GatewayError('pairing_claim_conflict')
      }
      return claim
    }
    if (claim.status !== 'delivered' || !claim.approved_by) {
      throw new GatewayError('invalid_pairing_claim')
    }
    this.db
      .prepare("UPDATE pairing_claims SET status='activated', native_fingerprint=? WHERE claim_id=?")
      .run(fingerprint, claimId)
    this.audit('pairing_claim_activated', 'local', now, undefined, {
      machine_id: claim.machine_id,
      pairing_id: claim.pairing_id,
      claim_id: claimId,
      approved_by: claim.approved_by,
      native_fingerprint: fingerprint
    })
    return this.pairingClaim(claimId)
  }

  // 交付失败、超时或网关重启时收敛认领；已终结的认领重复失败处理幂等无操作，凭据拒绝由调用方另行执行。
  failPairingClaim(claimId: string): void {
    this.transaction((now) => {
      const row = this.db
        .prepare('SELECT status,machine_id,pairing_id FROM pairing_claims WHERE claim_id=?')
        .get(claimId)
      if (
        !row ||
        row.status === 'delivered' ||
        row.status === 'activated' ||
        row.status === 'failed' ||
        row.status === 'cancelled'
      ) {
        return
      }
      this.db.prepare("UPDATE pairing_claims SET status='failed' WHERE claim_id=?").run(claimId)
      this.db
        .prepare("UPDATE admin_pairings SET status='failed' WHERE pairing_id=? AND status IN ('pending','paired')")
        .run(String(row.pairing_id))
      this.audit('pairing_claim_failed', 'local', now, undefined, {
        machine_id: String(row.machine_id),
        pairing_id: String(row.pairing_id),
        claim_id: claimId
      })
    })
  }
  // 核验设备凭据并生成新连接 epoch，旧连接不继承新会话身份。
  connect(machine: string, credential: string): string {
    return this.transaction(
      /* 校验凭据与设备状态，替换连接 epoch 并记录连接审计。 */ (now) => {
        const row = this.db
          .prepare('SELECT status,credential_hash,needs_confirmation FROM machines WHERE machine_id=?')
          .get(machine)
        if (
          !row ||
          row.status === 'revoked' ||
          row.needs_confirmation !== 0 ||
          row.credential_hash !== digest(credential)
        ) {
          throw new GatewayError('invalid_device_credential')
        }
        if (row.status === 'online') {
          throw new GatewayError('duplicate_device_connection')
        }
        const epoch = id('epoch')
        this.db
          .prepare(
            "UPDATE machines SET resource_revision=resource_revision+1,status='online',epoch=? WHERE machine_id=?"
          )
          .run(epoch, machine)
        this.audit('connected', machine, now, undefined, {
          machine_id: machine,
          epoch,
          generation: this.generation()
        })
        return epoch
      }
    )
  }
  // 同 ID 重配须经管理确认并核对当前 generation/epoch：清除旧凭据，使设备回到 pending，并在提交后使其全部上下文失效。
  // 调用方在提交后关闭该设备的通道；旧 epoch 已被清除，旧连接本身无法再通过 fence。
  resetDeviceEnrollment(machineId: string, recoveryGeneration: string, expectedEpoch: string | null): void {
    this.transaction(
      // 确认与预算先通过才改变设备状态；任何失败整体回滚。
      (now) => {
        validateId(machineId)
        if (recoveryGeneration !== this.generation()) {
          throw new GatewayError('recovery_generation_mismatch')
        }
        if (expectedEpoch !== null) {
          validateId(expectedEpoch)
        }
        const row = this.db.prepare('SELECT epoch FROM machines WHERE machine_id=?').get(machineId)
        if (!row || row.epoch !== expectedEpoch) {
          throw new GatewayError('device_epoch_mismatch')
        }
        const fence = boundedJson({ recovery_generation: recoveryGeneration, connection_epoch: expectedEpoch })
        this.manage('device_enrollment_reset', machineId, fence, now)
        this.stopWhere('machine_id=?', [machineId], 'device_enrollment_reset', now)
        // 仅在本库 COMMIT 后通知该设备全部上下文失效；即使没有调用行也回收尚无法归属调用的分片。
        this.host.invalidate({ kind: 'device_fence', machine_id: machineId })
        this.db.prepare('DELETE FROM enrollments WHERE machine_id=?').run(machineId)
        this.db
          .prepare(
            "UPDATE machines SET resource_revision=resource_revision+1,status='pending',credential_hash=NULL,epoch=NULL,needs_confirmation=0 WHERE machine_id=?"
          )
          .run(machineId)
      }
    )
  }
  // 凭据交付失败或结果未知时清除凭据并要求经确认重新配对；匹配不到当前凭据摘要则不改变任何状态。
  denyDelivery(machine: string, credentialDigest: string): void {
    this.transaction(
      // 保持降级时也能收紧权限，因此不要求准入。
      (now) => {
        const row = this.db.prepare('SELECT epoch,credential_hash FROM machines WHERE machine_id=?').get(machine)
        if (!row || row.credential_hash !== credentialDigest) {
          return
        }
        if (typeof row.epoch === 'string') {
          this.applyDisconnect(machine, row.epoch, now)
        }
        this.db
          .prepare(
            "UPDATE machines SET resource_revision=resource_revision+1,status='pending',credential_hash=NULL,epoch=NULL,needs_confirmation=1 WHERE machine_id=?"
          )
          .run(machine)
        this.audit('credential_delivery_unknown', 'custody', now, undefined, { machine_id: machine })
      },
      false
    )
  }
  // 只断开指定 epoch，将相关未完成调用收敛为未派发或结果未知，提交后发布绑定失效通知。
  disconnect(machine: string, epoch: string): void {
    return this.transaction(
      // 原入口保留其受保护宿主确认；共享管理服务另在同一 writer 事务消费持久确认。
      (now) => {
        const result = this.applyDisconnect(machine, epoch, now)
        return result
      },
      false
    )
  }
  // 同一事务内使用的生命周期原语，调用者必须先完成独立管理授权与 fence 核对。
  applyDisconnect(machine: string, epoch: string, now: number): void {
    const changed = this.db
      .prepare(
        "UPDATE machines SET resource_revision=resource_revision+1,status='offline',epoch=NULL WHERE machine_id=? AND epoch=?"
      )
      .run(machine, epoch)
    if (changed.changes === 1) {
      this.stopWhere('machine_id=? AND (epoch=? OR epoch IS NULL)', [machine, epoch], 'disconnect', now)
      this.invalidateWhere('machine_id=? AND epoch=?', [machine, epoch], 'fence')
    }
  }
  // 通过受保护确认撤销设备，收敛调用状态并清除凭据、注册令牌及内容，不承诺撤销远端副作用。
  revoke(machine: string): void {
    return this.transaction(
      // 原入口保留其受保护宿主确认；共享管理服务另在同一 writer 事务消费持久确认。
      (now) => {
        this.manage('devices_revoke', machine, this.generation(), now)
        const result = this.applyRevoke(machine, now)
        return result
      },
      false
    )
  }
  // 同一事务内使用的生命周期原语，调用者必须先完成独立管理授权与 fence 核对。
  applyRevoke(machine: string, now: number): void {
    this.machine(machine)
    this.stopWhere('machine_id=?', [machine], 'device_revoked', now)
    this.invalidateWhere('machine_id=?', [machine], 'fence')
    this.db
      .prepare(
        "UPDATE machines SET resource_revision=resource_revision+1,status='revoked',credential_hash=NULL,epoch=NULL WHERE machine_id=?"
      )
      .run(machine)
    this.db.prepare('DELETE FROM enrollments WHERE machine_id=?').run(machine)
    this.db.prepare('DELETE FROM results WHERE call_id IN (SELECT call_id FROM calls WHERE machine_id=?)').run(machine)
    this.db
      .prepare("UPDATE calls SET response=NULL,request_json=NULL,content_status='unavailable' WHERE machine_id=?")
      .run(machine)
  }
}
