'use client'

import { create } from 'zustand'
import type { DeviceMetrics, ScreenFrame } from '@/lib/types'

export type ViewId =
  | 'overview'
  | 'devices'
  | 'terminal'
  | 'files'
  | 'processes'
  | 'media'
  | 'network'
  | 'location'
  | 'alerts'
  | 'audit'
  | 'settings'

/** Max CPU samples kept per device for the sparkline in the devices view. */
const HISTORY_CAP = 40

export type DeviceSort = 'hostname' | 'health' | 'lastSeen' | 'cpu'

interface DashState {
  /** currently visible view (client-side routing, single / route) */
  view: ViewId
  setView: (v: ViewId) => void
  /** device currently selected in DeviceSelector (shared across views) */
  selectedDeviceId: string | null
  setSelectedDeviceId: (id: string | null) => void
  /** hub connectivity (polled from /api/hub/status) */
  hubOnline: boolean
  setHubOnline: (v: boolean) => void
  /** latest live metrics per deviceId (pushed over socket) */
  metricsByDevice: Record<string, DeviceMetrics>
  setMetrics: (m: DeviceMetrics) => void
  /** rolling CPU% history per deviceId (sparkline), appended on every metrics push */
  cpuHistory: Record<string, number[]>
  /** live screen viewer — latest frame pushed by the agent (socket `screen:frame`) */
  liveFrame: ScreenFrame | null
  setLiveFrame: (f: ScreenFrame | null) => void
  /** unread alert counter for the bell badge */
  unreadAlerts: number
  bumpUnreadAlerts: () => void
  clearUnreadAlerts: () => void
  /** global command palette (⌘K) */
  paletteOpen: boolean
  setPaletteOpen: (v: boolean) => void
  /** keyboard-shortcuts help dialog ("?" / palette action) */
  helpOpen: boolean
  setHelpOpen: (v: boolean) => void
  /** audible blip on new realtime alerts (persisted to localStorage) */
  alertSound: boolean
  setAlertSound: (v: boolean) => void
  /** audible blip when a device connects or disconnects (persisted) */
  presenceSound: boolean
  setPresenceSound: (v: boolean) => void
  /** devices view ordering (persisted) */
  deviceSort: DeviceSort
  setDeviceSort: (v: DeviceSort) => void
  /** pinned device ids — always listed first in the Devices view (persisted) */
  pinnedDevices: string[]
  togglePinnedDevice: (id: string) => void
  /** one-shot command handed to the Terminal (palette "run again") */
  pendingCommand: { command: string; deviceId: string | null; nonce: number } | null
  setPendingCommand: (c: { command: string; deviceId: string | null } | null) => void
}

const ALERT_SOUND_KEY = 'sentrarmm.alertSound'
const PRESENCE_SOUND_KEY = 'sentrarmm.presenceSound'
const DEVICE_SORT_KEY = 'sentrarmm.deviceSort'
const PINNED_KEY = 'sentrarmm.pinnedDevices'

function initialDeviceSort(): DeviceSort {
  if (typeof window === 'undefined') return 'hostname'
  try {
    const raw = window.localStorage.getItem(DEVICE_SORT_KEY)
    const allowed: DeviceSort[] = ['hostname', 'health', 'lastSeen', 'cpu']
    return allowed.includes(raw as DeviceSort) ? (raw as DeviceSort) : 'hostname'
  } catch {
    return 'hostname'
  }
}

function initialPinned(): string[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(PINNED_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

function initialAlertSound(): boolean {
  if (typeof window === 'undefined') return true
  try {
    return window.localStorage.getItem(ALERT_SOUND_KEY) !== 'off'
  } catch {
    return true
  }
}

function initialPresenceSound(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(PRESENCE_SOUND_KEY) === 'on'
  } catch {
    return false
  }
}

export const useDash = create<DashState>((set) => ({
  view: 'overview',
  setView: (view) => set({ view }),
  selectedDeviceId: null,
  setSelectedDeviceId: (selectedDeviceId) => set({ selectedDeviceId }),
  hubOnline: false,
  setHubOnline: (hubOnline) => set({ hubOnline }),
  metricsByDevice: {},
  setMetrics: (m) =>
    set((s) => {
      const prev = s.cpuHistory[m.deviceId] ?? []
      const next = [...prev, m.cpuPercent].slice(-HISTORY_CAP)
      return {
        metricsByDevice: { ...s.metricsByDevice, [m.deviceId]: m },
        cpuHistory: { ...s.cpuHistory, [m.deviceId]: next },
      }
    }),
  cpuHistory: {},
  liveFrame: null,
  setLiveFrame: (liveFrame) => set({ liveFrame }),
  unreadAlerts: 0,
  bumpUnreadAlerts: () => set((s) => ({ unreadAlerts: s.unreadAlerts + 1 })),
  clearUnreadAlerts: () => set({ unreadAlerts: 0 }),
  alertSound: initialAlertSound(),
  paletteOpen: false,
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  helpOpen: false,
  setHelpOpen: (helpOpen) => set({ helpOpen }),
  setAlertSound: (alertSound) => {
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(ALERT_SOUND_KEY, alertSound ? 'on' : 'off')
      }
    } catch {
      // storage unavailable (private mode) — in-memory only
    }
    set({ alertSound })
  },
  presenceSound: initialPresenceSound(),
  setPresenceSound: (presenceSound) => {
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(PRESENCE_SOUND_KEY, presenceSound ? 'on' : 'off')
      }
    } catch {
      // storage unavailable (private mode) — in-memory only
    }
    set({ presenceSound })
  },
  deviceSort: initialDeviceSort(),
  setDeviceSort: (deviceSort) => {
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(DEVICE_SORT_KEY, deviceSort)
      }
    } catch {
      // storage unavailable — in-memory only
    }
    set({ deviceSort })
  },
  pinnedDevices: initialPinned(),
  togglePinnedDevice: (id) =>
    set((s) => {
      const next = s.pinnedDevices.includes(id)
        ? s.pinnedDevices.filter((p) => p !== id)
        : [...s.pinnedDevices, id]
      try {
        if (typeof window !== 'undefined') {
          window.localStorage.setItem(PINNED_KEY, JSON.stringify(next))
        }
      } catch {
        // storage unavailable — in-memory only
      }
      return { pinnedDevices: next }
    }),
  pendingCommand: null,
  setPendingCommand: (c) =>
    set({ pendingCommand: c ? { ...c, nonce: Date.now() } : null }),
}))
