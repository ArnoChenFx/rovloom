/** 按真实角色验收八个资产目标Gateway；只有glibc Linux x64产品另须通过原生双角色往返。 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { smokeGatewayProduct } from './gateway-smoke.mjs'
import { smokeDualRoleProduct } from './dual-role-smoke.mjs'
import { runtimeLibc } from './libc.mjs'
import { smokeRuntime } from './runtime.mjs'

/** 每项目标必须运行实际Gateway；Linux x64不能跳过原生Owner，未支持角色明确标记。 */
export async function smokeProduct(binary, version, options = {}) {
  assert(['linux', 'darwin', 'win32'].includes(process.platform), 'product_gateway_storage_platform_unsupported')
  assert(['x64', 'arm64'].includes(process.arch), 'product_gateway_arch_unsupported')
  binary = resolve(binary)
  assert(lstatSync(binary).isFile(), 'product_binary_required')
  const digest = createHash('sha256').update(readFileSync(binary)).digest('hex')
  // musl 目标在 glibc runner 上跑不起来；ROVLOOM_MUSL_ALPINE=1 时改由 Alpine 容器执行真实 Gateway。
  const runtime = smokeRuntime()
  const gateway = await smokeGatewayProduct(
    binary,
    version,
    undefined,
    undefined,
    runtime.kind === 'alpine' ? runtime : undefined
  )
  assert.equal(gateway.product_sha256, digest, 'product_gateway_binary_mismatch')
  assert.deepEqual(gateway.schemaFactories, ['luvus', 'herdr'])
  // Gateway切片的pending不能变成角色支持声明；只有glibc Linux x64必须且能够运行原生Owner。
  // musl 产物缺少 pidfd_open/pidfd_send_signal，Luvus managed 原生进程管理按 fail-closed 不可用，
  // 因此 musl 目标只验收 Gateway 切片，绝不把双角色结果声明为通过。
  const { connector: _partialConnector, ...gatewayAcceptance } = gateway
  // 判据是产物自身的 libc，不是宿主：musl 产物即使跑在 glibc 宿主上也拿不到 pidfd。
  const productLibc = options.libc ?? runtimeLibc()
  const nativeOwner =
    process.platform === 'linux' && process.arch === 'x64' && productLibc === 'glibc' && runtime.kind === 'native'
  let dualRole
  if (nativeOwner) {
    dualRole = await smokeDualRoleProduct(binary, options)
    assert.equal(dualRole.product_sha256, digest, 'product_binary_changed_between_acceptances')
    assert.equal(dualRole.gateway, 'passed')
    assert.equal(dualRole.connector, 'passed')
  }
  assert.equal(createHash('sha256').update(readFileSync(binary)).digest('hex'), digest)
  return {
    scope: 'product',
    platform: `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`,
    version,
    product_sha256: digest,
    gateway: gatewayAcceptance,
    ...(dualRole ? { dualRole } : {}),
    connector: nativeOwner ? 'passed' : 'unsupported',
    nativeOwner: nativeOwner ? 'passed' : 'unsupported'
  }
}

if (import.meta.main) {
  const [binary, version] = process.argv.slice(2)
  assert.equal(process.argv.length, 4, 'Usage: bun scripts/release/product-smoke.mjs /built/product-binary version')
  console.log(JSON.stringify(await smokeProduct(binary, version)))
}
