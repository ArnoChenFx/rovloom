// Connector 启动失败时：凡是带固定错误码的异常（GatewayError / WireError / ProviderAdapterError / HerdrLocalError）
// 和操作系统错误的 errno 名都要作为一行 `native_unavailable <码>` 交给用户；message、路径、stack、请求一律不打印。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PassThrough } from 'node:stream'
import { configTemplate, type ConnectorConfig } from '../../src/cli/config.js'
import { CliSetup } from '../../src/cli/setup-runtime.js'
import { ProviderAdapterError } from '../../src/connector/provider-error.js'
import { HerdrLocalError } from '../../src/connector/herdr/local.js'
import { GatewayError } from '../../src/contracts.js'
import { WireError } from '../../src/wire/validation.js'

async function printed(error: unknown): Promise<string> {
  const setup = new CliSetup()
  const stderr = new PassThrough()
  await setup.prepare({ ...configTemplate('connector'), state_dir: '/nonexistent' } as ConnectorConfig, '', {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr,
    signal: new AbortController().signal
  })
  setup.nativeFailed(error)
  return stderr.read()?.toString() ?? ''
}

test('固定码异常都被打印成 native_unavailable <码>', async () => {
  assert.equal(
    await printed(new ProviderAdapterError('claim_ledger_invalid')),
    'native_unavailable claim_ledger_invalid\n'
  )
  assert.equal(
    await printed(new HerdrLocalError('herdr_launch_unavailable')),
    'native_unavailable herdr_launch_unavailable\n'
  )
  // 之前漏掉的两类：fail('…') 抛出的 GatewayError / WireError。
  assert.equal(
    await printed(new GatewayError('herdr_core_installation_changed')),
    'native_unavailable herdr_core_installation_changed\n'
  )
  assert.equal(
    await printed(new WireError('herdr_core_managed_directory_untrusted')),
    'native_unavailable herdr_core_managed_directory_untrusted\n'
  )
  // 码里带数字也是固定码（旧规则只认字母和下划线）。
  assert.equal(await printed(new GatewayError('tls1_unavailable')), 'native_unavailable tls1_unavailable\n')
})

test('操作系统错误只取 errno 名，不带 message、路径或系统调用参数', async () => {
  const system = Object.assign(new Error("ENOENT: no such file or directory, open '/home/secret/token'"), {
    code: 'ENOENT',
    path: '/home/secret/token',
    syscall: 'open'
  })
  const output = await printed(system)
  assert.equal(output, 'native_unavailable system_enoent\n')
  assert(!output.includes('secret') && !output.includes('/home'), output)
  assert.equal(
    await printed(Object.assign(new Error('x'), { code: 'EADDRINUSE' })),
    'native_unavailable system_eaddrinuse\n'
  )
})

test('不是固定码的异常什么都不打印，也不回显 message', async () => {
  // 普通异常、码里有大写/空格/路径/换行、非字符串码、非异常对象。
  for (const error of [
    new Error('contains /home/secret/path and token=abc'),
    new TypeError('x is not a function'),
    new GatewayError('Has Upper'),
    new GatewayError('has space'),
    new GatewayError('line\nbreak'),
    new GatewayError('/etc/passwd'),
    new GatewayError('a'.repeat(81)),
    new GatewayError(''),
    Object.assign(new Error('x'), { code: 'enoent' }),
    Object.assign(new Error('x'), { code: 42 }),
    Object.assign(new Error('x'), { code: 'E' }),
    'a string',
    null,
    undefined,
    { code: 'object_without_error_class' }
  ]) {
    assert.equal(await printed(error), '', String(error))
  }
})
