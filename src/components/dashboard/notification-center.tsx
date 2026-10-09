'use client'

import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { formatDistanceToNow } from 'date-fns'
import {
  Bell,
  BellRing,
  Check,
  CheckCheck,
  ChevronRight,
  Loader2,
  ShieldCheck,
} from 'lucide-react'
import { toast } from 'sonner'
import { api, type Alert } from '@/lib/types'
import { useDash } from '@/lib/store'
import { useAlerts } from './shared'
import { useUnreadAlerts } from '@/hooks/use-unread-alerts'
import { cn } from '@/lib/utils'
import { useMounted } from '@/hooks/use-mounted'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'

const SEVERITY_BADGE: Record<Alert['severity'], string> = {
  info: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  warning: 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  critical: 'border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400',
}

function timeAgo(iso: string): string {
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true })
  } catch {
    return '—'
  }
}

/**
 * Topbar notification center — a bell popover with the latest alerts,
 * per-alert acknowledge, ack-all and a jump into the full Alerts view.
 * Opening the popover clears the unread badge (the bell is the badge owner).
 */
export default function NotificationCenter() {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [ackId, setAckId] = useState<string | null>(null)
  // Radix Popover generates its content id via useId(); when the trigger is
  // server-rendered this was a recurring (flaky, React 19) hydration-mismatch
  // surface. SSR renders the identical-looking plain button — the interactive
  // Popover wrapper swaps in right after mount (zero visual change).
  const mounted = useMounted()

  // Live alerts for the panel — the always-mounted topbar owns the
  // ['alerts', 100] cache entry so the full Alerts view shares it for free.
  const { data: alertsData } = useAlerts(100)
  const alerts = alertsData ?? []
  const unack = alerts.filter((a) => !a.acknowledged)
  // server-synced unread state — persisted under Setting "notifyReadAt" so
  // marking read in one browser clears the badge everywhere
  const { unread, markRead } = useUnreadAlerts()
  const setView = useDash((s) => s.setView)

  const ack = useMutation({
    mutationFn: (id: string) =>
      api<Alert>(`/api/alerts/${id}/ack`, { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['alerts'] })
      qc.invalidateQueries({ queryKey: ['stats'] })
    },
    onSettled: () => setAckId(null),
    onError: (e) =>
      toast.error('Acknowledge failed', {
        description: e instanceof Error ? e.message : 'Request failed',
      }),
  })

  const ackAll = useMutation({
    mutationFn: async () => {
      const targets = [...unack]
      for (const a of targets) {
        await api<Alert>(`/api/alerts/${a.id}/ack`, { method: 'POST' })
      }
      return targets.length
    },
    onSuccess: (n) => {
      toast.success(`Acknowledged ${n} alert${n === 1 ? '' : 's'}`)
      qc.invalidateQueries({ queryKey: ['alerts'] })
      qc.invalidateQueries({ queryKey: ['stats'] })
    },
    onError: (e) =>
      toast.error('Ack-all failed', {
        description: e instanceof Error ? e.message : 'Request failed',
      }),
  })

  const openPanel = (next: boolean) => {
    setOpen(next)
    if (next) {
      // opening the panel = the operator has seen the badge (server-side,
      // optimistic — see useUnreadAlerts)
      markRead()
    }
  }

  const shown = [...unack, ...alerts.filter((a) => a.acknowledged)].slice(0, 8)

  const bellButton = (
    <Button
      variant="ghost"
      size="icon"
      className="relative size-11"
      aria-label={`Notifications${unread > 0 ? ` (${unread} unread)` : ''}`}
    >
      {unread > 0 ? (
        <BellRing className="size-[18px] text-emerald-600 dark:text-emerald-400" aria-hidden />
      ) : (
        <Bell className="size-[18px]" aria-hidden />
      )}
      {unread > 0 ? (
        <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold leading-none text-white">
          {unread > 99 ? '99+' : unread}
        </span>
      ) : null}
    </Button>
  )

  if (!mounted) return bellButton

  return (
    <Popover open={open} onOpenChange={openPanel}>
      <PopoverTrigger asChild>{bellButton}</PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="glass-overlay w-[min(92vw,380px)] rounded-2xl border-border/60 p-0"
      >
        {/* header */}
        <div className="flex items-center justify-between gap-2 px-4 pt-3.5 pb-2">
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold">Notifications</p>
            {unack.length > 0 ? (
              <Badge
                variant="outline"
                className="h-5 border-amber-500/30 bg-amber-500/10 px-1.5 text-[10px] text-amber-600 dark:text-amber-400"
              >
                {unack.length} unack
              </Badge>
            ) : (
              <Badge
                variant="outline"
                className="h-5 border-emerald-500/30 bg-emerald-500/10 px-1.5 text-[10px] text-emerald-600 dark:text-emerald-400"
              >
                all clear
              </Badge>
            )}
          </div>
          {unack.length > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 gap-1.5 text-xs text-muted-foreground"
              disabled={ackAll.isPending}
              onClick={() => ackAll.mutate()}
            >
              {ackAll.isPending ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
              ) : (
                <CheckCheck className="size-3.5" aria-hidden />
              )}
              Ack all
            </Button>
          ) : null}
        </div>
        <Separator className="bg-border/40" />

        {/* list */}
        <div className="scroll-slim max-h-80 overflow-y-auto p-2">
          {shown.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
              <ShieldCheck className="h-8 w-8 text-muted-foreground/60" aria-hidden />
              <p className="text-sm font-medium">Nothing to review</p>
              <p className="text-xs text-muted-foreground">
                New alerts will land here in real time.
              </p>
            </div>
          ) : (
            <ul className="flex flex-col gap-1">
              {shown.map((a) => (
                <li
                  key={a.id}
                  className={cn(
                    'group flex items-start gap-2.5 rounded-xl px-2.5 py-2 transition-colors',
                    a.acknowledged ? 'opacity-55' : 'hover:bg-primary/10',
                  )}
                >
                  <Badge
                    variant="outline"
                    className={cn('mt-0.5 shrink-0 capitalize', SEVERITY_BADGE[a.severity])}
                  >
                    {a.severity}
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium leading-snug" title={a.title}>
                      {a.title}
                    </p>
                    <p className="truncate text-xs text-muted-foreground" title={a.message}>
                      {a.message}
                    </p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground/70">
                      {timeAgo(a.createdAt)}
                    </p>
                  </div>
                  {!a.acknowledged ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8 shrink-0 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
                      aria-label={`Acknowledge: ${a.title}`}
                      disabled={ackId === a.id}
                      onClick={() => {
                        setAckId(a.id)
                        ack.mutate(a.id)
                      }}
                    >
                      {ackId === a.id ? (
                        <Loader2 className="size-3.5 animate-spin" aria-hidden />
                      ) : (
                        <Check className="size-3.5" aria-hidden />
                      )}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>

        <Separator className="bg-border/40" />
        {/* footer */}
        <div className="p-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-9 w-full justify-between gap-2 text-xs text-muted-foreground"
            onClick={() => {
              setOpen(false)
              setView('alerts')
            }}
          >
            Open full alerts view
            <ChevronRight className="size-3.5" aria-hidden />
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
