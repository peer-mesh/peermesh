import assert from 'node:assert/strict'
import test from 'node:test'
import {
  evaluateUptimeSchedule,
  getScheduleWindowState,
  normalizeScheduleTime,
  normalizeScheduleTimezone,
  scheduleTimeToMinutes,
  type UptimeScheduleRow,
} from '../lib/uptime-scheduler.ts'

function schedule(overrides: Partial<UptimeScheduleRow> = {}): UptimeScheduleRow {
  return {
    user_id: 'user-1',
    base_device_id: 'device-1',
    enabled: true,
    start_time: '09:00',
    end_time: '17:00',
    timezone: 'UTC',
    wake_enabled: true,
    shutdown_after_window: false,
    last_start_window_key: null,
    last_stop_window_key: null,
    last_wake_window_key: null,
    ...overrides,
  }
}

test('normalizes invalid schedule values safely', () => {
  assert.equal(normalizeScheduleTime('7:05'), '07:05')
  assert.equal(normalizeScheduleTime('24:00'), '00:00')
  assert.equal(scheduleTimeToMinutes('12:30'), 750)
  assert.equal(normalizeScheduleTimezone('Not/AZone'), 'UTC')
})

test('creates wake and start once when a daytime window is active', () => {
  const now = new Date('2026-05-21T10:15:00.000Z')
  const actions = evaluateUptimeSchedule(schedule(), now)

  assert.deepEqual(actions.map(action => action.action), ['wake', 'start'])
  assert.equal(actions[0].windowKey, '2026-05-21')
  assert.equal(actions[1].idempotencyKey, 'user-1:device-1:start:2026-05-21')

  const duplicateActions = evaluateUptimeSchedule(schedule({
    last_wake_window_key: '2026-05-21',
    last_start_window_key: '2026-05-21',
  }), now)
  assert.deepEqual(duplicateActions, [])
})

test('creates stop after a daytime window only for the started window', () => {
  const now = new Date('2026-05-21T18:00:00.000Z')
  const actions = evaluateUptimeSchedule(schedule({
    last_start_window_key: '2026-05-21',
  }), now)

  assert.deepEqual(actions.map(action => action.action), ['stop'])
  assert.equal(actions[0].windowKey, '2026-05-21')

  const noStart = evaluateUptimeSchedule(schedule(), now)
  assert.deepEqual(noStart, [])
})

test('handles overnight windows before and after midnight', () => {
  const overnight = schedule({ start_time: '22:00', end_time: '06:00' })

  const beforeMidnight = getScheduleWindowState(overnight, new Date('2026-05-21T23:00:00.000Z'))
  assert.equal(beforeMidnight.active, true)
  assert.equal(beforeMidnight.windowKey, '2026-05-21')

  const afterMidnight = getScheduleWindowState(overnight, new Date('2026-05-22T03:00:00.000Z'))
  assert.equal(afterMidnight.active, true)
  assert.equal(afterMidnight.windowKey, '2026-05-21')

  const afterEnd = evaluateUptimeSchedule(schedule({
    start_time: '22:00',
    end_time: '06:00',
    last_start_window_key: '2026-05-21',
  }), new Date('2026-05-22T12:00:00.000Z'))
  assert.deepEqual(afterEnd.map(action => action.action), ['stop'])
  assert.equal(afterEnd[0].windowKey, '2026-05-21')
})

test('treats matching start and end times as always on', () => {
  const now = new Date('2026-05-21T12:00:00.000Z')
  const alwaysOn = schedule({ start_time: '00:00', end_time: '00:00', wake_enabled: false })
  const actions = evaluateUptimeSchedule(alwaysOn, now)

  assert.deepEqual(actions.map(action => action.action), ['start'])
  assert.equal(actions[0].reason, 'always_on')

  const duplicateActions = evaluateUptimeSchedule(schedule({
    start_time: '00:00',
    end_time: '00:00',
    wake_enabled: false,
    last_start_window_key: '2026-05-21',
  }), now)
  assert.deepEqual(duplicateActions, [])
})

test('disabled schedules produce no actions', () => {
  const actions = evaluateUptimeSchedule(schedule({ enabled: false }), new Date('2026-05-21T10:00:00.000Z'))
  assert.deepEqual(actions, [])
})
