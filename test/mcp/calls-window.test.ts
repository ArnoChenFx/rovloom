/** Real management metadata must survive the same validation and pagination used by the browser. */
import assert from 'node:assert/strict'
import type { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import type { AdminContext } from '../../src/mcp/management.js'
import { createManagementPageRead } from '../../src/webui/read.js'
import { checkManagementReadReply, checkPage } from '../../src/webui/validate.js'
import { storeFixture, syntheticCredential, target } from './store-fixture.js'
import { options } from '../storage/helpers.js'

const context = (): AdminContext => ({
  caller: { principal_id: 'alice' },
  management_session_ref: 'admin_session',
  wait_signal: new AbortController().signal
})

function addCall(db: DatabaseSync, id: string, machine = 'machine_a', provider = 'luvus_a', state = 'responded') {
  db.prepare(`INSERT INTO calls(call_id,principal,machine_id,provider_id,binding_revision,provider_kind,
    request_hash,state,identity_json,target_json,method,mode,created,deadline,content_expires,
    metadata_expires,dedup_expires,content_status)
    SELECT ?,principal,?,?,binding_revision,provider_kind,request_hash,?,identity_json,?,method,mode,
      created,deadline,content_expires,metadata_expires,dedup_expires,content_status
    FROM calls WHERE call_id='call_fixture'`).run(
    id,
    machine,
    provider,
    state,
    JSON.stringify({ machine_id: machine, provider_id: provider, profile: 'session', session: 'test' })
  )
}

test('browser accepts first and last call pages when the aggregate covers more than one page', async () => {
  const f = storeFixture('active', (db) => {
    for (let i = 0; i < 60; i++) {
      addCall(db, 'call_page_' + i.toString().padStart(3, '0'))
    }
  })
  try {
    checkManagementReadReply('calls_list', await f.service.management.execute('calls_list', { limit: 50 }, context()), {
      limit: 50
    })
    const read = createManagementPageRead(async (name, args) =>
      checkManagementReadReply(name, await f.service.management.execute(name, args, context()), args)
    )
    const route = { machineId: null, cursor: null, providerCursor: null, section: 'calls' as const }
    const first = await read(route, new AbortController().signal)
    const checked = checkPage(first, route)
    assert.equal(checked.value.calls!.items.length, 50)
    assert.equal(checked.value.calls!.aggregate.total, 61)
    const nextRoute = { ...route, callsCursor: checked.value.calls!.next_cursor! }
    const second = checkPage(await read(nextRoute, new AbortController().signal), nextRoute)
    assert.equal(second.value.calls!.items.length, 11)
    assert.equal(second.value.calls!.aggregate.total, 61)
    assert.equal(second.value.calls!.window.sampled, 61)
    assert.equal(second.value.calls!.next_cursor, undefined)
    assert.equal(
      new Set([...checked.value.calls!.items, ...second.value.calls!.items].map((item) => item.call_id)).size,
      61
    )
  } finally {
    f.close()
  }
})

test('degraded-state filters use the public outcome_unknown state before paging and counting', async () => {
  const f = storeFixture()
  try {
    const epoch = f.store.connect('machine_a', syntheticCredential)
    const call = f.store.createCall('alice', target, { method: 'pane.read', params: {} }, options())
    f.store.dispatch('alice', call.call_id, epoch)
    f.advance(-1)
    assert.throws(() => f.store.clock(), { code: 'clock_untrusted' })
    f.advance(1)
    assert.equal(f.store.health().mode, 'storage_degraded')
    const args = { states: ['outcome_unknown' as const] }
    const reply = checkManagementReadReply(
      'calls_list',
      await f.service.management.execute('calls_list', args, context()),
      args
    )
    assert.deepEqual(
      reply.items.map((item) => item.call_id),
      [call.call_id]
    )
    assert.deepEqual(reply.aggregate.by_state, [{ state: 'outcome_unknown', count: 1 }])
    const pending = { states: ['dispatching' as const] }
    const empty = checkManagementReadReply(
      'calls_list',
      await f.service.management.execute('calls_list', pending, context()),
      pending
    )
    assert.equal(empty.items.length, 0)
    assert.equal(empty.aggregate.total, 0)
  } finally {
    f.close()
  }
})

test('provider distributions distinguish the same provider ID on different machines', async () => {
  const f = storeFixture('active', (db) => {
    addCall(db, 'call_same_a', 'machine_a', 'shared')
    addCall(db, 'call_same_b', 'machine_b', 'shared')
  })
  try {
    const ctx = context()
    const admin = f.identities.administrator(ctx.caller, ctx.management_session_ref)!
    f.setAdmin({ ...admin, grants: [...admin.grants, { action: 'calls_read', machine_id: 'machine_b' }] })
    const reply = checkManagementReadReply('calls_list', await f.service.management.execute('calls_list', {}, ctx), {})
    assert.deepEqual(
      reply.aggregate.by_provider.filter((row) => row.provider_id === 'shared'),
      [
        { machine_id: 'machine_a', provider_id: 'shared', kind: 'luvus', count: 1 },
        { machine_id: 'machine_b', provider_id: 'shared', kind: 'luvus', count: 1 }
      ]
    )
  } finally {
    f.close()
  }
})
