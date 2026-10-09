'use client'

import { useId, useMemo, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  ArrowDownWideNarrow,
  Camera,
  Clapperboard,
  Download,
  FolderTree,
  Info,
  Laptop,
  ListChecks,
  Loader2,
  MapPin,
  Monitor,
  MonitorSmartphone,
  Search,
  Server,
  SquareCheckBig,
  SquareTerminal,
  Star,
  Tag,
  Tags,
  Timer,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import { api, computeHealthScore, type Device, type DeviceType, type MediaAsset } from '@/lib/types'
import { useDash, type DeviceSort, type ViewId } from '@/lib/store'
import DeviceActivity from '../device-activity'
import { TelemetryChart } from '../telemetry-chart'
import { useTelemetryHistory, useTelemetrySparklines } from '@/hooks/use-telemetry-history'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
  HIST_RANGES,
  Panel,
  RangePicker,
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

/**
 * DB-backed utilization chart for one device (details dialog) with a local
 * window picker (5 m … 2 h). Falls back to an informative empty state for
 * offline / fresh devices.
 */
function DeviceUtilizationChart({ deviceId, online }: { deviceId: string; online: boolean }) {
  const [range, setRange] = useState(30)
  const { data, loading, error } = useTelemetryHistory({ deviceId, minutes: range })
  if (error) {
    return <ErrorBlock message={`History unavailable — ${error}`} />
  }
  if (data.length === 0) {
    return (
      <div className="glass-inset flex h-24 items-center justify-center rounded-xl px-4 text-center text-[11px] text-muted-foreground">
        {loading
          ? 'Loading utilization history…'
          : online
            ? 'Not enough samples yet — history accumulates every heartbeat (~15s).'
            : 'Device offline — history will resume on the next connection.'}
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-end">
        <RangePicker
          value={range}
          onChange={setRange}
          options={HIST_RANGES}
          label="Device utilization window"
          className="scale-95"
        />
      </div>
      <TelemetryChart
        data={data}
        metrics={['cpu', 'memory']}
        height={140}
        showLegend={false}
        ariaLabel={`Device utilization for the last ${range} minutes`}
        className="glass-inset rounded-xl p-1.5"
      />
    </div>
  )
}

function healthTone(score: number): string {
  if (score >= 80) return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
  if (score >= 55) return 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400'
  return 'border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400'
}

/**
 * Ultra-compact CPU sparkline strip for the DeviceCard — gradient area fill
 * with a soft glow on the last point. Unique gradient id per instance
 * (useId) so multiple cards never collide.
 */
function MiniSparkline({ values, className }: { values: number[]; className?: string }) {
  const id = useId()
  const w = 120
  const h = 30
  if (values.length < 2) {
    return (
      <div
        className={cn('flex items-center text-[10px] text-muted-foreground/70', className)}
        style={{ height: h }}
      >
        building trend…
      </div>
    )
  }
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * w
    const y = h - (Math.min(100, Math.max(0, v)) / 100) * (h - 8) - 4
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  const last = values[values.length - 1]
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className={cn('w-full', className)}
      style={{ height: h }}
      role="img"
      aria-label={`CPU trend over the last 15 minutes, currently ${Math.round(last)} percent`}
    >
      <defs>
        <linearGradient id={`spark-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.35" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <polygon points={`0,${h} ${pts.join(' ')} ${w},${h}`} fill={`url(#spark-${id})`} />
      <polyline
        points={pts.join(' ')}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        opacity="0.9"
      />
      <circle
        cx={w}
        cy={h - (Math.min(100, Math.max(0, last)) / 100) * (h - 8) - 4}
        r="2.5"
        className="fill-current"
        opacity="0.95"
      />
    </svg>
  )
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
  const [maintenance, setMaintenance] = useState(device.maintenance)
  const [maintBusy, setMaintBusy] = useState(false)

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

  async function toggleMaintenance(next: boolean) {
    setMaintBusy(true)
    try {
      await api<Device>(`/api/devices/${device.id}/maintenance`, {
        method: 'POST',
        body: JSON.stringify({ maintenance: next }),
      })
      setMaintenance(next)
      toast.success(next ? 'Maintenance window opened' : 'Maintenance window closed', {
        description: next
          ? `Alerts for ${device.hostname} are suppressed`
          : `Alerts for ${device.hostname} are active again`,
      })
      qc.invalidateQueries({ queryKey: ['devices'] })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to update maintenance mode')
    } finally {
      setMaintBusy(false)
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

      <DetailSection title="Utilization — window">
        <DeviceUtilizationChart deviceId={device.id} online={device.status === 'online'} />
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

      <DetailSection title="Recent activity">
        <DeviceActivity deviceId={device.id} />
      </DetailSection>

      <DetailSection title="Maintenance">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-xs font-medium">
              <Wrench
                className={cn('size-3.5', maintenance ? 'text-amber-500' : 'text-muted-foreground')}
                aria-hidden
              />
              Maintenance window
            </p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {maintenance
                ? 'Open — new alerts for this device are suppressed.'
                : 'Closed — alerts fire normally.'}
            </p>
          </div>
          <Switch
            checked={maintenance}
            onCheckedChange={(v) => toggleMaintenance(v)}
            disabled={maintBusy}
            aria-label={`Maintenance window for ${device.hostname}`}
          />
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

function DeviceCard({
  device,
  index,
  selectMode,
  selected,
  onToggleSelect,
  spark,
}: {
  device: Device
  index: number
  selectMode: boolean
  selected: boolean
  onToggleSelect: (id: string) => void
  /** recent cpu values (oldest → newest) for the card trend strip */
  spark?: number[]
}) {
  const setView = useDash((s) => s.setView)
  const setSelectedDeviceId = useDash((s) => s.setSelectedDeviceId)
  const metricsByDevice = useDash((s) => s.metricsByDevice)
  const pinned = useDash((s) => s.pinnedDevices.includes(device.id))
  const togglePinned = useDash((s) => s.togglePinnedDevice)
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
      <Panel
        className={cn(
          'glass-hover lift relative flex flex-col p-4',
          !online && 'opacity-80',
          pinned && !selectMode && 'ring-1 ring-primary/30',
          selectMode && selected && 'ring-2 ring-primary/50 shadow-lg shadow-primary/10',
        )}
        style={{ animation: `animate-in-up 360ms cubic-bezier(0.22,1,0.36,1) ${Math.min(index, 8) * 60}ms both` }}
      >
        {selectMode ? (
          <button
            type="button"
            aria-pressed={selected}
            aria-label={selected ? `Deselect ${device.hostname}` : `Select ${device.hostname}`}
            onClick={() => onToggleSelect(device.id)}
            className={cn(
              'absolute right-3 top-3 z-10 flex size-6 items-center justify-center rounded-md border transition-all',
              selected
                ? 'border-primary bg-primary text-primary-foreground shadow-inner'
                : 'border-border/70 bg-background/60 hover:border-primary/50 hover:bg-primary/10',
            )}
          >
            {selected ? <SquareCheckBig className="size-4" aria-hidden /> : null}
          </button>
        ) : null}
        <div className="flex items-start gap-2.5">
          <span className="mt-1.5">
            <StatusDot online={online} />
          </span>
          <div className="min-w-0 flex-1">
            {/* hostname gets the full row so it never over-truncates */}
            <div className="flex min-w-0 items-center gap-1.5">
              {device.maintenance ? (
                <span
                  className="flex shrink-0 items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-1.5 py-px text-[10px] font-semibold text-amber-600 dark:text-amber-400"
                  title="Maintenance window open — alerts suppressed"
                >
                  <Wrench className="size-3" aria-hidden />
                  maint
                </span>
              ) : null}
              <h3
                className="min-w-0 truncate font-semibold leading-tight"
                title={device.hostname}
              >
                {device.hostname}
              </h3>
              <TypeIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              {!selectMode ? (
                <button
                  type="button"
                  aria-label={pinned ? `Unpin ${device.hostname}` : `Pin ${device.hostname}`}
                  aria-pressed={pinned}
                  title={pinned ? 'Unpin device' : 'Pin to top'}
                  onClick={() => togglePinned(device.id)}
                  className="ml-auto shrink-0 rounded-md p-1 text-muted-foreground/50 outline-none transition-all hover:bg-primary/10 hover:text-primary focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  <Star
                    className={cn(
                      'size-4 transition-colors',
                      pinned && 'fill-primary text-primary',
                    )}
                    aria-hidden
                  />
                </button>
              ) : null}
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

        {online ? (
          <div className="mt-3 flex items-center gap-2.5 rounded-xl border border-border/40 bg-background/30 px-2.5 py-1.5">
            <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              cpu·15m
            </span>
            <div className="min-w-0 flex-1 text-primary">
              <MiniSparkline values={spark ?? []} />
            </div>
            {spark && spark.length >= 2 ? (
              <span
                className="shrink-0 rounded-md border border-primary/25 bg-primary/10 px-1.5 py-px font-mono text-[10px] font-semibold tabular-nums text-primary"
                title="current CPU %"
              >
                {Math.round(spark[spark.length - 1])}%
              </span>
            ) : null}
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

type StatusFilter = 'all' | 'online' | 'offline' | 'maintenance'

const SORT_LABELS: Record<DeviceSort, string> = {
  hostname: 'Hostname A–Z',
  health: 'Health score',
  lastSeen: 'Last seen',
  cpu: 'CPU live',
}

function StatusFilterPill({
  active,
  label,
  count,
  onClick,
}: {
  active: boolean
  label: string
  count: number
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'glass-inset inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-xs font-medium transition-all',
        active
          ? 'border border-primary/30 bg-primary/15 text-primary shadow-inner'
          : 'text-muted-foreground hover:bg-primary/10 hover:text-foreground',
      )}
    >
      {label}
      <span className="font-mono tabular-nums opacity-70">{count}</span>
    </button>
  )
}

export default function Devices() {
  const { data: devices, isLoading, error } = useDevices()
  const qc = useQueryClient()

  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [bulkBusy, setBulkBusy] = useState(false)
  const [tagDialogOpen, setTagDialogOpen] = useState(false)
  const [tagMode, setTagMode] = useState<'add' | 'remove'>('add')
  const [tagValue, setTagValue] = useState('')
  const deviceSort = useDash((s) => s.deviceSort)
  const setDeviceSort = useDash((s) => s.setDeviceSort)
  const pinnedDevices = useDash((s) => s.pinnedDevices)
  const metricsByDevice = useDash((s) => s.metricsByDevice)

  const deviceList = devices ?? []
  const onlineCount = deviceList.filter((d) => d.status === 'online').length
  const offlineCount = deviceList.length - onlineCount
  const maintenanceCount = deviceList.filter((d) => d.maintenance).length

  // every distinct tag in the fleet, alphabetical
  const allTags = useMemo(() => {
    const s = new Set<string>()
    for (const d of deviceList) for (const t of d.tags) s.add(t)
    return [...s].sort((a, b) => a.localeCompare(b))
  }, [deviceList])

  // tags present on the bulk-selected devices, with per-tag device counts
  const selectedTagCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const d of deviceList) {
      if (!selectedIds.includes(d.id)) continue
      for (const t of d.tags) counts.set(t, (counts.get(t) ?? 0) + 1)
    }
    return [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => a.tag.localeCompare(b.tag))
  }, [deviceList, selectedIds])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return deviceList.filter((d) => {
      if (statusFilter === 'online' && d.status !== 'online') return false
      if (statusFilter === 'offline' && d.status !== 'offline') return false
      if (statusFilter === 'maintenance' && !d.maintenance) return false
      if (tagFilter && !d.tags.includes(tagFilter)) return false
      if (!q) return true
      return (
        d.hostname.toLowerCase().includes(q) ||
        (d.friendlyName ?? '').toLowerCase().includes(q) ||
        d.osName.toLowerCase().includes(q) ||
        d.cpuModel?.toLowerCase().includes(q) ||
        d.ipAddress?.toLowerCase().includes(q) ||
        d.localIp?.toLowerCase().includes(q) ||
        d.tags.some((t) => t.toLowerCase().includes(q))
      )
    })
  }, [deviceList, search, statusFilter, tagFilter])

  // pinned devices always float to the top, then the chosen sort key
  const sorted = useMemo(() => {
    const healthOf = (d: Device) =>
      computeHealthScore({
        online: d.status === 'online',
        cpuPercent: metricsByDevice[d.id]?.cpuPercent,
        memoryPercent: metricsByDevice[d.id]?.memoryPercent,
        diskPercent: metricsByDevice[d.id]?.diskPercent,
        stale: d.status === 'online' && !metricsByDevice[d.id],
      })
    const byKey = (a: Device, b: Device): number => {
      switch (deviceSort) {
        case 'health':
          return healthOf(b) - healthOf(a)
        case 'lastSeen': {
          const ta = new Date(a.lastSeen ?? a.firstSeen).getTime()
          const tb = new Date(b.lastSeen ?? b.firstSeen).getTime()
          return tb - ta
        }
        case 'cpu':
          return (metricsByDevice[b.id]?.cpuPercent ?? -1) - (metricsByDevice[a.id]?.cpuPercent ?? -1)
        case 'hostname':
        default:
          return a.hostname.localeCompare(b.hostname)
      }
    }
    return [...filtered].sort((a, b) => {
      const pa = pinnedDevices.includes(a.id) ? 0 : 1
      const pb = pinnedDevices.includes(b.id) ? 0 : 1
      return pa !== pb ? pa - pb : byKey(a, b)
    })
  }, [filtered, deviceSort, pinnedDevices, metricsByDevice])

  // shared 15-minute CPU series — one query powers every card's trend strip
  const { series: sparkSeries } = useTelemetrySparklines({ minutes: 15 })

  const filtersActive = search.trim() !== '' || statusFilter !== 'all' || tagFilter !== null
  const clearFilters = () => {
    setSearch('')
    setStatusFilter('all')
    setTagFilter(null)
  }

  // ── bulk selection ──────────────────────────────────────────────
  const toggleSelectMode = () => {
    setSelectMode((v) => {
      if (v) setSelectedIds([])
      return !v
    })
  }
  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]))
  }
  const allFilteredSelected = filtered.length > 0 && filtered.every((d) => selectedIds.includes(d.id))
  const selectAllFiltered = () => {
    setSelectedIds((prev) =>
      allFilteredSelected
        ? prev.filter((id) => !filtered.some((d) => d.id === id))
        : [...new Set([...prev, ...filtered.map((d) => d.id)])],
    )
  }

  async function runBulk(action: 'maintenance' | 'addTag' | 'removeTag', value: boolean | string) {
    if (selectedIds.length === 0) return
    setBulkBusy(true)
    try {
      const res = await api<{ updated: number; detail: string }>('/api/devices/bulk', {
        method: 'POST',
        body: JSON.stringify({ ids: selectedIds, action, value }),
      })
      const label =
        action === 'maintenance'
          ? `Maintenance ${value === true ? 'opened' : 'closed'} on ${res.updated} device${res.updated === 1 ? '' : 's'}`
          : `Tag "${String(value)}" ${action === 'addTag' ? 'added to' : 'removed from'} ${res.updated} device${res.updated === 1 ? '' : 's'}`
      toast.success(label, { description: res.detail })
      qc.invalidateQueries({ queryKey: ['devices'] })
      qc.invalidateQueries({ queryKey: ['audit'] })
      setTagDialogOpen(false)
      setTagValue('')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Bulk action failed')
    } finally {
      setBulkBusy(false)
    }
  }

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
              variant={selectMode ? 'default' : 'ghost'}
              size="sm"
              className={cn('h-11 gap-2 md:h-9', !selectMode && 'glass-inset')}
              aria-pressed={selectMode}
              disabled={deviceList.length === 0}
              onClick={toggleSelectMode}
            >
              <ListChecks className="h-4 w-4" aria-hidden />
              {selectMode ? 'Cancel' : 'Bulk edit'}
            </Button>
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

      {/* Filter toolbar — search / status / tags */}
      {!isLoading && !error && deviceList.length > 0 ? (
        <Panel className="card-sheen relative overflow-hidden p-3">
          <div
            aria-hidden
            className="pointer-events-none absolute -left-10 -top-10 h-28 w-28 rounded-full bg-primary/5 blur-2xl"
          />
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              {/* search */}
              <div className="relative w-full sm:w-auto sm:min-w-0 sm:max-w-xs sm:flex-1">
                <Search
                  className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
                  aria-hidden
                />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search hostname, OS, IP, tag…"
                  className="h-9 pl-8"
                  aria-label="Search devices"
                />
              </div>
              {/* status pills */}
              <div
                className="flex items-center gap-1.5"
                role="group"
                aria-label="Filter by status"
              >
                <StatusFilterPill
                  active={statusFilter === 'all'}
                  label="All"
                  count={deviceList.length}
                  onClick={() => setStatusFilter('all')}
                />
                <StatusFilterPill
                  active={statusFilter === 'online'}
                  label="Online"
                  count={onlineCount}
                  onClick={() => setStatusFilter('online')}
                />
                <StatusFilterPill
                  active={statusFilter === 'offline'}
                  label="Offline"
                  count={offlineCount}
                  onClick={() => setStatusFilter('offline')}
                />
                <StatusFilterPill
                  active={statusFilter === 'maintenance'}
                  label="Maint"
                  count={maintenanceCount}
                  onClick={() => setStatusFilter('maintenance')}
                />
              </div>
              {/* sort control */}
              <div className="flex items-center gap-1.5">
                <ArrowDownWideNarrow
                  className="size-3.5 shrink-0 text-muted-foreground"
                  aria-hidden
                />
                <Select value={deviceSort} onValueChange={(v) => setDeviceSort(v as DeviceSort)}>
                  <SelectTrigger
                    className="glass-inset h-9 w-[132px] justify-between text-xs sm:w-[150px]"
                    aria-label="Sort devices"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="glass-strong">
                    {(Object.keys(SORT_LABELS) as DeviceSort[]).map((k) => (
                      <SelectItem key={k} value={k} className="text-xs">
                        {SORT_LABELS[k]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {filtersActive ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto h-9 gap-1.5 text-muted-foreground"
                  onClick={clearFilters}
                >
                  <X className="size-3.5" aria-hidden />
                  Clear
                </Button>
              ) : null}
            </div>
            {allTags.length > 0 ? (
              <div className="flex flex-wrap items-center gap-1.5">
                <Tag
                  className="mr-0.5 size-3.5 text-muted-foreground"
                  aria-hidden
                />
                {allTags.map((t) => {
                  const active = tagFilter === t
                  return (
                    <button
                      key={t}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setTagFilter(active ? null : t)}
                      className={cn(
                        'rounded-full border px-2.5 py-1 text-[11px] font-medium transition-all',
                        active
                          ? 'border-primary/40 bg-primary/15 text-primary shadow-inner'
                          : 'border-border/60 bg-background/40 text-muted-foreground hover:border-primary/30 hover:bg-primary/10 hover:text-foreground',
                      )}
                    >
                      {t}
                    </button>
                  )
                })}
              </div>
            ) : null}
          </div>
        </Panel>
      ) : null}

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
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<Search className="h-8 w-8" />}
          title="No devices match your filters"
          hint={
            filtersActive
              ? 'Try a different search term, status or tag.'
              : undefined
          }
        />
      ) : (
        <>
          {filtersActive ? (
            <p className="text-xs text-muted-foreground" aria-live="polite">
              showing{' '}
              <span className="font-semibold text-foreground">{filtered.length}</span> of{' '}
              {deviceList.length} devices
            </p>
          ) : null}
          {selectMode ? (
            <div className="glass-inset flex flex-wrap items-center gap-2 rounded-xl px-3 py-2">
              <button
                type="button"
                aria-pressed={allFilteredSelected}
                onClick={selectAllFiltered}
                className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-primary/10 hover:text-foreground"
              >
                <SquareCheckBig
                  className={cn('size-3.5', allFilteredSelected && 'text-primary')}
                  aria-hidden
                />
                {allFilteredSelected ? 'Deselect shown' : 'Select all shown'}
              </button>
              <span className="text-xs text-muted-foreground">
                pick machines for the bulk actions below
              </span>
              <span className="ml-auto font-mono text-xs tabular-nums text-muted-foreground">
                {selectedIds.length} selected
              </span>
            </div>
          ) : null}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {sorted.map((d, i) => (
              <DeviceCard
                key={d.id}
                device={d}
                index={i}
                selectMode={selectMode}
                selected={selectedIds.includes(d.id)}
                onToggleSelect={toggleSelect}
                spark={sparkSeries[d.id]}
              />
            ))}
          </div>
        </>
      )}

      {/* floating bulk-action dock */}
      {selectMode ? (
        <div
          className="glass-overlay fixed bottom-5 left-1/2 z-50 flex w-max max-w-[calc(100vw-2.5rem)] flex-wrap items-center justify-center gap-2 rounded-2xl border-border/60 px-4 py-3 shadow-2xl shadow-black/20"
          style={{ animation: 'dock-in 260ms cubic-bezier(0.22,1,0.36,1) both' }}
          role="toolbar"
          aria-label="Bulk device actions"
        >
          <span className="mr-1 flex items-center gap-1.5 text-xs font-semibold">
            <span className="flex size-5 items-center justify-center rounded-full bg-primary font-mono text-[10px] text-primary-foreground">
              {selectedIds.length}
            </span>
            selected
          </span>
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1.5"
            disabled={selectedIds.length === 0 || bulkBusy}
            onClick={() => void runBulk('maintenance', true)}
          >
            <Wrench className="size-3.5 text-amber-500" aria-hidden /> Open maint
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1.5"
            disabled={selectedIds.length === 0 || bulkBusy}
            onClick={() => void runBulk('maintenance', false)}
          >
            <Wrench className="size-3.5" aria-hidden /> Close maint
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1.5"
            disabled={selectedIds.length === 0 || bulkBusy}
            onClick={() => {
              setTagMode('add')
              setTagValue('')
              setTagDialogOpen(true)
            }}
          >
            <Tag className="size-3.5 text-teal-500" aria-hidden /> Add tag
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1.5"
            disabled={selectedIds.length === 0 || bulkBusy || selectedTagCounts.length === 0}
            title={selectedTagCounts.length === 0 ? 'The selected devices have no tags' : 'Remove a tag from every selected device'}
            onClick={() => {
              setTagMode('remove')
              setTagValue('')
              setTagDialogOpen(true)
            }}
          >
            <Tags className="size-3.5 text-rose-500" aria-hidden /> Remove tag
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-8 gap-1.5 text-muted-foreground"
            disabled={selectedIds.length === 0 || bulkBusy}
            onClick={() => setSelectedIds([])}
          >
            <X className="size-3.5" aria-hidden /> Clear
          </Button>
        </div>
      ) : null}

      {/* bulk tag dialog — add or remove mode */}
      <Dialog open={tagDialogOpen} onOpenChange={setTagDialogOpen}>
        <DialogContent className="glass-strong rounded-2xl sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              {tagMode === 'add' ? (
                <>
                  <Tag className="size-4 text-teal-500" aria-hidden /> Tag {selectedIds.length} device{selectedIds.length === 1 ? '' : 's'}
                </>
              ) : (
                <>
                  <Tags className="size-4 text-rose-500" aria-hidden /> Untag {selectedIds.length} device{selectedIds.length === 1 ? '' : 's'}
                </>
              )}
            </DialogTitle>
            <DialogDescription>
              {tagMode === 'add'
                ? 'Adds a new tag to every selected machine (existing tags are kept).'
                : 'Pick a tag that exists on at least one selected machine — it is removed from all of them.'}
            </DialogDescription>
          </DialogHeader>
          {tagMode === 'add' ? (
            <Input
              value={tagValue}
              onChange={(e) => setTagValue(e.target.value)}
              placeholder="e.g. q4-audit"
              maxLength={40}
              aria-label="Tag name"
            />
          ) : (
            <div className="flex max-h-48 flex-col gap-1.5 overflow-y-auto scroll-slim" role="list" aria-label="Tags on selected devices">
              {selectedTagCounts.map(({ tag, count }) => (
                <button
                  key={tag}
                  role="listitem"
                  className="glass-inset flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:border-rose-500/40 hover:bg-rose-500/10"
                  disabled={bulkBusy}
                  onClick={() => void runBulk('removeTag', tag)}
                >
                  <span className="flex items-center gap-1.5 font-mono text-xs">
                    <Tag className="size-3 text-teal-500" aria-hidden /> {tag}
                  </span>
                  <span className="text-[10px] text-muted-foreground">on {count} device{count === 1 ? '' : 's'} — remove</span>
                </button>
              ))}
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button variant="outline" size="sm" onClick={() => setTagDialogOpen(false)}>
              Cancel
            </Button>
            {tagMode === 'add' ? (
              <Button
                size="sm"
                disabled={tagValue.trim() === '' || bulkBusy}
                onClick={() => void runBulk('addTag', tagValue.trim())}
              >
                {bulkBusy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
                Add tag
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
