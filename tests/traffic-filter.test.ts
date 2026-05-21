import test from 'node:test'
import assert from 'node:assert/strict'
import { checkRateLimit, clearRateLimit, isRequestAllowed } from '../lib/traffic-filter.ts'

test('checkRateLimit allows up to 100 requests per minute', () => {
  const sessionId = 'session-rate-limit-test'
  clearRateLimit(sessionId)

  for (let index = 0; index < 100; index++) {
    assert.equal(checkRateLimit(sessionId), true)
  }

  assert.equal(checkRateLimit(sessionId), false)
  clearRateLimit(sessionId)
})

test('isRequestAllowed blocks private targets and unsafe ports', () => {
  assert.equal(isRequestAllowed('example.com', 443), true)
  assert.equal(isRequestAllowed('example.com', 22), false)
  assert.equal(isRequestAllowed('localhost', 443), false)
  assert.equal(isRequestAllowed('127.0.0.1', 443), false)
  assert.equal(isRequestAllowed('0.0.0.0', 443), false)
  assert.equal(isRequestAllowed('169.254.169.254', 443), false)
  assert.equal(isRequestAllowed('100.64.0.1', 443), false)
  assert.equal(isRequestAllowed('::1', 443), false)
  assert.equal(isRequestAllowed('fc00::1', 443), false)
})
