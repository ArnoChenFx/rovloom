/** Optional preflight diagnostics must leave completion reserves and real storage failures intact. */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { Store } from '../../src/store.js'
import { NativeRequestPreflightError } from '../../src/connector/preflight.js'
import { assertBudget } from '../../src/storage/budget.js'
import { managedBytes } from '../../src/storage/files.js'
import { connected, management, options, respond } from './helpers.js'

test('repeated invalid requests leave normal admission headroom without exhausting the Gateway', () => {
  const store = new Store(':memory:', () => 1_000_000, {
    management,
    retention: {
      storage_total_bytes: 1_000_000,
      storage_reserve_bytes: 400_000,
      content_bytes: 100_000,
      backup_bytes: 100_000
    }
  })
  try {
    const device = connected(store)
    const admission = {
      ...options(),
      timeoutMs: undefined,
      deadline: 1_010_000,
      client_request_key: 'corrected_after_burst'
    }
    for (let i = 0; i < 6_000; i++) {
      assert.throws(
        () =>
          store.admitCall('alice', device.target, { method: 'pane.read', params: {} }, admission, undefined, () => {
            throw new NativeRequestPreflightError()
          }),
        NativeRequestPreflightError
      )
    }
    assert.equal(store.health().mode, 'active')
    const corrected = store.admitCall('alice', device.target, { method: 'ping', params: {} }, admission)
    assert.equal(corrected.created, true)
    const binding = store.dispatch('alice', corrected.call.call_id, device.epoch)
    respond(store, binding, { result: { pong: true } }, 1_000_000)
    assert.equal(store.call('alice', corrected.call.call_id).state, 'responded')
    assert.equal(store.health().mode, 'active')
  } finally {
    store.close()
  }
})

test('preflight audit skips ordinary-budget exhaustion while an existing call can finish and the rejected key stays free', () => {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-preflight-budget-'))
  const path = join(root, 'gateway.db')
  const now = 1_000_000
  const store = new Store(path, () => now, {
    management,
    retention: {
      storage_total_bytes: 1_000_000,
      storage_reserve_bytes: 400_000,
      content_bytes: 100_000,
      backup_bytes: 100_000
    }
  })
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const device = connected(store)
    const pending = store.createCall('alice', device.target, { method: 'ping' }, options())
    const binding = store.dispatch('alice', pending.call_id, device.epoch)
    const reserved = Number(db.prepare('SELECT reserved_bytes FROM storage_usage').get()!.reserved_bytes)
    const ceiling = store.limits.storage_total_bytes - store.limits.storage_reserve_bytes
    const filler = join(root, 'ordinary-data')
    writeFileSync(filler, Buffer.alloc(ceiling - reserved - managedBytes(root) - 512))
    assertBudget(db, path, store.limits, undefined, true)
    const admission = {
      ...options(),
      timeoutMs: undefined,
      deadline: now + 10_000,
      client_request_key: 'rejected_then_corrected'
    }
    for (let i = 0; i < 64; i++) {
      assert.throws(
        () =>
          store.admitCall('alice', device.target, { method: 'pane.read', params: {} }, admission, undefined, () => {
            throw new NativeRequestPreflightError()
          }),
        NativeRequestPreflightError
      )
    }
    assert.equal(db.prepare("SELECT count(*) n FROM audit WHERE action='native_preflight_rejected'").get()!.n, 0)
    assert.equal(db.prepare('SELECT count(*) n FROM calls').get()!.n, 1)
    assert.equal(store.health().mode, 'active')
    assertBudget(db, path, store.limits, undefined, true)
    assert.equal(store.call('alice', pending.call_id).state, 'dispatching')
    respond(store, binding, { result: { pong: true } }, now)
    assert.equal(store.call('alice', pending.call_id).state, 'responded')
    assert.equal(store.health().mode, 'active')
    assert.equal(db.prepare('SELECT reserved_bytes FROM storage_usage').get()!.reserved_bytes, 0)

    unlinkSync(filler)
    const corrected = store.admitCall('alice', device.target, { method: 'ping', params: {} }, admission)
    assert.equal(corrected.created, true)
    store.dispatch('alice', corrected.call.call_id, device.epoch)
    assert.equal(store.health().mode, 'active')
  } finally {
    db.close()
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('a real commit failure in the optional preflight audit still latches storage degradation', () => {
  let failCommit = false
  const store = new Store(':memory:', () => 1_000_000, {
    management,
    fault: () => {
      if (failCommit) {
        throw new Error('synthetic_commit_failure')
      }
    }
  })
  try {
    const device = connected(store)
    assert.throws(
      () =>
        store.admitCall(
          'alice',
          device.target,
          { method: 'ping' },
          {
            ...options(),
            timeoutMs: undefined,
            deadline: 1_010_000
          },
          undefined,
          () => {
            failCommit = true
            throw new NativeRequestPreflightError()
          }
        ),
      NativeRequestPreflightError
    )
    assert.equal(store.health().mode, 'storage_degraded')
    assert.throws(() => store.createCall('alice', device.target, { method: 'ping' }, options()), {
      code: 'storage_degraded'
    })
  } finally {
    store.close()
  }
})
