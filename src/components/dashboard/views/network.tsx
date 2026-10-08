'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Play,
  RadioTower,
  ShieldCheck,
  Square,
  Timer,
} from 'lucide-react'
import { api, type NetworkCapture } from '@/lib/types'
import { useDash } from '@/lib/store'
import { cn } from '@/lib/utils'
import {
  DeviceSelector,
  EmptyState,
  ErrorBlock,
  LoadingBlock,
  Panel,
  SectionHeader,
  fmtBytes,
  fmtDate,
  useDevices,
} from '../shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

// ─────────────────────────── helpers ────────────────────────────────

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`
}

function captureDuration(c: NetworkCapture, now: number): number {
  const start = new Date(c.startedAt).getTime()
  const end = c.stoppedAt ? new Date(c.stoppedAt).getTime() : now
  return Math.max(0, end - start)
}

/** Smoothly animates a number toward its target (count-up). */
function useCountUp(target: number): number {
  const [display, setDisplay] = useState(target)
  const lastTargetRef = useRef(target)

  useEffect(() => {
    const from = lastTargetRef.current
    lastTargetRef.current = target
    if (from === target) return
    let raf = 0
    const t0 = performance.now()
    const dur = 450
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / dur)
      const eased = 1 - Math.pow(1 - p, 3)
      setDisplay(Math.round(from + (target - from) * eased))
      if (p < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [target])

  return display
}

function statusBadge(status: NetworkCapture['status']): { label: string; className: string } {
  switch (status) {
    case 'running':
      return {
        label: 'running',
        className: 'border-emerald-500/30 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
      }
    case 'stopped':
      return {
        label: 'stopped',
        className: 'border-zinc-500/30 bg-zinc-500/15 text-zinc-600 dark:text-zinc-400',
      }
    case 'failed':
      return {
        label: 'failed',
        className: 'border-rose-500/30 bg-rose-500/15 text-rose-600 dark:text-rose-400',
      }
  }
}

// ─────────────────────────── view ───────────────────────────────────

export default function NetworkView() {
  const qc = useQueryClient()
  const selectedDeviceId = useDash((s) => s.selectedDeviceId)
  const setSelectedDeviceId = useDash((s) => s.setSelectedDeviceId)
  const { data: devices } = useDevices()

  const [iface, setIface] = useState('any')
  const [filterBpf, setFilterBpf] = useState('')
  const [now, setNow] = useState(() => Date.now())

  const device = useMemo(
    () => (devices ?? []).find((d) => d.id === selectedDeviceId) ?? null,
    [devices, selectedDeviceId]
  )

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const capturesQuery = useQuery({
    queryKey: ['network', selectedDeviceId],
    queryFn: () =>
      api<NetworkCapture[]>(`/api/network?deviceId=${encodeURIComponent(String(selectedDeviceId))}`),
    enabled: !!selectedDeviceId,
    refetchInterval: 5000,
  })

  const invalidate = () => qc.invalidateQueries({ queryKey: ['network'] })

  const startCapture = useMutation({
    mutationFn: () =>
      api<NetworkCapture>('/api/network/start', {
        method: 'POST',
        body: JSON.stringify({ deviceId: selectedDeviceId, iface, filterBpf }),
      }),
    onSuccess: (c) => {
      invalidate()
      toast.success(`Capture started on ${device?.hostname ?? 'device'}`, {
        description: `iface ${c.iface}${c.filterBpf ? ` • filter: ${c.filterBpf}` : ''}`,
      })
    },
    onError: (e) =>
      toast.error('Failed to start capture', {
        description: e instanceof Error ? e.message : 'Unknown error',
      }),
  })

  const stopCapture = useMutation({
    mutationFn: () =>
      api<NetworkCapture>('/api/network/stop', {
        method: 'POST',
        body: JSON.stringify({ deviceId: selectedDeviceId }),
      }),
    onSuccess: (c) => {
      invalidate()
      toast.success('Capture stopped', {
        description: `${c.packets} packets • ${fmtBytes(c.bytesCaptured)} written (encrypted)`,
      })
    },
    onError: (e) =>
      toast.error('Failed to stop capture', {
        description: e instanceof Error ? e.message : 'Unknown error',
      }),
  })

  const captures = capturesQuery.data ?? []
  const running = captures.find((c) => c.status === 'running') ?? null
  const latest = running ?? captures[0] ?? null

  const packets = useCountUp(running?.packets ?? latest?.packets ?? 0)

  function handleToggle() {
    if (!selectedDeviceId) {
      toast.warning('Select a device first', {
        description: 'Network capture needs a target device.',
      })
      return
    }
    if (running) stopCapture.mutate()
    else startCapture.mutate()
  }

  if (!selectedDeviceId) {
    return (
      <div className="flex flex-col gap-4">
        <SectionHeader
          title="Network capture"
          subtitle="Packet capture via tshark — encrypted pcapng on the device"
          icon={<RadioTower className="h-5 w-5" />}
        />
        <EmptyState
          icon={<RadioTower className="h-10 w-10" />}
          title="No device selected"
          hint="Pick a device from the selector to start a packet capture."
        />
      </div>
    )
  }

  const live = !!running

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader
        title="Network capture"
        subtitle="Packet capture via tshark — encrypted pcapng on the device"
        icon={<RadioTower className="h-5 w-5" />}
        actions={
          live ? (
            <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" /> LIVE
            </Badge>
          ) : null
        }
      />

      {/* controls */}
      <Panel className="glass-hover p-6">
        <div className="flex flex-col gap-4">
          <div className="grid gap-4 md:grid-cols-[1fr_1fr_auto] md:items-end">
            <div className="flex flex-col gap-2">
              <Label className="text-xs uppercase tracking-wide text-muted-foreground">Device</Label>
              <DeviceSelector value={selectedDeviceId} onChange={setSelectedDeviceId} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="net-iface" className="text-xs uppercase tracking-wide text-muted-foreground">
                Interface
              </Label>
              <Input
                id="net-iface"
                value={iface}
                onChange={(e) => setIface(e.target.value)}
                placeholder="any"
                className="h-11 font-mono md:h-9"
              />
            </div>
            <Button
              className={cn('h-11 w-full md:w-auto md:px-6', running && 'border-destructive/40')}
              variant={running ? 'destructive' : 'default'}
              disabled={startCapture.isPending || stopCapture.isPending}
              onClick={handleToggle}
            >
              {running ? <Square className="h-4 w-4" /> : <Play className="h-4 w-4" />}
              {running ? 'Stop capture' : 'Start capture'}
            </Button>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="net-bpf" className="text-xs uppercase tracking-wide text-muted-foreground">
              BPF filter (optional)
            </Label>
            <Input
              id="net-bpf"
              value={filterBpf}
              onChange={(e) => setFilterBpf(e.target.value)}
              placeholder="tcp port 443 or udp port 53"
              className="h-11 font-mono text-sm md:h-9"
            />
            <p className="text-xs text-muted-foreground">
              tshark captures on the device; the pcapng is AES-encrypted with your dashboard password
              before touching disk.
            </p>
          </div>
        </div>
      </Panel>

      {/* live stats */}
      <div className="grid gap-4 sm:grid-cols-3">
        <Panel className="glass-hover p-4">
          <div className="flex items-center gap-2">
            {live ? <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" /> : null}
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Packets captured</p>
          </div>
          <p className="mt-1 font-mono text-2xl font-semibold tabular-nums" title={String(latest?.packets ?? 0)}>
            {packets.toLocaleString()}
          </p>
        </Panel>
        <Panel className="glass-hover p-4">
          <div className="flex items-center gap-2">
            {live ? <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" /> : null}
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Bytes captured</p>
          </div>
          <p className="mt-1 font-mono text-2xl font-semibold tabular-nums">
            {fmtBytes(latest?.bytesCaptured ?? 0)}
          </p>
        </Panel>
        <Panel className="glass-hover p-4">
          <div className="flex items-center gap-2">
            {live ? <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" /> : null}
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Duration</p>
          </div>
          <p className="mt-1 flex items-center gap-2 font-mono text-2xl font-semibold tabular-nums">
            <Timer className="h-5 w-5 text-primary" />
            {latest ? fmtDuration(captureDuration(latest, now)) : '0:00'}
          </p>
        </Panel>
      </div>

      {/* history */}
      <Panel className="glass-hover p-4 sm:p-6">
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-semibold">History</h3>
          {captures.length > 0 ? (
            <span className="text-xs text-muted-foreground">
              {captures.length} capture{captures.length === 1 ? '' : 's'}
            </span>
          ) : null}
        </div>
        <div className="mt-3">
          {capturesQuery.isLoading ? (
            <LoadingBlock label="Loading captures…" />
          ) : capturesQuery.isError ? (
            <ErrorBlock
              message={
                capturesQuery.error instanceof Error
                  ? capturesQuery.error.message
                  : 'Failed to load captures'
              }
            />
          ) : captures.length === 0 ? (
            <EmptyState
              icon={<RadioTower className="h-8 w-8" />}
              title="No captures yet"
              hint="Start a capture to see it appear here."
            />
          ) : (
            <div className="max-h-[40vh] overflow-y-auto scroll-slim">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Started</TableHead>
                    <TableHead>Interface</TableHead>
                    <TableHead>Filter</TableHead>
                    <TableHead className="text-right">Packets</TableHead>
                    <TableHead className="text-right">Bytes</TableHead>
                    <TableHead className="text-right">Duration</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Encrypted</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {captures.map((c) => {
                    const sb = statusBadge(c.status)
                    return (
                      <TableRow key={c.id} className="glass-hover">
                        <TableCell className="font-mono text-xs" title={fmtDate(c.startedAt)}>
                          {fmtDate(c.startedAt)}
                        </TableCell>
                        <TableCell className="font-mono text-xs">{c.iface}</TableCell>
                        <TableCell className="max-w-[180px]">
                          <span
                            className="block truncate font-mono text-xs text-muted-foreground"
                            title={c.filterBpf ?? 'no filter'}
                          >
                            {c.filterBpf ?? '—'}
                          </span>
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {c.packets.toLocaleString()}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {fmtBytes(c.bytesCaptured)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {fmtDuration(captureDuration(c, now))}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={cn('gap-1', sb.className)}>
                            {c.status === 'running' ? (
                              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
                            ) : null}
                            {sb.label}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {c.encrypted ? (
                            <Badge
                              variant="outline"
                              className="border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                            >
                              <ShieldCheck className="h-3 w-3" /> AES
                            </Badge>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      </Panel>
    </div>
  )
}
