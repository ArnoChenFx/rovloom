// 安装核验的摘要缓存：身份戳不变时不重读整个二进制；任何改写都使缓存失效并重新核对完整摘要。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { installationMeasurementCount, verifyInstallation } from '../../../src/connector/luvus/local.js'
import type { LuvusLocalConfig } from '../../../src/connector/luvus/index.js'

const sha = (bytes: string) => createHash('sha256').update(bytes).digest('hex')
// 内核文件时间戳是粗粒度的（常见 1–10 毫秒）：紧挨着的两次改写可能得到完全相同的 ctime。
// 需要“改写必然可见”的用例先等过一个时间戳粒度，不依赖宿主时钟精度。
const timestampTick = () => new Promise<void>((resolve) => setTimeout(resolve, 50))

function installation(original: string) {
  const root = mkdtempSync(
    join(process.env.LUVUS_TEST_ROOT ?? fileURLToPath(new URL('../../../../', import.meta.url)), '.luvus-cache-')
  )
  const home = join(root, 'home')
  const state = join(root, 'state')
  const cwd = join(root, 'project')
  for (const path of [home, state, cwd, ...['config', 'data', 'cache', 'runtime'].map((name) => join(home, name))]) {
    mkdirSync(path, { mode: 0o700 })
  }
  const binary = join(root, 'luvus')
  writeFileSync(binary, original, { mode: 0o700 })
  const config = { binary, binary_sha256: sha(original), state_root: state, home, cwd } as unknown as LuvusLocalConfig
  return { root, binary, config }
}

test('身份戳不变时只计算一次完整摘要', async () => {
  const f = installation('#!/bin/sh\nexit 0\n')
  try {
    const before = installationMeasurementCount()
    const first = await verifyInstallation(f.config)
    const second = await verifyInstallation(f.config)
    assert.equal(first, second)
    assert.equal(installationMeasurementCount() - before, 1)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('二进制的身份戳包含文件大小', async () => {
  const f = installation('#!/bin/sh\nexit 0\n')
  try {
    const stamp = await verifyInstallation(f.config)
    const fields = stamp.split('\n').at(-1)!.split(':')
    // component:dev:ino:ctimeNs:size:uid:mode
    assert.equal(fields[4], String(statSync(f.binary).size))
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('文件被改写后重新计算并拒绝，改回原内容后重新通过', async () => {
  const original = '#!/bin/sh\nexit 0\n'
  const f = installation(original)
  try {
    await verifyInstallation(f.config)
    const measured = installationMeasurementCount()
    await timestampTick()
    writeFileSync(f.binary, '#!/bin/sh\nexit 1\n')
    chmodSync(f.binary, 0o700)
    await assert.rejects(verifyInstallation(f.config), { code: 'binary_identity_changed' })
    assert.equal(installationMeasurementCount() - measured, 1)
    // 被拒绝的结果不会进入缓存：再次核验仍要重新计算并继续拒绝。
    await assert.rejects(verifyInstallation(f.config), { code: 'binary_identity_changed' })
    assert.equal(installationMeasurementCount() - measured, 2)
    await timestampTick()
    writeFileSync(f.binary, original)
    chmodSync(f.binary, 0o700)
    await verifyInstallation(f.config)
    assert.equal(installationMeasurementCount() - measured, 3)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})
