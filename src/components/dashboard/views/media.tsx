'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'framer-motion'
import { toast } from 'sonner'
import {
  Camera,
  Clapperboard,
  Download,
  Eye,
  Info,
  Loader2,
  Lock,
  Mic,
  Monitor,
  MonitorPlay,
  PhoneCall,
  Play,
  ShieldCheck,
  Square,
  SquareTerminal,
  Trash2,
  Video,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import {
  api,
  type AppSettings,
  type Device,
  type MediaAsset,
  type MediaKind,
  type MediaStatus,
  type StreamKind,
} from '@/lib/types'
import { useDash, type ActiveStream } from '@/lib/store'
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
  timeAgo,
  useDevices,
} from '../shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'

// ─────────────────────────── helpers ────────────────────────────────

const KIND_META: Record<MediaKind, { label: string; icon: LucideIcon }> = {
  screenshot: { label: 'Screenshot', icon: Camera },
  screen_record: { label: 'Screen recording', icon: MonitorPlay },
  mic_record: { label: 'Microphone only', icon: Mic },
  camera_stream: { label: 'Camera stream', icon: Video },
  call: { label: 'Video call', icon: PhoneCall },
}

const ACTIVE_STATUSES: MediaStatus[] = ['requested', 'capturing', 'processing']

const STREAM_KIND_META: Record<StreamKind, { label: string; icon: LucideIcon }> = {
  screen: { label: 'Screen', icon: Monitor },
  camera: { label: 'Camera', icon: Camera },
  mic: { label: 'Microphone', icon: Mic },
}

const SCREEN_FPS = [1, 2, 3, 5]
const CAMERA_FPS = [5, 10, 15]
const QUALITIES = ['480p', '720p', '1080p', 'source'] as const
type Quality = (typeof QUALITIES)[number]

function statusBadge(status: MediaStatus): { label: string; className: string; pulse: boolean } {
  switch (status) {
    case 'available':
      return {
        label: 'available',
        className: 'border-emerald-500/30 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
        pulse: false,
      }
    case 'capturing':
      return {
        label: 'capturing',
        className: 'border-amber-500/30 bg-amber-500/15 text-amber-600 dark:text-amber-400',
        pulse: true,
      }
    case 'requested':
      return {
        label: 'requested',
        className: 'border-amber-500/30 bg-amber-500/15 text-amber-600 dark:text-amber-400',
        pulse: true,
      }
    case 'processing':
      return {
        label: 'processing',
        className: 'border-teal-500/30 bg-teal-500/15 text-teal-600 dark:text-teal-400',
        pulse: true,
      }
    case 'failed':
      return {
        label: 'failed',
        className: 'border-rose-500/30 bg-rose-500/15 text-rose-600 dark:text-rose-400',
        pulse: false,
      }
    case 'stopped':
      return {
        label: 'stopped',
        className: 'border-zinc-500/30 bg-zinc-500/15 text-zinc-600 dark:text-zinc-400',
        pulse: false,
      }
  }
}

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`
}

function fmtDurationLabel(durationSec: number | null): string {
  if (!durationSec) return 'indefinite'
  if (durationSec < 60) return `${durationSec}s`
  if (durationSec < 3600) return `${Math.floor(durationSec / 60)} min`
  return `${Math.floor(durationSec / 3600)} h`
}

// ─────────────────── capture capabilities strip ─────────────────────

/**
 * Honest summary of what the agent says it can capture. Legacy agents
 * (captures === null) get an explicit "needs Python/Node agent" note
 * instead of a silently empty launcher.
 */
function CaptureStrip({ device }: { device: Device | null }) {
  if (!device) return null
  const caps = device.captures
  const hasAny =
    !!caps &&
    (caps.monitors.length > 0 || caps.cameras.length > 0 || caps.mics.length > 0)

  if (!caps || !hasAny) {
    return (
      <div className="glass-inset flex items-start gap-2.5 rounded-2xl border-amber-500/30 px-4 py-3">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" aria-hidden />
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{device.hostname}</span> did not report
          capture sources — the Python/Node agent is required for multi-source streaming.
          Screenshots below still work through the legacy capture channel.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Captures
      </span>
      <Badge variant="outline" className="gap-1 border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
        <Monitor className="h-3 w-3" /> {caps.monitors.length} monitor{caps.monitors.length === 1 ? '' : 's'}
      </Badge>
      <Badge variant="outline" className="gap-1 border-teal-500/30 bg-teal-500/10 text-teal-600 dark:text-teal-400">
        <Camera className="h-3 w-3" /> {caps.cameras.length} camera{caps.cameras.length === 1 ? '' : 's'}
      </Badge>
      <Badge variant="outline" className="gap-1 border-fuchsia-500/30 bg-fuchsia-500/10 text-fuchsia-600 dark:text-fuchsia-400">
        <Mic className="h-3 w-3" /> {caps.mics.length} mic{caps.mics.length === 1 ? '' : 's'}
      </Badge>
      {caps.shells.length > 0 ? (
        <Badge variant="outline" className="gap-1 border-border/60 bg-background/40">
          <SquareTerminal className="h-3 w-3" /> {caps.shells.join(' · ')}
        </Badge>
      ) : null}
      {(caps.notes ?? []).map((n) => (
        <span key={n} className="text-[11px] text-muted-foreground/80" title="agent-reported limitation">
          {n}
        </span>
      ))}
    </div>
  )
}

// ───────────────────── mic level meter (no image) ───────────────────

/**
 * Animated input-level meter driven by `stream:frame` level (0..1, ~8 Hz).
 * The fill eases via CSS transition; a peak-hold marker decays slowly so
 * transient spikes stay readable.
 */
function MicLevelMeter({ level }: { level: number }) {
  const peakRef = useRef(0)
  const [peak, setPeak] = useState(0)

  useEffect(() => {
    // rise instantly, decay ~0.02 per frame (~8 Hz updates)
    const next = Math.max(level, peakRef.current - 0.02)
    peakRef.current = next
    setPeak(next)
  }, [level])

  const pct = Math.min(100, Math.max(0, Math.round(level * 100)))
  const peakPct = Math.min(99, Math.max(1, Math.round(peak * 100)))

  return (
    <div className="flex flex-col items-center justify-center gap-5 px-6 py-12">
      <div className="glass-inset flex h-14 w-14 items-center justify-center rounded-2xl">
        <Mic
          className={cn(
            'h-6 w-6 transition-colors duration-200',
            pct > 4 ? 'text-rose-500' : 'text-muted-foreground',
          )}
          aria-hidden
        />
      </div>
      <div
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label="Microphone input level"
        className="glass-inset relative h-3.5 w-full max-w-sm overflow-hidden rounded-full"
      >
        <div
          className="h-full rounded-full bg-gradient-to-r from-emerald-500 via-teal-400 to-rose-400 transition-[width] duration-150 ease-out"
          style={{ width: `${Math.max(2, pct)}%` }}
        />
        {/* peak-hold marker */}
        <span
          aria-hidden
          className="absolute top-0 h-full w-0.5 rounded-full bg-foreground/60 transition-[left] duration-150 ease-out"
          style={{ left: `calc(${peakPct}% - 1px)` }}
        />
      </div>
      <p className="font-mono text-xs tabular-nums text-muted-foreground">
        {pct}% input level · live
      </p>
    </div>
  )
}

// ─────────────────────── live stream panel ──────────────────────────

function StreamPanel({
  stream,
  now,
  onStop,
  stopping,
}: {
  stream: ActiveStream
  now: number
  onStop: (streamId: string) => void
  stopping: boolean
}) {
  const frame = useDash((s) => s.streamFrames[stream.streamId])
  const { data: devices } = useDevices()
  const hostname =
    devices?.find((d) => d.id === stream.deviceId)?.hostname ?? stream.agentId

  // measured fps — trailing 5s window of frame arrivals, 1s ticker
  const timesRef = useRef<number[]>([])
  const [measuredFps, setMeasuredFps] = useState(0)
  const seq = frame?.seq ?? 0

  useEffect(() => {
    if (seq === 0) return
    const t = Date.now()
    timesRef.current = [...timesRef.current, t].filter((x) => t - x <= 5000)
  }, [seq, frame?.at])

  useEffect(() => {
    const iv = setInterval(() => {
      const t = Date.now()
      timesRef.current = timesRef.current.filter((x) => t - x <= 5000)
      setMeasuredFps(Math.round((timesRef.current.length / 5) * 10) / 10)
    }, 1000)
    return () => clearInterval(iv)
  }, [])

  const meta = STREAM_KIND_META[stream.kind]
  const Icon = meta.icon
  const hasImage = stream.kind !== 'mic'

  // stall watchdog — if no frame has arrived for 12s (e.g. the agent or hub
  // restarted while this panel was open) the panel must not keep claiming
  // LIVE. Derived from the 1s `now` ticker, so no extra timers/state.
  const lastFrameAt = frame?.at ?? stream.startedAt
  const stalled = now - lastFrameAt > 12000

  return (
    <motion.div
      layout
      variants={{
        hidden: { opacity: 0, y: 14, scale: 0.98 },
        show: {
          opacity: 1,
          y: 0,
          scale: 1,
          transition: { duration: 0.28, ease: 'easeOut' },
        },
      }}
      exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.18 } }}
      className="glass glass-hover lift flex flex-col overflow-hidden rounded-2xl"
    >
      {/* header */}
      <div className="flex items-center gap-2.5 px-3.5 pb-2 pt-3">
        {stalled ? (
          <span className="relative flex h-2.5 w-2.5 shrink-0" aria-hidden>
            <span className="inline-flex h-2.5 w-2.5 rounded-full bg-amber-500" />
          </span>
        ) : (
          <span className="relative flex h-2.5 w-2.5 shrink-0" aria-hidden>
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-500 opacity-70" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-rose-500" />
          </span>
        )}
        <div className="glass-inset flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-primary">
          <Icon className="h-3.5 w-3.5" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold leading-tight">{stream.sourceName}</p>
          <p className="truncate text-[11px] text-muted-foreground">
            {meta.label} · {hostname}
          </p>
        </div>
        {stalled ? (
          <Badge
            variant="outline"
            title="No frames for 12s — the stream may have ended when the agent or hub reconnected. Stop clears the panel."
            className="shrink-0 animate-pulse border-amber-500/40 bg-amber-500/10 text-[10px] font-bold tracking-wider text-amber-600 dark:text-amber-400"
          >
            NO SIGNAL
          </Badge>
        ) : (
          <Badge
            variant="outline"
            className="shrink-0 border-rose-500/40 bg-rose-500/10 text-[10px] font-bold tracking-wider text-rose-600 dark:text-rose-400"
          >
            LIVE
          </Badge>
        )}
      </div>

      {/* body */}
      {hasImage ? (
        frame?.dataUri ? (
          <img
            src={frame.dataUri}
            alt={`Live ${stream.kind} stream from ${stream.sourceName}`}
            className={cn(
              'max-h-56 w-full bg-black/50 object-contain transition-opacity duration-500 sm:max-h-64',
              stalled && 'opacity-50 grayscale',
            )}
            decoding="async"
          />
        ) : (
          <div className="flex h-40 w-full flex-col items-center justify-center gap-2 bg-black/30">
            <Loader2
              className={cn(
                'h-5 w-5 animate-spin text-emerald-400',
                stalled && 'opacity-40',
              )}
              aria-hidden
            />
            <p className="text-xs text-zinc-400">
              {stalled ? 'no frames arriving — agent may have reconnected' : 'waiting for first frame…'}
            </p>
          </div>
        )
      ) : (
        <MicLevelMeter level={stalled ? 0 : (frame?.level ?? 0)} />
      )}

      {/* footer */}
      <div className="flex flex-wrap items-center gap-1.5 px-3.5 py-2.5 text-[11px] text-muted-foreground">
        <Badge variant="secondary" className="font-mono text-[10px] tabular-nums">
          {measuredFps > 0 ? `${measuredFps.toFixed(1)} fps` : `${stream.fps || '—'} fps target`}
        </Badge>
        <Badge variant="secondary" className="font-mono text-[10px] tabular-nums">
          #{seq}
        </Badge>
        <Badge variant="secondary" className="font-mono text-[10px] tabular-nums">
          {fmtElapsed(now - stream.startedAt)}
        </Badge>
        {hasImage && stream.quality ? (
          <Badge variant="secondary" className="font-mono text-[10px]">
            {stream.quality}
          </Badge>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          className="ml-auto h-8 shrink-0 border-rose-500/40 text-rose-600 hover:bg-rose-500/10 hover:text-rose-700 dark:text-rose-400 dark:hover:text-rose-300"
          disabled={stopping}
          onClick={() => onStop(stream.streamId)}
        >
          {stopping ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <Square className="h-3.5 w-3.5" aria-hidden />
          )}
          Stop
        </Button>
      </div>
    </motion.div>
  )
}

// ───────────────────── per-source launcher row ──────────────────────

interface SourceConfig {
  fps: number
  quality: Quality
}

function LauncherRow({
  kind,
  sourceId,
  name,
  meta,
  cfg,
  onCfg,
  active,
  busy,
  disabled,
  onStart,
  onStop,
}: {
  kind: StreamKind
  sourceId: string | null
  name: string
  meta: string | null
  cfg: SourceConfig
  onCfg: (sourceId: string, kind: StreamKind, patch: Partial<SourceConfig>) => void
  active: boolean
  busy: boolean
  disabled: boolean
  onStart: () => void
  onStop: () => void
}) {
  const key = sourceId ?? '__default__'
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl px-3 py-2.5 transition-colors',
        active ? 'bg-rose-500/5 ring-1 ring-rose-500/20' : 'hover:bg-primary/5',
      )}
    >
      <div className="min-w-0 flex-1 basis-40">
        <p className="flex items-center gap-1.5 truncate text-sm font-medium">
          {active ? (
            <span className="relative flex h-2 w-2 shrink-0" aria-hidden>
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-500 opacity-70" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-rose-500" />
            </span>
          ) : null}
          {name}
        </p>
        {meta ? <p className="truncate text-[11px] text-muted-foreground">{meta}</p> : null}
      </div>

      {kind !== 'mic' ? (
        <>
          <div className="flex items-center gap-1.5">
            <Label className="sr-only" htmlFor={`fps-${key}`}>
              Frames per second for {name}
            </Label>
            <Select
              value={String(cfg.fps)}
              onValueChange={(v) => onCfg(key, kind, { fps: Number(v) })}
              disabled={disabled || active}
            >
              <SelectTrigger
                id={`fps-${key}`}
                className="h-8 w-[74px] text-xs"
                aria-label={`FPS for ${name}`}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="glass-overlay">
                {(kind === 'screen' ? SCREEN_FPS : CAMERA_FPS).map((f) => (
                  <SelectItem key={f} value={String(f)} className="text-xs">
                    {f} fps
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-1.5">
            <Label className="sr-only" htmlFor={`q-${key}`}>
              Quality for {name}
            </Label>
            <Select
              value={cfg.quality}
              onValueChange={(v) => onCfg(key, kind, { quality: v as Quality })}
              disabled={disabled || active}
            >
              <SelectTrigger
                id={`q-${key}`}
                className="h-8 w-[92px] text-xs"
                aria-label={`Quality for ${name}`}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="glass-overlay">
                {QUALITIES.map((q) => (
                  <SelectItem key={q} value={q} className="text-xs">
                    {q === 'source' ? 'source' : q}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </>
      ) : null}

      {active ? (
        <Button
          size="sm"
          variant="outline"
          className="h-8 shrink-0 border-rose-500/40 text-rose-600 hover:bg-rose-500/10 hover:text-rose-700 dark:text-rose-400 dark:hover:text-rose-300"
          onClick={onStop}
        >
          <Square className="h-3.5 w-3.5" aria-hidden />
          Stop
        </Button>
      ) : (
        <Button size="sm" variant="outline" className="h-8 shrink-0 border-primary/40" disabled={disabled || busy} onClick={onStart}>
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <Play className="h-3.5 w-3.5" aria-hidden />
          )}
          Start
        </Button>
      )}
    </div>
  )
}

// ───────────────────────── live view dialog ─────────────────────────

/**
 * Live screen viewer — one-way socket stream (`screen:frame`).
 * Frames are rendered straight from the store; nothing is persisted.
 */
function LiveViewDialog({
  device,
  open,
  onOpenChange,
  now,
}: {
  device: Device | null
  open: boolean
  onOpenChange: (o: boolean) => void
  now: number
}) {
  const liveFrame = useDash((s) => s.liveFrame)
  const clearLiveFrame = useDash((s) => s.setLiveFrame)
  const { data: devices } = useDevices()
  const [fps, setFps] = useState(0)
  const frameTimes = useRef<number[]>([])
  const startedAt = useRef<number>(Date.now())

  const frame = useMemo(() => {
    if (!liveFrame || !device) return null
    if (liveFrame.agentId === device.id) return liveFrame
    const matchesAgent = (devices ?? []).some(
      (d) => d.id === device.id && d.agentId === liveFrame.agentId,
    )
    return matchesAgent ? liveFrame : null
  }, [liveFrame, device, devices])

  // record frame arrivals (one effect per frame, no timers)
  useEffect(() => {
    if (!open || frame?.seq == null) return
    const t = Date.now()
    frameTimes.current = [...frameTimes.current, t].filter((x) => t - x <= 4000)
  }, [open, frame?.seq])

  // FPS meter — independent 1s ticker over the trailing 4s window
  useEffect(() => {
    if (!open) return
    const iv = setInterval(() => {
      const t = Date.now()
      frameTimes.current = frameTimes.current.filter((x) => t - x <= 4000)
      setFps(Math.round((frameTimes.current.length / 4) * 10) / 10)
    }, 1000)
    return () => clearInterval(iv)
  }, [open])

  useEffect(() => {
    if (open) startedAt.current = Date.now()
  }, [open])

  const stop = useMutation({
    mutationFn: () =>
      api<{ ok: true }>('/api/media/live', {
        method: 'POST',
        body: JSON.stringify({ deviceId: device?.id, action: 'stop' }),
      }),
    onSettled: () => clearLiveFrame(null),
  })

  const handleClose = (o: boolean) => {
    if (!o && open) stop.mutate()
    onOpenChange(o)
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="glass-strong sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-500 opacity-70" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-rose-500" />
            </span>
            Live view — {device?.hostname ?? 'device'}
          </DialogTitle>
          <DialogDescription>
            Realtime one-way stream over the agent socket · never persisted · encrypted transport
          </DialogDescription>
        </DialogHeader>

        <div className="overflow-hidden rounded-xl ring-1 ring-border/60">
          {frame ? (
            <img
              src={frame.dataUri}
              alt={`Live screen of ${device?.hostname ?? 'device'}`}
              className="w-full object-contain"
            />
          ) : (
            <div className="terminal-glass flex h-72 w-full flex-col items-center justify-center gap-3">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
              <p className="text-sm text-muted-foreground">Waiting for first frame…</p>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-400">
              LIVE
            </Badge>
            <Badge variant="secondary" className="font-mono text-[10px]">{fps} fps</Badge>
            <Badge variant="secondary" className="font-mono text-[10px]">
              frame #{frame?.seq ?? 0}
            </Badge>
            <Badge variant="secondary" className="font-mono text-[10px]">1600×900</Badge>
          </div>
          <div className="flex items-center gap-3">
            <span className="font-mono">{fmtElapsed(now - startedAt.current)} elapsed</span>
            <Button
              size="sm"
              variant="destructive"
              className="h-9"
              disabled={stop.isPending}
              onClick={() => handleClose(false)}
            >
              <Square className="h-3.5 w-3.5" /> Stop stream
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ──────────────────────────── view ──────────────────────────────────

export default function MediaView() {
  const qc = useQueryClient()
  const selectedDeviceId = useDash((s) => s.selectedDeviceId)
  const setSelectedDeviceId = useDash((s) => s.setSelectedDeviceId)
  const activeStreams = useDash((s) => s.activeStreams)
  const addStream = useDash((s) => s.addStream)
  const removeStream = useDash((s) => s.removeStream)
  const { data: devices } = useDevices()

  const device = useMemo(
    () => (devices ?? []).find((d) => d.id === selectedDeviceId) ?? null,
    [devices, selectedDeviceId]
  )

  // settings → encryption banner + default stream quality
  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api<AppSettings>('/api/settings'),
    staleTime: 60_000,
  })

  const [kind, setKind] = useState<MediaKind>('screen_record')
  const [quality, setQuality] = useState<string | null>(null)
  const [durationSec, setDurationSec] = useState('60')
  const [withMic, setWithMic] = useState(false)
  const [preview, setPreview] = useState<MediaAsset | null>(null)
  const [liveOpen, setLiveOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  // per-source launcher config (fps + quality), keyed by sourceId
  const [srcCfg, setSrcCfg] = useState<Record<string, SourceConfig>>({})
  const [startingKey, setStartingKey] = useState<string | null>(null)
  const [stoppingId, setStoppingId] = useState<string | null>(null)

  const effectiveQuality = quality ?? settings?.defaultStreamQuality ?? '720p'
  const hasPassword = Boolean(settings?.capturePassword)

  // 1s ticker for "elapsed" on active captures + stream panels
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const mediaQuery = useQuery({
    queryKey: ['media', selectedDeviceId],
    queryFn: () =>
      api<MediaAsset[]>(`/api/media?deviceId=${encodeURIComponent(String(selectedDeviceId))}&limit=60`),
    enabled: !!selectedDeviceId,
    refetchInterval: 8000,
  })

  const invalidate = () => qc.invalidateQueries({ queryKey: ['media'] })

  // ── multi-source stream control ─────────────────────────────────

  const startStream = useMutation({
    mutationFn: (v: {
      kind: StreamKind
      sourceId: string | null
      sourceName: string
      fps?: number
      quality?: string
    }) =>
      api<{ streamId: string }>('/api/streams/start', {
        method: 'POST',
        body: JSON.stringify({
          deviceId: selectedDeviceId,
          kind: v.kind,
          sourceId: v.sourceId,
          fps: v.fps,
          quality: v.quality,
        }),
      }),
    onSuccess: (data, v) => {
      if (!data?.streamId) throw new Error('agent did not return a streamId')
      addStream({
        streamId: data.streamId,
        kind: v.kind,
        deviceId: selectedDeviceId ?? '',
        agentId: device?.agentId ?? '',
        sourceId: v.sourceId,
        sourceName: v.sourceName,
        fps: v.fps ?? 0,
        quality: v.quality ?? 'source',
        startedAt: Date.now(),
      })
      toast.success(`${STREAM_KIND_META[v.kind].label} stream started`, {
        description: `${v.sourceName} • ${v.fps ? `${v.fps} fps` : 'levels only'}${
          v.quality ? ` • ${v.quality}` : ''
        }`,
      })
    },
    onError: (e) =>
      toast.error('Stream failed to start', {
        description: e instanceof Error ? e.message : 'Unknown error',
      }),
    onSettled: () => setStartingKey(null),
  })

  const stopStream = useMutation({
    mutationFn: (streamId: string) =>
      api<{ ok: true }>('/api/streams/stop', {
        method: 'POST',
        body: JSON.stringify({ streamId }),
      }),
    onSuccess: (_d, streamId) => {
      // keep the panel until the socket confirms — the button shows a spinner
      toast.success('Stop signal sent — stream is wrapping up')
    },
    onError: (e) =>
      toast.error('Failed to stop stream', {
        description:
          (e instanceof Error ? e.message : 'Unknown error') +
          ' — the panel is retired locally if the agent no longer knows the stream.',
      }),
    // Belt-and-braces (success AND error paths): the hub normally broadcasts
    // `stream:ended` after the agent acks, but some dispatch paths skip the
    // broadcast — and a stop against a stream the agent already lost (agent
    // restart, hub restart) errors out without any `stream:ended`. If the
    // panel is still registered after a short grace period, retire it locally
    // so the UI never hangs. (removeStream is idempotent.)
    onSettled: (_d, _e, streamId) => {
      setStoppingId(null)
      window.setTimeout(() => {
        if (useDash.getState().activeStreams[streamId]) {
          removeStream(streamId)
          toast.info('Stream ended')
        }
      }, 3000)
    },
  })

  const stopAllStreams = useMutation({
    mutationFn: async (ids: string[]) => {
      await Promise.allSettled(
        ids.map((streamId) =>
          api<{ ok: true }>('/api/streams/stop', {
            method: 'POST',
            body: JSON.stringify({ streamId }),
          }),
        ),
      )
    },
    onSuccess: (_d, ids) => {
      toast.success('Stop signal sent to all streams')
    },
    onError: (e) =>
      toast.error('Failed to stop streams', {
        description: e instanceof Error ? e.message : 'Unknown error',
      }),
    // Same belt-and-braces as stopStream (both paths) — retire panels the
    // socket never confirmed ended (idempotent when `stream:ended` arrived).
    onSettled: (_d, _e, ids) => {
      for (const streamId of ids) {
        window.setTimeout(() => {
          if (useDash.getState().activeStreams[streamId]) {
            removeStream(streamId)
          }
        }, 3000)
      }
    },
  })

  const caps = device?.captures ?? null
  const hasCaps =
    !!caps && (caps.monitors.length > 0 || caps.cameras.length > 0 || caps.mics.length > 0)
  const runningList = Object.values(activeStreams)

  const cfgFor = (sourceId: string | null, k: StreamKind): SourceConfig => {
    const key = sourceId ?? '__default__'
    const existing = srcCfg[key]
    if (existing) return existing
    return {
      fps: k === 'screen' ? 2 : 10,
      quality: (settings?.defaultStreamQuality ?? '720p') as Quality,
    }
  }

  const patchCfg = (sourceId: string, k: StreamKind, patch: Partial<SourceConfig>) =>
    setSrcCfg((prev) => ({
      ...prev,
      [sourceId]: { ...cfgFor(sourceId, k), ...patch },
    }))

  const activeFor = (k: StreamKind, sourceId: string | null) =>
    runningList.find(
      (s) => s.deviceId === selectedDeviceId && s.kind === k && (s.sourceId ?? null) === sourceId,
    )

  const launch = (k: StreamKind, sourceId: string | null, sourceName: string) => {
    if (!selectedDeviceId || device?.status !== 'online') return
    const cfg = cfgFor(sourceId, k)
    setStartingKey(`${k}:${sourceId ?? 'default'}`)
    startStream.mutate({
      kind: k,
      sourceId,
      sourceName,
      fps: k === 'mic' ? undefined : cfg.fps,
      quality: k === 'mic' ? undefined : cfg.quality,
    })
  }

  // ── legacy capture console (v0.2 features, preserved) ───────────

  const screenshot = useMutation({
    mutationFn: () =>
      api<MediaAsset>('/api/media/screenshot', {
        method: 'POST',
        body: JSON.stringify({ deviceId: selectedDeviceId }),
      }),
    onSuccess: (asset) => {
      invalidate()
      toast.success(`Screenshot captured on ${device?.hostname ?? 'device'}`, {
        description: 'Encrypted, in-memory — opening preview',
      })
      if (asset.dataRef) setPreview(asset)
    },
    onError: (e) =>
      toast.error('Screenshot failed', {
        description: e instanceof Error ? e.message : 'Unknown error',
      }),
  })

  const startRecord = useMutation({
    mutationFn: () =>
      api<MediaAsset>('/api/media', {
        method: 'POST',
        body: JSON.stringify({
          deviceId: selectedDeviceId,
          kind,
          quality: effectiveQuality,
          durationSec: Number(durationSec),
          withMic: kind === 'screen_record' ? withMic : false,
        }),
      }),
    onSuccess: () => {
      invalidate()
      toast.success(`Capture started on ${device?.hostname ?? 'device'}`, {
        description: `${KIND_META[kind].label} • ${effectiveQuality} • ${
          Number(durationSec) === 0 ? 'indefinite' : `${durationSec}s`
        }`,
      })
    },
    onError: (e) =>
      toast.error('Failed to start capture', {
        description: e instanceof Error ? e.message : 'Unknown error',
      }),
  })

  const stopCapture = useMutation({
    mutationFn: (assetId: string) =>
      api<MediaAsset>('/api/media/stop', {
        method: 'POST',
        body: JSON.stringify({ assetId }),
      }),
    onSuccess: () => {
      invalidate()
      toast.success('Stop signal sent — capture is wrapping up')
    },
    onError: (e) =>
      toast.error('Failed to stop capture', {
        description: e instanceof Error ? e.message : 'Unknown error',
      }),
  })

  const startLive = useMutation({
    mutationFn: () =>
      api<{ ok: true }>('/api/media/live', {
        method: 'POST',
        body: JSON.stringify({ deviceId: selectedDeviceId, action: 'start' }),
      }),
    onSuccess: () => {
      toast.success(`Live view started on ${device?.hostname ?? 'device'}`, {
        description: 'Streaming over the agent socket — stream-only, not persisted',
      })
      setLiveOpen(true)
    },
    onError: (e) =>
      toast.error('Live view failed', {
        description: e instanceof Error ? e.message : 'Unknown error',
      }),
  })

  const removeAsset = useMutation({
    mutationFn: (id: string) => api<{ ok: true }>(`/api/media/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      invalidate()
      toast.success('Asset deleted')
    },
    onError: (e) =>
      toast.error('Failed to delete asset', {
        description: e instanceof Error ? e.message : 'Unknown error',
      }),
  })

  const assets = mediaQuery.data ?? []
  const activeCaptures = assets.filter((a) => ACTIVE_STATUSES.includes(a.status))

  // ── no device selected ──────────────────────────────────────────
  if (!selectedDeviceId) {
    return (
      <div className="flex flex-col gap-4">
        <SectionHeader
          title="Streams"
          subtitle="Multi-source live capture — screen, cameras & microphones simultaneously"
          icon={<Clapperboard className="h-5 w-5" />}
        />
        <EmptyState
          icon={<Clapperboard className="h-10 w-10" />}
          title="No device selected"
          hint="Pick a device below to open the stream launcher."
        />
        <div className="mx-auto w-full max-w-sm">
          <DeviceSelector value={selectedDeviceId} onChange={setSelectedDeviceId} />
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader
        title="Streams"
        subtitle="Multi-source live capture — screen, cameras & microphones simultaneously"
        icon={<Clapperboard className="h-5 w-5" />}
        actions={
          runningList.length > 0 ? (
            <>
              <Badge
                variant="outline"
                className="gap-1.5 border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-400"
              >
                <span className="relative flex h-2 w-2" aria-hidden>
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-500 opacity-70" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-rose-500" />
                </span>
                {runningList.length} stream{runningList.length === 1 ? '' : 's'} active
              </Badge>
              <Button
                size="sm"
                variant="outline"
                className="h-9 border-rose-500/40 text-rose-600 hover:bg-rose-500/10 hover:text-rose-700 dark:text-rose-400 dark:hover:text-rose-300"
                disabled={stopAllStreams.isPending}
                onClick={() => stopAllStreams.mutate(runningList.map((s) => s.streamId))}
              >
                <Square className="h-3.5 w-3.5" /> Stop all
              </Button>
            </>
          ) : null
        }
      />

      {/* device + capture summary */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <DeviceSelector value={selectedDeviceId} onChange={setSelectedDeviceId} />
          <CaptureStrip device={device} />
        </div>
        {device && device.status !== 'online' ? (
          <p className="flex items-center gap-2 text-xs text-amber-600 dark:text-amber-400">
            <Info className="h-3.5 w-3.5" aria-hidden />
            Device is offline — streams can only start while the agent is connected.
          </p>
        ) : null}
      </div>

      {/* transparency strip */}
      <div className="glass-inset flex items-center gap-3 rounded-2xl px-4 py-3">
        <Eye className="h-4 w-4 shrink-0 text-primary" aria-hidden />
        <p className="text-sm text-muted-foreground">
          Live capture is announced on the device — the user always sees SentraRMM indicators.
        </p>
      </div>

      {/* stream launcher */}
      {hasCaps && caps ? (
        <Panel className="card-sheen glass-hover p-5 sm:p-6">
          <div className="flex flex-col gap-4">
            <div>
              <h3 className="font-semibold">Stream launcher</h3>
              <p className="text-sm text-muted-foreground">
                Start any combination — multiple sources and kinds run at the same time.
              </p>
            </div>

            <div className="grid gap-3 lg:grid-cols-3">
              {/* Screen */}
              <div className="glass-inset flex flex-col gap-1 rounded-xl p-2.5">
                <p className="flex items-center gap-2 px-1 pb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  <Monitor className="h-3.5 w-3.5" aria-hidden /> Screen
                </p>
                {caps.monitors.length === 0 ? (
                  <p className="px-2 py-3 text-xs text-muted-foreground">no monitors reported</p>
                ) : (
                  caps.monitors.map((m) => {
                    const active = activeFor('screen', m.id)
                    return (
                      <LauncherRow
                        key={m.id}
                        kind="screen"
                        sourceId={m.id}
                        name={m.name}
                        meta={`${m.width}×${m.height}${m.primary ? ' · primary' : ''}`}
                        cfg={cfgFor(m.id, 'screen')}
                        onCfg={patchCfg}
                        active={!!active}
                        busy={startingKey === `screen:${m.id}`}
                        disabled={device?.status !== 'online'}
                        onStart={() => launch('screen', m.id, m.name)}
                        onStop={() => active && stopStream.mutate(active.streamId)}
                      />
                    )
                  })
                )}
              </div>

              {/* Cameras */}
              <div className="glass-inset flex flex-col gap-1 rounded-xl p-2.5">
                <p className="flex items-center gap-2 px-1 pb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  <Camera className="h-3.5 w-3.5" aria-hidden /> Cameras
                </p>
                {caps.cameras.length === 0 ? (
                  <p className="px-2 py-3 text-xs text-muted-foreground">no cameras reported</p>
                ) : (
                  caps.cameras.map((c) => {
                    const active = activeFor('camera', c.id)
                    return (
                      <LauncherRow
                        key={c.id}
                        kind="camera"
                        sourceId={c.id}
                        name={c.name}
                        meta={null}
                        cfg={cfgFor(c.id, 'camera')}
                        onCfg={patchCfg}
                        active={!!active}
                        busy={startingKey === `camera:${c.id}`}
                        disabled={device?.status !== 'online'}
                        onStart={() => launch('camera', c.id, c.name)}
                        onStop={() => active && stopStream.mutate(active.streamId)}
                      />
                    )
                  })
                )}
              </div>

              {/* Microphones */}
              <div className="glass-inset flex flex-col gap-1 rounded-xl p-2.5">
                <p className="flex items-center gap-2 px-1 pb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  <Mic className="h-3.5 w-3.5" aria-hidden /> Microphones
                </p>
                {caps.mics.length === 0 ? (
                  <p className="px-2 py-3 text-xs text-muted-foreground">no microphones reported</p>
                ) : (
                  caps.mics.map((mc) => {
                    const active = activeFor('mic', mc.id)
                    return (
                      <LauncherRow
                        key={mc.id}
                        kind="mic"
                        sourceId={mc.id}
                        name={mc.name}
                        meta="input level stream"
                        cfg={cfgFor(mc.id, 'mic')}
                        onCfg={patchCfg}
                        active={!!active}
                        busy={startingKey === `mic:${mc.id}`}
                        disabled={device?.status !== 'online'}
                        onStart={() => launch('mic', mc.id, mc.name)}
                        onStop={() => active && stopStream.mutate(active.streamId)}
                      />
                    )
                  })
                )}
              </div>
            </div>
          </div>
        </Panel>
      ) : null}

      {/* active stream grid */}
      <AnimatePresence initial={false}>
        {runningList.length > 0 ? (
          <motion.div
            key="stream-grid"
            variants={{ hidden: {}, show: { transition: { staggerChildren: 0.07 } } }}
            initial="hidden"
            animate="show"
            exit={{ opacity: 0, transition: { duration: 0.15 } }}
            className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3"
          >
            {runningList.map((s) => (
              <StreamPanel
                key={s.streamId}
                stream={s}
                now={now}
                stopping={stoppingId === s.streamId}
                onStop={(id) => {
                  setStoppingId(id)
                  stopStream.mutate(id)
                }}
              />
            ))}
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* ───────────────────── Captures (legacy features) ───────────────────── */}
      <div className="mt-2 flex items-center gap-3" role="separator">
        <span className="h-px flex-1 bg-border/60" aria-hidden />
        <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          Captures
        </span>
        <span className="h-px flex-1 bg-border/60" aria-hidden />
      </div>

      <SectionHeader
        title="Capture console"
        subtitle="Single-shot screenshots, queued recordings & the encrypted vault gallery"
        icon={<Camera className="h-5 w-5" />}
      />

      {/* encryption banner */}
      <div
        className={cn(
          'glass-inset flex flex-wrap items-center gap-3 rounded-2xl px-4 py-3',
          !hasPassword && 'border-amber-500/30'
        )}
      >
        <Lock className={cn('h-4 w-4 shrink-0', hasPassword ? 'text-primary' : 'text-amber-500')} />
        <p className="min-w-0 flex-1 text-sm text-muted-foreground">
          {hasPassword
            ? 'Artifacts are encrypted with your dashboard-set password (AES-256-GCM).'
            : 'No capture password set — configure one in Settings for at-rest encryption.'}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="border-teal-500/30 bg-teal-500/10 text-teal-600 dark:text-teal-400">
            <Zap className="h-3 w-3" /> in-memory execution
          </Badge>
          <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
            <ShieldCheck className="h-3 w-3" /> encrypted at rest
          </Badge>
        </div>
      </div>

      {/* capture console */}
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <Panel className="card-sheen glass-hover p-6">
          <div className="flex flex-col gap-5">
            <div>
              <h3 className="font-semibold">Single-shot & queued capture</h3>
              <p className="text-sm text-muted-foreground">
                Target: <span className="font-medium text-foreground">{device?.hostname}</span>
                {device?.friendlyName ? (
                  <span className="text-muted-foreground"> • {device.friendlyName}</span>
                ) : null}
              </p>
            </div>

            <div className="flex flex-col gap-2 sm:flex-row">
              <Button
                size="lg"
                className="h-11 flex-1 sm:flex-none sm:px-8"
                disabled={screenshot.isPending}
                onClick={() => screenshot.mutate()}
              >
                <Camera className="h-5 w-5" />
                {screenshot.isPending ? 'Capturing…' : 'Take screenshot'}
              </Button>
              <Button
                size="lg"
                variant="outline"
                className="h-11 flex-1 border-primary/40 sm:flex-none sm:px-6"
                disabled={startLive.isPending || device?.status !== 'online'}
                onClick={() => startLive.mutate()}
              >
                {startLive.isPending ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                  <MonitorPlay className="h-5 w-5" />
                )}
                {startLive.isPending ? 'Connecting…' : 'Live view'}
              </Button>
            </div>

            <div className="h-px bg-border/60" role="separator" />

            {/* recording config */}
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <div className="flex flex-col gap-2">
                <Label className="text-xs uppercase tracking-wide text-muted-foreground">Kind</Label>
                <Select value={kind} onValueChange={(v) => setKind(v as MediaKind)}>
                  <SelectTrigger className="w-full" aria-label="Capture kind">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="glass-strong">
                    <SelectItem value="screen_record">Screen recording</SelectItem>
                    <SelectItem value="mic_record">Microphone only</SelectItem>
                    <SelectItem value="camera_stream">Camera stream</SelectItem>
                    <SelectItem value="call">Video call (screen+cam+mic)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col gap-2">
                <Label className="text-xs uppercase tracking-wide text-muted-foreground">Quality</Label>
                <Select value={effectiveQuality} onValueChange={(v) => setQuality(v)}>
                  <SelectTrigger className="w-full" aria-label="Stream quality">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="glass-strong">
                    <SelectItem value="480p">480p</SelectItem>
                    <SelectItem value="720p">720p</SelectItem>
                    <SelectItem value="1080p">1080p</SelectItem>
                    <SelectItem value="source">Source</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col gap-2">
                <Label className="text-xs uppercase tracking-wide text-muted-foreground">Duration</Label>
                <Select value={durationSec} onValueChange={setDurationSec}>
                  <SelectTrigger className="w-full" aria-label="Capture duration">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="glass-strong">
                    <SelectItem value="30">30 sec</SelectItem>
                    <SelectItem value="60">1 min</SelectItem>
                    <SelectItem value="300">5 min</SelectItem>
                    <SelectItem value="0">Indefinite</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col justify-end gap-2">
                {kind === 'screen_record' ? (
                  <div className="glass-inset flex min-h-11 items-center justify-between gap-3 rounded-xl px-3">
                    <Label htmlFor="with-mic" className="cursor-pointer text-sm">
                      Include microphone
                    </Label>
                    <Switch id="with-mic" checked={withMic} onCheckedChange={setWithMic} />
                  </div>
                ) : null}
                <Button
                  className="h-11 w-full"
                  disabled={startRecord.isPending}
                  onClick={() => startRecord.mutate()}
                >
                  {kind === 'mic_record' ? <Mic className="h-4 w-4" /> : <Video className="h-4 w-4" />}
                  {startRecord.isPending ? 'Starting…' : 'Start recording'}
                </Button>
              </div>
            </div>
          </div>
        </Panel>

        {/* active captures */}
        <Panel className="glass-hover p-4">
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-semibold">Active captures</h3>
            {activeCaptures.length > 0 ? (
              <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400">
                {activeCaptures.length} running
              </Badge>
            ) : null}
          </div>
          <div className="mt-3 flex flex-col gap-2">
            {activeCaptures.length === 0 ? (
              <p className="glass-inset rounded-xl px-3 py-6 text-center text-sm text-muted-foreground">
                No active captures
              </p>
            ) : (
              activeCaptures.map((a) => {
                const meta = KIND_META[a.kind] ?? KIND_META.screenshot
                return (
                  <div
                    key={a.id}
                    className="glass-inset glass-hover flex items-center gap-3 rounded-xl px-3 py-2.5"
                  >
                    <span className="relative flex h-2.5 w-2.5 shrink-0">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-60" />
                      <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-amber-500" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{meta.label}</p>
                      <p className="text-xs text-muted-foreground">
                        {fmtElapsed(now - new Date(a.createdAt).getTime())} elapsed
                      </p>
                    </div>
                    {a.quality ? (
                      <Badge variant="secondary" className="text-[10px]">
                        {a.quality}
                      </Badge>
                    ) : null}
                    <Button
                      size="icon"
                      variant="outline"
                      className="h-9 w-9 shrink-0"
                      aria-label="Stop capture"
                      disabled={stopCapture.isPending}
                      onClick={() => stopCapture.mutate(a.id)}
                    >
                      <Square className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                )
              })
            )}
          </div>
        </Panel>
      </div>

      {/* gallery */}
      <Panel className="glass-hover p-4 sm:p-6">
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-semibold">Gallery</h3>
          {assets.length > 0 ? (
            <span className="text-xs text-muted-foreground">{assets.length} asset{assets.length === 1 ? '' : 's'}</span>
          ) : null}
        </div>

        <div className="mt-3">
          {mediaQuery.isLoading ? (
            <LoadingBlock label="Loading media assets…" />
          ) : mediaQuery.isError ? (
            <ErrorBlock message={mediaQuery.error instanceof Error ? mediaQuery.error.message : 'Failed to load media'} />
          ) : assets.length === 0 ? (
            <EmptyState
              icon={<Clapperboard className="h-8 w-8" />}
              title="No media assets yet"
              hint="Take a screenshot or start a recording to populate the gallery."
            />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {assets.map((a) => {
                const meta = KIND_META[a.kind] ?? KIND_META.screenshot
                const sb = statusBadge(a.status)
                const Icon = meta.icon
                return (
                  <div key={a.id} className="glass-inset glass-hover flex flex-col gap-3 rounded-2xl p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <div className="glass flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-primary">
                          <Icon className="h-4 w-4" />
                        </div>
                        <p className="truncate text-sm font-medium">{meta.label}</p>
                      </div>
                      <Badge variant="outline" className={cn('gap-1', sb.className)}>
                        {sb.pulse ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" /> : null}
                        {sb.label}
                      </Badge>
                    </div>

                    {a.dataRef ? (
                      <img
                        src={a.dataRef}
                        alt={`${meta.label} preview`}
                        className="h-28 w-full rounded-xl object-cover ring-1 ring-border/50"
                        loading="lazy"
                      />
                    ) : (
                      <div className="glass flex h-28 w-full items-center justify-center rounded-xl text-xs text-muted-foreground">
                        no preview data
                      </div>
                    )}

                    <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      {a.quality ? <Badge variant="secondary" className="text-[10px]">{a.quality}</Badge> : null}
                      <span>{fmtDurationLabel(a.durationSec)}</span>
                      <span aria-hidden>•</span>
                      <span>{fmtBytes(a.sizeBytes)}</span>
                      <span aria-hidden>•</span>
                      <span title={fmtDate(a.createdAt)}>{timeAgo(a.createdAt)}</span>
                    </div>

                    {a.encrypted ? (
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-[10px] text-emerald-600 dark:text-emerald-400">
                          <ShieldCheck className="h-3 w-3" /> encrypted
                        </Badge>
                        {a.inMemory ? (
                          <Badge variant="outline" className="border-teal-500/30 bg-teal-500/10 text-[10px] text-teal-600 dark:text-teal-400">
                            <Zap className="h-3 w-3" /> in-memory
                          </Badge>
                        ) : null}
                      </div>
                    ) : null}

                    <div className="mt-auto flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-9 flex-1"
                        disabled={!a.dataRef}
                        onClick={() => setPreview(a)}
                      >
                        <Eye className="h-3.5 w-3.5" /> Preview
                      </Button>
                      {a.dataRef ? (
                        <a
                          href={a.dataRef}
                          download={`sentra-${a.kind}-${a.id.slice(0, 8)}`}
                          className="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-md border bg-background px-3 text-sm font-medium shadow-xs transition-colors hover:bg-accent hover:text-accent-foreground"
                          aria-label="Download asset"
                        >
                          <Download className="h-3.5 w-3.5" /> Download
                        </a>
                      ) : (
                        <Button size="sm" variant="outline" className="h-9 flex-1" disabled>
                          <Download className="h-3.5 w-3.5" /> Download
                        </Button>
                      )}
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            size="icon"
                            variant="outline"
                            className="h-9 w-9 shrink-0 border-rose-500/30 text-rose-500 hover:bg-rose-500/10 hover:text-rose-600"
                            aria-label="Delete asset"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent className="glass-strong">
                          <AlertDialogHeader>
                            <AlertDialogTitle>Delete this asset?</AlertDialogTitle>
                            <AlertDialogDescription>
                              {meta.label} from {timeAgo(a.createdAt)} will be permanently removed from
                              the device vault. This cannot be undone.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              className="bg-destructive text-white hover:bg-destructive/90"
                              onClick={() => removeAsset.mutate(a.id)}
                            >
                              Delete
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </Panel>

      {/* live screen viewer */}
      <LiveViewDialog device={device} open={liveOpen} onOpenChange={setLiveOpen} now={now} />

      {/* preview dialog */}
      <Dialog open={!!preview} onOpenChange={(open) => !open && setPreview(null)}>
        <DialogContent className="glass-strong sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {preview ? (KIND_META[preview.kind] ?? KIND_META.screenshot).label : 'Preview'}
            </DialogTitle>
            <DialogDescription>
              {preview
                ? `${preview.quality ?? 'source'} • ${fmtBytes(preview.sizeBytes)} • ${timeAgo(preview.createdAt)}`
                : null}
            </DialogDescription>
          </DialogHeader>
          {preview?.dataRef ? (
            <div className="flex flex-col gap-2">
              <img
                src={preview.dataRef}
                alt={`${preview.kind} preview`}
                className="w-full rounded-xl ring-1 ring-border/50"
              />
              {preview.kind !== 'screenshot' ? (
                <p className="text-center text-xs text-muted-foreground">
                  video preview not available in demo — showing poster frame
                </p>
              ) : null}
            </div>
          ) : (
            <p className="py-6 text-center text-sm text-muted-foreground">No preview data available.</p>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
