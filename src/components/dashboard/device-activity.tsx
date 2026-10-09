'use client'

import { useQuery } from '@tanstack/react-query'
import {
  Bell,
  Clapperboard,
  FolderTree,
  MapPin,
  RadioTower,
  SquareTerminal,
  type LucideIcon,
} from 'lucide-react'
import { api, type DeviceActivityEntry } from '@/lib/types'
import { cn } from '@/lib/utils'
import { timeAgoShort } from './shared'
import { LoadingBlock, ErrorBlock } from './shared'

const TYPE_META: Record<
  DeviceActivityEntry['type'],
  { icon: LucideIcon; chip: string; label: string }
> = {
  command: {
    icon: SquareTerminal,
    label: 'terminal',
    chip: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  },
  file: {
    icon: FolderTree,
    label: 'files',
    chip: 'border-teal-500/30 bg-teal-500/10 text-teal-600 dark:text-teal-400',
  },
  media: {
    icon: Clapperboard,
    label: 'media',
    chip: 'border-fuchsia-500/25 bg-fuchsia-500/10 text-fuchsia-600 dark:text-fuchsia-400',
  },
  network: {
    icon: RadioTower,
    label: 'network',
    chip: 'border-cyan-500/25 bg-cyan-500/10 text-cyan-600 dark:text-cyan-400',
  },
  location: {
    icon: MapPin,
    label: 'location',
    chip: 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  },
  alert: {
    icon: Bell,
    label: 'alert',
    chip: 'border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400',
  },
}

const STATUS_DOT: Record<string, string> = {
  completed: 'bg-emerald-500',
  ok: 'bg-emerald-500',
  available: 'bg-emerald-500',
  stopped: 'bg-teal-500',
  acked: 'bg-zinc-400',
  open: 'bg-rose-500 animate-pulse',
  running: 'bg-amber-500 animate-pulse',
  requested: 'bg-amber-500/70',
  capturing: 'bg-amber-500 animate-pulse',
  processing: 'bg-amber-500/70 animate-pulse',
  failed: 'bg-rose-500',
  timeout: 'bg-rose-500',
}

/**
 * Unified recent-activity timeline for one device (commands, files,
 * captures, pings, alerts) — rendered inside the device details dialog.
 */
export default function DeviceActivity({ deviceId }: { deviceId: string }) {
  const q = useQuery({
    queryKey: ['device-activity', deviceId],
    queryFn: () => api<DeviceActivityEntry[]>(`/api/devices/${deviceId}/activity?limit=14`),
    refetchInterval: 20_000,
  })

  if (q.isLoading) return <LoadingBlock label="Loading activity…" />
  if (q.isError)
    return (
      <ErrorBlock
        message={q.error instanceof Error ? q.error.message : 'Failed to load activity'}
      />
    )

  const entries = q.data ?? []

  if (entries.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-border/50 px-3 py-4 text-center text-xs text-muted-foreground">
        No recorded activity yet — run a command or take a capture and it will
        appear here.
      </p>
    )
  }

  return (
    <ol className="scroll-slim relative max-h-64 space-y-0 overflow-y-auto pr-1" aria-label="Recent device activity">
      {entries.map((e, i) => {
        const meta = TYPE_META[e.type]
        const Icon = meta.icon
        const dot = STATUS_DOT[e.status] ?? 'bg-zinc-400'
        const last = i === entries.length - 1
        return (
          <li key={e.id} className="relative flex gap-3 pb-3 last:pb-0">
            {/* connector line */}
            <span
              aria-hidden
              className={cn(
                'absolute left-[15px] top-8 w-px bg-border/50',
                last ? 'h-0' : 'h-[calc(100%-2rem)]',
              )}
            />
            {/* icon chip */}
            <span
              className={cn(
                'relative z-10 flex size-8 shrink-0 items-center justify-center rounded-lg border',
                meta.chip,
              )}
              title={meta.label}
            >
              <Icon className="size-3.5" aria-hidden />
              {/* status dot */}
              <span
                aria-hidden
                className={cn(
                  'absolute -right-0.5 -top-0.5 size-2 rounded-full ring-2 ring-background',
                  dot,
                )}
                title={e.status}
              />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <p className="truncate font-mono text-xs leading-snug" title={e.title}>
                  {e.title}
                </p>
                <span
                  className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70"
                  title={new Date(e.at).toLocaleString()}
                >
                  {timeAgoShort(e.at)}
                </span>
              </div>
              {e.detail ? (
                <p className="mt-0.5 truncate text-[11px] text-muted-foreground" title={e.detail}>
                  {e.detail}
                </p>
              ) : null}
            </div>
          </li>
        )
      })}
    </ol>
  )
}
