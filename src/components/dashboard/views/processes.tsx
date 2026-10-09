'use client'

import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Cpu,
  Loader2,
  MoreHorizontal,
  Pause,
  Play,
  RefreshCw,
  Search,
  Square,
} from 'lucide-react'
import {
  api,
  type DeviceMetrics,
  type ProcessInfo,
  type ProcessSnapshot,
} from '@/lib/types'
import { useDash } from '@/lib/store'
import {
  EmptyState,
  ErrorBlock,
  DeviceSelector,
  LoadingBlock,
  Panel,
  SectionHeader,
  fmtBytes,
  useDevices,
} from '../shared'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'

type SortKey = 'pid' | 'name' | 'cpu' | 'mem'
type SortDir = 'asc' | 'desc'
type ProcAction = 'kill' | 'suspend' | 'resume'

interface ProcessesResponse {
  snapshot: ProcessSnapshot | null
  processes: ProcessInfo[]
  metrics: DeviceMetrics
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : 'Request failed'
}

function StatusBadge({ status }: { status: ProcessInfo['status'] }) {
  if (status === 'running') {
    return (
      <Badge className="border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
        running
      </Badge>
    )
  }
  if (status === 'suspended') {
    return (
      <Badge className="border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400">
        suspended
      </Badge>
    )
  }
  return <Badge variant="secondary">stopped</Badge>
}

function MetricCard({
  label,
  value,
  pct,
  hint,
}: {
  label: string
  value: string
  pct: number
  hint?: string
}) {
  return (
    <div className="glass-inset rounded-xl p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <span className="text-sm font-semibold tabular-nums">{value}</span>
      </div>
      <Progress
        value={Math.max(0, Math.min(100, pct))}
        className="mt-2 h-1.5"
        aria-label={label}
      />
      {hint ? <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

function SortHead({
  label,
  k,
  sortKey,
  sortDir,
  onSort,
  className,
}: {
  label: string
  k: SortKey
  sortKey: SortKey
  sortDir: SortDir
  onSort: (k: SortKey) => void
  className?: string
}) {
  const active = sortKey === k
  return (
    <TableHead className={className}>
      <button
        type="button"
        onClick={() => onSort(k)}
        className={cn(
          'inline-flex min-h-11 items-center gap-1 rounded px-1 text-xs font-semibold uppercase tracking-wide',
          active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
        )}
        aria-label={`Sort by ${label}`}
      >
        {label}
        {active ? (
          sortDir === 'asc' ? (
            <ArrowUp className="h-3 w-3" />
          ) : (
            <ArrowDown className="h-3 w-3" />
          )
        ) : (
          <ArrowUpDown className="h-3 w-3 opacity-40" />
        )}
      </button>
    </TableHead>
  )
}

export default function Processes() {
  const qc = useQueryClient()
  const selectedDeviceId = useDash((s) => s.selectedDeviceId)
  const setSelectedDeviceId = useDash((s) => s.setSelectedDeviceId)
  const storeMetrics = useDash((s) => (selectedDeviceId ? s.metricsByDevice[selectedDeviceId] : undefined))
  const setMetrics = useDash((s) => s.setMetrics)
  const { data: devices } = useDevices()
  const device = devices?.find((d) => d.id === selectedDeviceId) ?? null

  const [auto, setAuto] = useState(true)
  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('cpu')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [killTarget, setKillTarget] = useState<ProcessInfo | null>(null)

  const procQuery = useQuery({
    queryKey: ['processes', selectedDeviceId],
    queryFn: () => api<ProcessesResponse>(`/api/processes?deviceId=${selectedDeviceId}`),
    enabled: !!selectedDeviceId,
    refetchInterval: auto ? 5000 : false,
  })

  // seed the live-metrics store once when telemetry hasn't arrived over the socket yet
  useEffect(() => {
    if (procQuery.data?.metrics && !storeMetrics) {
      setMetrics(procQuery.data.metrics)
    }
  }, [procQuery.data, storeMetrics, setMetrics])

  const processes = useMemo(() => procQuery.data?.processes ?? [], [procQuery.data])

  const metrics = storeMetrics ?? procQuery.data?.metrics

  const toggleSort = (k: SortKey) => {
    if (k === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(k)
      setSortDir(k === 'name' ? 'asc' : 'desc')
    }
  }

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    const filtered = q
      ? processes.filter(
          (p) =>
            p.name.toLowerCase().includes(q) ||
            p.user.toLowerCase().includes(q) ||
            String(p.pid).includes(q),
        )
      : processes
    const dir = sortDir === 'asc' ? 1 : -1
    const value = (p: ProcessInfo): number | string =>
      sortKey === 'pid'
        ? p.pid
        : sortKey === 'name'
          ? p.name.toLowerCase()
          : sortKey === 'cpu'
            ? p.cpuPercent
            : p.memoryMB
    return [...filtered].sort((a, b) => {
      const va = value(a)
      const vb = value(b)
      if (typeof va === 'string' || typeof vb === 'string') {
        return String(va).localeCompare(String(vb)) * dir
      }
      return (va - vb) * dir
    })
  }, [processes, search, sortKey, sortDir])

  const totalCpu = processes.reduce((acc, p) => acc + p.cpuPercent, 0)
  const topMem = processes.reduce<ProcessInfo | null>(
    (best, p) => (!best || p.memoryMB > best.memoryMB ? p : best),
    null,
  )
  const suspendedCount = processes.filter((p) => p.status === 'suspended').length

  const action = useMutation({
    mutationFn: (v: { pid: number; act: ProcAction; name: string }) => {
      if (!selectedDeviceId) return Promise.reject(new Error('No device selected'))
      return api<Record<string, unknown>>('/api/processes/action', {
        method: 'POST',
        body: JSON.stringify({ deviceId: selectedDeviceId, pid: v.pid, action: v.act }),
      })
    },
    onSuccess: (_d, v) => {
      const label = v.act === 'kill' ? 'killed' : v.act === 'suspend' ? 'suspended' : 'resumed'
      toast.success(`${v.name} ${label}`)
      qc.invalidateQueries({ queryKey: ['processes'] })
    },
    onError: (e) => toast.error('Action failed', { description: errMsg(e) }),
  })

  const header = (
    <SectionHeader
      title="Process manager"
      subtitle="Live process list with control actions"
      icon={<Cpu className="h-5 w-5" />}
      actions={
        <>
          <div className="glass-inset flex h-11 items-center gap-2 rounded-md px-3">
            <Switch
              id="proc-auto"
              checked={auto}
              onCheckedChange={setAuto}
              aria-label="Auto refresh every 5 seconds"
            />
            <Label htmlFor="proc-auto" className="cursor-pointer text-xs text-muted-foreground">
              Auto 5s
            </Label>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="glass-inset h-11 w-11"
            aria-label="Refresh processes"
            onClick={() => qc.invalidateQueries({ queryKey: ['processes', selectedDeviceId] })}
          >
            <RefreshCw className={cn('h-4 w-4', procQuery.isFetching && 'animate-spin')} />
          </Button>
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter processes…"
              className="h-11 w-40 pl-8"
              aria-label="Filter processes"
            />
          </div>
        </>
      }
    />
  )

  return (
    <div className="flex flex-col gap-4">
      {header}

      {!selectedDeviceId ? (
        <>
          <EmptyState
            icon={<Cpu className="h-10 w-10" />}
            title="Select a device to view processes"
            hint="Pick a machine to see its live process table and control actions."
          />
          <div className="flex justify-center">
            <DeviceSelector value={selectedDeviceId} onChange={setSelectedDeviceId} />
          </div>
        </>
      ) : (
        <>
          {/* summary chips */}
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary" className="glass-inset tabular-nums">
              {processes.length} processes
            </Badge>
            <Badge className="border-emerald-500/30 bg-emerald-500/10 tabular-nums text-emerald-600 dark:text-emerald-400">
              Σ CPU {totalCpu.toFixed(1)}%
            </Badge>
            {topMem ? (
              <Badge variant="outline" className="glass-inset">
                Top memory:&nbsp;<span className="font-semibold">{topMem.name}</span>
                &nbsp;· {fmtBytes(topMem.memoryMB * 1024 * 1024)}
              </Badge>
            ) : null}
            <Badge
              className={cn(
                'tabular-nums',
                suspendedCount > 0
                  ? 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400'
                  : 'border-zinc-500/30 bg-zinc-500/10 text-zinc-600 dark:text-zinc-400',
              )}
            >
              {suspendedCount} suspended
            </Badge>
          </div>

          {/* device metrics mini-cards (live telemetry from the store) */}
          {metrics ? (
            <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
              <MetricCard label="CPU" value={`${metrics.cpuPercent.toFixed(0)}%`} pct={metrics.cpuPercent} />
              <MetricCard
                label="Memory"
                value={`${metrics.memoryPercent.toFixed(0)}%`}
                pct={metrics.memoryPercent}
              />
              <MetricCard
                label="Disk"
                value={`${metrics.diskPercent.toFixed(0)}%`}
                pct={metrics.diskPercent}
              />
              <div className="glass-inset rounded-xl p-3">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-xs font-medium text-muted-foreground">Network</span>
                  <span className="text-sm font-semibold tabular-nums">
                    ↓ {metrics.netDownKBps.toFixed(0)} · ↑ {metrics.netUpKBps.toFixed(0)} KB/s
                  </span>
                </div>
                <Progress
                  value={Math.max(0, Math.min(100, metrics.netDownKBps))}
                  className="mt-2 h-1.5"
                  aria-label="Download KBps"
                />
                <Progress
                  value={Math.max(0, Math.min(100, metrics.netUpKBps))}
                  className="mt-1 h-1.5"
                  aria-label="Upload KBps"
                />
              </div>
            </div>
          ) : (
            <LoadingBlock label="waiting for telemetry" />
          )}

          {/* process table */}
          <Panel className="overflow-hidden p-0">
            <div className="max-h-[50vh] overflow-y-auto scroll-slim">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <SortHead label="PID" k="pid" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="pl-4" />
                    <SortHead label="Name" k="name" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                    <TableHead>User</TableHead>
                    <TableHead>Status</TableHead>
                    <SortHead label="CPU" k="cpu" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="w-24" />
                    <SortHead label="Memory" k="mem" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                    <TableHead className="pr-3 text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {procQuery.isPending ? (
                    Array.from({ length: 7 }).map((_, i) => (
                      <TableRow key={`sk-${i}`}>
                        <TableCell className="pl-4">
                          <Skeleton className="h-4 w-10" />
                        </TableCell>
                        <TableCell>
                          <Skeleton className="h-4 w-32" />
                        </TableCell>
                        <TableCell>
                          <Skeleton className="h-4 w-20" />
                        </TableCell>
                        <TableCell>
                          <Skeleton className="h-4 w-16" />
                        </TableCell>
                        <TableCell>
                          <Skeleton className="h-4 w-20" />
                        </TableCell>
                        <TableCell>
                          <Skeleton className="h-4 w-14" />
                        </TableCell>
                        <TableCell />
                      </TableRow>
                    ))
                  ) : procQuery.isError ? (
                    <TableRow>
                      <TableCell colSpan={7}>
                        <div className="flex flex-col items-center gap-3 py-6">
                          <ErrorBlock message={errMsg(procQuery.error)} />
                          <Button variant="outline" size="sm" onClick={() => procQuery.refetch()}>
                            <RefreshCw className="h-4 w-4" />
                            Retry
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ) : rows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">
                        No processes match “{search}”.
                      </TableCell>
                    </TableRow>
                  ) : (
                    rows.map((p) => {
                      const rowPending = action.isPending && action.variables?.pid === p.pid
                      return (
                        <TableRow key={p.pid}>
                          <TableCell className="pl-4 font-mono text-xs tabular-nums">{p.pid}</TableCell>
                          <TableCell className="max-w-56 truncate font-medium" title={p.path || p.name}>
                            {p.name}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">{p.user}</TableCell>
                          <TableCell>
                            <StatusBadge status={p.status} />
                          </TableCell>
                          <TableCell className="w-24">
                            <div className="flex flex-col gap-1">
                              <span className="font-mono text-xs tabular-nums">
                                {p.cpuPercent.toFixed(1)}%
                              </span>
                              <Progress
                                value={Math.max(0, Math.min(100, p.cpuPercent))}
                                className="h-1"
                                aria-label={`CPU ${p.cpuPercent.toFixed(1)}%`}
                              />
                            </div>
                          </TableCell>
                          <TableCell className="font-mono text-xs tabular-nums">
                            {fmtBytes(p.memoryMB * 1024 * 1024)}
                          </TableCell>
                          <TableCell className="pr-3 text-right">
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-11 w-11"
                                  aria-label={`Actions for ${p.name}`}
                                  disabled={rowPending}
                                >
                                  {rowPending ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                  ) : (
                                    <MoreHorizontal className="h-4 w-4" />
                                  )}
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent className="glass-strong" align="end">
                                <DropdownMenuItem variant="destructive" onClick={() => setKillTarget(p)}>
                                  <Square className="h-4 w-4" />
                                  Kill
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onClick={() => action.mutate({ pid: p.pid, act: 'suspend', name: p.name })}
                                >
                                  <Pause className="h-4 w-4" />
                                  Suspend
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onClick={() => action.mutate({ pid: p.pid, act: 'resume', name: p.name })}
                                >
                                  <Play className="h-4 w-4" />
                                  Resume
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </TableCell>
                        </TableRow>
                      )
                    })
                  )}
                </TableBody>
              </Table>
            </div>
          </Panel>
        </>
      )}

      {/* kill confirm */}
      <AlertDialog
        open={!!killTarget}
        onOpenChange={(open) => {
          if (!open) setKillTarget(null)
        }}
      >
        <AlertDialogContent className="glass-strong">
          <AlertDialogHeader>
            <AlertDialogTitle>Kill “{killTarget?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This will terminate the process on {device?.hostname ?? 'the selected device'} (PID{' '}
              {killTarget?.pid}). Unsaved data held by this process will be lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault()
                if (killTarget) {
                  action.mutate({ pid: killTarget.pid, act: 'kill', name: killTarget.name })
                  setKillTarget(null)
                }
              }}
            >
              <Square className="h-4 w-4" />
              Kill process
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
