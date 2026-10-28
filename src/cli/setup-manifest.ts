import { ProviderAdapterError } from '../connector/provider-error.js'
// Gateway从配对设备的实际schema字节核对固定首次来源清单；不接受设备选择Gateway文件路径或重建可信句柄。
import { HERDR_INPUT_LIMIT } from '../connector/herdr/compiler-protocol.js'
import { compileHerdrSchemas } from '../connector/herdr/compiler-api.js'
import { parseHerdrProviderRefConfig, createHerdrGatewayResources } from '../connector/herdr/provider.js'
import { createHerdrCodec } from '../connector/herdr/readonly.js'
import { checkedRemoteLuvusConfig, createPinnedRemoteLuvus } from '../connector/luvus/host/remote-luvus.js'
import { boundedJson, fields, hash, object } from '../wire/index.js'
import type { ProviderBinding, V2Target } from '../wire/types.js'
import { CliError, type NativeProviderKind } from './config.js'
import type { SetupPlanFacts } from './setup-targets.js'
import { setupProviderKinds, setupReference, setupSessions, setupTarget } from './setup-targets.js'
import { publishSchema, schemaReference } from '../connector/schema-store.js'

export type ReviewedSetupInstallation = Readonly<{
  kind: NativeProviderKind
  reference: string
  target: V2Target
  binding: ProviderBinding
  value: unknown
  label: string
  binary_sha256: string
  schema?: Readonly<{ path: string; bytes: Buffer }>
  /** 落盘后由该 provider 重新加载已发布字节；公共发布层不解释 provider 语义。 */
  verifyPublished(): Promise<void>
}>

// 诊断标签须为有界单行文本，不能向所有者确认注入TTY控制序列。
function label(value: string | null): string {
  if (value === null) {
    return 'unavailable'
  }
  if (
    !value.length ||
    value.length > 128 ||
    [...value].some(
      /* 保留普通可见字符，拒绝C0/DEL。 */ (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    )
  ) {
    throw new CliError('configuration_required')
  }
  return value
}

// 兼容既有单Luvus封套；新清单只接纳一个Herdr或固定顺序的Luvus+Herdr，没有任意provider注册入口。
export async function reviewSetupManifest(
  input: unknown,
  // 只消费计划的身份事实（attempt/批准主体/谱系/已批准选择）；单码直连配对以固定常量构造同一事实集。
  plan: Pick<SetupPlanFacts, 'attempt_id' | 'actor' | 'lineage' | 'providers'>,
  machine: string,
  directory: string,
  signal: AbortSignal
) {
  const row = object(input)
  let entries: unknown[]
  if (Object.hasOwn(row, 'installations')) {
    fields(row, ['installations'])
    if (!Array.isArray(row.installations)) {
      throw new CliError('configuration_required')
    }
    entries = row.installations
  } else {
    fields(row, ['reference', 'value'])
    entries = [row]
  }
  const kinds = setupProviderKinds(
    entries.map(
      /* kind只供选择已有静态核验器；完整封套随后继续严格解析。 */ (entry) => object(object(entry).value).kind
    )
  )
  if (plan.providers && boundedJson(plan.providers) !== boundedJson(kinds)) {
    throw new CliError('configuration_required')
  }
  // Luvus 的会话名来自 Connector 的运行方式（附着 default / managed rovloom），只接受这两个程序定义的值。
  const luvusIndex = kinds.indexOf('luvus')
  const sessions = setupSessions(
    luvusIndex < 0 ? undefined : { luvus: object(object(object(entries[luvusIndex]).value).target).session }
  )
  const authorization = { principal_id: plan.actor }
  const reviewed: ReviewedSetupInstallation[] = []
  for (let index = 0; index < entries.length; index++) {
    const kind = kinds[index]!
    const entry = object(entries[index])
    fields(entry, ['reference', 'value'])
    const reference = setupReference(plan.attempt_id, kind)
    const target = setupTarget(machine, kind, sessions)
    if (entry.reference !== reference) {
      throw new CliError('configuration_required')
    }
    if (kind === 'luvus') {
      const remote = { ...checkedRemoteLuvusConfig(reference, entry.value) }
      // 旧字段只为读取兼容；新发布的配对记录不再包含逐方法 raw 授权。
      delete remote.raw_grant
      if (
        boundedJson(remote.target) !== boundedJson(target) ||
        remote.binding.binding_revision !== 1 ||
        !remote.binding.enabled
      ) {
        throw new CliError('configuration_required')
      }
      // 设备只交付原始 schema 字节；不接受设备指定 Gateway 自己的文件路径，
      // 也不由设备发布本地副本（两台机器部署时那路径在 Gateway 侧不存在）。
      if (remote.contract.schema_ref !== undefined || remote.contract.schema_bundle === undefined) {
        throw new CliError('configuration_required')
      }
      const bytes = Buffer.from(remote.contract.schema_bundle, 'utf8')
      const path = schemaReference(directory, remote.contract.schema_sha256)
      const verified = await createPinnedRemoteLuvus(remote)
      verified.close()
      const { schema_bundle: _inline, ...pin } = remote.contract
      const value = { ...remote, contract: { ...pin, schema_ref: path } }
      reviewed.push({
        kind,
        reference,
        target,
        binding: remote.binding,
        // 发布后的 pin 只留 Gateway 自己的内容寻址引用，不再内嵌原始文本。
        value,
        label: label(remote.contract.binary_version),
        binary_sha256: remote.contract.binary_sha256,
        schema: { path, bytes },
        async verifyPublished() {
          const loaded = await createPinnedRemoteLuvus(value)
          loaded.close()
        }
      })
    } else {
      const remote = object(entry.value)
      fields(remote, ['kind', 'config', 'schema_bundle'])
      const config = object(remote.config)
      fields(
        config,
        ['version', 'target', 'binding_revision', 'config_ref', 'expected_source'],
        ['peer_policy_revision']
      )
      if (
        remote.kind !== 'herdr' ||
        typeof remote.schema_bundle !== 'string' ||
        Buffer.byteLength(remote.schema_bundle) > HERDR_INPUT_LIMIT
      ) {
        throw new CliError('configuration_required')
      }
      // Gateway 自己保存的原始字节走与 Luvus 相同的内容寻址布局，引用不再按配对批次命名。
      const path = schemaReference(directory, object(config.expected_source).schema_sha256 as string)
      const parsed = parseHerdrProviderRefConfig({ ...config, schema_ref: path })
      const bytes = Buffer.from(remote.schema_bundle, 'utf8')
      if (
        parsed.config_ref !== reference ||
        parsed.binding_revision !== 1 ||
        boundedJson(parsed.target) !== boundedJson(target) ||
        hash(bytes) !== parsed.expected_source.schema_sha256
      ) {
        throw new CliError('configuration_required')
      }
      const compiled = await compileHerdrSchemas(bytes, signal)
      createHerdrCodec(parsed.expected_source, compiled)
      const binding: ProviderBinding = {
        machine_id: machine,
        provider_id: kind,
        kind,
        config_ref: reference,
        binding_revision: 1,
        enabled: true
      }
      reviewed.push({
        kind,
        reference,
        target,
        binding,
        value: { kind, config: parsed },
        label: label(parsed.expected_source.binary_version),
        binary_sha256: parsed.expected_source.binary_sha256,
        schema: { path, bytes },
        /** 发布后按 Gateway 自己的路径重建资源，证明落盘字节与编译身份一致。 */
        async verifyPublished() {
          const verified = await createHerdrGatewayResources({ config: parsed, signal })
          await verified.release()
        }
      })
    }
  }
  return { kinds, reviewed, authorization, fingerprint: hash(boundedJson(input, 1_048_576)) }
}

// 获准后才落盘Gateway自己的原始schema；已有不同字节不能被重入或设备输入覆盖。
export async function publishSetupSchemas(
  entries: readonly ReviewedSetupInstallation[],
  signal: AbortSignal
): Promise<void> {
  for (const entry of entries) {
    if (!entry.schema) {
      continue
    }
    const { path, bytes } = entry.schema
    if (signal.aborted) {
      throw new CliError('configuration_required')
    }
    try {
      publishSchema(path, bytes)
    } catch (error) {
      if (error instanceof ProviderAdapterError && error.code === 'schema_digest_conflict') {
        throw new CliError('configuration_required')
      }
      throw error
    }
    await entry.verifyPublished()
  }
}
