import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isPrivateShareActive,
  shouldDeleteStalePrivateShareSlot,
} from '../lib/private-sharing.ts'

test('private share activity treats no-expiry enabled codes as active', () => {
  assert.equal(isPrivateShareActive(true, null), true)
  assert.equal(isPrivateShareActive(true, ''), true)
  assert.equal(isPrivateShareActive(false, null), false)
})

test('stale slot cleanup only deletes inactive private share rows', () => {
  const now = Date.parse('2026-05-27T12:00:00.000Z')
  const future = new Date(now + 60_000).toISOString()
  const past = new Date(now - 60_000).toISOString()

  assert.equal(shouldDeleteStalePrivateShareSlot(true, null, now), false)
  assert.equal(shouldDeleteStalePrivateShareSlot(true, future, now), false)
  assert.equal(shouldDeleteStalePrivateShareSlot(false, null, now), true)
  assert.equal(shouldDeleteStalePrivateShareSlot(true, past, now), true)
})
