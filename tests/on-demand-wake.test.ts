import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildOnDemandWakeJobRows,
  getOnDemandWakeBucket,
  normalizeProviderBaseDeviceId,
} from '../lib/on-demand-wake.ts'

test('normalizes provider slot device ids to base device ids', () => {
  assert.equal(normalizeProviderBaseDeviceId('pm_abc_slot_0'), 'pm_abc')
  assert.equal(normalizeProviderBaseDeviceId('pm_abc'), 'pm_abc')
})

test('builds idempotent private on-demand start jobs per requester bucket', () => {
  const now = new Date('2026-05-21T12:04:30.000Z')
  const rows = buildOnDemandWakeJobRows({
    providerUserId: 'provider-1',
    baseDeviceId: 'pm_abc_slot_1',
    requesterUserId: 'requester-1',
    now,
    source: 'session_create:desktop',
  })

  assert.deepEqual(rows.map(row => row.action), ['start'])
  assert.equal(rows[0].base_device_id, 'pm_abc')
  assert.equal(rows[0].scheduled_for, '2026-05-21T12:04:30.000Z')
  assert.equal(rows[0].expires_at, '2026-05-21T12:19:30.000Z')
  assert.equal(rows[0].window_key, `on-demand:${getOnDemandWakeBucket(now)}`)
  assert.equal(rows[0].idempotency_key, `provider-1:pm_abc:requester-1:on-demand:${getOnDemandWakeBucket(now)}:start`)
  assert.deepEqual(rows[0].payload, {
    reason: 'on_demand_private_start',
    requesterUserId: 'requester-1',
    requestedAt: '2026-05-21T12:04:30.000Z',
    source: 'session_create:desktop',
  })
})

test('can include a wake job when power wake is explicitly requested', () => {
  const now = new Date('2026-05-21T12:04:30.000Z')
  const rows = buildOnDemandWakeJobRows({
    providerUserId: 'provider-1',
    baseDeviceId: 'pm_abc',
    requesterUserId: 'requester-1',
    now,
    includeWake: true,
  })

  assert.deepEqual(rows.map(row => row.action), ['wake', 'start'])
  assert.equal(rows[0].payload.reason, 'on_demand_private_wake')
  assert.equal(rows[1].payload.reason, 'on_demand_private_wake')
})
