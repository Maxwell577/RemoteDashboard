'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Alert } from '@/lib/types'
import { useAlerts } from '@/components/dashboard/shared'

interface ReadState {
  lastReadAt: string | null
}

/**
 * Server-synced unread-alert state for the bell badge + alerts nav pill.
 *
 * Unread = unacknowledged alerts newer than the last "marked read" timestamp
 * persisted server-side (Setting "notifyReadAt" via /api/notifications/
 * read-state) — so opening the notification center on one browser clears the
 * badge everywhere, and a reload never resurrects stale unread counts.
 *
 * Realtime: `alert:new` invalidates the ['alerts'] cache, so the derived
 * count updates live without any store plumbing.
 */
export function useUnreadAlerts(): {
  unread: number
  lastReadAt: string | null
  markRead: () => void
  marking: boolean
} {
  const qc = useQueryClient()
  const { data: alertsData } = useAlerts(100)
  const { data: readState } = useQuery({
    queryKey: ['notify-read-state'],
    queryFn: () => api<ReadState>('/api/notifications/read-state'),
    staleTime: 15_000,
  })

  const mark = useMutation({
    mutationFn: () => api<ReadState>('/api/notifications/read-state', { method: 'POST' }),
    onMutate: () => {
      // optimistic — badge clears instantly
      qc.setQueryData<ReadState>(['notify-read-state'], {
        lastReadAt: new Date().toISOString(),
      })
    },
    onSuccess: (saved) => {
      qc.setQueryData<ReadState>(['notify-read-state'], saved)
    },
  })

  const alerts = alertsData ?? []
  const lastReadAt = readState?.lastReadAt ?? null
  const readMs = lastReadAt ? Date.parse(lastReadAt) : 0
  const unread = alerts.filter(
    (a: Alert) => !a.acknowledged && (!readMs || Date.parse(a.createdAt) > readMs),
  ).length

  return {
    unread,
    lastReadAt,
    markRead: () => mark.mutate(),
    marking: mark.isPending,
  }
}
