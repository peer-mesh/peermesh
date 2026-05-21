const { contextBridge, ipcRenderer } = require('electron')

let _version = ''
try { _version = require('./package.json').version } catch {}

contextBridge.exposeInMainWorld('peermesh', {
  version: _version,
  getState: () => ipcRenderer.invoke('get-state'),
  getExtId: () => ipcRenderer.invoke('get-ext-id'),
  checkWebsiteAuth: () => ipcRenderer.invoke('check-website-auth'),
  openAuth: (url) => ipcRenderer.invoke('open-auth', url),
  signIn: (data) => ipcRenderer.invoke('sign-in', data),
  toggleSharing: () => ipcRenderer.invoke('toggle-sharing'),
  setLaunchOnStartup: (enabled) => ipcRenderer.invoke('set-launch-on-startup', enabled),
  setAutoShareOnLaunch: (enabled) => ipcRenderer.invoke('set-auto-share-on-launch', enabled),
  setPreventSleepWhileSharing: (enabled) => ipcRenderer.invoke('set-prevent-sleep-while-sharing', enabled),
  setSharingSchedule: (schedule) => ipcRenderer.invoke('set-sharing-schedule', schedule),
  setScheduleWakeEnabled: (enabled) => ipcRenderer.invoke('set-schedule-wake-enabled', enabled),
  setOnDemandWakeEnabled: (enabled) => ipcRenderer.invoke('set-on-demand-wake-enabled', enabled),
  setConnectionSlots: (slots) => ipcRenderer.invoke('set-connection-slots', slots),
  setDailyShareLimit: (limitMb) => ipcRenderer.invoke('set-daily-share-limit', limitMb),
  setSlotDailyLimit: (payload) => ipcRenderer.invoke('set-slot-daily-limit', payload),
  getPrivateShare: () => ipcRenderer.invoke('get-private-share'),
  updatePrivateShare: (payload) => ipcRenderer.invoke('update-private-share', payload),
  signOut: () => ipcRenderer.invoke('sign-out'),
  openDashboard: () => ipcRenderer.invoke('open-dashboard'),
  acceptProviderTerms: (opts) => ipcRenderer.invoke('accept-provider-terms', opts),
  requestDeviceCode: () => ipcRenderer.invoke('request-device-code'),
  pollDeviceCode: (device_code) => ipcRenderer.invoke('poll-device-code', { device_code }),
  onSharingError: (cb) => ipcRenderer.on('sharing-error', (_, message) => cb(message)),
})
