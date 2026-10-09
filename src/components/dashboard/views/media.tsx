'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Camera,
  Clapperboard,
  Download,
  Eye,
  Loader2,
  Lock,
  Mic,
  MonitorPlay,
  PhoneCall,
  ShieldCheck,
  Square,
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
} from '@/lib/types'
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

// ─────────────────────────── view ───────────────────────────────────

export default function MediaView() {
  const qc = useQueryClient()
  const selectedDeviceId = useDash((s) => s.selectedDeviceId)
  const setSelectedDeviceId = useDash((s) => s.setSelectedDeviceId)
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

  const effectiveQuality = quality ?? settings?.defaultStreamQuality ?? '720p'
  const hasPassword = Boolean(settings?.capturePassword)

  // 1s ticker for "elapsed" on active captures
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
          title="Media capture"
          subtitle="Screenshots, screen recording, microphone & camera — encrypted, in-memory"
          icon={<Clapperboard className="h-5 w-5" />}
        />
        <EmptyState
          icon={<Clapperboard className="h-10 w-10" />}
          title="No device selected"
          hint="Pick a device below to open the capture studio."
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
        title="Media capture"
        subtitle="Screenshots, screen recording, microphone & camera — encrypted, in-memory"
        icon={<Clapperboard className="h-5 w-5" />}
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
              <h3 className="font-semibold">Capture console</h3>
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
                const isRecord = a.kind !== 'screenshot'
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
