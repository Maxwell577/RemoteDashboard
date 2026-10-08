'use client'

import { useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  Camera,
  Clapperboard,
  Download,
  FolderTree,
  Info,
  Laptop,
  Loader2,
  MapPin,
  Monitor,
  MonitorSmartphone,
  Server,
  SquareTerminal,
  Timer,
  type LucideIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import { api, computeHealthScore, type Device, type DeviceType, type MediaAsset } from '@/lib/types'
import { useDash, type ViewId } from '@/lib/store'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import {
  EmptyState,
  ErrorBlock,
  Panel,
  SectionHeader,
  StatusDot,
  fmtBytes,
  fmtDate,
  timeAgo,
  useDevices,
} from '../shared'

const TYPE_ICON: Record<DeviceType, LucideIcon> = {
  workstation: Monitor,
  laptop: Laptop,
  server: Server,
}

function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const min = Math.floor((sec % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${min}m`
  return `${min}m`
}

function ramLabel(mb: number): string {
  return fmtBytes(mb * 1024 * 1024)
}

// ───────────────────────── details dialog atoms ─────────────────────

function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="glass-inset rounded-xl p-3">
      <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h4>
      {children}
    </section>
  )
}

function DetailRow({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  const empty = value == null || value === ''
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <span
        className={cn(
          'min-w-0 truncate text-right text-xs font-medium',
          mono && 'font-mono',
          empty && 'text-muted-foreground/60',
        )}
      >
        {empty ? '—' : value}
      </span>
    </div>
  )
}

function MetricBar({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono font-medium">{Math.round(value)}%</span>
      </div>
      <Progress value={Math.min(100, Math.max(0, value))} className="h-1.5" />
    </div>
  )
}

/** SVG donut showing a 0-100 health score with a tinted arc. */
function HealthRing({ score, size = 64 }: { score: number; size?: number }) {
  const stroke = 6
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const pct = Math.min(100, Math.max(0, score))
  const color =
    score >= 80
      ? 'oklch(0.72 0.14 168)' // emerald
      : score >= 55
        ? 'oklch(0.8 0.14 85)' // amber
        : 'oklch(0.7 0.19 22)' // rose
  return (
    <div
      className="relative shrink-0"
      style={{ width: size, height: size }}
      role="img"
      aria-label={`Health score ${score} of 100`}
    >
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="currentColor"
          className="text-border/60"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${(pct / 100) * c} ${c}`}
          style={{ transition: 'stroke-dasharray 600ms cubic-bezier(0.22,1,0.36,1)' }}
        />
      </svg>
      <span
        className="absolute inset-0 flex items-center justify-center font-mono text-sm font-semibold"
        style={{ color }}
      >
        {score}
      </span>
    </div>
  )
}

/** Tiny inline CPU% sparkline from the live telemetry buffer. */
function CpuSparkline({ history, className }: { history: number[]; className?: string }) {
  const w = 220
  const h = 48
  if (history.length < 2) {
    return (
      <div className={cn('flex items-center justify-center text-[11px] text-muted-foreground', className)} style={{ height: h }}>
        collecting samples…
      </div>
    )
  }
  const pts = history
    .map((v, i) => {
      const x = (i / (history.length - 1)) * w
      const y = h - (Math.min(100, Math.max(0, v)) / 100) * (h - 6) - 3
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  const last = history[history.length - 1]
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className={cn('w-full', className)} style={{ height: h }} aria-hidden>
      <polyline
        points={pts}
        fill="none"
        stroke="currentColor"
        className="text-primary"
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle
        cx={w}
        cy={h - (Math.min(100, Math.max(0, last)) / 100) * (h - 6) - 3}
        r="3"
        className="fill-primary"
      />
    </svg>
  )
}

function healthTone(score: number): string {
  if (score >= 80) return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
  if (score >= 55) return 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400'
  return 'border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400'
}

// ───────────────────────── details dialog body ──────────────────────

function DeviceDetailsBody({ device, close }: { device: Device; close: () => void }) {
  const qc = useQueryClient()
  const setView = useDash((s) => s.setView)
  const setSelectedDeviceId = useDash((s) => s.setSelectedDeviceId)
  const metricsByDevice = useDash((s) => s.metricsByDevice)
  const cpuHistory = useDash((s) => s.cpuHistory)
  const m = metricsByDevice[device.id]
  const history = cpuHistory[device.id] ?? []
  const health = computeHealthScore({
    online: device.status === 'online',
    cpuPercent: m?.cpuPercent,
    memoryPercent: m?.memoryPercent,
    diskPercent: m?.diskPercent,
    stale: device.status === 'online' && !m,
  })

  const [notes, setNotes] = useState(device.notes ?? '')
  const [saving, setSaving] = useState(false)
  const [shot, setShot] = useState<MediaAsset | null>(null)
  const [shotBusy, setShotBusy] = useState(false)

  const go = (v: ViewId) => {
    setSelectedDeviceId(device.id)
    setView(v)
    close()
  }

  async function saveNotes() {
    setSaving(true)
    try {
      await api<Device>(`/api/devices/${device.id}/notes`, {
        method: 'POST',
        body: JSON.stringify({ notes }),
      })
      toast.success('Notes saved', { description: device.hostname })
      qc.invalidateQueries({ queryKey: ['devices'] })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save notes')
    } finally {
      setSaving(false)
    }
  }

  async function takeScreenshot() {
    setShotBusy(true)
    try {
      const asset = await api<MediaAsset>('/api/media/screenshot', {
        method: 'POST',
        body: JSON.stringify({ deviceId: device.id }),
      })
      setShot(asset)
      toast.success('Screenshot captured', { description: device.hostname })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Screenshot failed')
    } finally {
      setShotBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <DetailSection title="Identity">
          <DetailRow label="Hostname" value={device.hostname} />
          <DetailRow label="Friendly name" value={device.friendlyName} />
          <DetailRow label="Type" value={device.deviceType} />
          <DetailRow label="Agent ID" value={device.agentId} mono />
          <DetailRow label="Agent version" value={device.agentVersion} mono />
          <DetailRow label="First seen" value={fmtDate(device.firstSeen)} />
          <DetailRow label="Last seen" value={fmtDate(device.lastSeen)} />
        </DetailSection>

        <DetailSection title="OS & hardware">
          <DetailRow label="OS" value={`${device.osName} ${device.osVersion}`.trim()} />
          <DetailRow label="Architecture" value={device.osArch} mono />
          <DetailRow label="CPU" value={device.cpuModel} />
          <DetailRow label="Cores" value={device.cpuCores} />
          <DetailRow label="Memory" value={ramLabel(device.totalMemoryMB)} />
          <DetailRow label="MAC" value={device.macAddress} mono />
        </DetailSection>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <DetailSection title="Network">
          <DetailRow label="Public IP" value={device.ipAddress} mono />
          <DetailRow label="Local IP" value={device.localIp} mono />
          <DetailRow label="Platform" value={device.platform} />
        </DetailSection>

        <DetailSection title="Location">
          {device.locationLat != null && device.locationLon != null ? (
            <>
              <DetailRow label="Latitude" value={device.locationLat.toFixed(5)} mono />
              <DetailRow label="Longitude" value={device.locationLon.toFixed(5)} mono />
              <DetailRow label="Label" value={device.locationLabel} />
            </>
          ) : (
            <p className="text-xs text-muted-foreground">No location recorded yet.</p>
          )}
        </DetailSection>
      </div>

      <DetailSection title="Live metrics">
        <div className="flex items-center gap-4 pb-1">
          <HealthRing score={health} />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium">Health score</p>
            <p className="text-[11px] text-muted-foreground">
              {device.status !== 'online'
                ? 'offline — capped penalty score'
                : health >= 80
                  ? 'nominal — no resource pressure'
                  : health >= 55
                    ? 'elevated load on this machine'
                    : 'saturated — needs attention'}
            </p>
          </div>
        </div>
        <div className="glass-inset rounded-lg px-2 pb-1 pt-2">
          <div className="flex items-center justify-between px-1 text-[11px] text-muted-foreground">
            <span>CPU — last {history.length || 0} samples</span>
            <span className="font-mono">peak {history.length ? Math.round(Math.max(...history)) : '—'}%</span>
          </div>
          <CpuSparkline history={history} />
        </div>
        {m ? (
          <div className="mt-1 flex flex-col gap-2.5">
            <MetricBar label="CPU" value={m.cpuPercent} />
            <MetricBar label="Memory" value={m.memoryPercent} />
            <MetricBar label="Disk" value={m.diskPercent} />
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 pt-0.5 text-xs text-muted-foreground">
              <span>Uptime {fmtUptime(m.uptimeSec)}</span>
              <span className="font-mono">
                ↓ {m.netDownKBps.toFixed(1)} KB/s · ↑ {m.netUpKBps.toFixed(1)} KB/s
              </span>
              <span>
                {m.activeUsers} active user{m.activeUsers === 1 ? '' : 's'}
              </span>
            </div>
          </div>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">
            {device.status === 'online'
              ? 'Waiting for telemetry…'
              : 'Device offline — no live metrics.'}
          </p>
        )}
      </DetailSection>

      <DetailSection title="Notes">
        <Textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          placeholder="Operational notes for this machine…"
          className="resize-none"
          aria-label={`Notes for ${device.hostname}`}
        />
        <div className="mt-2 flex justify-end">
          <Button size="sm" onClick={saveNotes} disabled={saving}>
            {saving ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
            Save notes
          </Button>
        </div>
      </DetailSection>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => go('terminal')}>
          <SquareTerminal className="size-3.5" aria-hidden /> Terminal
        </Button>
        <Button size="sm" variant="outline" onClick={() => go('files')}>
          <FolderTree className="size-3.5" aria-hidden /> Files
        </Button>
        <Button size="sm" variant="outline" onClick={() => go('media')}>
          <Clapperboard className="size-3.5" aria-hidden /> Media
        </Button>
        <Button size="sm" variant="outline" onClick={takeScreenshot} disabled={shotBusy}>
          {shotBusy ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          ) : (
            <Camera className="size-3.5" aria-hidden />
          )}
          Screenshot
        </Button>
      </div>

      {/* Screenshot preview */}
      <Dialog open={shot != null} onOpenChange={(o) => { if (!o) setShot(null) }}>
        <DialogContent className="glass rounded-2xl sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle className="text-base">Screenshot — {device.hostname}</DialogTitle>
            <DialogDescription>
              {shot
                ? `Captured ${timeAgo(shot.createdAt)} · ${shot.format ?? 'image'} · ${fmtBytes(shot.sizeBytes)}`
                : ''}
            </DialogDescription>
          </DialogHeader>
          {shot?.dataRef ? (
            <>
              <div className="glass-inset overflow-hidden rounded-xl">
                <img
                  src={shot.dataRef}
                  alt={`Screenshot of ${device.hostname}`}
                  className="max-h-[60vh] w-full object-contain"
                />
              </div>
              <div className="flex justify-end">
                <a
                  href={shot.dataRef}
                  download={`${device.hostname}-${shot.id}.${shot.format ?? 'svg'}`}
                  className={buttonVariants({ variant: 'outline', size: 'sm' })}
                >
                  <Download className="size-3.5" aria-hidden /> Download
                </a>
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">No preview data available.</p>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

function DeviceDetailsDialog({
  device,
  open,
  onOpenChange,
}: {
  device: Device
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="glass scroll-slim max-h-[85vh] overflow-y-auto rounded-2xl sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <StatusDot online={device.status === 'online'} />
            {device.hostname}
          </DialogTitle>
          <DialogDescription>
            {device.friendlyName ?? device.osName} · {device.deviceType} ·{' '}
            {device.status === 'online' ? 'online' : `last seen ${timeAgo(device.lastSeen)}`}
          </DialogDescription>
        </DialogHeader>
        <DeviceDetailsBody
          key={device.id}
          device={device}
          close={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  )
}

// ─────────────────────────── device card ────────────────────────────

function DeviceCard({ device }: { device: Device }) {
  const setView = useDash((s) => s.setView)
  const setSelectedDeviceId = useDash((s) => s.setSelectedDeviceId)
  const metricsByDevice = useDash((s) => s.metricsByDevice)
  const [detailsOpen, setDetailsOpen] = useState(false)

  const TypeIcon = TYPE_ICON[device.deviceType]
  const online = device.status === 'online'
  const m = online ? metricsByDevice[device.id] : undefined
  const health = computeHealthScore({
    online,
    cpuPercent: m?.cpuPercent,
    memoryPercent: m?.memoryPercent,
    diskPercent: m?.diskPercent,
    stale: online && !m,
  })

  const go = (v: ViewId) => {
    setSelectedDeviceId(device.id)
    setView(v)
  }

  return (
    <>
      <Panel className={cn('glass-hover flex flex-col p-4', !online && 'opacity-80')}>
        <div className="flex items-start gap-2.5">
          <span className="mt-1.5">
            <StatusDot online={online} />
          </span>
          <div className="min-w-0 flex-1">
            {/* hostname gets the full row so it never over-truncates */}
            <div className="flex min-w-0 items-center gap-1.5">
              <h3
                className="min-w-0 truncate font-semibold leading-tight"
                title={device.hostname}
              >
                {device.hostname}
              </h3>
              <TypeIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            </div>
            <div className="mt-0.5 flex items-center gap-1.5">
              <p
                className="min-w-0 truncate text-xs text-muted-foreground"
                title={device.friendlyName ?? undefined}
              >
                {device.friendlyName ?? 'No friendly name'}
              </p>
              <Badge
                variant="outline"
                className="ml-auto max-w-[150px] shrink-0 truncate border-border/60 bg-background/40 text-[10px]"
                title={device.osName}
              >
                {device.osName}
              </Badge>
            </div>
          </div>
        </div>

        <dl className="mt-3 flex flex-col gap-1 text-xs">
          <div className="flex items-center justify-between gap-2">
            <dt className="flex items-center gap-1.5 text-muted-foreground">
              Health
              <span
                className={cn(
                  'rounded-full border px-1.5 py-px font-mono text-[10px] font-semibold',
                  healthTone(health),
                )}
              >
                {health}
              </span>
            </dt>
            <dd className="min-w-0 truncate text-right font-medium">{online ? 'live' : 'offline'}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="shrink-0 text-muted-foreground">CPU</dt>
            <dd className="min-w-0 truncate text-right font-medium">{device.cpuModel ?? '—'}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="shrink-0 text-muted-foreground">RAM</dt>
            <dd className="text-right font-medium">{ramLabel(device.totalMemoryMB)}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="shrink-0 text-muted-foreground">IP</dt>
            <dd className="font-mono text-right font-medium">
              {device.ipAddress ?? device.localIp ?? '—'}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="shrink-0 text-muted-foreground">{online ? 'Status' : 'Last seen'}</dt>
            <dd
              className={cn(
                'truncate text-right font-medium',
                online && !m && 'text-muted-foreground',
                online && m && 'text-emerald-600 dark:text-emerald-400',
              )}
            >
              {online
                ? m
                  ? `live · CPU ${Math.round(m.cpuPercent)}% · MEM ${Math.round(m.memoryPercent)}%`
                  : 'waiting for telemetry…'
                : timeAgo(device.lastSeen)}
            </dd>
          </div>
          {online && m ? (
            <div className="flex items-baseline justify-between gap-3">
              <dt className="flex shrink-0 items-center gap-1 text-muted-foreground">
                <Timer className="size-3" aria-hidden />
                Uptime
              </dt>
              <dd
                className="truncate text-right font-medium tabular-nums"
                title={`Last boot ${new Date(Date.now() - m.uptimeSec * 1000).toLocaleString()}`}
              >
                {fmtUptime(m.uptimeSec)}
              </dd>
            </div>
          ) : null}
        </dl>

        {device.tags.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-1">
            {device.tags.map((t) => (
              <Badge key={t} variant="secondary" className="text-[10px]">
                {t}
              </Badge>
            ))}
          </div>
        ) : null}

        <div className="mt-4 flex items-center gap-2 border-t border-border/50 pt-3">
          <Button size="sm" className="flex-1" onClick={() => go('terminal')}>
            <SquareTerminal className="size-3.5" aria-hidden /> Manage
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="flex-1"
            onClick={() => setDetailsOpen(true)}
          >
            <Info className="size-3.5" aria-hidden /> Details
          </Button>
          <Button size="sm" variant="outline" className="flex-1" onClick={() => go('location')}>
            <MapPin className="size-3.5" aria-hidden /> Locate
          </Button>
        </div>
      </Panel>

      <DeviceDetailsDialog
        device={device}
        open={detailsOpen}
        onOpenChange={setDetailsOpen}
      />
    </>
  )
}

// ──────────────────────────── devices view ──────────────────────────

export default function Devices() {
  const { data: devices, isLoading, error } = useDevices()

  const deviceList = devices ?? []
  const onlineCount = deviceList.filter((d) => d.status === 'online').length
  const offlineCount = deviceList.length - onlineCount

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="Devices"
        subtitle="All enrolled machines — online and offline"
        icon={<MonitorSmartphone className="h-5 w-5" />}
        actions={
          <>
            <Badge
              variant="outline"
              className="border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
            >
              {onlineCount} online
            </Badge>
            <Badge
              variant="outline"
              className="border-zinc-400/40 text-zinc-600 dark:text-zinc-400"
            >
              {offlineCount} offline
            </Badge>
            <Badge variant="secondary">{deviceList.length} total</Badge>
            <Button
              variant="ghost"
              size="sm"
              className="glass-inset h-11 gap-2 md:h-9"
              disabled={deviceList.length === 0}
              onClick={() => {
                const headers = [
                  'hostname',
                  'friendlyName',
                  'osName',
                  'osVersion',
                  'osArch',
                  'deviceType',
                  'status',
                  'cpuModel',
                  'cpuCores',
                  'totalMemoryMB',
                  'localIp',
                  'ipAddress',
                  'macAddress',
                  'agentVersion',
                  'lastSeen',
                  'locationLabel',
                ]
                const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
                const rows = deviceList.map((d) =>
                  [
                    d.hostname,
                    d.friendlyName,
                    d.osName,
                    d.osVersion,
                    d.osArch,
                    d.deviceType,
                    d.status,
                    d.cpuModel,
                    d.cpuCores,
                    d.totalMemoryMB,
                    d.localIp,
                    d.ipAddress,
                    d.macAddress,
                    d.agentVersion,
                    d.lastSeen,
                    d.locationLabel,
                  ]
                    .map(esc)
                    .join(',')
                )
                const csv = [headers.map(esc).join(','), ...rows].join('\n')
                const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
                const a = document.createElement('a')
                a.href = url
                a.download = 'sentrarmm-device-inventory.csv'
                a.click()
                URL.revokeObjectURL(url)
                toast.success(`Exported ${deviceList.length} devices to CSV`)
              }}
            >
              <Download className="h-4 w-4" />
              Export CSV
            </Button>
          </>
        }
      />

      {isLoading ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-48 rounded-2xl" />
          ))}
        </div>
      ) : error ? (
        <ErrorBlock
          message={error instanceof Error ? error.message : 'Failed to load devices'}
        />
      ) : deviceList.length === 0 ? (
        <EmptyState
          icon={<MonitorSmartphone className="h-8 w-8" />}
          title="No devices enrolled"
          hint="Start an agent to register your first machine."
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {deviceList.map((d) => (
            <DeviceCard key={d.id} device={d} />
          ))}
        </div>
      )}
    </div>
  )
}
