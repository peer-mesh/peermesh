import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getBestRequestIp,
  getRequestIpCandidates,
  isPrivateIpAddress,
  normalizeCountryCode,
  normalizeIpAddress,
} from '../lib/ip-country.ts'

test('normalizeCountryCode rejects unknown and malformed country codes', () => {
  assert.equal(normalizeCountryCode('ng'), 'NG')
  assert.equal(normalizeCountryCode('XX'), null)
  assert.equal(normalizeCountryCode('T1'), null)
  assert.equal(normalizeCountryCode(''), null)
})

test('getBestRequestIp prefers the first public forwarded IP', () => {
  const req = new Request('https://example.test', {
    headers: {
      'x-forwarded-for': '10.0.0.5, 8.8.8.8',
    },
  })

  assert.equal(getBestRequestIp(req), '8.8.8.8')
})

test('getRequestIpCandidates parses Forwarded and IPv4-mapped values', () => {
  const req = new Request('https://example.test', {
    headers: {
      forwarded: 'for="[2001:4860:4860::8888]";proto=https, for=::ffff:192.168.1.20',
    },
  })

  assert.deepEqual(getRequestIpCandidates(req), ['2001:4860:4860::8888', '192.168.1.20'])
  assert.equal(getBestRequestIp(req), '2001:4860:4860::8888')
})

test('private IP helpers cover local IPv4 and IPv6 forms', () => {
  assert.equal(normalizeIpAddress('::ffff:127.0.0.1'), '127.0.0.1')
  assert.equal(isPrivateIpAddress('127.0.0.1'), true)
  assert.equal(isPrivateIpAddress('192.168.1.7'), true)
  assert.equal(isPrivateIpAddress('fd00::1'), true)
  assert.equal(isPrivateIpAddress('8.8.8.8'), false)
})
