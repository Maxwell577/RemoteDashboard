'use client'

import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { format, formatDistanceToNow } from 'date-fns'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { api, type Alert, type Device } from '@/lib/types'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

// ─────────────────────────── formatting helpers ─────────────────────

export function fmtBytes(n?: number | null): string {
  if (n == null || Number.isNaN(n)) return '—'
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`
}

export function timeAgo(iso?: string | null): string {
  if (!iso) return 'never'
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true })
  } catch {
    return '—'
  }
}

/** Compact relative time for tight spaces: "42s", "7m", "3h", "2d" (never "just now"). */
export function timeAgoShort(iso?: string | null): string {
  if (!iso) return '—'
  try {
    const sec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
    if (sec < 60) return `${sec}s`
    const min = Math.floor(sec / 60)
    if (min < 60) return `${min}m`
    const h = Math.floor(min / 60)
    if (h < 24) return `${h}h`
    const d = Math.floor(h / 24)
    return `${d}d`
  } catch {
    return '—'
  }
}

export function fmtDate(iso?: string | null): string {
  if (!iso) return '—'
  try {
    return format(new Date(iso), 'yyyy-MM-dd HH:mm:ss')
  } catch {
    return '—'
  }
}

// ─────────────────────────── tiny UI atoms ──────────────────────────

export function StatusDot({
  online,
  pulse = true,
}: {
  online: boolean
  pulse?: boolean
}) {
  return (
    <span
      title={online ? 'Online' : 'Offline'}
      className={cn(
        'status-dot',
        online ? 'bg-emerald-500' : 'bg-zinc-400 dark:bg-zinc-600',
        !pulse && 'status-dot--static'
      )}
    />
  )
}

export function Panel({
  className,
  children,
  style,
}: {
  className?: string
  children: ReactNode
  style?: React.CSSProperties
}) {
  return <div className={cn('glass rounded-2xl', className)} style={style}>{children}</div>
}

export function SectionHeader({
  title,
  subtitle,
  icon,
  actions,
}: {
  title: string
  subtitle?: string
  icon?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-3">
        {icon ? (
          <div className="glass-inset flex h-10 w-10 items-center justify-center rounded-xl text-primary">
            {icon}
          </div>
        ) : null}
        <div>
          <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
          {subtitle ? (
            <p className="text-sm text-muted-foreground">{subtitle}</p>
          ) : null}
        </div>
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  )
}

export function EmptyState({
  icon,
  title,
  hint,
}: {
  icon?: ReactNode
  title: string
  hint?: string
}) {
  return (
    <div className="glass-inset flex flex-col items-center justify-center gap-3 rounded-2xl px-6 py-10 text-center">
      {icon ? (
        <div className="empty-state-art" aria-hidden>
          <div className="text-muted-foreground/80">{icon}</div>
        </div>
      ) : null}
      <p className="font-medium">{title}</p>
      {hint ? <p className="text-sm text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

export function LoadingBlock({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="glass-inset flex items-center justify-center gap-2 rounded-2xl px-6 py-10 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />
      {label}
    </div>
  )
}

export function ErrorBlock({ message }: { message: string }) {
  return (
    <div className="glass-inset rounded-2xl px-6 py-8 text-center text-sm text-destructive">
      {message}
    </div>
  )
}

// ─────────────────────────── data hooks ─────────────────────────────

export function useDevices() {
  return useQuery({
    queryKey: ['devices'],
    queryFn: () => api<Device[]>('/api/devices'),
    refetchInterval: 10000,
  })
}

export function useAlerts(limit = 100) {
  return useQuery({
    queryKey: ['alerts', limit],
    queryFn: () => api<Alert[]>(`/api/alerts?limit=${limit}`),
    refetchInterval: 30000,
  })
}

// ─────────────────────────── device selector ────────────────────────

export function DeviceSelector({
  value,
  onChange,
  className,
}: {
  value: string | null
  onChange: (deviceId: string | null) => void
  className?: string
}) {
  const { data: devices, isLoading } = useDevices()

  return (
    <Select
      // always a string — keeps the Select controlled for its whole lifetime
      // (passing `undefined` here flips it uncontrolled → controlled and logs a React warning)
      value={value ?? '__none'}
      onValueChange={(v) => onChange(v === '__none' ? null : v)}
    >
      <SelectTrigger className={cn('w-full sm:w-[280px]', className)} aria-label="Select device">
        <SelectValue
          placeholder={isLoading ? 'Loading devices…' : 'Select a device…'}
        />
      </SelectTrigger>
      <SelectContent className="glass-strong">
        <SelectItem value="__none" className="text-muted-foreground">
          {value ? 'No device selected' : 'Select a device…'}
        </SelectItem>
        {(devices ?? []).map((d) => (
          <SelectItem key={d.id} value={d.id}>
            <span className="inline-flex items-center gap-2">
              <StatusDot online={d.status === 'online'} pulse={false} />
              <span className="font-medium">{d.hostname}</span>
              <span className="text-xs text-muted-foreground">{d.osName}</span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
