'use client'

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type RecordingArtifact } from '@/lib/types'
import { useDash } from '@/lib/store'

/**
 * TanStack query over GET /api/recordings, merged live with the zustand
 * mirror fed by socket `recording:update` (same pattern as the alerts
 * cache + realtime invalidation, plus a mirror so progress never waits
 * for the next poll).
 *
 * `retry: false` + `{ ...query, data }` keep the UI graceful while the
 * v0.3 backend routes are being deployed — the view renders its empty
 * state instead of an error wall.
 */
export function useRecordings(deviceId?: string | null, limit = 100) {
  const recordingsLive = useDash((s) => s.recordingsLive)

  const query = useQuery({
    queryKey: ['recordings', deviceId ?? 'all'],
    queryFn: () =>
      api<RecordingArtifact[]>(
        `/api/recordings?limit=${limit}${deviceId ? `&deviceId=${encodeURIComponent(deviceId)}` : ''}`,
      ),
    refetchInterval: 15000,
    staleTime: 10_000,
    retry: false,
  })

  const data = useMemo(() => {
    const byId = new Map<string, RecordingArtifact>()
    for (const r of query.data ?? []) byId.set(r.id, r)
    for (const r of Object.values(recordingsLive)) {
      if (deviceId && r.deviceId !== deviceId) continue
      const prev = byId.get(r.id)
      if (!prev || new Date(prev.updatedAt).getTime() <= new Date(r.updatedAt).getTime()) {
        byId.set(r.id, r)
      }
    }
    if (byId.size === 0) return (query.data ?? []) as RecordingArtifact[]
    return [...byId.values()].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    )
  }, [query.data, recordingsLive, deviceId])

  return { ...query, data }
}

/**
 * Fleet-wide count of active (armed + recording) artifacts for the
 * overview stats row. Returns 0 on error/while loading — the stat card
 * is hidden instead of showing a broken value.
 */
export function useActiveRecordingCount() {
  const recordingsLive = useDash((s) => s.recordingsLive)
  const query = useQuery({
    queryKey: ['recordings', 'all'],
    queryFn: () => api<RecordingArtifact[]>('/api/recordings?limit=100'),
    refetchInterval: 15000,
    staleTime: 10_000,
    retry: false,
  })

  const activeCount = useMemo(() => {
    // no early-return on error: the live mirror still counts if the poll
    // hiccups; when both are empty this is 0 and the card stays hidden
    const byId = new Map<string, RecordingArtifact>()
    for (const r of query.data ?? []) byId.set(r.id, r)
    for (const r of Object.values(recordingsLive)) {
      const prev = byId.get(r.id)
      if (!prev || new Date(prev.updatedAt).getTime() <= new Date(r.updatedAt).getTime()) {
        byId.set(r.id, r)
      }
    }
    return [...byId.values()].filter((r) => r.state === 'armed' || r.state === 'recording')
      .length
  }, [query.data, recordingsLive])

  return { query, activeCount }
}
