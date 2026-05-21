import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildProviderDeviceOccupancyLookupKeys,
  buildOccupiedProviderDeviceSet,
  filterAvailableProviderDevices,
  filterCanonicalProviderDeviceRows,
  getProviderBaseDeviceId,
  isProviderSlotDeviceId,
} from '../lib/provider-capacity.ts'

test('buildOccupiedProviderDeviceSet ignores null provider slots', () => {
  const occupied = buildOccupiedProviderDeviceSet([
    { provider_id: 'u1', provider_device_id: 'slot_a' },
    { provider_device_id: null },
    { provider_device_id: 'slot_b' },
  ])

  assert.deepEqual([...occupied].sort(), ['slot_b', 'u1:slot_a'])
})

test('filterAvailableProviderDevices removes occupied devices from counts', () => {
  const devices = [
    { user_id: 'u1', device_id: 'slot_a', country_code: 'US', relay_url: 'wss://relay-a' },
    { user_id: 'u2', device_id: 'slot_b', country_code: 'US', relay_url: 'wss://relay-b' },
    { user_id: 'u3', device_id: 'slot_c', country_code: 'NG', relay_url: null },
  ]
  const occupied = new Set(['slot_b'])

  const available = filterAvailableProviderDevices(devices, occupied)

  assert.deepEqual(available.map((device) => device.device_id), ['slot_a', 'slot_c'])
})

test('provider slot helpers recognize slot ids and base ids', () => {
  assert.equal(isProviderSlotDeviceId('pm_base_slot_0'), true)
  assert.equal(isProviderSlotDeviceId('pm_base'), false)
  assert.equal(getProviderBaseDeviceId('pm_base_slot_31'), 'pm_base')
})

test('filterCanonicalProviderDeviceRows drops legacy base rows when slot rows exist', () => {
  const devices = [
    { user_id: 'u1', device_id: 'pm_base', country_code: 'US', relay_url: 'wss://relay-a' },
    { user_id: 'u1', device_id: 'pm_base_slot_0', country_code: 'US', relay_url: 'wss://relay-a' },
    { user_id: 'u1', device_id: 'pm_base_slot_1', country_code: 'US', relay_url: 'wss://relay-a' },
    { user_id: 'u2', device_id: 'legacy_base', country_code: 'US', relay_url: 'wss://relay-b' },
  ]

  const canonical = filterCanonicalProviderDeviceRows(devices)

  assert.deepEqual(canonical.map((device) => device.device_id), ['pm_base_slot_0', 'pm_base_slot_1', 'legacy_base'])
})

test('legacy base occupancy hides all slot rows for the same base device', () => {
  const devices = [
    { user_id: 'u1', device_id: 'pm_base_slot_0', country_code: 'US', relay_url: 'wss://relay-a' },
    { user_id: 'u1', device_id: 'pm_base_slot_1', country_code: 'US', relay_url: 'wss://relay-a' },
    { user_id: 'u2', device_id: 'other_base_slot_0', country_code: 'US', relay_url: 'wss://relay-b' },
  ]

  const available = filterAvailableProviderDevices(devices, new Set(['pm_base']))

  assert.deepEqual(available.map((device) => device.device_id), ['other_base_slot_0'])
})

test('provider-scoped legacy base occupancy only hides matching user slots', () => {
  const devices = [
    { user_id: 'u1', device_id: 'shared_base_slot_0', country_code: 'US', relay_url: 'wss://relay-a' },
    { user_id: 'u2', device_id: 'shared_base_slot_0', country_code: 'US', relay_url: 'wss://relay-b' },
  ]

  const occupied = buildOccupiedProviderDeviceSet([
    { provider_id: 'u1', provider_device_id: 'shared_base' },
  ])
  const available = filterAvailableProviderDevices(devices, occupied)

  assert.deepEqual(available.map((device) => `${device.user_id}:${device.device_id}`), ['u2:shared_base_slot_0'])
})

test('buildProviderDeviceOccupancyLookupKeys includes legacy base keys for slot rows', () => {
  const keys = buildProviderDeviceOccupancyLookupKeys([
    { user_id: 'u1', device_id: 'pm_base_slot_0', country_code: 'US', relay_url: 'wss://relay-a' },
    { user_id: 'u1', device_id: 'pm_base_slot_1', country_code: 'US', relay_url: 'wss://relay-a' },
    { user_id: 'u2', device_id: 'legacy_base', country_code: 'US', relay_url: 'wss://relay-b' },
  ])

  assert.deepEqual(keys.sort(), ['legacy_base', 'pm_base', 'pm_base_slot_0', 'pm_base_slot_1'])
})
