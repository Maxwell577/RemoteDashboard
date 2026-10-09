'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  api,
  type Device,
  type TelemetryAllSeries,
  type TelemetryDeviceSeries,
  type TelemetryPoint,
} from '@/lib/types'
import { useDash } from '@/lib/store'

/** One averaged, bucketed utilization sample. */
export interface TelemetryBucket {
  t: number
  cpu: number
  memory: number
  disk: number
}

interface UseTelemetryHistoryOpts {
  /** Omit for cluster-wide aggregation across all reporting devices. */
  deviceId?: string
  /** History window in minutes (server caps at 120, persisted window is 2h). */
  minutes?: number
  /** Bucket width in ms (averaging). Default 30s. */
  bucketMs?: number
}

const round1 = (n: number): number => Math.round(n * 10) / 10

/**
 * Telemetry history with a live tail.
 *
 * - Backfills from GET /api/metrics/history (DB-persisted heartbeat samples,
 *   pruned to 2h) and refetches every 60s.
 * - Appends incoming realtime `metrics:update` telemetry (resolved to Device.id)
 *   so the chart extends seamlessly between refetches.
 * - Buckets samples (default 30s): single-device mode averages within the
 *   bucket; cluster mode averages across every device reporting in the bucket.
 */
export function useTelemetryHistory({
  deviceId,
  minutes = 30,
  bucketMs = 30_000,
}: UseTelemetryHistoryOpts): {
  data: TelemetryBucket[]
  loading: boolean
  error: string | null
  /** devices that actually contributed samples to the current window */
  devicesReporting: number
} {
  const metricsByDevice = useDash((s) => s.metricsByDevice)
  const qc = useQueryClient()

  const key = deviceId ?? 'all'
  const { data, isLoading, error } = useQuery({
    queryKey: ['metrics-history', key, minutes],
    queryFn: () =>
      deviceId
        ? api<TelemetryDeviceSeries>(
            `/api/metrics/history?deviceId=${encodeURIComponent(deviceId)}&minutes=${minutes}`,
          ).then((r) => ({ [r.deviceId]: r.points }))
        : api<TelemetryAllSeries>(`/api/metrics/history?minutes=${minutes}`).then(
            (r) => r.series,
          ),
    refetchInterval: 60_000,
    staleTime: 30_000,
  })

  // live tail — realtime metrics keyed by raw store id (normalized in the memo)
  const liveRef = useRef<Record<string, TelemetryPoint[]>>({})
  const [liveV, setLiveV] = useState(0)
  useEffect(() => {
    let added = 0
    for (const [rawId, m] of Object.entries(metricsByDevice)) {
      if (!m) continue
      const t = Date.parse(m.capturedAt)
      if (!Number.isFinite(t)) continue
      const arr = (liveRef.current[rawId] ??= [])
      if (arr.length > 0 && arr[arr.length - 1].t >= t) continue
      arr.push({ t, cpu: m.cpuPercent, memory: m.memoryPercent, disk: m.diskPercent })
      if (arr.length > 600) arr.splice(0, arr.length - 600)
      added += 1
    }
    if (added > 0) setLiveV((v) => v + 1)
  }, [metricsByDevice])

  // periodic tick so old buckets age out even without fresh telemetry
  useEffect(() => {
    const id = setInterval(() => setLiveV((v) => v + 1), bucketMs)
    return () => clearInterval(id)
  }, [bucketMs])

  const buckets = useMemo(() => {
    void liveV // recompute on new telemetry and on bucket aging
    // Metrics live under BOTH keys in the store (Device.id + agentId) —
    // normalize aliases to Device.id here using the fresh devices cache.
    const devices = qc.getQueryData<Device[]>(['devices'])
    const resolve = (id: string): string =>
      devices?.find((d) => d.id === id || d.agentId === id)?.id ?? id
    const live: Record<string, TelemetryPoint[]> = {}
    for (const [rawId, pts] of Object.entries(liveRef.current)) {
      const id = resolve(rawId)
      const arr = (live[id] ??= [])
      for (const p of pts) {
        if (!arr.some((x) => x.t === p.t)) arr.push(p)
      }
    }

    const cutoff = Date.now() - minutes * 60_000
    const ids = deviceId
      ? [deviceId]
      : Array.from(new Set([...Object.keys(data ?? {}), ...Object.keys(live)]))

    const perDevice: TelemetryPoint[][] = []
    for (const id of ids) {
      const merged = [...(data?.[id] ?? []), ...(live[id] ?? [])]
        .filter((p) => p.t >= cutoff - bucketMs)
        .sort((a, b) => a.t - b.t)
      if (merged.length > 0) perDevice.push(merged)
    }
    const contributing = perDevice.length
    if (contributing === 0) return { out: [], contributing }

    const rawBuckets = new Map<number, { s: [number, number, number]; n: number }>()
    const addTo = (t: number, cpu: number, memory: number, disk: number): void => {
      const k = Math.floor(t / bucketMs) * bucketMs
      const b = rawBuckets.get(k) ?? { s: [0, 0, 0], n: 0 }
      b.s[0] += cpu
      b.s[1] += memory
      b.s[2] += disk
      b.n += 1
      rawBuckets.set(k, b)
    }
    for (const pts of perDevice) {
      for (const p of pts) addTo(p.t, p.cpu, p.memory, p.disk)
    }
    const out = [...rawBuckets.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([t, b]) => ({
        t,
        cpu: round1(b.s[0] / b.n),
        memory: round1(b.s[1] / b.n),
        disk: round1(b.s[2] / b.n),
      }))
    return { out, contributing }
  }, [data, deviceId, minutes, bucketMs, liveV, qc])

  return {
    data: buckets.out,
    loading: isLoading,
    error: error ? (error as Error).message : null,
    devicesReporting: deviceId ? (buckets.out.length > 0 ? 1 : 0) : buckets.contributing,
  }
}

/**
 * Compact per-device CPU series for the Devices view sparklines.
 *
 * One shared query (GET /api/metrics/history?minutes=N) backfills the DB
 * window; incoming realtime telemetry is appended per device and everything
 * is condensed into `cap` evenly spaced cpu values (oldest → newest).
 */
export function useTelemetrySparklines({
  minutes = 15,
  cap = 32,
}: {
  minutes?: number
  cap?: number
} = {}): {
  series: Record<string, number[]>
  loading: boolean
} {
  const metricsByDevice = useDash((s) => s.metricsByDevice)
  const qc = useQueryClient()

  const { data, isLoading } = useQuery({
    queryKey: ['metrics-history', 'sparks', minutes],
    queryFn: () =>
      api<TelemetryAllSeries>(`/api/metrics/history?minutes=${minutes}`).then((r) => r.series),
    refetchInterval: 60_000,
    staleTime: 30_000,
  })

  // live tail — same alias-normalization strategy as useTelemetryHistory
  const liveRef = useRef<Record<string, TelemetryPoint[]>>({})
  const [liveV, setLiveV] = useState(0)
  useEffect(() => {
    let added = 0
    for (const [rawId, m] of Object.entries(metricsByDevice)) {
      if (!m) continue
      const t = Date.parse(m.capturedAt)
      if (!Number.isFinite(t)) continue
      const arr = (liveRef.current[rawId] ??= [])
      if (arr.length > 0 && arr[arr.length - 1].t >= t) continue
      arr.push({ t, cpu: m.cpuPercent, memory: m.memoryPercent, disk: m.diskPercent })
      if (arr.length > 200) arr.splice(0, arr.length - 200)
      added += 1
    }
    if (added > 0) setLiveV((v) => v + 1)
  }, [metricsByDevice])

  const series = useMemo(() => {
    void liveV
    const devices = qc.getQueryData<Device[]>(['devices'])
    const resolve = (id: string): string =>
      devices?.find((d) => d.id === id || d.agentId === id)?.id ?? id

    const cutoff = Date.now() - minutes * 60_000
    const ids = Array.from(new Set([...Object.keys(data ?? {}), ...Object.keys(liveRef.current)]))
    const out: Record<string, number[]> = {}
    for (const rawId of ids) {
      const id = resolve(rawId)
      const merged = [...(data?.[rawId] ?? []), ...(liveRef.current[rawId] ?? [])]
        .filter((p) => p.t >= cutoff)
        .sort((a, b) => a.t - b.t)
      if (merged.length < 2) continue
      // condense into `cap` evenly spaced slices — last value per slice
      const width = (minutes * 60_000) / cap
      const vals: number[] = []
      for (let i = 0; i < cap; i += 1) {
        const from = cutoff + i * width
        const to = from + width
        let v: number | null = null
        for (const p of merged) {
          if (p.t >= from && p.t < to) v = round1(p.cpu)
        }
        if (v != null) vals.push(v)
      }
      if (vals.length >= 2) out[id] = vals
    }
    return out
  }, [data, minutes, cap, liveV, qc])

  return { series, loading: isLoading }
}
