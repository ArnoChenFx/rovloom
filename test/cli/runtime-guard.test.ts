import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { MINIMUM_BUN, bunSupported } from '../../src/cli/runtime-guard.js'

test('Bun 版本下限与 package.json engines 一致，低版本和非 Bun 运行时被拒绝', () => {
  const engines = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).engines.bun
  assert.equal(engines, `>=${MINIMUM_BUN}`)
  assert.equal(bunSupported(MINIMUM_BUN), true)
  assert.equal(bunSupported('1.4.4'), true)
  assert.equal(bunSupported('1.10.0'), true)
  assert.equal(bunSupported('2.0.0'), true)
  assert.equal(bunSupported('1.4.4-canary.1'), true)
  assert.equal(bunSupported('1.4.3'), false)
  assert.equal(bunSupported('1.4.2'), false)
  assert.equal(bunSupported('1.3.99'), false)
  assert.equal(bunSupported('0.9.9'), false)
  assert.equal(bunSupported(undefined), false)
  assert.equal(bunSupported('latest'), false)
  assert.equal(bunSupported('1.4'), false)
})
