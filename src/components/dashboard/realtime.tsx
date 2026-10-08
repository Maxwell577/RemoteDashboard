'use client'

import { useEffect, useRef } from 'react'
import { io, type Socket } from 'socket.io-client'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useDash } from '@/lib/store'
import { playAlertSound, playPresenceSound } from '@/lib/alert-sound'
import type { Alert, Device, DeviceMetrics, ScreenFrame } from '@/lib/types'

/**
 * Mounted once inside the dashboard shell.
 * Bridges hub socket events → react-query cache invalidation,
 * live metrics store, toast notifications and hub-status polling.
 */
export default function Realtime() {
  const qc = useQueryClient()
  const setMetrics = useDash((s) => s.setMetrics)
  const setHubOnline = useDash((s) => s.setHubOnline)
  const bumpUnread = useDash((s) => s.bumpUnreadAlerts)
  const setLiveFrame = useDash((s) => s.setLiveFrame)
  // last seen online/offline status per device key — used to detect
  // presence transitions (only events observed while this tab is open)
  const prevStatus = useRef<Map<string, 'online' | 'offline'>>(new Map())

  useEffect(() => {
    const socket: Socket = io('/?XTransformPort=3003', { path: '/' })

    socket.on('connect', () => {
      socket.emit('dashboard:join')
      qc.invalidateQueries({ queryKey: ['devices'] })
    })
    socket.on('disconnect', () => setHubOnline(false))

    socket.on('device:update', (p: { device: Device }) => {
      const d = p?.device
      qc.invalidateQueries({ queryKey: ['devices'] })
      if (!d || !d.status) return
      // the offline event is partial ({ agentId, status }) — resolve a
      // human name from the devices cache when possible
      const key = d.agentId ?? d.id
      if (!key) return
      const prev = prevStatus.current.get(key)
      prevStatus.current.set(key, d.status)
      if (prev === d.status) return
      const cached = qc.getQueryData<Device[]>(['devices'])
      const known =
        cached?.find((x) => x.agentId === d.agentId || x.id === d.id) ?? null
      const hostname = d.hostname ?? known?.hostname ?? d.agentId ?? 'A device'
      // maintenance window — no presence noise for machines under planned work
      if (known?.maintenance) return
      const up = d.status === 'online'
      if (up) {
        toast.success(`${hostname} is online`, {
          description: 'agent connected to the hub',
        })
      } else {
        toast.warning(`${hostname} went offline`, {
          description: 'agent stopped checking in',
        })
      }
      if (useDash.getState().presenceSound) playPresenceSound(up)
    })

    socket.on('metrics:update', (p: { metrics: DeviceMetrics }) => {
      const m = p?.metrics
      if (!m?.deviceId) return
      // Metrics may arrive keyed by agentId (e.g. SIM-WKS-001) — the UI looks
      // devices up by DB id, so store the entry under BOTH keys when possible.
      const devices = qc.getQueryData<Device[]>(['devices'])
      const dev = devices?.find((d) => d.id === m.deviceId || d.agentId === m.deviceId)
      setMetrics(m)
      if (dev && dev.id !== m.deviceId) setMetrics({ ...m, deviceId: dev.id })
    })

    socket.on('command:result', () => {
      qc.invalidateQueries({ queryKey: ['commands'] })
    })

    socket.on('media:update', () => {
      qc.invalidateQueries({ queryKey: ['media'] })
    })

    socket.on('network:update', () => {
      qc.invalidateQueries({ queryKey: ['network'] })
    })

    socket.on('alert:new', (p: { alert: Alert }) => {
      const a = p?.alert
      if (!a) return
      if (a.severity === 'critical') toast.error(a.title, { description: a.message })
      else if (a.severity === 'warning') toast.warning(a.title, { description: a.message })
      else toast.info(a.title, { description: a.message })
      if (useDash.getState().alertSound) playAlertSound(a.severity)
      qc.invalidateQueries({ queryKey: ['alerts'] })
      bumpUnread()
    })

    // Live screen viewer stream — frames arrive keyed by agentId; also store
    // under the DB id so the media view can filter by selectedDeviceId.
    socket.on('screen:frame', (p: ScreenFrame) => {
      if (!p?.agentId || typeof p.dataUri !== 'string') return
      setLiveFrame(p)
      const devices = qc.getQueryData<Device[]>(['devices'])
      const dev = devices?.find((d) => d.agentId === p.agentId)
      if (dev && dev.id !== p.agentId) setLiveFrame({ ...p, agentId: dev.id })
    })

    return () => {
      socket.close()
    }
  }, [qc, setMetrics, setHubOnline, bumpUnread, setLiveFrame])

  // poll hub status every 30s
  useEffect(() => {
    let alive = true
    const check = async () => {
      try {
        const res = await fetch('/api/hub/status')
        const json = (await res.json()) as { ok: boolean; data?: { online: boolean } }
        if (alive) setHubOnline(Boolean(json?.data?.online))
      } catch {
        if (alive) setHubOnline(false)
      }
    }
    check()
    const t = setInterval(check, 30000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [setHubOnline])

  return null
}
