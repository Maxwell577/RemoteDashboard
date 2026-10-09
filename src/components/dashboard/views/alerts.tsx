'use client'

import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  AlertTriangle,
  Bell,
  Check,
  Info,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  type LucideIcon,
} from 'lucide-react'
import { api, type Alert } from '@/lib/types'
import { cn } from '@/lib/utils'
import { EmptyState, ErrorBlock, LoadingBlock, Panel, SectionHeader, timeAgo, useDevices } from '../shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'

const SEVERITY_META: Record<
  Alert['severity'],
  { icon: LucideIcon; label: string; block: string; tint: string }
> = {
  info: {
    icon: Info,
    label: 'info',
    block: 'border-teal-500/30 bg-teal-500/10 text-teal-600 dark:text-teal-400',
    tint: '',
  },
  warning: {
    icon: AlertTriangle,
    label: 'warning',
    block: 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400',
    tint: '',
  },
  critical: {
    icon: ShieldAlert,
    label: 'critical',
    block: 'border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400',
    tint: 'bg-rose-500/5',
  },
}

type SeverityFilter = 'all' | 'critical' | 'warning' | 'info'

const FILTER_ORDER: SeverityFilter[] = ['all', 'critical', 'warning', 'info']

const FILTER_CHIP: Record<SeverityFilter, string> = {
  all: 'border-border/60 bg-background/60 text-foreground',
  critical: 'border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400',
  warning: 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  info: 'border-teal-500/30 bg-teal-500/10 text-teal-600 dark:text-teal-400',
}

export default function AlertsView() {
  const qc = useQueryClient()
  const [unackOnly, setUnackOnly] = useState(true)
  const [ackAllBusy, setAckAllBusy] = useState(false)
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>('all')

  const { data: devices } = useDevices()
  const hostById = useMemo(() => new Map((devices ?? []).map((d) => [d.id, d])), [devices])

  const alertsQuery = useQuery({
    queryKey: ['alerts', unackOnly],
    queryFn: () =>
      api<Alert[]>(`/api/alerts?limit=100${unackOnly ? '&unackOnly=1' : ''}`),
    refetchInterval: 30_000,
  })

  const alerts = alertsQuery.data ?? []
  const unackedCount = alerts.filter((a) => !a.acknowledged).length
  const ackedCount = alerts.filter((a) => a.acknowledged).length

  // severity counts over the loaded set (live on both unack and history lists)
  const severityCounts = useMemo(() => {
    const c: Record<SeverityFilter, number> = { all: alerts.length, critical: 0, warning: 0, info: 0 }
    for (const a of alerts) {
      if (a.severity === 'critical') c.critical++
      else if (a.severity === 'warning') c.warning++
      else c.info++
    }
    return c
  }, [alerts])

  const visible =
    severityFilter === 'all' ? alerts : alerts.filter((a) => a.severity === severityFilter)

  const clearAcked = useMutation({
    mutationFn: () => api<{ deleted: number }>('/api/alerts/clear-acked', { method: 'POST' }),
    onSuccess: (r) => {
      toast.success(
        r.deleted > 0
          ? `Cleared ${r.deleted} acknowledged alert${r.deleted === 1 ? '' : 's'}`
          : 'Nothing to clear',
      )
      qc.invalidateQueries({ queryKey: ['alerts'] })
      qc.invalidateQueries({ queryKey: ['stats'] })
      qc.invalidateQueries({ queryKey: ['audit'] })
    },
    onError: (e) =>
      toast.error('Failed to clear acknowledged alerts', {
        description: e instanceof Error ? e.message : 'Unknown error',
      }),
  })

  const ack = useMutation({
    mutationFn: (id: string) => api<Alert>(`/api/alerts/${id}/ack`, { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['alerts'] })
      toast.success('Alert acknowledged')
    },
    onError: (e) =>
      toast.error('Failed to acknowledge', {
        description: e instanceof Error ? e.message : 'Unknown error',
      }),
  })

  async function ackAllVisible() {
    const targets = alerts.filter((a) => !a.acknowledged)
    if (targets.length === 0) {
      toast.info('Nothing to acknowledge')
      return
    }
    setAckAllBusy(true)
    let done = 0
    try {
      for (const a of targets) {
        try {
          await api<Alert>(`/api/alerts/${a.id}/ack`, { method: 'POST' })
          done++
        } catch {
          // keep acknowledging the rest
        }
      }
      if (done > 0) {
        toast.success(`Acknowledged ${done} alert${done === 1 ? '' : 's'}`)
        qc.invalidateQueries({ queryKey: ['alerts'] })
      } else {
        toast.error('Could not acknowledge alerts')
      }
    } finally {
      setAckAllBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader
        title="Alerts"
        subtitle="Security and fleet events requiring attention"
        icon={<Bell className="h-5 w-5" />}
        actions={
          <>
            <div className="glass-inset flex min-h-11 items-center gap-2 rounded-xl px-3">
              <Switch id="unack-only" checked={unackOnly} onCheckedChange={setUnackOnly} />
              <Label htmlFor="unack-only" className="cursor-pointer text-sm">
                Unack only
              </Label>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="h-11 md:h-9"
              disabled={ackAllBusy || unackedCount === 0}
              onClick={() => void ackAllVisible()}
            >
              <Check className="h-4 w-4" />
              {ackAllBusy ? 'Acknowledging…' : 'Ack all visible'}
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-11 border-rose-500/30 text-rose-600 hover:bg-rose-500/10 hover:text-rose-600 dark:text-rose-400 md:h-9"
                  disabled={clearAcked.isPending || (!unackOnly && ackedCount === 0)}
                  title={
                    unackOnly
                      ? 'Clears acknowledged alerts from history'
                      : `${ackedCount} acknowledged in this list`
                  }
                >
                  <Trash2 className="h-4 w-4" />
                  Clear acked
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent className="glass-strong">
                <AlertDialogHeader>
                  <AlertDialogTitle>Clear acknowledged alerts?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This permanently removes every acknowledged alert from the
                    history. Unacknowledged alerts are kept. This action cannot
                    be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    className="bg-rose-600 text-white hover:bg-rose-600/90"
                    onClick={() => clearAcked.mutate()}
                  >
                    Clear acknowledged
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </>
        }
      />

      <Panel className="glass-hover overflow-hidden">
        {/* severity filter toolbar */}
        {!alertsQuery.isLoading && !alertsQuery.isError && alerts.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2 border-b border-border/40 px-4 py-3">
            <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/70">
              Severity
            </span>
            {FILTER_ORDER.map((f) => {
              const active = severityFilter === f
              return (
                <button
                  key={f}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setSeverityFilter(f)}
                  className={cn(
                    'flex min-h-8 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium capitalize transition-all outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                    active
                      ? FILTER_CHIP[f] + ' shadow-sm'
                      : 'border-border/50 bg-background/40 text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                  )}
                >
                  {f}
                  <span className="rounded-full bg-background/60 px-1.5 text-[10px] tabular-nums text-muted-foreground">
                    {severityCounts[f]}
                  </span>
                </button>
              )
            })}
            <span className="ml-auto text-xs text-muted-foreground" aria-live="polite">
              showing {visible.length} of {alerts.length}
            </span>
          </div>
        ) : null}
        {alertsQuery.isLoading ? (
          <LoadingBlock label="Loading alerts…" />
        ) : alertsQuery.isError ? (
          <ErrorBlock
            message={
              alertsQuery.error instanceof Error ? alertsQuery.error.message : 'Failed to load alerts'
            }
          />
        ) : alerts.length === 0 ? (
          <EmptyState
            icon={<ShieldCheck className="h-10 w-10" />}
            title="All clear — no alerts"
            hint={
              unackOnly
                ? 'No unacknowledged alerts. Flip “Unack only” to see history.'
                : 'Nothing has been raised by the fleet yet.'
            }
          />
        ) : visible.length === 0 ? (
          <EmptyState
            icon={<ShieldCheck className="h-10 w-10" />}
            title={`No ${severityFilter} alerts`}
            hint="Try a different severity filter."
          />
        ) : (
          <div className="max-h-[60vh] divide-y overflow-y-auto scroll-slim">
            {visible.map((a) => {
              const meta = SEVERITY_META[a.severity] ?? SEVERITY_META.info
              const Icon = meta.icon
              const host = a.deviceId ? hostById.get(a.deviceId)?.hostname : null
              return (
                <div
                  key={a.id}
                  className={cn(
                    'glass-hover flex flex-col gap-3 border-l-2 p-4 sm:flex-row sm:items-center',
                    a.acknowledged
                      ? 'border-l-transparent'
                      : a.severity === 'critical'
                        ? 'border-l-rose-500'
                        : a.severity === 'warning'
                          ? 'border-l-amber-500'
                          : 'border-l-teal-500',
                    meta.tint && !a.acknowledged ? meta.tint : undefined,
                  )}
                >
                  <div
                    className={cn(
                      'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border',
                      a.acknowledged ? 'border-zinc-500/20 bg-zinc-500/5 text-zinc-500' : meta.block
                    )}
                  >
                    <Icon className="h-5 w-5" />
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-medium leading-tight">{a.title}</p>
                      <Badge
                        variant="outline"
                        className={cn(
                          'text-[10px]',
                          a.acknowledged
                            ? 'border-zinc-500/30 bg-zinc-500/10 text-zinc-500'
                            : meta.block
                        )}
                      >
                        {meta.label}
                      </Badge>
                    </div>
                    <p className="mt-0.5 text-sm text-muted-foreground">{a.message}</p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span className="font-medium text-foreground/70">{host ?? 'fleet'}</span>
                      <span aria-hidden>•</span>
                      <span title={a.createdAt}>{timeAgo(a.createdAt)}</span>
                    </div>
                  </div>

                  <div className="shrink-0 self-start sm:self-center">
                    {a.acknowledged ? (
                      <span className="text-xs text-muted-foreground">
                        Acked by admin • {timeAgo(a.acknowledgedAt ?? a.createdAt)}
                      </span>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-9"
                        disabled={ack.isPending}
                        onClick={() => ack.mutate(a.id)}
                      >
                        <Check className="h-3.5 w-3.5" /> Ack
                      </Button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </Panel>
    </div>
  )
}
