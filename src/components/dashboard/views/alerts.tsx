'use client'

import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { AlertTriangle, Bell, Check, Info, ShieldAlert, ShieldCheck, type LucideIcon } from 'lucide-react'
import { api, type Alert } from '@/lib/types'
import { cn } from '@/lib/utils'
import { EmptyState, ErrorBlock, LoadingBlock, Panel, SectionHeader, timeAgo, useDevices } from '../shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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

export default function AlertsView() {
  const qc = useQueryClient()
  const [unackOnly, setUnackOnly] = useState(true)
  const [ackAllBusy, setAckAllBusy] = useState(false)

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
          </>
        }
      />

      <Panel className="glass-hover overflow-hidden">
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
        ) : (
          <div className="max-h-[60vh] divide-y overflow-y-auto scroll-slim">
            {alerts.map((a) => {
              const meta = SEVERITY_META[a.severity] ?? SEVERITY_META.info
              const Icon = meta.icon
              const host = a.deviceId ? hostById.get(a.deviceId)?.hostname : null
              return (
                <div
                  key={a.id}
                  className={cn(
                    'glass-hover flex flex-col gap-3 p-4 sm:flex-row sm:items-center',
                    a.severity === 'critical' && !a.acknowledged
                      ? 'border-l-2 border-rose-500'
                      : undefined,
                    meta.tint && !a.acknowledged ? meta.tint : undefined
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
