'use client'

import { create } from 'zustand'
import type { DeviceMetrics } from '@/lib/types'

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
  /** unread alert counter for the bell badge */
  unreadAlerts: number
  bumpUnreadAlerts: () => void
  clearUnreadAlerts: () => void
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
    set((s) => ({ metricsByDevice: { ...s.metricsByDevice, [m.deviceId]: m } })),
  unreadAlerts: 0,
  bumpUnreadAlerts: () => set((s) => ({ unreadAlerts: s.unreadAlerts + 1 })),
  clearUnreadAlerts: () => set({ unreadAlerts: 0 }),
}))
