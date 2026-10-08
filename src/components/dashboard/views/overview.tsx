'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import {
  ArrowRight,
  Bell,
  Clapperboard,
  LayoutDashboard,
  MonitorSmartphone,
  RadioTower,
  ScrollText,
  ShieldCheck,
  SquareTerminal,
} from 'lucide-react'
import {
  api,
  type Alert,
  type AuditLog,
  type DashboardStats,
  type Device,
} from '@/lib/types'
import { useDash } from '@/lib/store'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { cn } from '@/lib/utils'
import {
  EmptyState,
  ErrorBlock,
  LoadingBlock,
  Panel,
  SectionHeader,
  StatusDot,
  timeAgo,
  timeAgoShort,
  useDevices,
} from '../shared'

const CPU_HISTORY = 40 // rolling buffer size (samples)
const NET_HISTORY = 40
const SAMPLE_MS = 5000

const SEVERITY_DOT: Record<AuditLog['severity'], string> = {
  info: 'bg-emerald-500',
  warning: 'bg-amber-500',
  critical: 'bg-red-500',
}

const SEVERITY_BADGE: Record<Alert['severity'], string> = {
  info: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  warning: 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  critical: 'border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400',
}

// ─────────────────────────── stat card atom ─────────────────────────

/** Smoothly animates between numeric values (ease-out, reduced-motion aware). */
function CountUp({ value, className }: { value: number; className?: string }) {
  // Ref-based tween: deps are [value] ONLY (state in deps would restart the
  // effect every frame and freeze the counter near its start value).
  const [shown, setShown] = useState(value)
  const fromRef = useRef(value)
  const rafRef = useRef(0)

  useEffect(() => {
    const from = fromRef.current
    if (from === value) return
    const reduce =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const DURATION = reduce ? 0 : 550
    const start = performance.now()
    const tick = (now: number) => {
      const t = DURATION === 0 ? 1 : Math.min(1, (now - start) / DURATION)
      const eased = 1 - Math.pow(1 - t, 3)
      const next = from + (value - from) * eased
      fromRef.current = next
      setShown(next)
      if (t < 1) rafRef.current = requestAnimationFrame(tick)
      else fromRef.current = value // land exactly on the target
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [value])

  // counters are non-negative by definition — clamp so a mid-flight
  // fractional state can never render as a negative stat
  const display = Number.isInteger(value)
    ? Math.max(0, Math.round(shown))
    : shown.toFixed(1)

  return <span className={className}>{display}</span>
}

function StatCard({
  icon,
  label,
  value,
  subtitle,
  tint = 'emerald',
}: {
  icon: ReactNode
  label: string
  value: ReactNode
  subtitle?: ReactNode
  tint?: 'emerald' | 'teal' | 'amber' | 'rose' | 'zinc'
}) {
  const tints = {
    emerald: 'text-emerald-600 dark:text-emerald-400 shadow-emerald-500/20',
    teal: 'text-teal-600 dark:text-teal-400 shadow-teal-500/20',
    amber: 'text-amber-600 dark:text-amber-400 shadow-amber-500/20',
    rose: 'text-rose-600 dark:text-rose-400 shadow-rose-500/20',
    zinc: 'text-zinc-500 dark:text-zinc-400',
  } as const
  return (
    <Panel className="card-sheen glass-hover group relative overflow-hidden p-4 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-primary/5">
      {/* corner sheen for the liquid-glass look */}
      <div
        aria-hidden
        className="pointer-events-none absolute -right-8 -top-8 h-24 w-24 rounded-full bg-primary/5 blur-2xl transition-opacity duration-300 group-hover:bg-primary/10"
      />
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <span
          className={cn(
            'glass-inset flex h-7 w-7 shrink-0 items-center justify-center rounded-lg shadow-sm transition-transform duration-300 group-hover:scale-110 [&_svg]:size-3.5',
            tints[tint]
          )}
        >
          {icon}
        </span>
      </div>
      <p className="mt-2 text-2xl font-semibold tabular-nums tracking-tight">
        {typeof value === 'number' ? <CountUp value={value} /> : value}
      </p>
      {subtitle ? (
        <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>
      ) : null}
    </Panel>
  )
}

// ──────────────────────────── overview view ─────────────────────────

export default function Overview() {
  const { data: devices } = useDevices()
  const metricsByDevice = useDash((s) => s.metricsByDevice)
  const setView = useDash((s) => s.setView)
  const setSelectedDeviceId = useDash((s) => s.setSelectedDeviceId)

  const { data: stats } = useQuery({
    queryKey: ['stats'],
    queryFn: () => api<DashboardStats>('/api/stats'),
    refetchInterval: 15000,
  })

  const { data: audit, isLoading: auditLoading, error: auditError } = useQuery({
    queryKey: ['audit', 8],
    queryFn: () => api<AuditLog[]>('/api/audit?limit=8'),
    refetchInterval: 20000,
  })

  const { data: alerts, isLoading: alertsLoading, error: alertsError } = useQuery({
    queryKey: ['alerts', 5, 'unack'],
    queryFn: () => api<Alert[]>('/api/alerts?limit=5&unackOnly=1'),
    refetchInterval: 20000,
  })

  const deviceList = devices ?? []
  const onlineDevices = deviceList.filter((d) => d.status === 'online')
  const onlineCount = stats?.onlineDevices ?? onlineDevices.length
  const metricsDevices = onlineDevices.filter((d) => metricsByDevice[d.id] != null)

  // Rolling aggregate-CPU + fleet network I/O buffers: seeded with nulls so the
  // lines start rendering once real telemetry arrives. Samples every 5s, reading
  // the latest devices + metrics from the react-query cache / zustand store.
  const qc = useQueryClient()
  const [cpuSamples, setCpuSamples] = useState<(number | null)[]>(() =>
    Array(CPU_HISTORY).fill(null),
  )
  const [netSamples, setNetSamples] = useState<
    { down: number | null; up: number | null }[]
  >(() => Array.from({ length: NET_HISTORY }, () => ({ down: null, up: null })))

  useEffect(() => {
    const sample = () => {
      const cached = qc.getQueryData<Device[]>(['devices']) ?? []
      const metrics = useDash.getState().metricsByDevice
      const live = cached.filter(
        (d) => d.status === 'online' && metrics[d.id] != null,
      )
      const avg =
        live.length > 0
          ? live.reduce((acc, d) => acc + metrics[d.id].cpuPercent, 0) / live.length
          : null
      setCpuSamples((prev) => [
        ...prev.slice(1),
        avg == null ? null : Math.round(avg * 10) / 10,
      ])
      // fleet aggregate network I/O (KB/s summed across reporting agents)
      if (live.length > 0) {
        const down = live.reduce((acc, d) => acc + metrics[d.id].netDownKBps, 0)
        const up = live.reduce((acc, d) => acc + metrics[d.id].netUpKBps, 0)
        setNetSamples((prev) => [
          ...prev.slice(1),
          { down: Math.round(down * 10) / 10, up: Math.round(up * 10) / 10 },
        ])
      } else {
        setNetSamples((prev) => [...prev.slice(1), { down: null, up: null }])
      }
    }
    const id = setInterval(sample, SAMPLE_MS)
    return () => clearInterval(id)
  }, [qc])

  const chartData = useMemo(
    () => cpuSamples.map((cpu, i) => ({ i, cpu })),
    [cpuSamples],
  )

  const netChartData = useMemo(
    () => netSamples.map((n, i) => ({ i, down: n.down, up: n.up })),
    [netSamples],
  )

  // Chart summary chips — computed from the rolling buffers
  const chartStats = useMemo(() => {
    const vals = cpuSamples.filter((v): v is number => v != null)
    if (vals.length === 0) return null
    return {
      last: vals[vals.length - 1],
      avg: Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10,
      peak: Math.round(Math.max(...vals) * 10) / 10,
      samples: vals.length,
    }
  }, [cpuSamples])

  const netStats = useMemo(() => {
    const downs = netSamples.map((n) => n.down).filter((v): v is number => v != null)
    const ups = netSamples.map((n) => n.up).filter((v): v is number => v != null)
    if (downs.length === 0) return null
    const sum = (arr: number[]) => Math.round(arr.reduce((a, b) => a + b, 0) * 10) / 10
    return {
      down: sum(downs),
      up: sum(ups),
      peakDown: sum([Math.max(...downs)]),
      peakUp: sum([Math.max(...ups)]),
      samples: downs.length,
    }
  }, [netSamples])

  const glance = deviceList.slice(0, 6)

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="Fleet overview"
        subtitle="Live status across your managed machines"
        icon={<LayoutDashboard className="h-5 w-5" />}
      />

      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 xl:grid-cols-6">
        {(
          [
            <StatCard
              key="devices"
              icon={<MonitorSmartphone />}
              label="Total devices"
              value={stats?.totalDevices ?? deviceList.length}
              subtitle={<>{onlineCount} online</>}
              tint="emerald"
            />,
            <StatCard
              key="online"
              icon={<span className="status-dot status-dot--static bg-emerald-500" />}
              label="Online now"
              value={onlineCount}
              subtitle="agents reporting in"
              tint="teal"
            />,
            <StatCard
              key="commands"
              icon={<SquareTerminal />}
              label="Commands today"
              value={stats?.commandsToday ?? '—'}
              subtitle="executions since midnight"
              tint="zinc"
            />,
            <StatCard
              key="media"
              icon={<Clapperboard />}
              label="Active media"
              value={stats?.activeCaptures ?? '—'}
              subtitle="media captures running"
              tint="teal"
            />,
            <StatCard
              key="net"
              icon={<RadioTower />}
              label="Net captures"
              value={stats?.runningNetCaptures ?? '—'}
              subtitle="packet captures live"
              tint="amber"
            />,
            <StatCard
              key="alerts"
              icon={<Bell />}
              label="Unack alerts"
              value={stats?.unackAlerts ?? '—'}
              tint={stats && stats.unackAlerts > 0 ? 'amber' : 'zinc'}
              subtitle={
                stats && stats.criticalAlerts > 0 ? (
                  <span className="font-medium text-destructive">
                    {stats.criticalAlerts} critical
                  </span>
                ) : (
                  'nothing critical'
                )
              }
            />,
          ] as const
        ).map((card, i) => (
          <div
            key={i}
            className="animate-in fade-in slide-in-from-bottom-3 fill-mode-both duration-500"
            style={{ animationDelay: `${i * 70}ms` }}
          >
            {card}
          </div>
        ))}
      </div>

      {/* Live performance + devices at a glance */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Panel className="p-4 sm:p-6 lg:col-span-2">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold">Live performance</h3>
              <p className="text-xs text-muted-foreground">
                Aggregate CPU % averaged across online agents · sampled every 5s
              </p>
            </div>
            <Badge
              variant="outline"
              className="gap-1.5 border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
            >
              <span className="status-dot status-dot--static bg-emerald-500" aria-hidden />
              live
            </Badge>
          </div>

          {chartStats ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Badge
                variant="outline"
                className="border-emerald-500/30 bg-emerald-500/10 font-mono text-[11px] text-emerald-600 dark:text-emerald-400"
              >
                now {chartStats.last}%
              </Badge>
              <Badge variant="secondary" className="font-mono text-[11px]">avg {chartStats.avg}%</Badge>
              <Badge variant="secondary" className="font-mono text-[11px]">peak {chartStats.peak}%</Badge>
              <span className="text-[11px] text-muted-foreground">{chartStats.samples} samples buffered</span>
            </div>
          ) : null}

          <div className="mt-4 grid gap-6 lg:grid-cols-5">
            {/* Aggregate CPU area chart */}
            <div className="lg:col-span-3">
              <div className="h-44 text-muted-foreground sm:h-52">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                    <defs>
                      <linearGradient id="cpuAreaFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#10b981" stopOpacity={0.35} />
                        <stop offset="100%" stopColor="#10b981" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="#888" strokeOpacity={0.15} vertical={false} />
                    <XAxis dataKey="i" hide />
                    <YAxis
                      domain={[0, 100]}
                      ticks={[0, 50, 100]}
                      width={32}
                      tick={{ fill: 'currentColor', fontSize: 10 }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <Tooltip
                      formatter={(value) =>
                        typeof value === 'number' ? `${value.toFixed(1)} %` : String(value)
                      }
                    />
                    <Area
                      type="monotone"
                      dataKey="cpu"
                      name="Aggregate CPU"
                      stroke="#10b981"
                      strokeWidth={2}
                      fill="url(#cpuAreaFill)"
                      connectNulls={false}
                      dot={false}
                      isAnimationActive={false}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>

              {/* Fleet network I/O — aggregate down/up across reporting agents */}
              <div className="mt-4 border-t border-border/40 pt-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs font-medium text-muted-foreground">
                    Fleet network I/O <span className="text-muted-foreground/60">· KB/s</span>
                  </p>
                  {netStats ? (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge
                        variant="outline"
                        className="border-emerald-500/30 bg-emerald-500/10 font-mono text-[11px] text-emerald-600 dark:text-emerald-400"
                      >
                        ↓ {netStats.down} KB/s
                      </Badge>
                      <Badge
                        variant="outline"
                        className="border-teal-500/30 bg-teal-500/10 font-mono text-[11px] text-teal-600 dark:text-teal-400"
                      >
                        ↑ {netStats.up} KB/s
                      </Badge>
                      <span className="font-mono text-[11px] text-muted-foreground">
                        peak ↓{netStats.peakDown} · ↑{netStats.peakUp}
                      </span>
                    </div>
                  ) : null}
                </div>
                <div className="mt-2 h-28 text-muted-foreground sm:h-32">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={netChartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                      <defs>
                        <linearGradient id="netDownFill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#10b981" stopOpacity={0.3} />
                          <stop offset="100%" stopColor="#10b981" stopOpacity={0.02} />
                        </linearGradient>
                        <linearGradient id="netUpFill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#14b8a6" stopOpacity={0.3} />
                          <stop offset="100%" stopColor="#14b8a6" stopOpacity={0.02} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid stroke="#888" strokeOpacity={0.15} vertical={false} />
                      <XAxis dataKey="i" hide />
                      <YAxis
                        width={38}
                        tick={{ fill: 'currentColor', fontSize: 10 }}
                        axisLine={false}
                        tickLine={false}
                      />
                      <Tooltip
                        formatter={(value, name) =>
                          typeof value === 'number'
                            ? [`${value.toFixed(1)} KB/s`, name === 'down' ? 'download' : 'upload']
                            : [String(value), String(name)]
                        }
                      />
                      <Area
                        type="monotone"
                        dataKey="down"
                        name="down"
                        stroke="#10b981"
                        strokeWidth={2}
                        fill="url(#netDownFill)"
                        connectNulls={false}
                        dot={false}
                        isAnimationActive={false}
                      />
                      <Area
                        type="monotone"
                        dataKey="up"
                        name="up"
                        stroke="#14b8a6"
                        strokeWidth={1.5}
                        fill="url(#netUpFill)"
                        connectNulls={false}
                        dot={false}
                        isAnimationActive={false}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>

            {/* Per-device utilization */}
            <div className="lg:col-span-2">
              <p className="mb-2 text-xs font-medium text-muted-foreground">
                Per-device utilization
              </p>
              {metricsDevices.length === 0 ? (
                onlineDevices.length === 0 ? (
                  <EmptyState
                    icon={<MonitorSmartphone className="h-5 w-5" />}
                    title="No devices online"
                    hint="Live utilization appears once an agent connects."
                  />
                ) : (
                  <LoadingBlock label="Waiting for agent telemetry…" />
                )
              ) : (
                <div className="scroll-slim flex max-h-64 flex-col gap-2 overflow-y-auto pr-1">
                  {metricsDevices.map((d) => {
                    const m = metricsByDevice[d.id]
                    return (
                      <div key={d.id} className="glass-inset rounded-xl p-3">
                        {/* row 1 — hostname gets the full width (no more "HO…") */}
                        <div className="flex items-center gap-2">
                          <StatusDot online pulse={false} />
                          <span
                            className="min-w-0 flex-1 truncate text-[13px] font-medium"
                            title={d.hostname}
                          >
                            {d.hostname}
                          </span>
                          <span
                            className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground"
                            title={`CPU ${m.cpuPercent.toFixed(1)}% · MEM ${m.memoryPercent.toFixed(1)}%`}
                          >
                            {Math.round(m.cpuPercent)}% / {Math.round(m.memoryPercent)}%
                          </span>
                        </div>
                        {/* row 2 — labeled bars */}
                        <div className="mt-2 flex items-center gap-1.5">
                          <span className="w-7 shrink-0 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                            cpu
                          </span>
                          <Progress
                            value={Math.min(100, m.cpuPercent)}
                            className="h-1.5 flex-1"
                            aria-label={`${d.hostname} CPU`}
                          />
                        </div>
                        <div className="mt-1 flex items-center gap-1.5">
                          <span className="w-7 shrink-0 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                            mem
                          </span>
                          <Progress
                            value={Math.min(100, m.memoryPercent)}
                            className="h-1.5 flex-1"
                            aria-label={`${d.hostname} memory`}
                          />
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </Panel>

        {/* Devices at a glance */}
        <Panel className="flex flex-col p-4 sm:p-6">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">Devices at a glance</h3>
            <Button
              variant="ghost"
              size="sm"
              className="text-primary"
              onClick={() => setView('devices')}
            >
              View all <ArrowRight className="size-3.5" aria-hidden />
            </Button>
          </div>
          <div className="mt-2 flex flex-1 flex-col gap-1">
            {glance.length === 0 ? (
              <LoadingBlock label="Loading devices…" />
            ) : (
              glance.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => {
                    setSelectedDeviceId(d.id)
                    setView('devices')
                  }}
                  className="flex min-h-[44px] items-center gap-3 rounded-xl px-2 text-left transition-colors hover:bg-primary/10"
                >
                  <StatusDot online={d.status === 'online'} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium" title={d.hostname}>
                      {d.hostname}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {d.osName}
                    </span>
                  </span>
                  <span
                    className="hidden shrink-0 text-xs tabular-nums text-muted-foreground sm:block"
                    title={`last seen ${timeAgo(d.lastSeen)}`}
                  >
                    {timeAgoShort(d.lastSeen)} ago
                  </span>
                </button>
              ))
            )}
          </div>
        </Panel>
      </div>

      {/* Recent activity + active alerts */}
      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <Panel className="min-w-0 p-4 sm:p-6">
          <h3 className="text-sm font-semibold">Recent activity</h3>
          <div className="mt-3">
            {auditLoading ? (
              <LoadingBlock label="Loading audit trail…" />
            ) : auditError ? (
              <ErrorBlock
                message={auditError instanceof Error ? auditError.message : 'Failed to load activity'}
              />
            ) : !audit || audit.length === 0 ? (
              <EmptyState
                icon={<ScrollText className="h-5 w-5" />}
                title="No activity yet"
                hint="Audit events appear as you operate the fleet."
              />
            ) : (
              <ul className="flex flex-col gap-0.5">
                {audit.slice(0, 8).map((a) => (
                  <li
                    key={a.id}
                    className="flex min-h-[40px] items-center gap-3 rounded-lg px-2 transition-colors hover:bg-primary/5"
                  >
                    <span
                      className={cn('h-2 w-2 shrink-0 rounded-full', SEVERITY_DOT[a.severity])}
                      aria-hidden
                    />
                    <span className="min-w-0 shrink truncate font-mono text-xs font-medium" title={a.action}>
                      {a.action}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                      {a.detail ?? ''}
                    </span>
                    <span
                      className="shrink-0 text-xs tabular-nums text-muted-foreground"
                      title={new Date(a.createdAt).toLocaleString()}
                    >
                      {timeAgoShort(a.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Panel>

        <Panel className="min-w-0 p-4 sm:p-6">
          <h3 className="text-sm font-semibold">Active alerts</h3>
          <div className="mt-3">
            {alertsLoading ? (
              <LoadingBlock label="Loading alerts…" />
            ) : alertsError ? (
              <ErrorBlock
                message={alertsError instanceof Error ? alertsError.message : 'Failed to load alerts'}
              />
            ) : !alerts || alerts.length === 0 ? (
              <EmptyState
                icon={<ShieldCheck className="h-5 w-5" />}
                title="No active alerts"
                hint="Unacknowledged alerts will show up here."
              />
            ) : (
              <ul className="flex flex-col gap-1.5">
                {alerts.slice(0, 5).map((al) => (
                  <li
                    key={al.id}
                    className="glass-inset flex min-h-[44px] items-center gap-3 rounded-xl px-3 py-2"
                    title={al.message}
                  >
                    <Badge
                      variant="outline"
                      className={cn('shrink-0 capitalize', SEVERITY_BADGE[al.severity])}
                    >
                      {al.severity}
                    </Badge>
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {al.title}
                    </span>
                    <span
                      className="shrink-0 text-xs tabular-nums text-muted-foreground"
                      title={new Date(al.createdAt).toLocaleString()}
                    >
                      {timeAgoShort(al.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Panel>
      </div>
    </div>
  )
}
