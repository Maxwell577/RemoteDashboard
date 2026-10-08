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
}

const ALERT_SOUND_KEY = 'sentrarmm.alertSound'

function initialAlertSound(): boolean {
  if (typeof window === 'undefined') return true
  try {
    return window.localStorage.getItem(ALERT_SOUND_KEY) !== 'off'
  } catch {
    return true
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
}))
