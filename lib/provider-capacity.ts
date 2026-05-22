export type ProviderDeviceRow = {
  user_id: string
  device_id: string
  country_code: string
  relay_url: string | null
  health_score?: number | null
  provider_avg_mbps?: number | null
  provider_last_mbps?: number | null
  disconnect_count?: number | null
  reconnect_count?: number | null
  last_heartbeat?: string | null
}

export type SessionOccupancyRow = {
  provider_device_id: string | null
  provider_id?: string | null
}

export function buildOccupiedProviderDeviceSet(rows: SessionOccupancyRow[] | null | undefined): Set<string> {
  const occupied = new Set<string>()
  for (const row of rows ?? []) {
    if (!row?.provider_device_id) continue
    if (row.provider_id) occupied.add(providerDeviceKey(row.provider_id, row.provider_device_id))
    else occupied.add(row.provider_device_id)
  }
  return occupied
}

const SLOT_DEVICE_SUFFIX = /_slot_\d+$/

export function getProviderBaseDeviceId(deviceId: string): string {
  return deviceId.replace(SLOT_DEVICE_SUFFIX, '')
}

export function isProviderSlotDeviceId(deviceId: string): boolean {
  return SLOT_DEVICE_SUFFIX.test(deviceId)
}

function providerDeviceKey(userId: string, deviceId: string): string {
  return `${userId}:${deviceId}`
}

export function filterCanonicalProviderDeviceRows(
  devices: ProviderDeviceRow[] | null | undefined,
): ProviderDeviceRow[] {
  const rows = (devices ?? []).filter((device) => !!device?.device_id)
  const basesWithSlotRows = new Set<string>()

  for (const device of rows) {
    if (!isProviderSlotDeviceId(device.device_id)) continue
    basesWithSlotRows.add(providerDeviceKey(device.user_id, getProviderBaseDeviceId(device.device_id)))
  }

  return rows.filter((device) => {
    if (isProviderSlotDeviceId(device.device_id)) return true
    return !basesWithSlotRows.has(providerDeviceKey(device.user_id, device.device_id))
  })
}

export function buildProviderDeviceOccupancyLookupKeys(
  devices: ProviderDeviceRow[] | null | undefined,
): string[] {
  const keys = new Set<string>()
  for (const device of devices ?? []) {
    if (!device?.device_id) continue
    keys.add(device.device_id)
    if (isProviderSlotDeviceId(device.device_id)) {
      keys.add(getProviderBaseDeviceId(device.device_id))
    }
  }
  return [...keys]
}

function parseOccupiedDeviceKey(value: string): { userId: string | null; deviceId: string } {
  const separatorIndex = value.indexOf(':')
  if (separatorIndex <= 0) return { userId: null, deviceId: value }
  return {
    userId: value.slice(0, separatorIndex),
    deviceId: value.slice(separatorIndex + 1),
  }
}

function isOccupiedProviderDevice(device: ProviderDeviceRow, occupied: Set<string>): boolean {
  if (occupied.has(device.device_id)) return true
  if (occupied.has(providerDeviceKey(device.user_id, device.device_id))) return true

  for (const occupiedKey of occupied) {
    const { userId, deviceId: occupiedDeviceId } = parseOccupiedDeviceKey(occupiedKey)
    if (userId && userId !== device.user_id) continue
    if (isProviderSlotDeviceId(occupiedDeviceId)) continue
    if (device.device_id.startsWith(`${occupiedDeviceId}_slot_`)) return true
  }

  return false
}

export function filterAvailableProviderDevices(
  devices: ProviderDeviceRow[] | null | undefined,
  occupied: Set<string>,
): ProviderDeviceRow[] {
  return filterCanonicalProviderDeviceRows(devices)
    .filter((device) => !isOccupiedProviderDevice(device, occupied))
}
