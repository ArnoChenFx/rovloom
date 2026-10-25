/** 挂载内置管理页面并管理导航/可见性资源；读取适配层不接收浏览器自报管理员身份。 */
import { createSnapshotReader, ReadError, type ReadClock, type SnapshotReader, type TimedSnapshot } from './reader.js'
import { parseRoute, renderPage, type PageRoute, type PageView, type DeviceFilter } from './view.js'
import { checkPage } from './validate.js'
import type { ReaderState } from './reader.js'
import { createLocalizer } from './i18n.js'
import { createUiPreferences, type UiPreferences } from './preferences.js'
import { createPreferenceControl } from './preference-control.js'
import { createDeviceActions } from './device-actions.js'
import { uiIcon } from './icons.js'
import { createResourcePanel } from './resource-panel.js'
import type { ResourceTransport } from './resource-client.js'
import { copyText } from './clipboard.js'
import type { ManagementWriteTransport } from './write-contract.js'

/** 接入共享管理读取后的页面投影函数；不是授权接口，不能代替每次后端鉴权。 */
export type PageRead = (route: Readonly<PageRoute>, signal: AbortSignal) => Promise<TimedSnapshot<PageView>>

/** 创建固定的页面节点，不把任何身份、秘密或设备输入写进 HTML 字符串。 */
function element<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag)
  result.textContent = text
  result.className = className
  return result
}

/** 默认入口在共享读取/认证接线完成前明确不可用，永不回退到测试 fixture。 */
export async function unavailableRead(): Promise<never> {
  throw new ReadError('unavailable')
}

/** 建立页面壳、手动刷新/取消与单路由 reader，返回幂等卸载函数。 */
export function mountWebUi(
  root: HTMLElement,
  read: PageRead = unavailableRead,
  clock?: ReadClock,
  management?: ManagementWriteTransport,
  resources?: ResourceTransport
): () => void {
  const sidebar = element('aside', '', 'sidebar')
  const brand = element('a', '', 'brand')
  brand.href = '#'
  const logo = element('img', '', 'brand-logo')
  logo.src = './rovloom-logo.png'
  logo.alt = 'Rovloom'
  logo.width = 180
  logo.height = 60
  brand.append(logo)
  const sidebarCaption = element('p', '', 'sidebar-caption')
  const navHeading = element('p', '', 'nav-heading')
  const navigation = element('nav', '', 'sidebar-nav')
  const navLinks = (['overview', 'devices', 'pairing', 'connect'] as const).map((section) => {
    const link = element('a', '', 'nav-link')
    link.href = section === 'overview' ? '#' : '#view=' + section
    const label = element('span')
    link.append(uiIcon(section), label)
    navigation.append(link)
    return { section, link, label }
  })
  const resourceHeading = element('p', '', 'nav-heading resource-heading')
  const docs = element('a', '', 'nav-link docs-link')
  docs.target = '_blank'
  docs.rel = 'noopener noreferrer'
  const docsLabel = element('span')
  docs.append(uiIcon('book'), docsLabel)
  const sidebarStatus = element('div', '', 'sidebar-status')
  const statusIcon = element('span', '', 'sidebar-gateway-icon')
  statusIcon.append(uiIcon('gateway'))
  const statusCopy = element('div')
  const statusLabel = element('strong', 'Gateway')
  const statusValue = element('span', '', 'sidebar-status-value')
  statusCopy.append(statusLabel, statusValue)
  sidebarStatus.append(statusIcon, statusCopy)
  sidebar.append(brand, sidebarCaption, navHeading, navigation, resourceHeading, docs, sidebarStatus)
  const workspace = element('div', '', 'workspace')
  const header = element('header', '', 'topbar')
  const headerLabel = element('div', '', 'header-label')
  headerLabel.append(uiIcon('overview'))
  const title = element('span', '', 'brand-context')
  headerLabel.append(title)
  const preferencesBar = element('div', '', 'preferences')
  const commandbar = element('div', '', 'commandbar')
  commandbar.setAttribute('role', 'toolbar')
  const toolbar = element('div', '', 'toolbar')
  const refresh = element('button', '')
  refresh.type = 'button'
  const cancel = element('button', '')
  cancel.type = 'button'
  const indicator = element('span', '', 'read-indicator')
  indicator.setAttribute('role', 'status')
  indicator.setAttribute('aria-live', 'polite')
  const content = element('main', '', 'content')
  content.id = 'management-content'
  content.tabIndex = -1
  refresh.setAttribute('aria-controls', content.id)
  cancel.setAttribute('aria-controls', content.id)
  const language = createPreferenceControl('language', (value) => preferences.setLanguage(value))
  const theme = createPreferenceControl('theme', (value) => preferences.setTheme(value))
  preferencesBar.append(language.root, theme.root)
  toolbar.append(indicator, refresh, cancel)
  commandbar.append(toolbar)
  const headerActions = element('div', '', 'topbar-actions')
  headerActions.append(commandbar, preferencesBar)
  header.append(headerLabel, headerActions)
  const skip = element('a', '', 'skip-link')
  skip.href = '#management-content'
  const footer = element('footer', '', 'muted')
  const copyFeedback = element('span', '', 'visually-hidden')
  copyFeedback.setAttribute('role', 'status')
  copyFeedback.setAttribute('aria-live', 'polite')
  workspace.append(header, content, copyFeedback, footer)
  root.replaceChildren(skip, sidebar, workspace)
  let route = parseRoute(location.hash)
  let filter: DeviceFilter = { query: '', status: 'all' }
  let reader: SnapshotReader<PageView>
  let disposed = false
  let i18n = createLocalizer('en')
  const actions = management
    ? createDeviceActions({
        transport: management,
        /** 持久提交后销毁旧在途读取，再取当前目标；迟到旧快照不能覆盖真实变更。 */
        committed(machineId) {
          if (!disposed && (route.machineId === machineId || route.machineId === null)) {
            reader.dispose()
            start()
          }
        },
        /** 写请求发现会话/权限失效时同样清空读数据，不能让旧页面继续操作。 */
        authorizationLost(problem) {
          if (disposed) {
            return
          }
          // 这里不能用 dispose：它会永久封闭 reader，之后「刷新」与重新可见都无法再读取，
          // 而认证失败正是最需要手动重试的场景。reset 清空旧数据并停在可重试状态。
          reader.reset(problem)
          actions?.clear()
        }
      })
    : undefined
  if (actions) {
    footer.before(actions.region)
  }
  const resourcePanel = resources
    ? createResourcePanel({
        transport: resources,
        committed(machine) {
          if (machine) {
            location.hash = '#view=devices'
          }
        },
        authorizationLost(problem) {
          if (disposed) {
            return
          }
          // 与设备操作同一处理：保留 reader，使用户仍可手动刷新重试。
          reader.reset(problem)
          actions?.clear()
        }
      })
    : undefined
  if (resourcePanel) {
    footer.before(resourcePanel.region)
  }

  /** 稳定工具栏与当前快照重新本地化；不替换 reader、路由、等待信号或时间锚点。 */
  function paint(state: ReaderState<PageView>, current: PageRoute): void {
    // 认证类失败后 reader 允许重试（cookie 会话恢复后无需整页刷新），按钮必须同步可用，
    // 否则用户停在当前页面时没有触发那条恢复路径的入口。
    refresh.disabled = state.pending
    cancel.disabled = !state.pending
    indicator.textContent = i18n.t(
      state.pending
        ? 'reader.pending'
        : state.snapshot
          ? state.stale
            ? 'reader.stale'
            : 'reader.snapshot'
          : 'reader.empty'
    )
    content.setAttribute('aria-busy', String(state.pending))
    indicator.dataset.state = state.pending ? 'pending' : state.stale ? 'stale' : state.snapshot ? 'current' : 'empty'
    if (['unauthenticated', 'forbidden', 'not_found'].includes(state.problem ?? '')) {
      actions?.clear()
    }
    actions?.update(
      i18n,
      !!state.snapshot && !state.stale && state.snapshot.value.status.mode === 'active',
      state.snapshot ? state.snapshot.observedAt + state.ageMs : undefined
    )
    const section = current.machineId ? 'devices' : (current.section ?? 'overview')
    content.dataset.section = section
    for (const item of navLinks) {
      if (item.section === section) {
        item.link.setAttribute('aria-current', 'page')
      } else {
        item.link.removeAttribute('aria-current')
      }
    }
    title.textContent = i18n.t(('nav.' + section) as 'nav.overview' | 'nav.devices' | 'nav.pairing' | 'nav.connect')
    const active = !!state.snapshot && !state.stale && state.snapshot.value.status.mode === 'active'
    sidebarStatus.dataset.state = active ? 'current' : 'unknown'
    statusValue.textContent = i18n.t(
      active ? 'gateway.active' : state.snapshot ? (state.stale ? 'reader.stale' : 'gateway.degraded') : 'reader.empty'
    )
    renderPage(content, state, current, i18n, !!actions, filter)
    const authorized = active && !['unauthenticated', 'forbidden', 'not_found'].includes(state.problem ?? '')
    resourcePanel?.update(current, i18n, authorized)
    if (resourcePanel && section === 'connect' && authorized) {
      const guide = content.querySelector<HTMLElement>('.connection-guide')
      if (guide) {
        guide.hidden = true
      }
    }
  }

  /** 偏好仅改变文案与 CSS 主题；标题、语言和无障碍名称随词典同步。 */
  function applyPreferences(state: UiPreferences): void {
    const languageChanged = i18n.language !== state.language
    if (languageChanged) {
      i18n = createLocalizer(state.language)
    }
    const { t } = i18n
    document.documentElement.lang = state.language
    document.documentElement.dataset.theme = state.theme
    document.title = t('app.title')
    brand.setAttribute('aria-label', t('app.navigation'))
    title.textContent = t('nav.console')
    sidebarCaption.textContent = t('app.console')
    navHeading.textContent = t('nav.workspace')
    resourceHeading.textContent = t('nav.resources')
    navigation.setAttribute('aria-label', t('app.subtitle'))
    docsLabel.textContent = t('nav.docs')
    docs.href = `https://github.com/ArnoChenFx/rovloom/blob/main/docs/QUICK-START${state.language === 'zh-CN' ? '-zh' : ''}.md`
    for (const item of navLinks) {
      item.label.textContent = t(
        ('nav.' + item.section) as 'nav.overview' | 'nav.devices' | 'nav.pairing' | 'nav.connect'
      )
    }
    commandbar.setAttribute('aria-label', t('app.subtitle'))
    refresh.textContent = t('action.refresh')
    cancel.textContent = t('action.cancel')
    skip.textContent = t('app.skip')
    footer.textContent = t(actions ? 'app.managedFooter' : 'app.footer')
    language.update(i18n, state.language)
    theme.update(i18n, state.theme)
    if (languageChanged && reader) {
      paint(reader.state(), route)
    }
  }
  const preferences = createUiPreferences(applyPreferences)
  applyPreferences(preferences.state())

  /** 每个路由拥有独立 reader，拒绝旧机器或旧分页响应写入新页面。 */
  function start(): void {
    const current = { ...route }
    reader = createSnapshotReader(
      /** 调用已有授权读取的展示适配层；不传 principal、credential 或 approved 标志。 */
      async (signal) => checkPage(await read(current, signal), current),
      /** 读取生命周期更新使用当前词典，不续期或改变授权结果。 */
      (state) => paint(state, current),
      clock
    )
    if (document.visibilityState === 'hidden') {
      reader.visible(false)
      paint(reader.state(), current)
    } else {
      void reader.refresh()
    }
  }

  /** 跳转主内容时保留当前机器路由，避免刷新后丢失目标。 */
  function skipContent(event: MouseEvent): void {
    event.preventDefault()
    content.focus()
  }

  /** 手动刷新只读快照，重复点击由 reader 合并。 */
  function refreshPage(): void {
    resourcePanel?.refresh()
    void reader.refresh()
  }

  /** 取消本次读取不会发起设备操作，也不等待迟到响应。 */
  function cancelRead(): void {
    reader.cancel()
  }

  /** 只接收实际启用的设备入口和当前读模型目标，不消费浏览器自报身份。 */
  function deviceAction(event: MouseEvent): void {
    const button =
      event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>('button[data-device-action],button[data-provider-action]')
        : null
    if (!actions || !button || button.disabled || !content.contains(button)) {
      return
    }
    const snapshot = reader.state()
    const page = snapshot.snapshot?.value
    if (!page || snapshot.stale || page.status.mode !== 'active') {
      return
    }
    const device = page.device
    if (!device || route.machineId !== device.machine_id) {
      return
    }
    if (button.dataset.providerAction === 'disable') {
      const provider = page.providers.items.find(
        /** 仅从当前已授权实例页选取目标。 */ (item) => item.provider_id === button.dataset.providerId
      )
      if (provider?.enabled) {
        actions.open(
          {
            action: 'provider_disable',
            machine_id: device.machine_id,
            provider_id: provider.provider_id,
            kind: provider.kind,
            expected_binding_revision: provider.binding_revision
          },
          button
        )
      }
      return
    }
    const action = button.dataset.deviceAction
    if (action === 'device_rename') {
      actions.open({ action, machine_id: device.machine_id, name: device.name }, button)
    }
    if (action === 'device_disconnect' || action === 'device_revoke') {
      actions.open({ action, machine_id: device.machine_id }, button)
    }
  }

  /** 仅筛选当前已授权列表页；不构造新的设备读取或写入。 */
  function searchDevices(event: Event): void {
    if (event.target instanceof HTMLInputElement && event.target.name === 'device-search') {
      filter.query = event.target.value
      paint(reader.state(), route)
    }
  }

  function filterDevices(event: MouseEvent): void {
    const button =
      event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-device-filter]') : null
    const selected = button?.dataset.deviceFilter
    if (selected === 'all' || selected === 'online' || selected === 'attention') {
      filter.status = selected
      paint(reader.state(), route)
    }
  }

  /** 复制仅由明确用户点击触发，结果未知时不宣称成功。 */
  async function copy(event: MouseEvent): Promise<void> {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button[data-copy]') : null
    if (!button || button.disabled || !root.contains(button)) {
      return
    }
    const value = button.dataset.copy
    if (value === undefined) {
      return
    }
    copyFeedback.textContent = ''
    const success = await copyText(value)
    if (!disposed) {
      copyFeedback.textContent = i18n.t(success ? 'copy.done' : 'copy.failed')
      button.title = copyFeedback.textContent
      button.dataset.copied = String(success)
    }
  }

  /** 哈希导航、后退与分页都先清理旧路由资源，再获取新目标。 */
  function navigate(): void {
    filter = { query: '', status: 'all' }
    actions?.suspend()
    if (location.hash === '#management-content') {
      content.focus()
      return
    }
    reader.dispose()
    route = parseRoute(location.hash)
    start()
    content.focus({ preventScroll: true })
  }

  /** 后台暂停轮询并取消在途读取，前台立即按原页面范围刷新。 */
  function visibility(): void {
    if (document.visibilityState === 'hidden') {
      actions?.suspend()
    }
    reader.visible(document.visibilityState !== 'hidden')
  }

  /** BFCache 恢复时新建 reader，清除先前会话的所有状态。 */
  function show(event: PageTransitionEvent): void {
    if (event.persisted) {
      reader.dispose()
      preferences.sync()
      route = parseRoute(location.hash)
      start()
    }
  }

  /** 页面离开时销毁在途请求及定时器，后退不会重复任何写入。 */
  function hide(): void {
    actions?.suspend()
    reader.dispose()
    resourcePanel?.clear()
    content.replaceChildren()
  }

  /** 永久卸载移除所有宿主监听器并清空 DOM/内存。 */
  function dispose(): void {
    if (disposed) {
      return
    }
    disposed = true
    reader.dispose()
    resourcePanel?.dispose()
    actions?.dispose()
    content.removeEventListener('click', deviceAction)
    content.removeEventListener('click', filterDevices)
    content.removeEventListener('input', searchDevices)
    root.removeEventListener('click', copy)
    skip.removeEventListener('click', skipContent)
    refresh.removeEventListener('click', refreshPage)
    cancel.removeEventListener('click', cancelRead)
    language.dispose()
    theme.dispose()
    preferences.dispose()
    window.removeEventListener('hashchange', navigate)
    document.removeEventListener('visibilitychange', visibility)
    window.removeEventListener('pageshow', show)
    window.removeEventListener('pagehide', hide)
    root.replaceChildren()
  }

  skip.addEventListener('click', skipContent)
  refresh.addEventListener('click', refreshPage)
  cancel.addEventListener('click', cancelRead)
  content.addEventListener('click', deviceAction)
  content.addEventListener('click', filterDevices)
  content.addEventListener('input', searchDevices)
  root.addEventListener('click', copy)
  window.addEventListener('hashchange', navigate)
  document.addEventListener('visibilitychange', visibility)
  window.addEventListener('pageshow', show)
  window.addEventListener('pagehide', hide)
  start()
  return dispose
}
