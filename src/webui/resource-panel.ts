/** Everyday homelab management: one form to create and one confirmation to delete. */
import type { Localizer } from './i18n.js'
import type { PageRoute } from './view.js'
import { copyControl } from './clipboard.js'
import { ResourceError, type ResourceTransport, type ResourceOperation } from './resource-client.js'

type Token = { principal: string; token: string | null; expires_at: number; scope: string }
type PairingCode = {
  code_id: string
  machine_id: string
  name: string
  created_at: number
  status: 'unused' | 'used' | 'revoked' | 'failed'
  used_at: number | null
  code?: string
}
type CreatedPairingCode = { code: string; name: string; device_port: number }
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag)
  element.textContent = text
  element.className = className
  return element
}
export function createResourcePanel(options: {
  transport: ResourceTransport
  committed(machine?: string, pairing?: string): void
  authorizationLost(problem: 'forbidden' | 'unauthenticated'): void
}) {
  const region = node('section', '', 'resource-panel')
  const feedback = node('p', '', 'resource-feedback')
  feedback.setAttribute('role', 'status')
  let i18n: Localizer
  let key = ''
  let active = false
  let pending = false
  let controller = new AbortController()
  let data:
    | { resource?: string; next_cursor?: number | null; device_port?: number; items: (Token | PairingCode)[] }
    | undefined
  let tokenName = ''
  let tokenDays = '365'
  let codeName = ''
  let created: CreatedPairingCode | undefined
  let version = 0
  let route: PageRoute
  let language = ''
  function button(label: string, action: () => void, danger = false) {
    const result = node('button', label, danger ? 'danger-button' : '')
    result.type = 'button'
    result.disabled = pending
    result.addEventListener('click', action)
    return result
  }
  async function request(operation: ResourceOperation, args: Record<string, unknown>): Promise<unknown> {
    return options.transport(operation, args, controller.signal)
  }
  function failure(error: unknown) {
    if (error instanceof ResourceError && (error.code === 'forbidden' || error.code === 'unauthenticated')) {
      clear()
      options.authorizationLost(error.code)
      return
    }
    feedback.textContent = i18n.t(
      error instanceof ResourceError && error.code === 'invalid_arguments' ? 'resources.invalid' : 'resources.failed'
    )
  }
  async function refresh() {
    const generation = ++version
    controller.abort()
    controller = new AbortController()
    pending = true
    feedback.textContent = i18n.t('resources.loading')
    try {
      const value = (await request(
        key === 'connect' ? 'tokens_list' : 'pairing_codes_list',
        key === 'connect' ? {} : {}
      )) as typeof data
      if (generation !== version || !active) {
        return
      }
      if (!value || !Array.isArray(value.items)) {
        throw new Error('invalid_reply')
      }
      data = value
      feedback.textContent = ''
    } catch (error) {
      if (generation === version && active) {
        failure(error)
      }
    } finally {
      if (generation === version && active) {
        pending = false
        render()
      }
    }
  }
  async function mutate(operation: ResourceOperation, args: Record<string, unknown>) {
    if (pending || !active) {
      return
    }
    const generation = version
    pending = true
    feedback.textContent = i18n.t('resources.saving')
    render()
    try {
      const reply =
        operation === 'pairing_codes_create'
          ? ((await request(operation, args)) as CreatedPairingCode)
          : ((await request(operation, args)) as null)
      if (operation === 'pairing_codes_create' && reply && typeof reply.code === 'string') {
        created = reply
      }
      if (generation !== version || !active) {
        return
      }
      feedback.textContent = i18n.t('resources.saved')
      if (operation === 'tokens_create') {
        tokenName = ''
        tokenDays = '365'
      }
      if (operation === 'pairing_codes_create') {
        codeName = ''
      }
      if (operation === 'devices_delete') {
        options.committed(route.machineId ?? undefined)
      } else {
        await refresh()
        if (operation === 'pairings_delete') {
          options.committed(undefined, args.pairing_id as string)
        }
      }
    } catch (error) {
      if (generation === version && active) {
        failure(error)
      }
    } finally {
      if (generation === version && active) {
        pending = false
        render()
      }
    }
  }
  function remove(operation: ResourceOperation, args: Record<string, unknown>, message: string) {
    if (window.confirm(message)) {
      void mutate(operation, args)
    }
  }
  function render() {
    if (!active) {
      return
    }
    const { t } = i18n
    const body = node('div', '', 'resource-body')
    if (key === 'device') {
      const card = node('article', '', 'resource-delete-card')
      card.append(
        node('div', t('resources.deleteDeviceNote'), 'muted'),
        button(
          t('resources.deleteDevice'),
          () => remove('devices_delete', { machine_id: route.machineId }, t('resources.confirmDevice')),
          true
        )
      )
      body.append(card)
    } else {
      const heading = node('div', '', 'section-heading')
      heading.append(
        node('h2', t(key === 'connect' ? 'resources.tokens' : 'resources.pairingCodes')),
        button(t('action.refresh'), () => {
          void refresh()
        })
      )
      body.append(heading)
      if (key === 'connect') {
        const form = node('form', '', 'token-create-form')
        const nameLabel = node('label', t('resources.name'))
        const name = node('input')
        name.name = 'token-name'
        name.required = true
        name.pattern = '[A-Za-z0-9_-]{1,128}'
        name.maxLength = 128
        name.placeholder = 'my-client'
        name.disabled = pending
        name.value = tokenName
        name.addEventListener('input', () => {
          tokenName = name.value
        })
        nameLabel.append(name)
        const daysLabel = node('label', t('resources.expiry'))
        const days = node('select')
        days.name = 'token-days'
        days.disabled = pending
        for (const value of [365, 90, 30, 7]) {
          const option = node('option', t('resources.days', { count: value }))
          option.value = String(value)
          days.append(option)
        }
        days.value = tokenDays
        days.addEventListener('change', () => {
          tokenDays = days.value
        })
        daysLabel.append(days)
        const submit = node('button', t('resources.create'), 'primary-button')
        submit.type = 'submit'
        submit.disabled = pending
        form.append(nameLabel, daysLabel, submit)
        form.addEventListener('submit', (event) => {
          event.preventDefault()
          void mutate('tokens_create', { principal: name.value.trim(), days: Number(days.value) })
        })
        body.append(node('p', t('resources.tokenNote'), 'muted'), form)
        if (data?.resource) {
          const endpoint = node('div', '', 'mcp-endpoint')
          endpoint.append(
            node('span', t('resources.endpoint')),
            node('code', data.resource),
            copyControl(data.resource, t('copy.action'))
          )
          body.append(endpoint, node('p', t('resources.endpointNote'), 'muted'))
        }
        for (const item of data?.items ?? []) {
          const token = item as Token
          const card = node('article', '', 'token-card')
          card.dataset.tokenPrincipal = token.principal
          const summary = node('div', '', 'token-summary')
          summary.append(
            node('h3', token.principal),
            node('span', t(token.expires_at > Date.now() ? 'resources.active' : 'resources.expired'), 'badge'),
            node('span', t('resources.expiresAt', { time: i18n.timestamp(token.expires_at) }), 'muted')
          )
          const controls = node('div', '', 'token-controls')
          if (token.token) {
            const value = node('input')
            value.type = 'password'
            value.value = token.token
            value.readOnly = true
            value.setAttribute('aria-label', token.principal + ' Token')
            value.autocomplete = 'off'
            value.spellcheck = false
            const toggle = button(t('resources.show'), () => {
              const hidden = value.type === 'password'
              value.type = hidden ? 'text' : 'password'
              toggle.textContent = t(hidden ? 'resources.hide' : 'resources.show')
            })
            controls.append(value, toggle, copyControl(token.token, t('copy.action')))
          } else {
            controls.append(
              node('span', t('resources.legacy'), 'muted'),
              button(t('resources.reissue'), () => {
                if (window.confirm(t('resources.confirmReissue'))) {
                  void mutate('tokens_rotate', { principal: token.principal })
                }
              })
            )
          }
          controls.append(
            button(
              t('resources.delete'),
              () =>
                remove(
                  'tokens_delete',
                  { principal: token.principal },
                  t('resources.confirmToken', { name: token.principal })
                ),
              true
            )
          )
          card.append(summary, controls)
          body.append(card)
        }
      } else {
        const host = typeof location === 'undefined' ? '127.0.0.1' : location.hostname
        const form = node('form', '', 'token-create-form')
        const nameLabel = node('label', t('resources.name'))
        const name = node('input')
        name.name = 'code-name'
        name.pattern = '[A-Za-z0-9._-]{0,63}'
        name.maxLength = 63
        name.placeholder = 'workstation'
        name.disabled = pending
        name.value = codeName
        name.addEventListener('input', () => {
          codeName = name.value
        })
        nameLabel.append(name)
        const submit = node('button', t('resources.createCode'), 'primary-button')
        submit.type = 'submit'
        submit.disabled = pending
        form.append(nameLabel, submit)
        form.addEventListener('submit', (event) => {
          event.preventDefault()
          void mutate('pairing_codes_create', name.value.trim() ? { name: name.value.trim() } : {})
        })
        body.append(node('p', t('resources.codesNote'), 'muted'), form)
        if (created) {
          const command = 'rovloom connector --join ws://' + host + ':' + created.device_port + '#' + created.code
          const card = node('article', '', 'pairing-record code-created')
          const details = node('div')
          details.append(node('h3', created.name), node('p', t('resources.codeCreatedNote'), 'muted'))
          const block = node('div', '', 'command-snippet')
          block.append(node('code', command), copyControl(command, t('copy.action')))
          card.append(details, block)
          body.append(card)
          created = undefined
        }
        const port = data?.device_port ?? 9443
        for (const item of data?.items ?? []) {
          const entry = item as PairingCode
          const card = node('article', '', 'pairing-record')
          const details = node('div')
          const label = t(('resources.code_' + entry.status) as 'resources.code_unused')
          details.append(
            node('h3', entry.name),
            node('code', entry.machine_id),
            node(
              'p',
              label +
                ' · ' +
                i18n.timestamp(entry.created_at) +
                (entry.used_at ? ' · ' + i18n.timestamp(entry.used_at) : ''),
              'muted'
            )
          )
          card.append(details)
          if (entry.status === 'unused' && entry.code) {
            const command = 'rovloom connector --join ws://' + host + ':' + port + '#' + entry.code
            const block = node('div', '', 'command-snippet')
            block.append(node('code', command), copyControl(command, t('copy.action')))
            card.append(block)
            card.append(
              button(
                t('resources.revokeCode'),
                () => remove('pairing_codes_revoke', { code_id: entry.code_id }, t('resources.confirmRevokeCode')),
                true
              )
            )
          }
          body.append(card)
        }
      }
      if (data?.items.length === 0 && key === 'connect') {
        body.append(node('p', t('resources.emptyTokens'), 'empty'))
      }
    }
    region.replaceChildren(body, feedback)
  }
  function clear() {
    active = false
    key = ''
    data = undefined
    tokenName = ''
    tokenDays = '365'
    codeName = ''
    created = undefined
    version++
    controller.abort()
    pending = false
    region.replaceChildren()
    region.hidden = true
  }
  return {
    region,
    clear,
    dispose: clear,
    refresh() {
      if (active && key !== 'device') {
        void refresh()
      }
    },
    update(next: PageRoute, localizer: Localizer, enabled: boolean) {
      const nextKey = next.machineId
        ? 'device'
        : next.section === 'connect' || next.section === 'pairing'
          ? next.section
          : ''
      if (!enabled || !nextKey) {
        clear()
        return
      }
      const changed = key !== nextKey || route?.machineId !== next.machineId
      const translated = language !== localizer.language
      route = next
      i18n = localizer
      language = localizer.language
      active = true
      region.hidden = false
      if (changed) {
        key = nextKey
        data = undefined
        created = undefined
        version++
        controller.abort()
        controller = new AbortController()
        pending = false
        render()
        if (key !== 'device') {
          void refresh()
        }
      } else if (translated) {
        render()
      }
    }
  }
}
