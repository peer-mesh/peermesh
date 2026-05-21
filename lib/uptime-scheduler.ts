export type UptimeScheduleActionKind = 'wake' | 'start' | 'stop'

export type UptimeScheduleRow = {
  user_id: string
  base_device_id: string
  enabled: boolean | null
  start_time: string | null
  end_time: string | null
  timezone: string | null
  wake_enabled?: boolean | null
  shutdown_after_window?: boolean | null
  last_start_window_key?: string | null
  last_stop_window_key?: string | null
  last_wake_window_key?: string | null
}

export type UptimeScheduleAction = {
  action: UptimeScheduleActionKind
  idempotencyKey: string
  scheduledFor: string
  windowKey: string
  reason: string
}

const TIME_RE = /^(\d{1,2}):(\d{2})$/

export function normalizeScheduleTime(value: unknown, fallback = '00:00'): string {
  const match = TIME_RE.exec(String(value ?? '').trim())
  if (!match) return fallback
  const hours = Number.parseInt(match[1], 10)
  const minutes = Number.parseInt(match[2], 10)
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return fallback
  }
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

export function normalizeScheduleTimezone(value: unknown, fallback = 'UTC'): string {
  const timezone = String(value ?? fallback).trim() || fallback
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date())
    return timezone
  } catch {
    return fallback
  }
}

export function scheduleTimeToMinutes(value: unknown): number {
  const normalized = normalizeScheduleTime(value)
  const [hours, minutes] = normalized.split(':').map((part) => Number.parseInt(part, 10))
  return hours * 60 + minutes
}

function getLocalParts(now: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)

  const getPart = (type: string) => parts.find((part) => part.type === type)?.value ?? '00'
  return {
    year: getPart('year'),
    month: getPart('month'),
    day: getPart('day'),
    hour: Number.parseInt(getPart('hour'), 10),
    minute: Number.parseInt(getPart('minute'), 10),
  }
}

export function getLocalDateKey(now: Date, timezone: string): string {
  const parts = getLocalParts(now, timezone)
  return `${parts.year}-${parts.month}-${parts.day}`
}

export function getLocalMinuteOfDay(now: Date, timezone: string): number {
  const parts = getLocalParts(now, timezone)
  return parts.hour * 60 + parts.minute
}

export function getScheduleWindowState(schedule: UptimeScheduleRow, now = new Date()) {
  const startTime = normalizeScheduleTime(schedule.start_time)
  const endTime = normalizeScheduleTime(schedule.end_time)
  const timezone = normalizeScheduleTimezone(schedule.timezone)
  const start = scheduleTimeToMinutes(startTime)
  const end = scheduleTimeToMinutes(endTime)
  const current = getLocalMinuteOfDay(now, timezone)
  const todayKey = getLocalDateKey(now, timezone)
  const yesterdayKey = getLocalDateKey(new Date(now.getTime() - 24 * 60 * 60 * 1000), timezone)
  const alwaysOn = start === end

  if (alwaysOn) {
    return { active: schedule.enabled === true, alwaysOn, windowKey: todayKey, previousWindowKey: yesterdayKey, startTime, endTime, timezone }
  }

  if (start < end) {
    if (current >= start && current < end) {
      return { active: schedule.enabled === true, alwaysOn, windowKey: todayKey, previousWindowKey: yesterdayKey, startTime, endTime, timezone }
    }
    return {
      active: false,
      alwaysOn,
      windowKey: null,
      previousWindowKey: current >= end ? todayKey : yesterdayKey,
      startTime,
      endTime,
      timezone,
    }
  }

  if (current >= start) {
    return { active: schedule.enabled === true, alwaysOn, windowKey: todayKey, previousWindowKey: yesterdayKey, startTime, endTime, timezone }
  }
  if (current < end) {
    return { active: schedule.enabled === true, alwaysOn, windowKey: yesterdayKey, previousWindowKey: yesterdayKey, startTime, endTime, timezone }
  }

  return { active: false, alwaysOn, windowKey: null, previousWindowKey: yesterdayKey, startTime, endTime, timezone }
}

function actionKey(schedule: UptimeScheduleRow, action: UptimeScheduleActionKind, windowKey: string): string {
  return `${schedule.user_id}:${schedule.base_device_id}:${action}:${windowKey}`
}

function createAction(
  schedule: UptimeScheduleRow,
  action: UptimeScheduleActionKind,
  windowKey: string,
  now: Date,
  reason: string,
): UptimeScheduleAction {
  return {
    action,
    idempotencyKey: actionKey(schedule, action, windowKey),
    scheduledFor: now.toISOString(),
    windowKey,
    reason,
  }
}

export function evaluateUptimeSchedule(schedule: UptimeScheduleRow, now = new Date()): UptimeScheduleAction[] {
  if (schedule.enabled !== true) return []

  const state = getScheduleWindowState(schedule, now)
  const actions: UptimeScheduleAction[] = []

  if (state.active && state.windowKey) {
    if (schedule.wake_enabled === true && schedule.last_wake_window_key !== state.windowKey) {
      actions.push(createAction(schedule, 'wake', state.windowKey, now, 'window_start'))
    }
    if (schedule.last_start_window_key !== state.windowKey) {
      actions.push(createAction(schedule, 'start', state.windowKey, now, state.alwaysOn ? 'always_on' : 'window_start'))
    }
    return actions
  }

  if (!state.alwaysOn && state.previousWindowKey && schedule.last_start_window_key === state.previousWindowKey && schedule.last_stop_window_key !== state.previousWindowKey) {
    actions.push(createAction(schedule, 'stop', state.previousWindowKey, now, 'window_end'))
  }

  return actions
}
