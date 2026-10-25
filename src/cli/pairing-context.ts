// 配对主体与策略谱系来自 Gateway 已有的私有状态；升级后不改写旧设备、调用方或令牌。
import { canonicalLoopbackHost } from '../mcp/listen.js'
import { fields, id, object } from '../wire/index.js'
import { GatewayError } from '../contracts.js'
import type { GatewayConfig } from './config.js'
import { runtimeReference } from './runtime-files.js'
import { readSetupJson } from './setup-files.js'
import { parseRegistry, REGISTRY_MAX_BYTES } from './token-registry.js'
import { SIMPLE_SETUP_ACTOR, SIMPLE_SETUP_LINEAGE } from './setup-policy.js'

export type PairingContext = Readonly<{ actor: string; lineage: string }>

export function gatewayPairingContext(config: GatewayConfig): PairingContext {
  const original = readSetupJson(runtimeReference(config.state_dir, 'mcp-client'))
  if (original === undefined) {
    return { actor: SIMPLE_SETUP_ACTOR, lineage: SIMPLE_SETUP_LINEAGE }
  }
  const client = object(original)
  fields(client, [
    'schema_version',
    'kind',
    'attempt_id',
    'resource',
    'principal_id',
    'token',
    'issued_at',
    'expires_at'
  ])
  const resource = new URL('http://' + canonicalLoopbackHost(config.mcp_hostname) + ':' + config.mcp_port + '/mcp').href
  const actor = client.principal_id
  const lineage = actor === SIMPLE_SETUP_ACTOR ? SIMPLE_SETUP_LINEAGE : client.attempt_id
  id(actor)
  id(lineage)
  if (
    client.schema_version !== 1 ||
    client.kind !== 'mcp-client-credential' ||
    client.resource !== resource ||
    typeof client.token !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(client.token) ||
    !Number.isSafeInteger(client.issued_at) ||
    !Number.isSafeInteger(client.expires_at) ||
    Number(client.expires_at) <= Date.now()
  ) {
    throw new GatewayError('pairing_conflict')
  }
  const registry = parseRegistry(
    readSetupJson(runtimeReference(config.state_dir, 'mcp-callers'), REGISTRY_MAX_BYTES),
    resource
  )
  const caller = registry.callers.find((entry) => entry.principal.id === actor)
  // 原 MCP 令牌可被撤销；缓存仍标识配对谱系，后续合并不得重新创建这个调用方。
  if (
    registry.local_policy.revision !== 'setup_local_' + lineage ||
    (caller !== undefined && caller.principal.policy.revision !== 'setup_caller_' + lineage)
  ) {
    throw new GatewayError('pairing_conflict')
  }
  return { actor: actor as string, lineage: lineage as string }
}
