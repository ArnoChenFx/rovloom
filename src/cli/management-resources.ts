/** Simple authenticated Dashboard CRUD; tokens remain in the Gateway's private state directory. */
import { GatewayError } from '../contracts.js'
import type { Store } from '../store.js'
import type { ManagementWriteHttpOptions } from '../admin/write-http.js'
import { ManagementServiceError } from '../admin/write-service.js'
import { CliError, type GatewayConfig } from './config.js'
import { isAdminPlaceholder } from './admin-registry.js'
import type { PairingCodes } from './pairing-codes.js'
import { runtimeReference, readRuntimeJson } from './runtime-files.js'
import { readSetupJson, setupFileStamp, writeSetupFile } from './setup-files.js'
import {
  createGatewayCaller,
  deviceScopeView,
  digestToken,
  parseRegistry,
  REGISTRY_MAX_BYTES,
  revokeCaller,
  rotateCaller,
  setDeviceScope
} from './token-registry.js'
import { boundedJson, fields, id, LIMITS, object } from '../wire/index.js'

type Resources = NonNullable<ManagementWriteHttpOptions['resources']>
export function createManagementResources(options: {
  config: GatewayConfig
  store: Store
  authorize(identity: Parameters<Resources['execute']>[2]): boolean
  disconnect(machine: string): void
  /** 一机一码账本：生成/作废/列表；未注入时配对码操作明确拒绝。 */
  codes?: PairingCodes
}): Resources {
  const path = runtimeReference(options.config.state_dir, options.config.authentication_ref)
  return {
    execute(operation, input, identity, signal) {
      if (signal.aborted || !options.authorize(identity)) {
        throw new ManagementServiceError('forbidden')
      }
      try {
        const args = object(input)
        const actor = identity.caller.principal_id
        if (operation === 'pairing_codes_list') {
          if (!options.codes) {
            throw new ManagementServiceError('backend_unavailable')
          }
          const codes = options.codes
          fields(args, [])
          const items = codes.list()
          return {
            device_port: options.config.device_port,
            items: items.map((entry) => ({
              code_id: entry.code_id,
              machine_id: entry.machine_id,
              name: entry.name,
              created_at: entry.created_at,
              status: entry.status,
              used_at: entry.used_at ?? null,
              // 未使用码附完整值（面板拼接加入命令）；终结条目只保留对账字段。
              ...(entry.status === 'unused' && entry.secret
                ? { code: entry.machine_id + '.' + entry.code_id + '.' + entry.secret }
                : {})
            }))
          }
        }
        if (operation === 'pairing_codes_create') {
          if (!options.codes) {
            throw new ManagementServiceError('backend_unavailable')
          }
          const codes = options.codes
          fields(args, [], ['name'])
          if (args.name !== undefined && (typeof args.name !== 'string' || args.name.length > 63)) {
            throw new ManagementServiceError('invalid_arguments')
          }
          const issued = codes.create(args.name)
          return {
            code: issued.code,
            machine_id: issued.entry.machine_id,
            name: issued.entry.name,
            created_at: issued.entry.created_at,
            device_port: options.config.device_port
          }
        }
        if (operation === 'pairing_codes_revoke') {
          if (!options.codes) {
            throw new ManagementServiceError('backend_unavailable')
          }
          fields(args, ['code_id'])
          id(args.code_id)
          options.codes.revoke(args.code_id as string)
          return { revoked: true }
        }
        if (operation === 'pairings_list') {
          fields(args, [], ['cursor'])
          const cursor = args.cursor ?? 0
          if (typeof cursor !== 'number' || !Number.isSafeInteger(cursor) || cursor < 0 || cursor > 1_000_000) {
            throw new ManagementServiceError('invalid_arguments')
          }
          const items = options.store.listPairings(cursor)
          return { items: items.slice(0, 50), next_cursor: items.length > 50 ? cursor + 50 : null }
        }
        if (operation === 'pairings_delete') {
          fields(args, ['pairing_id'])
          id(args.pairing_id)
          const machine = options.store.deletePairing(args.pairing_id as string, actor)
          if (machine) {
            options.disconnect(machine)
          }
          return { deleted: true }
        }
        if (operation === 'devices_delete') {
          fields(args, ['machine_id'])
          id(args.machine_id)
          const machine = args.machine_id as string
          options.store.machine(machine)
          // Remove persisted runtime bindings first, so a restart cannot reload a deleted device.
          const providersPath = runtimeReference(options.config.state_dir, 'providers')
          const previous = readSetupJson(providersPath, 1_048_576)
          if (previous !== undefined) {
            const stamp = setupFileStamp(providersPath)
            const document = object(previous)
            if (!Array.isArray(document.providers)) {
              throw new CliError('invalid_config')
            }
            const refs = options.store
              .resources()
              .find((entry) => entry.machine_id === machine)!
              .provider_ids.map((provider) => options.store.provider(machine, provider)!.config_ref)
            const next = {
              ...document,
              providers: document.providers.filter((entry: { reference: string }) => !refs.includes(entry.reference))
            }
            writeSetupFile(providersPath, boundedJson(next, 1_048_576), true, stamp)
            try {
              options.store.deleteDevice(machine, actor)
            } catch (error) {
              writeSetupFile(providersPath, boundedJson(document, 1_048_576), true, setupFileStamp(providersPath))
              throw error
            }
          } else {
            options.store.deleteDevice(machine, actor)
          }
          options.disconnect(machine)
          return { deleted: true }
        }
        if (operation === 'tokens_list') {
          fields(args, [])
        } else if (operation === 'tokens_create') {
          fields(args, ['principal'], ['days'])
        } else if (operation === 'tokens_delete' || operation === 'tokens_rotate') {
          fields(args, ['principal'])
        } else if (operation === 'tokens_scope') {
          // 面板显式提交整张列表；空数组等价于「全部设备」，CLI 侧仍要求显式 --all-devices。
          fields(args, ['principal'], ['machine_ids'])
        } else {
          throw new ManagementServiceError('invalid_arguments')
        }
        const stamp = setupFileStamp(path)
        const registry = parseRegistry(readRuntimeJson(path, REGISTRY_MAX_BYTES))
        if (operation === 'tokens_list') {
          const client = readSetupJson(runtimeReference(options.config.state_dir, 'mcp-client')) as
            | { principal_id?: string; token?: string }
            | undefined
          // 设备候选与令牌列表来自同一次读取：有界、按 machine_id 排序，不额外开一条读路径。
          // Store.resources() 已按 machine_id 排序；超上限时显式交付截断标记，绝不静默丢设备。
          const all = options.store.resources()
          const devices = all
            .slice(0, LIMITS.scope_machines)
            .map((entry) => ({ machine_id: entry.machine_id, name: options.store.machine(entry.machine_id).name }))
          return {
            resource: registry.resource,
            devices,
            devices_total: all.length,
            devices_truncated: all.length > LIMITS.scope_machines,
            items: registry.callers
              .filter((entry) => !isAdminPlaceholder(entry))
              .map((entry) => ({
                principal: entry.principal.id,
                issued_at: entry.issued_at,
                expires_at: entry.expires_at,
                scope: entry.scope ?? 'selected_devices',
                // 设备范围是纯过滤器：管理页令牌同样适用（不影响 Administrator.grants 的管理页可见性）。
                device_scope: deviceScopeView(entry),
                token:
                  entry.token ??
                  (client?.principal_id === entry.principal.id &&
                  typeof client.token === 'string' &&
                  digestToken(client.token) === entry.token_sha256
                    ? client.token
                    : null)
              }))
          }
        }
        if (typeof args.principal !== 'string') {
          throw new ManagementServiceError('invalid_arguments')
        }
        if (
          operation !== 'tokens_create' &&
          !registry.callers.some((entry) => entry.principal.id === args.principal && !isAdminPlaceholder(entry))
        ) {
          throw new ManagementServiceError('invalid_arguments')
        }
        if (args.days !== undefined && (typeof args.days !== 'number' || !Number.isInteger(args.days))) {
          throw new ManagementServiceError('invalid_arguments')
        }
        if (operation === 'tokens_scope') {
          const requested = args.machine_ids ?? []
          if (
            !Array.isArray(requested) ||
            requested.length > LIMITS.scope_machines ||
            requested.some(/* 只接受稳定 machine_id 形状；设备名永不参与授权。 */ (item) => typeof item !== 'string') ||
            new Set(requested).size !== requested.length
          ) {
            throw new ManagementServiceError('invalid_arguments')
          }
          // 空数组是面板上「设为全部设备」的显式提交，等价于 CLI 的 --all-devices。
          const scoped = setDeviceScope(registry, args.principal, requested.length === 0 ? null : requested)
          writeSetupFile(path, boundedJson(scoped, REGISTRY_MAX_BYTES), true, stamp)
          return { saved: true }
        }
        const next =
          operation === 'tokens_create'
            ? createGatewayCaller(registry, args.principal, Date.now(), args.days as number | undefined).registry
            : operation === 'tokens_rotate'
              ? rotateCaller(registry, args.principal, Date.now(), { days: 365 }).registry
              : revokeCaller(registry, args.principal)
        writeSetupFile(path, boundedJson(next, REGISTRY_MAX_BYTES), true, stamp)
        if (operation === 'tokens_rotate') {
          const clientPath = runtimeReference(options.config.state_dir, 'mcp-client')
          const client = readSetupJson(clientPath) as Record<string, unknown> | undefined
          if (client?.principal_id === args.principal) {
            const entry = next.callers.find((value) => value.principal.id === args.principal)!
            writeSetupFile(
              clientPath,
              boundedJson({ ...client, token: entry.token, issued_at: entry.issued_at, expires_at: entry.expires_at }),
              true
            )
          }
        }
        return { saved: true }
      } catch (error) {
        if (error instanceof ManagementServiceError) {
          throw error
        }
        if (error instanceof CliError) {
          throw new ManagementServiceError(
            error.code === 'invalid_arguments'
              ? 'invalid_arguments'
              : error.code === 'config_changed'
                ? 'revision_conflict'
                : 'backend_unavailable'
          )
        }
        if (
          error instanceof GatewayError &&
          ['machine_not_found', 'pairing_not_found', 'storage_degraded', 'invalid_machine_state'].includes(error.code)
        ) {
          throw new ManagementServiceError(error.code)
        }
        throw new ManagementServiceError('invalid_arguments')
      }
    }
  }
}
