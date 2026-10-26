/** Feed real management replies through the HTTP/browser boundary, including the full permission vocabulary. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createManagementPageRead } from '../../src/webui/read.js'
import { checkManagementReadReply, checkPage } from '../../src/webui/validate.js'
import { storeFixture } from './store-fixture.js'

for (const callsAllowed of [true, false]) {
  test(`real device details accept calls_read=${callsAllowed} without weakening unknown-action validation`, async () => {
    const f = storeFixture()
    const context = {
      caller: { principal_id: 'alice' },
      management_session_ref: 'admin_session',
      wait_signal: new AbortController().signal
    }
    try {
      const admin = f.identities.administrator(context.caller, context.management_session_ref)!
      if (!callsAllowed) {
        f.setAdmin({ ...admin, grants: admin.grants.filter((grant) => grant.action !== 'calls_read') })
      }
      const args = { machine_id: 'machine_a' }
      const reply = await f.service.management.execute('permissions_get', args, context)
      const checked = checkManagementReadReply('permissions_get', reply, args)
      assert.deepEqual(
        checked.decisions.find((decision) => decision.action === 'calls_read'),
        {
          action: 'calls_read',
          allowed: callsAllowed,
          reason_code: callsAllowed ? 'allowed' : 'forbidden'
        }
      )
      const read = createManagementPageRead(async (name, input) =>
        checkManagementReadReply(name, await f.service.management.execute(name, input, context), input)
      )
      const route = { machineId: 'machine_a', cursor: null, providerCursor: null }
      const page = checkPage(await read(route, context.wait_signal), route)
      assert.equal(page.value.device!.machine_id, 'machine_a')
      assert(page.value.providers.items.length > 0)
      assert.equal(
        page.value.permissions!.decisions.find((decision) => decision.action === 'calls_read')!.allowed,
        callsAllowed
      )
      assert.throws(
        () =>
          checkManagementReadReply(
            'permissions_get',
            {
              ...reply,
              decisions: [...reply.decisions, { action: 'unknown_permission', allowed: true, reason_code: 'allowed' }]
            },
            args
          ),
        { problem: 'invalid_response' }
      )
    } finally {
      f.close()
    }
  })
}
