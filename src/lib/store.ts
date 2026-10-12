'use client'

import { create } from 'zustand'
import type {
  DeviceMetrics,
  RecordingArtifact,
  ScreenFrame,
  ShellKind,
  StreamKind,
} from '@/lib/types'

export type ViewId =
  | 'overview'
  | 'devices'
  | 'terminal'
  | 'files'
  | 'processes'
  | 'media'
  | 'recordings'
  | 'network'
  | 'location'
  | 'alerts'
  | 'audit'
  | 'settings'

/** Terminal shell preference (persisted). "auto" = powershell with cmd fallback. */
export type ExecShellPref = ShellKind | 'auto'

/** One running multi-source stream (client-side registry, not persisted). */
export interface ActiveStream {
  streamId: string
  kind: StreamKind
  deviceId: string
  agentId: string
  sourceId: string | null
  /** human label resolved from device.captures ("Display 1 (primary)") */
  sourceName: string
  fps: number
  quality: string
  /** client epoch ms when the start call succeeded */
  startedAt: number
}

/** Latest frame per streamId (socket `stream:frame`) — only the newest is kept. */
export interface StreamFrameLite {
  dataUri?: string
  seq: number
  ts: number
  width?: number
  height?: number
  /** mic streams only: input level 0..1 */
  level?: number
  /** client epoch ms at arrival (drives fps/elapsed meters) */
  at: number
}

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
  /** utilization-history window in minutes (5|15|30|60|120, persisted) */
  histRange: number
  setHistRange: (v: number) => void
  /** pull all persisted prefs from localStorage after mount — see hydratePrefs */
  hydratePrefs: () => void
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
  /** terminal shell preference (persisted, hydration-safe — see hydratePrefs) */
  execShell: ExecShellPref
  setExecShell: (v: ExecShellPref) => void
  /** running multi-source streams, keyed by streamId (socket-driven) */
  activeStreams: Record<string, ActiveStream>
  addStream: (s: ActiveStream) => void
  removeStream: (streamId: string) => void
  /** latest frame per streamId (socket `stream:frame`) */
  streamFrames: Record<string, StreamFrameLite>
  setStreamFrame: (streamId: string, f: StreamFrameLite) => void
  /** live mirror of recording artifacts (socket `recording:update`), keyed by row id */
  recordingsLive: Record<string, RecordingArtifact>
  upsertRecording: (r: RecordingArtifact) => void
  dropRecording: (id: string) => void
}

const ALERT_SOUND_KEY = 'sentrarmm.alertSound'
const PRESENCE_SOUND_KEY = 'sentrarmm.presenceSound'
const DEVICE_SORT_KEY = 'sentrarmm.deviceSort'
const PINNED_KEY = 'sentrarmm.pinnedDevices'
const HIST_RANGE_KEY = 'sentrarmm.histRange'
const HIST_RANGE_ALLOWED = [5, 15, 30, 60, 120]
const DEVICE_SORT_ALLOWED: DeviceSort[] = ['hostname', 'health', 'lastSeen', 'cpu']
const EXEC_SHELL_KEY = 'sentrarmm.execShell'
const EXEC_SHELL_ALLOWED: ExecShellPref[] = ['powershell', 'cmd', 'auto']

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
  histRange: 30,
  setHistRange: (histRange) => {
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(HIST_RANGE_KEY, String(histRange))
      }
    } catch {
      // storage unavailable — in-memory only
    }
    set({ histRange })
  },
  hydratePrefs: () => {
    if (typeof window === 'undefined') return
    const patch: Partial<DashState> = {}
    try {
      const rawRange = Number(window.localStorage.getItem(HIST_RANGE_KEY))
      if (HIST_RANGE_ALLOWED.includes(rawRange)) patch.histRange = rawRange
    } catch {
      // storage unavailable — keep defaults
    }
    try {
      const rawSort = window.localStorage.getItem(DEVICE_SORT_KEY)
      if (rawSort && DEVICE_SORT_ALLOWED.includes(rawSort as DeviceSort)) {
        patch.deviceSort = rawSort as DeviceSort
      }
    } catch {
      // ignore
    }
    try {
      const rawPinned = window.localStorage.getItem(PINNED_KEY)
      if (rawPinned) {
        const parsed: unknown = JSON.parse(rawPinned)
        if (Array.isArray(parsed)) {
          patch.pinnedDevices = parsed.filter((v): v is string => typeof v === 'string')
        }
      }
    } catch {
      // ignore
    }
    try {
      if (window.localStorage.getItem(ALERT_SOUND_KEY) === 'off') patch.alertSound = false
    } catch {
      // ignore
    }
    try {
      if (window.localStorage.getItem(PRESENCE_SOUND_KEY) === 'on') patch.presenceSound = true
    } catch {
      // ignore
    }
    try {
      const rawShell = window.localStorage.getItem(EXEC_SHELL_KEY)
      if (rawShell && EXEC_SHELL_ALLOWED.includes(rawShell as ExecShellPref)) {
        patch.execShell = rawShell as ExecShellPref
      }
    } catch {
      // ignore
    }
    if (Object.keys(patch).length > 0) set(patch)
  },
  alertSound: true,
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
  presenceSound: false,
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
  deviceSort: 'hostname',
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
  pinnedDevices: [],
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
  execShell: 'powershell',
  setExecShell: (execShell) => {
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(EXEC_SHELL_KEY, execShell)
      }
    } catch {
      // storage unavailable — in-memory only
    }
    set({ execShell })
  },
  activeStreams: {},
  addStream: (s) =>
    set((state) => ({ activeStreams: { ...state.activeStreams, [s.streamId]: s } })),
  removeStream: (streamId) =>
    set((state) => {
      if (!(streamId in state.activeStreams) && !(streamId in state.streamFrames)) return state
      const { [streamId]: _gone, ...restFrames } = state.streamFrames
      return {
        activeStreams: Object.fromEntries(
          Object.entries(state.activeStreams).filter(([id]) => id !== streamId),
        ),
        streamFrames: restFrames,
      }
    }),
  streamFrames: {},
  setStreamFrame: (streamId, f) =>
    set((state) => ({ streamFrames: { ...state.streamFrames, [streamId]: f } })),
  recordingsLive: {},
  upsertRecording: (r) =>
    set((state) => {
      const prev = state.recordingsLive[r.id]
      // stale-arrival guard: never regress to an older artifact revision
      if (prev && new Date(prev.updatedAt).getTime() > new Date(r.updatedAt).getTime()) {
        return state
      }
      return { recordingsLive: { ...state.recordingsLive, [r.id]: r } }
    }),
  dropRecording: (id) =>
    set((state) => {
      if (!(id in state.recordingsLive)) return state
      const { [id]: _gone, ...rest } = state.recordingsLive
      return { recordingsLive: rest }
    }),
}))
