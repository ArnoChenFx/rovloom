/** 管理页直接渲染共享管理 DTO；不补造未核实状态，也不建立另一套管理协议。 */
import type {
  CallAggregate,
  DeviceSnapshot,
  ManagementStatus,
  ManagementReply,
  PermissionSnapshot
} from '../mcp/management.js'
import type { ReaderState } from './reader.js'
import { createLocalizer, type Localizer, type MessageKey } from './i18n.js'
import { uiIcon, type IconName } from './icons.js'
import { copyControl } from './clipboard.js'

/** 仅组合一次页面读取，所有业务对象仍是共享 DTO。 */
export interface PageView {
  status: ManagementStatus
  devices: ManagementReply['devices_list']
  device: DeviceSnapshot | null
  providers: ManagementReply['providers_list']
  permissions: PermissionSnapshot | null
  providersProblem: 'forbidden' | 'unavailable' | null
  /** 调用窗口只在调用页读取；其它页面为 null，部分失败单独标记。 */
  calls: ManagementReply['calls_list'] | null
  callsProblem: 'forbidden' | 'unavailable' | null
}
export type PageRoute = {
  machineId: string | null
  cursor: string | null
  providerCursor: string | null
  /** 调用页分页游标；省略等同于没有后续页。 */
  callsCursor?: string | null
  section?: 'devices' | 'pairing' | 'connect' | 'calls'
}
export type DeviceFilter = { query: string; status: 'all' | 'online' | 'attention' }
/** 调用页只在前端筛选当前页；不发起新的服务端读取，也不改变统计范围。 */
export type CallFilter = 'all' | 'responded' | 'pending' | 'failed'
type PageSection = { heading: HTMLElement; body: HTMLElement }

const connectionNames = {
  connecting: 'connection.connecting',
  reconnecting: 'connection.reconnecting',
  online: 'connection.online',
  degraded: 'connection.degraded',
  offline: 'connection.offline'
} as const satisfies Record<string, MessageKey>
const authenticationNames = {
  pending: 'authentication.pending',
  authenticated: 'authentication.authenticated',
  failed: 'authentication.failed',
  expired: 'authentication.expired',
  revoked: 'authentication.revoked'
} as const satisfies Record<string, MessageKey>
const readinessNames = {
  ready: 'readiness.ready',
  unavailable: 'readiness.unavailable',
  unverified: 'readiness.unverified'
} as const satisfies Record<string, MessageKey>
const componentNames = {
  available: 'component.available',
  degraded: 'component.degraded',
  unavailable: 'component.unavailable',
  unverified: 'component.unverified'
} as const satisfies Record<string, MessageKey>
const problemNames: Record<NonNullable<ReaderState<PageView>['problem']>, MessageKey> = {
  unauthenticated: 'error.unauthenticated',
  forbidden: 'error.forbidden',
  not_found: 'error.not_found',
  conflict: 'error.conflict',
  unavailable: 'error.unavailable',
  invalid_response: 'error.invalid_response',
  timeout: 'error.timeout',
  cancelled: 'error.cancelled'
}

/** 创建节点，所有后端文本通过 textContent 转义。 */
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag)
  result.textContent = text
  result.className = className
  return result
}

/** 渲染只含文本的键值信息。 */
function facts(rows: [string, string][], variant = ''): HTMLElement {
  const result = node('dl', '', `facts ${variant}`)
  for (const [label, value] of rows) {
    const item = node('div', '', 'fact')
    item.append(node('dt', label), node('dd', value))
    result.append(item)
  }
  return result
}

/** 创建文字与颜色并用的状态标签。 */
function badge(text: string, tone = 'neutral'): HTMLElement {
  return node('span', text, `badge ${tone}`)
}

/** 编码明确 machine_id 和不透明分页游标，不携带身份或秘密。 */
export function routeHref(route: PageRoute): string {
  const parameters = new URLSearchParams()
  if (route.machineId !== null) {
    parameters.set('machine', route.machineId)
  }
  if (route.cursor !== null) {
    parameters.set('cursor', route.cursor)
  }
  if (route.providerCursor !== null) {
    parameters.set('providers', route.providerCursor)
  }
  if (route.callsCursor) {
    parameters.set('calls', route.callsCursor)
  }
  if (route.machineId === null && route.section) {
    parameters.set('view', route.section)
  }
  return `#${parameters.toString()}`
}

/** 拒绝重复/超限导航字段，不保留隐式当前机器。 */
export function parseRoute(hash: string): PageRoute {
  const empty: PageRoute = { machineId: null, cursor: null, providerCursor: null }
  // 两个 1024 字符字段经 UTF-8 百分号编码最多约 18 KiB；编码前后预算保持一致。
  if (hash.length > 20_000) {
    return empty
  }
  const parameters = new URLSearchParams(hash.replace(/^#/, ''))
  for (const key of ['machine', 'cursor', 'providers', 'calls', 'view']) {
    if (parameters.getAll(key).length > 1 || (parameters.get(key)?.length ?? 0) > 1_024) {
      return empty
    }
  }
  const machineId = parameters.get('machine') || null
  const callsCursor = machineId ? null : parameters.get('calls') || null
  return {
    machineId,
    cursor: machineId ? null : parameters.get('cursor') || null,
    providerCursor: machineId ? parameters.get('providers') || null : null,
    // 省略而非 null，使既有路由字面量保持不变且不引入隐式分页。
    ...(callsCursor === null ? {} : { callsCursor }),
    ...(!machineId && ['devices', 'pairing', 'connect', 'calls'].includes(parameters.get('view') ?? '')
      ? { section: parameters.get('view') as PageRoute['section'] }
      : {})
  }
}

/** 各层观测共享服务时间和单调经过时间，但分别保留自己的观测时点。 */
interface Freshness {
  now: number
  staleAfter: number
  pageStale: boolean
  i18n: Localizer
}

/** 新 status 只更新当前时间，不续期旧设备、认证或原生观测。 */
function current(observedAt: number, freshness: Freshness): boolean {
  return !freshness.pageStale && freshness.now - observedAt < freshness.staleAfter
}

/** 同时显示每层原始时间、年龄和过期标记；未知没有可补造的时间。 */
function observationTime(observedAt: number | null, freshness: Freshness): string {
  const { i18n } = freshness
  const { t } = i18n
  if (observedAt === null) {
    return t('value.unverified')
  }
  return t('time.observed', {
    time: i18n.timestamp(observedAt),
    age: i18n.age(observedAt, freshness.now),
    expired: current(observedAt, freshness) ? '' : t('time.expiredSuffix')
  })
}

/** 列表用真实年龄紧凑对齐，过期/未知常驻；绝对时刻保留在标题及设备详情，不续期观测。 */
function listObservation(
  key: 'devices.observed' | 'devices.connectionObserved' | 'devices.authObserved',
  observedAt: number | null,
  freshness: Freshness
): HTMLElement {
  const { i18n } = freshness
  const time =
    observedAt === null
      ? i18n.t('time.noObservation')
      : `${i18n.age(observedAt, freshness.now)}${current(observedAt, freshness) ? '' : i18n.t('time.expiredSuffix')}`
  const result = node('p', i18n.t(key, { time }), 'muted')
  result.title = i18n.t(key, { time: observationTime(observedAt, freshness) })
  return result
}

/** Provider 的绿色就绪提示还要求当前设备、连接与认证观测均有效。 */
function currentDeviceLink(device: DeviceSnapshot, freshness: Freshness): boolean {
  return (
    device.persisted_state === 'online' &&
    current(device.observed_at, freshness) &&
    device.connection.verification === 'verified' &&
    current(device.connection.observed_at, freshness) &&
    device.connection.value.state === 'online' &&
    device.authentication.verification === 'verified' &&
    current(device.authentication.observed_at, freshness) &&
    device.authentication.value.state === 'authenticated'
  )
}

/**
 * 把设备平台渲染成人类可读文本：如「Linux · Ubuntu 24.04 · x64」「Linux · x64」「macOS · arm64」。
 * 只翻译固定词汇；发行版标识是原始值，不做大小写或名称猜测。Linux 没有发行版标识时只显示 os 与架构。
 */
function platformLabel(platform: NonNullable<DeviceSnapshot['platform']>, i18n: Localizer): string {
  const { t } = i18n
  const os = t(
    platform.os === 'linux' ? 'platform.osLinux' : platform.os === 'darwin' ? 'platform.osDarwin' : 'platform.osWindows'
  )
  const arch = t(platform.arch === 'x64' ? 'platform.archX64' : 'platform.archArm64')
  if (platform.os !== 'linux' || platform.distribution === null) {
    return t('device.platformParts', { os, arch })
  }
  const distribution = platform.distribution.version_id
    ? `${platform.distribution.id} ${platform.distribution.version_id}`
    : platform.distribution.id
  return t('device.platformDistribution', { os, distribution, arch })
}

/** 只在设备确有平台时渲染一个中性徽标；没有平台就不渲染任何占位。 */
function platformBadge(device: DeviceSnapshot, i18n: Localizer): HTMLElement | null {
  if (device.platform === null) {
    return null
  }
  const result = badge(platformLabel(device.platform, i18n))
  result.dataset.platform = device.platform.os
  return result
}

/** 分开显示持久状态、连接与认证；过期的已验证来源仅可作为历史，不呈绿色在线。 */
function deviceBadges(device: DeviceSnapshot, freshness: Freshness): HTMLElement {
  const { i18n } = freshness
  const { t } = i18n
  const result = node('div', '', 'badges')
  const deviceCurrent = current(device.observed_at, freshness)
  if (!deviceCurrent) {
    result.append(badge(t('device.expired'), 'warning'))
  }
  if (device.persisted_state === 'revoked') {
    result.append(
      badge(
        deviceCurrent ? t('authentication.revoked') : t('device.revokedHistory'),
        deviceCurrent ? 'danger' : 'warning'
      ),
      badge(t('device.oldRecords'))
    )
    return result
  }
  if (device.persisted_state === 'pending') {
    result.append(
      badge(deviceCurrent ? t('device.pending') : t('device.pendingHistory'), 'warning'),
      badge(t('device.pendingUnverified'), 'warning')
    )
    return result
  }
  const connection = device.connection
  const authenticationCurrent =
    device.authentication.verification === 'verified' &&
    current(device.authentication.observed_at, freshness) &&
    device.authentication.value.state === 'authenticated'
  if (connection.verification === 'verified') {
    const ownCurrent = current(connection.observed_at, freshness)
    result.append(
      deviceCurrent && ownCurrent
        ? connection.value.state === 'online' && !authenticationCurrent
          ? badge(t('device.onlineAuthUnknown'), 'warning')
          : badge(t(connectionNames[connection.value.state]), connection.value.state === 'online' ? 'good' : 'neutral')
        : badge(
            t('device.lastState', {
              label: t(ownCurrent ? 'device.connectionParentExpired' : 'device.connectionExpired'),
              state: t(connectionNames[connection.value.state])
            }),
            'warning'
          )
    )
  } else {
    result.append(badge(t('device.connectionUnknown', { reason: i18n.reason(connection.reason_code) }), 'warning'))
  }
  const authentication = device.authentication
  if (authentication.verification === 'verified') {
    const ownCurrent = current(authentication.observed_at, freshness)
    result.append(
      deviceCurrent && ownCurrent
        ? badge(
            t(authenticationNames[authentication.value.state]),
            ['failed', 'expired', 'revoked'].includes(authentication.value.state) ? 'danger' : 'neutral'
          )
        : badge(
            t('device.lastState', {
              label: t(ownCurrent ? 'device.authParentExpired' : 'device.authExpired'),
              state: t(authenticationNames[authentication.value.state])
            }),
            'warning'
          )
    )
  } else {
    result.append(badge(t('device.authUnknown', { reason: i18n.reason(authentication.reason_code) }), 'warning'))
  }
  return result
}

/** 未接后端时说明入口不可用的原因；已连接时该说明会被隐藏，不留在可用按钮上方。 */
function unavailableActions(kind: 'device' | 'provider', i18n: Localizer): HTMLElement {
  const { t } = i18n
  const section = node('section', '', 'actions')
  const noteId = `unavailable-${kind}`
  const note = node('p', t('actions.unavailable'), 'muted')
  note.id = noteId
  section.append(note)
  const labels =
    kind === 'provider' ? [t('actions.provider')] : [t('actions.rename'), t('actions.disconnect'), t('actions.revoke')]
  for (const label of labels) {
    const button = node('button', label)
    button.type = 'button'
    button.disabled = true
    button.setAttribute('aria-describedby', noteId)
    section.append(button)
  }
  return section
}

/** 只按当前可信展示范围启用三个入口；权限提示不代替写服务的每次授权。 */
function deviceActions(page: PageView, freshness: Freshness, connected: boolean): HTMLElement {
  const section = unavailableActions('device', freshness.i18n)
  if (!connected) {
    return section
  }
  // 已连接时不再显示“尚未接入”说明：隐藏而不删除节点，避免每次重绘重建按钮并丢焦。
  const note = section.querySelector('p')
  if (note) {
    note.hidden = true
    note.removeAttribute('id')
  }
  for (const button of section.querySelectorAll('button')) {
    button.removeAttribute('aria-describedby')
  }
  const permission = page.permissions
  const allowed =
    permission &&
    page.device &&
    current(page.device.observed_at, freshness) &&
    current(permission.observed_at, freshness) &&
    freshness.now < permission.expires_at
  const actions = ['device_rename', 'device_disconnect', 'device_revoke'] as const
  const grants = ['devices_rename', 'devices_disconnect', 'devices_revoke']
  const buttons = section.querySelectorAll('button')
  for (let index = 0; index < actions.length; index++) {
    const action = actions[index]!
    const button = buttons[index]!
    button.dataset.deviceAction = action
    button.disabled =
      !allowed ||
      !permission.decisions.some(
        /** 权限仅作入口提示，服务端逐请求重验。 */ (decision) =>
          decision.action === grants[index] && decision.allowed && decision.reason_code === 'allowed'
      )
  }
  return section
}

/** 统计仅覆盖当前授权页；过期时不把历史连接显示为当前在线或离线。 */
function overviewMetrics(page: PageView, freshness: Freshness): HTMLElement {
  const t = freshness.i18n.t
  const online = page.devices.items.filter((device) => currentDeviceLink(device, freshness)).length
  const section = node('section', '', 'overview-metrics')
  section.setAttribute('aria-label', t('nav.overview'))
  const rows: [MessageKey, MessageKey, string, IconName][] = [
    ['overview.visible', 'overview.visibleNote', String(page.devices.items.length), 'devices'],
    ['overview.online', 'overview.onlineNote', freshness.pageStale ? '—' : String(online), 'shield'],
    [
      'overview.attention',
      'overview.attentionNote',
      freshness.pageStale ? '—' : String(page.devices.items.length - online),
      'attention'
    ]
  ]
  for (const [label, description, value, icon] of rows) {
    const card = node('article', '', 'metric-card')
    const top = node('div', '', 'metric-heading')
    top.append(node('span', t(label)), uiIcon(icon))
    card.append(top, node('strong', value, 'metric-value'), node('p', t(description), 'muted'))
    section.append(card)
  }
  return section
}

/** 向用户说明当前客户端配置流程，不从管理页端口推测 MCP 地址或展示任何凭据。 */
function guidePage(section: 'pairing' | 'connect', i18n: Localizer, management: boolean): PageSection {
  const { t } = i18n
  const heading = node('header', '', 'page-heading')
  const copy = node('div', '', 'heading-copy')
  copy.append(node('p', t('nav.workspace'), 'eyebrow'))
  copy.append(node('h1', t(section === 'pairing' ? 'pairing.pageTitle' : 'connect.title')))
  copy.append(node('p', t(section === 'pairing' ? 'pairing.pageDescription' : 'connect.description'), 'muted'))
  heading.append(copy)
  const body = node('section', '', 'connection-guide')
  if (section === 'pairing') {
    if (!management) {
      const empty = node('div', '', 'empty')
      empty.append(uiIcon('shield'), node('h2', t('pairing.loginRequired')), node('p', t('pairing.loginHint'), 'muted'))
      body.append(empty)
    }
    return { heading, body }
  }
  const commands = ['rovloom token list', 'rovloom token create --principal my_client --like EXISTING_CALLER_ID']
  for (const [index, title, description] of [
    [0, 'connect.stepOne', 'connect.stepOneNote'],
    [1, 'connect.stepTwo', 'connect.stepTwoNote'],
    [2, 'connect.stepThree', 'connect.stepThreeNote']
  ] as const) {
    const card = node('article', '', 'connection-step')
    const number = node('span', String(index + 1).padStart(2, '0'), 'step-number')
    const details = node('div', '', 'connection-step-body')
    details.append(node('h2', t(title)), node('p', t(description), 'muted'))
    if (index < commands.length) {
      const command = commands[index]!
      const block = node('div', '', 'command-snippet')
      block.append(node('code', command), copyControl(command, t('copy.action')))
      const docker = node('details', '', 'docker-command')
      docker.dataset.disclosure = 'docker-command-' + index
      docker.append(node('summary', t('connect.docker')))
      const dockerCommand = command.replace(/^rovloom /u, 'docker compose run --rm gateway ')
      const snippet = node('div', '', 'command-snippet')
      snippet.append(node('code', dockerCommand), copyControl(dockerCommand, t('copy.action')))
      docker.append(snippet)
      details.append(block, docker)
    } else {
      const link = node('a', t('connect.docs'), 'text-link')
      link.href = `https://github.com/ArnoChenFx/rovloom/blob/main/docs/QUICK-START${i18n.language === 'zh-CN' ? '-zh' : ''}.md`
      link.target = '_blank'
      link.rel = 'noreferrer noopener'
      details.append(link)
    }
    card.append(number, details)
    body.append(card)
  }
  return { heading, body }
}

/** 调用状态到展示词条的固定映射；未知状态已在共享校验中拒绝。 */
const callStateNames = {
  created: 'calls.state.created',
  dispatching: 'calls.state.dispatching',
  connector_accepted: 'calls.state.connector_accepted',
  responded: 'calls.state.responded',
  not_dispatched: 'calls.state.not_dispatched',
  outcome_unknown: 'calls.state.outcome_unknown'
} as const satisfies Record<string, MessageKey>
const callContentNames = {
  available: 'calls.contentAvailable',
  expired: 'calls.contentExpired',
  discarded: 'calls.contentDiscarded',
  unavailable: 'calls.contentUnavailable'
} as const satisfies Record<string, MessageKey>

/** 状态标签沿用设备页的语义色：已响应为良好，结果未知/未派发为警告，其余中性。 */
function callStateTone(state: keyof typeof callStateNames): string {
  if (state === 'responded') {
    return 'good'
  }
  if (state === 'outcome_unknown' || state === 'not_dispatched') {
    return 'warning'
  }
  return 'neutral'
}

/** 水平条只按本页最大计数归一；数值始终以文本给出，不依赖颜色读数。 */
function distributionRows(
  title: MessageKey,
  rows: readonly { label: string; count: number; tone?: string }[],
  freshness: Freshness
): HTMLElement {
  const { t } = freshness.i18n
  const section = node('section', '', 'call-distribution')
  const header = node('div', '', 'distribution-heading')
  header.append(node('h3', t(title)))
  section.append(header)
  const max = Math.max(1, ...rows.map((row) => row.count))
  if (!rows.length) {
    section.append(node('p', t('calls.noData'), 'muted'))
    return section
  }
  const list = node('ul', '', 'distribution-list')
  for (const row of rows) {
    const item = node('li', '', 'distribution-row')
    const label = node('span', row.label, 'distribution-label')
    label.title = row.label
    const bar = node('span', '', 'distribution-bar')
    const fill = node('span', '', `distribution-fill ${row.tone ?? ''}`)
    // 宽度只表达相对计数，不承载唯一信息；计数文本同时可读。
    fill.style.setProperty('--share', String(Math.round((row.count / max) * 100)) + '%')
    bar.append(fill)
    const value = node('strong', t('calls.count', { count: row.count }), 'distribution-value')
    item.append(label, bar, value)
    list.append(item)
  }
  section.append(list)
  return section
}

/** 状态分布用环形图与计数并列；未知状态不合并进成功。 */
function stateDistribution(aggregate: CallAggregate, freshness: Freshness): HTMLElement {
  const { t } = freshness.i18n
  const section = node('section', '', 'call-distribution call-states')
  const header = node('div', '', 'distribution-heading')
  header.append(node('h3', t('calls.distribution')))
  section.append(header)
  if (!aggregate.total) {
    section.append(node('p', t('calls.noData'), 'muted'))
    return section
  }
  // 环形图只用 CSS conic-gradient 表达比例，中心给出总数；分类明细在右侧文本列表中重复。
  const ring = node('div', '', 'state-ring')
  const slices: string[] = []
  let offset = 0
  const tones: Record<string, string> = {
    responded: 'var(--good-text)',
    created: 'var(--muted)',
    dispatching: 'var(--accent)',
    connector_accepted: 'var(--accent)',
    not_dispatched: 'var(--warning-text)',
    outcome_unknown: 'var(--warning-text)'
  }
  for (const row of aggregate.by_state) {
    const end = offset + (row.count / aggregate.total) * 100
    slices.push(`${tones[row.state] ?? 'var(--muted)'} ${offset}% ${end}%`)
    offset = end
  }
  ring.style.setProperty('--ring', slices.length ? `conic-gradient(${slices.join(',')})` : 'none')
  const center = node('div', '', 'state-ring-center')
  center.append(node('strong', String(aggregate.total), 'state-ring-total'), node('span', t('calls.total'), 'muted'))
  ring.append(center)
  const legend = node('ul', '', 'state-legend')
  for (const row of aggregate.by_state) {
    const item = node('li')
    const dot = node('span', '', 'state-dot')
    dot.style.setProperty('--tone', tones[row.state] ?? 'var(--muted)')
    item.append(
      dot,
      node('span', t(callStateNames[row.state]), 'state-name'),
      node('strong', String(row.count), 'state-count')
    )
    legend.append(item)
  }
  section.append(ring, legend)
  return section
}

/** Backward links remain available even if the current live page has become empty. */
function callPagination(calls: ManagementReply['calls_list'], i18n: Localizer): HTMLElement | null {
  const { t } = i18n
  const pagination = node('nav', '', 'call-pagination')
  pagination.setAttribute('aria-label', t('calls.pagination'))
  for (const [cursor, label, rel] of [
    [calls.previous_cursor, 'calls.previous', 'prev'],
    [calls.next_cursor, 'calls.next', 'next']
  ] as const) {
    if (cursor === undefined) {
      continue
    }
    const link = node('a', t(label), 'button-link')
    link.rel = rel
    link.href = routeHref({
      machineId: null,
      cursor: null,
      providerCursor: null,
      callsCursor: cursor,
      section: 'calls'
    })
    pagination.append(link)
  }
  return pagination.childNodes.length ? pagination : null
}

/** 调用页只使用共享调用窗口 DTO；正文、凭据与未授权设备不在此构造。 */
function callsPage(page: PageView, freshness: Freshness, route: PageRoute, filter: CallFilter): PageSection {
  const { i18n } = freshness
  const { t } = i18n
  const heading = node('header', '', 'page-heading')
  const copy = node('div', '', 'heading-copy')
  copy.append(node('h1', t('calls.title')))
  heading.append(copy)
  const section = node('section', '', 'calls-section')
  if (page.callsProblem !== null) {
    section.append(
      node('p', page.callsProblem === 'forbidden' ? t('calls.forbidden') : t('calls.unavailable'), 'notice warning')
    )
    return { heading, body: section }
  }
  const calls = page.calls
  if (!calls) {
    section.append(node('p', t('calls.unavailable'), 'notice warning'))
    return { heading, body: section }
  }
  const aggregate = calls.aggregate
  const responded = aggregate.by_state.find(/* 已响应计数只来自账本状态。 */ (row) => row.state === 'responded')
  const pending = aggregate.by_state
    .filter(
      /* 在途只含明确未定状态，不把未派发算作在途。 */ (row) =>
        ['created', 'dispatching', 'connector_accepted'].includes(row.state)
    )
    .reduce((sum, row) => sum + row.count, 0)
  const metrics = node('section', '', 'overview-metrics call-metrics')
  metrics.setAttribute('aria-label', t('calls.title'))
  for (const [label, value, icon] of [
    ['calls.total', String(aggregate.total), 'calls'],
    ['calls.responded', String(responded?.count ?? 0), 'check'],
    ['calls.pending', String(pending), 'activity']
  ] as const) {
    const card = node('article', '', 'metric-card')
    const top = node('div', '', 'metric-heading')
    top.append(node('span', t(label)), uiIcon(icon))
    card.append(top, node('strong', value, 'metric-value'))
    metrics.append(card)
  }
  const charts = node('section', '', 'call-charts')
  charts.append(
    stateDistribution(aggregate, freshness),
    distributionRows(
      'calls.bySource',
      aggregate.by_principal.map(
        /* 来源使用 principal 标识，不展开凭据。 */ (row) => ({
          label: row.principal,
          count: row.count
        })
      ),
      freshness
    ),
    distributionRows(
      'calls.byTarget',
      aggregate.by_provider.map(
        /* 目标使用 provider 实例标识与类型。 */ (row) => ({
          label: `${row.machine_id} · ${row.kind === 'luvus' ? 'Luvus' : 'Herdr'} · ${row.provider_id}`,
          count: row.count
        })
      ),
      freshness
    ),
    distributionRows(
      'calls.byMethod',
      aggregate.by_method.map(/* 命令只展示已提交方法名。 */ (row) => ({ label: row.method, count: row.count })),
      freshness
    )
  )
  const listHeader = node('div', '', 'section-heading')
  const listCopy = node('div')
  listCopy.append(node('h2', t('calls.listHeading')))
  if (calls.window.truncated) {
    listCopy.append(badge(t('calls.truncated'), 'warning'))
  }
  listHeader.append(listCopy)
  if (calls.items.length) {
    const filters = node('div', '', 'device-filters call-filters')
    filters.setAttribute('role', 'group')
    filters.setAttribute('aria-label', t('calls.filterLabel'))
    for (const [value, key] of [
      ['all', 'calls.filterAll'],
      ['responded', 'calls.state.responded'],
      ['pending', 'calls.pending'],
      ['failed', 'calls.failed']
    ] as const) {
      const button = node('button', t(key))
      button.type = 'button'
      button.dataset.callFilter = value
      button.setAttribute('aria-pressed', String(value === filter))
      filters.append(button)
    }
    listHeader.append(filters)
  }
  const details = node('section', '', 'call-details')
  details.append(listHeader)
  section.append(metrics, charts, details)
  const pagination = callPagination(calls, i18n)
  if (!calls.items.length) {
    const empty = node('div', '', 'empty')
    empty.append(uiIcon('calls'), node('h2', t('calls.emptyTitle')), node('p', t('calls.emptyHint'), 'muted'))
    details.append(empty)
    if (pagination) {
      details.append(pagination)
    }
    return { heading, body: section }
  }
  const columns = node('div', '', 'call-columns')
  columns.setAttribute('aria-hidden', 'true')
  for (const key of ['calls.colCall', 'calls.colSource', 'calls.colState', 'calls.colTime'] as const) {
    columns.append(node('span', t(key)))
  }
  const list = node('ul', '', 'call-list')
  list.setAttribute('aria-label', t('calls.listHeading'))
  const visible = calls.items.filter(
    /* 前端筛选只作用于当前页；统计始终来自完整采样窗口。 */ (call) =>
      filter === 'all' ||
      (filter === 'responded'
        ? call.state === 'responded'
        : filter === 'pending'
          ? ['created', 'dispatching', 'connector_accepted'].includes(call.state)
          : ['not_dispatched', 'outcome_unknown'].includes(call.state))
  )
  for (const call of visible) {
    const row = node('li', '', 'call-card')
    const identity = node('div', '', 'call-identity')
    const method = node('strong', call.method, 'call-method')
    const id = node('code', call.call_id)
    id.title = call.call_id
    identity.append(method, id)
    const source = node('div', '', 'call-source')
    source.append(node('span', call.principal, 'call-principal'))
    source.append(
      node(
        'p',
        call.target.profile === 'session' && call.target.session
          ? t('calls.targetSession', { session: call.target.session })
          : t('calls.targetHost'),
        'muted'
      )
    )
    source.append(node('p', `${call.machine_id} · ${call.provider_id}`, 'mono muted'))
    const state = node('div', '', 'call-state')
    state.append(
      node('span', t(callStateNames[call.state]), `badge ${callStateTone(call.state)}`),
      node('span', t(call.dispatched ? 'calls.dispatched' : 'calls.notDispatched'), 'muted')
    )
    const content = node('p', t(callContentNames[call.content_status]), 'muted')
    if (call.outcome !== null) {
      content.textContent = `${t(call.outcome === 'result' ? 'calls.outcome.result' : 'calls.outcome.error')} · ${content.textContent}`
    }
    state.append(content)
    const when = node('div', '', 'call-time')
    when.append(
      node('strong', i18n.timestamp(call.created_at), 'activity-age'),
      node('p', i18n.age(call.created_at, freshness.now), 'muted'),
      node('p', t('calls.deadline', { time: i18n.timestamp(call.deadline) }), 'muted')
    )
    row.append(identity, source, state, when)
    list.append(row)
  }
  // 表头与行包在同一个边框容器内，与设备列表一致；无匹配行时不渲染空表框，只留提示。
  if (visible.length) {
    const table = node('div', '', 'call-table')
    table.append(columns, list)
    details.append(table)
  } else {
    const empty = node('div', '', 'empty search-empty')
    empty.append(uiIcon('search'), node('h3', t('devices.noMatches')), node('p', t('calls.emptyHint'), 'muted'))
    details.append(empty)
  }
  if (pagination) {
    details.append(pagination)
  }
  return { heading, body: section }
}

/** 概览只汇总当前授权页并给出设备页入口，不复用设备列表，避免两页内容重复。 */
function overviewPage(page: PageView, freshness: Freshness): PageSection {
  const { t } = freshness.i18n
  const heading = node('header', '', 'page-heading')
  const copy = node('div', '', 'heading-copy')
  copy.append(node('p', t('overview.eyebrow'), 'eyebrow'))
  copy.append(node('h1', t('overview.title')), node('p', t('overview.description'), 'muted'))
  heading.append(copy)
  const add = node('a', '', 'primary-button')
  add.href = '#view=pairing'
  add.append(uiIcon('plus'), node('span', t('nav.pairing')))
  heading.append(add)
  const section = node('section', '', 'devices-section')
  const sectionHeader = node('div', '', 'section-heading')
  const sectionCopy = node('div')
  sectionCopy.append(node('h2', t('overview.deviceSection')), node('p', t('overview.deviceSubtitle'), 'muted'))
  sectionHeader.append(sectionCopy)
  const all = node('a', '', 'text-link')
  all.href = '#view=devices'
  all.append(node('span', t('overview.manage')), uiIcon('arrow'))
  sectionHeader.append(all)
  section.append(sectionHeader)
  if (page.devices.items.length === 0) {
    const empty = node('div', '', 'empty')
    empty.append(uiIcon('devices'), node('h2', t('devices.emptyTitle')), node('p', t('devices.emptyHint'), 'muted'))
    section.append(empty)
  } else {
    // 概览只列出最近几条摘要，完整检索、筛选和分页留在设备页。
    const list = node('ul', '', 'device-list overview-device-list')
    for (const device of page.devices.items.slice(0, 3)) {
      const item = node('li', '', 'device-card')
      const name = node('div', '', 'device-name')
      name.append(node('strong', device.name), node('p', device.machine_id, 'mono muted'))
      item.append(name)
      list.append(item)
    }
    section.append(list)
  }
  return { heading, body: section }
}

/** 列表只展示后端返回的授权页，不将页长宣称为设备总数。 */
function deviceList(page: PageView, freshness: Freshness, route: PageRoute, filter: DeviceFilter): PageSection {
  const { i18n } = freshness
  const { t } = i18n
  const heading = node('header', '', 'page-heading')
  const copy = node('div', '', 'heading-copy')
  copy.append(node('p', t('devices.eyebrow'), 'eyebrow'))
  copy.append(node('h1', t('devices.heading')))
  heading.append(copy)
  const add = node('a', '', 'primary-button')
  add.href = '#view=pairing'
  add.append(uiIcon('plus'), node('span', t('nav.pairing')))
  heading.append(add)
  const section = node('section', '', 'devices-section')
  const sectionHeader = node('div', '', 'section-heading')
  const sectionCopy = node('div')
  sectionCopy.append(node('h2', t('devices.heading')), node('p', t('devices.subtitle'), 'muted'))
  sectionHeader.append(sectionCopy)
  section.append(sectionHeader)
  if (page.devices.items.length) {
    const tools = node('div', '', 'device-tools')
    const search = node('label', '', 'search-field')
    const input = node('input')
    input.type = 'search'
    input.name = 'device-search'
    input.value = filter.query
    input.placeholder = t('devices.searchPlaceholder')
    input.setAttribute('aria-label', t('devices.search'))
    search.append(uiIcon('search'), input)
    const filters = node('div', '', 'device-filters')
    filters.setAttribute('role', 'group')
    filters.setAttribute('aria-label', t('devices.health'))
    for (const [value, key] of [
      ['all', 'devices.filterAll'],
      ['online', 'devices.filterOnline'],
      ['attention', 'devices.filterAttention']
    ] as const) {
      const button = node('button', t(key))
      button.type = 'button'
      button.dataset.deviceFilter = value
      button.setAttribute('aria-pressed', String(value === filter.status))
      filters.append(button)
    }
    tools.append(search, filters)
    section.append(tools)
  }
  const items = page.devices.items.filter((device) => {
    const query = filter.query.trim().toLocaleLowerCase(i18n.language)
    const matches =
      !query ||
      [device.name, device.machine_id, ...(device.labels ?? [])].some((value) =>
        value.toLocaleLowerCase(i18n.language).includes(query)
      )
    const online = currentDeviceLink(device, freshness)
    return matches && (filter.status === 'all' || (filter.status === 'online' ? online : !online))
  })
  if (page.devices.items.length === 0) {
    const empty = node('div', '', 'empty')
    const symbol = node('span', '', 'empty-illustration')
    symbol.append(uiIcon('devices'))
    empty.append(symbol, node('h2', t('empty.title')), node('p', t('empty.description'), 'muted'))
    const pair = node('a', '', 'primary-button')
    pair.href = '#view=pairing'
    pair.append(uiIcon('plus'), node('span', t('nav.pairing')))
    empty.append(pair)
    section.append(empty)
  }
  const columns = node('div', '', 'device-columns')
  columns.setAttribute('aria-hidden', 'true')
  for (const key of ['devices.identity', 'devices.health', 'devices.activity', 'devices.record'] as const) {
    columns.append(node('span', t(key)))
  }
  if (page.devices.items.length) {
    section.append(columns)
  }
  const list = node('ul', '', 'device-list')
  list.setAttribute('aria-label', t('devices.heading'))
  for (const device of items) {
    const row = node('li', '', 'device-card')
    const identity = node('div', '', 'device-identity')
    const link = node('a', device.name, 'device-name')
    link.href = routeHref({ machineId: device.machine_id, cursor: null, providerCursor: null })
    const deviceIcon = node('span', '', 'device-icon')
    deviceIcon.append(uiIcon('devices'))
    const deviceCopy = node('div', '', 'device-copy')
    const identifier = node('code', device.machine_id)
    identifier.title = device.machine_id
    deviceCopy.append(link, identifier)
    identity.append(deviceIcon, deviceCopy)
    deviceCopy.append(
      node(
        'p',
        device.labels === null
          ? t('value.noLabelRecord')
          : device.labels.length
            ? device.labels.join(' · ')
            : t('value.noLabels'),
        'muted'
      )
    )
    const health = node('div', '', 'device-health')
    health.append(node('span', t('devices.health'), 'cell-label'), deviceBadges(device, freshness))
    // 平台是设备属性，与连接/认证徽标并列但不参与在线判定；没有平台就不渲染。
    const platform = platformBadge(device, i18n)
    if (platform) {
      health.append(platform)
    }
    const heartbeat = device.connection.verification === 'verified' ? device.connection.value.last_heartbeat_at : null
    const activity = node('div', '', 'device-activity')
    activity.append(node('span', t('devices.activity'), 'cell-label'))
    activity.append(
      node('strong', heartbeat === null ? t('time.noHeartbeat') : i18n.age(heartbeat, freshness.now), 'activity-age')
    )
    activity.append(node('p', t('devices.received', { time: i18n.timestamp(heartbeat) }), 'muted'))
    const observations = node('div', '', 'device-observations')
    const record = node('details', '', 'device-record')
    record.dataset.disclosure = 'device-record-' + device.machine_id
    const summary = node('summary', t('devices.record'))
    record.append(summary)
    record.append(listObservation('devices.observed', device.observed_at, freshness))
    record.append(
      listObservation(
        'devices.connectionObserved',
        device.connection.verification === 'verified' ? device.connection.observed_at : null,
        freshness
      )
    )
    record.append(
      listObservation(
        'devices.authObserved',
        device.authentication.verification === 'verified' ? device.authentication.observed_at : null,
        freshness
      )
    )
    const inspect = node('a', '', 'inspect-device')
    inspect.href = link.href
    inspect.setAttribute('aria-label', t('devices.open', { name: device.name }))
    inspect.append(uiIcon('arrow'))
    observations.append(record, inspect)
    row.append(identity, health, activity, observations)
    list.append(row)
  }
  section.append(list)
  if (page.devices.items.length && !items.length) {
    const empty = node('div', '', 'empty search-empty')
    empty.append(uiIcon('search'), node('h3', t('devices.noMatches')), node('p', t('devices.noMatchesHint'), 'muted'))
    section.append(empty)
  }
  if (page.devices.items.length) {
    section.append(
      node('p', t('devices.results', { shown: items.length, count: page.devices.items.length }), 'list-count')
    )
  }
  if (page.devices.next_cursor !== undefined) {
    const next = node('a', t('devices.next'), 'button-link')
    next.href = routeHref({
      machineId: null,
      cursor: page.devices.next_cursor,
      providerCursor: null,
      section: route.section
    })
    section.append(next)
  }
  return { heading, body: section }
}

/** 已配置 provider 的启停、readiness 与原生观测分别来自共享 DTO。 */
function providerList(page: PageView, device: DeviceSnapshot, freshness: Freshness, management: boolean): HTMLElement {
  const { i18n } = freshness
  const { t } = i18n
  const section = node('section', '', 'providers-section')
  section.append(node('h2', t('providers.heading')))
  if (page.providersProblem) {
    section.append(
      node(
        'p',
        page.providersProblem === 'forbidden' ? t('providers.forbidden') : t('providers.unavailable'),
        'notice warning'
      )
    )
    return section
  }
  if (page.providers.items.length === 0) {
    section.append(node('p', t('providers.empty'), 'empty'))
  }
  for (const provider of page.providers.items) {
    const row = node('article', '', 'provider-card')
    const header = node('header', '', 'provider-heading')
    header.append(node('h3', `${provider.kind === 'luvus' ? 'Luvus' : 'Herdr'} · ${provider.provider_id}`))
    const states = node('div', '', 'provider-states')
    const registryCurrent = current(provider.observed_at, freshness)
    const ready =
      registryCurrent && provider.enabled && provider.readiness === 'ready' && currentDeviceLink(device, freshness)
    states.append(
      badge(
        registryCurrent
          ? provider.enabled
            ? t('providers.enabled')
            : t('providers.disabled')
          : t('providers.enabledHistory', { state: t(provider.enabled ? 'providers.enabled' : 'providers.disabled') }),
        registryCurrent ? 'neutral' : 'warning'
      )
    )
    states.append(
      badge(
        provider.readiness === 'ready' && !ready
          ? t('providers.readyUnknown')
          : t(registryCurrent ? 'providers.readiness' : 'providers.readinessHistory', {
              state: t(readinessNames[provider.readiness])
            }),
        ready ? 'good' : 'warning'
      )
    )
    header.append(states)
    row.append(header)
    row.append(
      facts(
        [
          [t('providers.bindingRevision'), String(provider.binding_revision)],
          [t('providers.configRef'), provider.config_ref ?? t('value.unverified')],
          [t('providers.observed'), observationTime(provider.observed_at, freshness)]
        ],
        'provider-facts'
      )
    )
    const actions = node('div', '', 'actions')
    const disable = node('button', t('provider.disable'))
    disable.type = 'button'
    disable.dataset.providerAction = 'disable'
    disable.dataset.providerId = provider.provider_id
    disable.disabled = !management || !registryCurrent || !current(device.observed_at, freshness) || !provider.enabled
    actions.append(disable)
    row.append(actions)
    section.append(row)
  }
  if (page.providers.next_cursor !== undefined) {
    const next = node('a', t('providers.next'), 'button-link')
    next.href = routeHref({ machineId: device.machine_id, cursor: null, providerCursor: page.providers.next_cursor })
    section.append(next)
  }
  return section
}

/** 详情只使用该 machine_id 的共享快照，未提供的配对/ready/重连信息明确未知。 */
/** 主机卡明确展示连接时来源，不能把历史报告渲染成实时探测或当前在线证明。 */
function hostDetails(device: DeviceSnapshot, freshness: Freshness): HTMLElement | null {
  const host = device.host
  if (!host) {
    return null
  }
  const { i18n } = freshness
  const { t } = i18n
  const section = node('section', '', 'detail-host')
  section.dataset.hostSource = host.source
  section.append(node('h2', t('detail.hostHeading')), node('p', t('detail.hostNote'), 'muted'))
  const family = t(
    host.os.family === 'linux'
      ? 'platform.osLinux'
      : host.os.family === 'darwin'
        ? 'platform.osDarwin'
        : 'platform.osWindows'
  )
  const memoryUnit = host.memory_bytes !== null && host.memory_bytes < 1073741824 ? 'MiB' : 'GiB'
  const memory =
    host.memory_bytes === null
      ? t('value.notRecorded')
      : `${new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 }).format(host.memory_bytes / (memoryUnit === 'MiB' ? 1048576 : 1073741824))} ${memoryUnit}`
  section.append(
    facts([
      [t('detail.platform'), host.os.distribution ? `${family} · ${host.os.distribution}` : family],
      [t('detail.hostArch'), host.arch],
      [t('detail.hostKernel'), host.os.kernel ?? t('value.notRecorded')],
      [t('detail.hostCpus'), host.cpus === null ? t('value.notRecorded') : String(host.cpus)],
      [t('detail.hostMemory'), memory],
      [
        t('detail.hostContainer'),
        host.container === 'unknown'
          ? t('detail.hostUnknown')
          : host.container === 'none'
            ? t('detail.hostNone')
            : host.container
      ],
      [t('detail.hostAgentVersion'), host.agent_version],
      [t('detail.hostReportedAt'), i18n.timestamp(host.reported_at)],
      [t('detail.hostSource'), t('detail.hostHandshake')]
    ])
  )
  if (host.providers.length) {
    const providers = node('div', '', 'host-provider-versions')
    providers.append(node('h3', t('detail.hostProviderVersions')))
    const list = node('ul')
    for (const provider of host.providers) {
      list.append(node('li', `${provider.provider_id} · ${provider.native_version ?? t('value.notRecorded')}`))
    }
    providers.append(list)
    section.append(providers)
  }
  return section
}

function deviceDetail(page: PageView, freshness: Freshness, management = false): PageSection {
  const { i18n } = freshness
  const { t } = i18n
  const section = node('section', '', 'device-detail')
  const heading = node('header', '', 'page-heading')
  const back = node('a', t('detail.back'), 'back-link')
  back.href = '#'
  heading.append(back)
  const device = page.device
  if (!device) {
    heading.append(node('h1', t('detail.unavailable')))
    section.append(node('p', t('detail.invisible'), 'empty'))
    return { heading, body: section }
  }
  const connection = device.connection.verification === 'verified' ? device.connection : null
  const authentication = device.authentication.verification === 'verified' ? device.authentication : null
  heading.append(node('h1', device.name), node('code', device.machine_id))
  const layout = node('div', '', 'detail-layout')
  const registration = node('section', '', 'detail-registration')
  registration.append(node('h2', t('detail.identityHeading')))
  registration.append(
    facts([
      [
        t('detail.labels'),
        device.labels === null ? t('value.notRecorded') : device.labels.join(' · ') || t('value.noLabels')
      ],
      [
        t('detail.revision'),
        device.resource_revision === null ? t('value.notProvided') : String(device.resource_revision)
      ],
      // 平台只在确有值时出现；没有平台就没有这一行，也不写占位说明。
      ...(device.platform === null
        ? []
        : ([[t('detail.platform'), platformLabel(device.platform, i18n)]] as [string, string][]))
    ])
  )
  const connectionSection = node('section', '', 'detail-connection')
  connectionSection.append(node('h2', t('detail.connectionHeading')), deviceBadges(device, freshness))
  connectionSection.append(
    facts([
      [t('detail.epoch'), connection?.value.connection_epoch_ref ?? t('value.noConnection')],
      ...(device.last_seen_at === undefined
        ? []
        : ([
            [
              t('detail.lastSeen'),
              device.last_seen_at === null ? t('value.notRecorded') : i18n.timestamp(device.last_seen_at)
            ]
          ] as [string, string][])),
      ...(device.link_since === undefined
        ? []
        : ([
            [
              t('detail.linkSince'),
              device.link_since === null ? t('value.notRecorded') : i18n.timestamp(device.link_since)
            ]
          ] as [string, string][])),
      [
        t('detail.heartbeat'),
        `${i18n.timestamp(connection?.value.last_heartbeat_at ?? null)} · ${i18n.age(connection?.value.last_heartbeat_at ?? null, freshness.now)}`
      ],
      [
        t('detail.failure'),
        authentication?.value.last_failure
          ? `${i18n.reason(authentication.value.last_failure.reason_code)} · ${i18n.timestamp(authentication.value.last_failure.occurred_at)}`
          : t('value.noFailure')
      ]
    ])
  )
  const observations = node('section', '', 'detail-observation')
  observations.append(node('h2', t('detail.observationHeading')))
  observations.append(
    facts([
      [t('detail.observed'), observationTime(device.observed_at, freshness)],
      [t('detail.connectionObserved'), observationTime(connection?.observed_at ?? null, freshness)],
      [t('detail.authObserved'), observationTime(authentication?.observed_at ?? null, freshness)],
      [t('detail.connectionSource'), connection?.source ?? t('value.unverified')],
      [t('detail.authSource'), authentication?.source ?? t('value.unverified')]
    ])
  )
  layout.append(connectionSection, registration, observations)
  const host = hostDetails(device, freshness)
  if (host) {
    layout.append(host)
  }
  section.append(layout)
  section.append(providerList(page, device, freshness, management), deviceActions(page, freshness, management))
  return { heading, body: section }
}

/** 同一路由按结构同步安全构造的节点，年龄更新不替换正在点击或聚焦的控件。 */
function syncChildren(parent: Node, desired: Node): void {
  const children = Array.from(desired.childNodes)
  for (let index = 0; index < children.length; index++) {
    const next = children[index]!
    const current = parent.childNodes[index]
    if (!current) {
      parent.appendChild(next)
    } else if (current.nodeType === Node.TEXT_NODE && next.nodeType === Node.TEXT_NODE) {
      if (current.nodeValue !== next.nodeValue) {
        current.nodeValue = next.nodeValue
      }
    } else if (
      current instanceof Element &&
      next instanceof Element &&
      current.tagName === next.tagName &&
      (current.tagName !== 'A' || current.getAttribute('href') === next.getAttribute('href'))
    ) {
      for (const attribute of Array.from(current.attributes)) {
        if (!next.hasAttribute(attribute.name)) {
          current.removeAttribute(attribute.name)
        }
      }
      for (const attribute of Array.from(next.attributes)) {
        if (current.getAttribute(attribute.name) !== attribute.value) {
          current.setAttribute(attribute.name, attribute.value)
        }
      }
      syncChildren(current, next)
    } else {
      parent.replaceChild(next, current)
    }
  }
  while (parent.childNodes.length > children.length) {
    parent.removeChild(parent.lastChild!)
  }
}

/** 渲染页面主体；同一路由保留交互节点，换目标时清除旧节点与焦点关联。 */
export function renderPage(
  content: HTMLElement,
  state: ReaderState<PageView>,
  route: PageRoute,
  i18n: Localizer = createLocalizer('zh-CN'),
  management = false,
  filter: DeviceFilter = { query: '', status: 'all' },
  callFilter: CallFilter = 'all'
): void {
  const { t } = i18n
  const focused =
    content.contains(document.activeElement) && document.activeElement instanceof HTMLAnchorElement
      ? document.activeElement.getAttribute('href')
      : null
  const metadataWasOpen = content.querySelector<HTMLDetailsElement>('.gateway-metadata')?.open ?? false
  const metadataHadFocus =
    content.contains(document.activeElement) && document.activeElement?.matches('.gateway-metadata > summary')
  const disclosures = new Map(
    [...content.querySelectorAll<HTMLDetailsElement>('details[data-disclosure]')].map((details) => [
      details.dataset.disclosure,
      details.open
    ])
  )
  const view = document.createDocumentFragment()
  if (state.problem) {
    const message = node('p', t(problemNames[state.problem]), 'notice warning')
    message.setAttribute('role', 'status')
    view.append(message)
  }
  if (!state.snapshot) {
    const empty = node('section', '', `state-panel ${state.pending ? 'loading' : 'unavailable'}`)
    const symbol = node('span', state.pending ? '' : '!', 'state-symbol')
    symbol.setAttribute('aria-hidden', 'true')
    empty.append(symbol, node('h1', state.pending ? t('gateway.pending') : t('gateway.unavailable')))
    empty.append(node('p', t('gateway.authorization'), 'muted'))
    view.append(empty)
  } else {
    const snapshot = state.snapshot
    const page = snapshot.value
    const status = page.status
    const freshness: Freshness = {
      now: snapshot.observedAt + state.ageMs,
      staleAfter: status.stale_after_ms,
      pageStale: state.stale,
      i18n
    }
    const gateway = node('section', '', 'gateway')
    const gatewayHeading = node('div', '', 'gateway-heading')
    gatewayHeading.append(node('h2', t('gateway.heading')))
    gatewayHeading.append(
      badge(
        status.mode === 'active'
          ? state.stale
            ? t('gateway.activeHistory')
            : t('gateway.active')
          : t('gateway.degraded'),
        status.mode === 'active' && !state.stale ? 'good' : 'warning'
      )
    )
    gatewayHeading.append(
      badge(state.stale ? t('reader.stale') : t('gateway.fresh'), state.stale ? 'warning' : 'neutral')
    )
    const mark = node('span', '', 'gateway-symbol')
    mark.append(uiIcon('gateway'))
    gatewayHeading.prepend(mark)
    const components = node('div', '', 'gateway-components')
    for (const [name, key] of [
      ['store', 'overview.store'],
      ['transport', 'overview.transport'],
      ['native', 'overview.native']
    ] as const) {
      const item = node('div', '', 'component-item')
      item.append(
        node('span', t(key), 'muted'),
        badge(
          t(`overview.${status.components[name]}`),
          status.components[name] === 'available' && !state.stale ? 'good' : 'neutral'
        )
      )
      components.append(item)
    }
    gateway.append(gatewayHeading, components)
    const metadata = node('details', '', 'gateway-metadata')
    metadata.open = metadataWasOpen
    metadata.append(node('summary', t('gateway.metadata')))
    metadata.append(
      facts([
        [t('gateway.generation'), status.recovery_generation],
        [t('gateway.policy'), status.policy_revision]
      ])
    )
    metadata.append(
      facts(
        [
          [t('gateway.listener'), t('gateway.listenerUnknown')],
          [
            t('gateway.authentication'),
            snapshot.sessionExpiresAt === null
              ? t('gateway.sessionUnknown')
              : t('gateway.sessionUntil', { time: i18n.timestamp(snapshot.sessionExpiresAt) })
          ],
          [
            t('gateway.components'),
            `${t(componentNames[status.components.store])} / ${t(componentNames[status.components.transport])} / ${t(componentNames[status.components.native])}`
          ],
          [
            t('gateway.observed'),
            t('time.observed', {
              time: i18n.timestamp(snapshot.observedAt),
              age: i18n.age(snapshot.observedAt, snapshot.observedAt + state.ageMs),
              expired: ''
            })
          ]
        ],
        'gateway-facts'
      )
    )
    gateway.append(metadata)
    if (status.mode !== 'active') {
      gateway.append(node('p', t('gateway.degradedNote'), 'notice warning'))
    }
    const section =
      route.machineId !== null
        ? deviceDetail(page, freshness, management && status.mode === 'active' && !state.stale)
        : route.section === 'pairing' || route.section === 'connect'
          ? guidePage(route.section, i18n, management)
          : route.section === 'devices'
            ? deviceList(page, freshness, route, filter)
            : route.section === 'calls'
              ? callsPage(page, freshness, route, callFilter)
              : overviewPage(page, freshness)
    view.append(section.heading)
    if (route.section === 'pairing' && (state.stale || status.mode !== 'active')) {
      view.append(node('p', t(state.stale ? 'reader.stale' : 'gateway.degradedNote'), 'notice warning'))
    }
    if (route.machineId === null && route.section === undefined) {
      view.append(overviewMetrics(page, freshness), gateway)
    } else if (status.mode !== 'active' && route.section !== 'pairing') {
      view.append(node('p', t('gateway.degradedNote'), 'notice warning'))
    }
    view.append(section.body)
  }
  const identity = routeHref(route)
  if (content.dataset.route === identity) {
    for (const details of view.querySelectorAll<HTMLDetailsElement>('details[data-disclosure]')) {
      details.open = disclosures.get(details.dataset.disclosure) ?? false
    }
    syncChildren(content, view)
  } else {
    content.replaceChildren(view)
    content.dataset.route = identity
  }
  if (focused !== null) {
    for (const link of content.querySelectorAll('a')) {
      if (link.getAttribute('href') === focused) {
        link.focus({ preventScroll: true })
        break
      }
    }
  } else if (metadataHadFocus) {
    content.querySelector<HTMLElement>('.gateway-metadata > summary')?.focus({ preventScroll: true })
  }
}
