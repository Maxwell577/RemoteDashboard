'use client'

import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  CheckCircle2,
  Copy,
  Disc3,
  Download,
  Eye,
  EyeOff,
  Info,
  KeyRound,
  Loader2,
  Lock,
  Monitor,
  Camera,
  Mic,
  Radar,
  ShieldCheck,
  Square,
  Trash2,
  Wand2,
  type LucideIcon,
} from 'lucide-react'
import {
  api,
  type Device,
  type RecordingArtifact,
  type RecordingState,
} from '@/lib/types'
import { useDash } from '@/lib/store'
import { cn } from '@/lib/utils'
import { useRecordings } from '@/hooks/use-recordings'
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
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

// ─────────────────────────── constants ──────────────────────────────

const DURATION_CHIPS = [5, 15, 50, 120]

const DECRYPT_CMD =
  'python agent-python/tools/decrypt_recording.py <file>.enc --passphrase "<passphrase>" --out frames/'

// short memorable word list for the strong-passphrase generator
const WORDS = [
  'harbor', 'quartz', 'lumen', 'cactus', 'vector', 'nimbus', 'ember', 'onyx',
  'ridge', 'falcon', 'cedar', 'cobalt', 'delta', 'orbit', 'pixel', 'summit',
  'thistle', 'vertex', 'willow', 'zenith', 'anchor', 'basil', 'comet', 'dynamo',
  'echo', 'fjord', 'glacier', 'helix', 'ivory', 'jade', 'krypton', 'lotus',
  'mango', 'nebula', 'opal', 'prism', 'quiver', 'raven', 'sable', 'topaz',
  'umber', 'violet', 'wombat', 'xenon', 'yonder', 'zephyr', 'maple', 'juno',
]

// ─────────────────────────── helpers ────────────────────────────────

/** sha256 hex prefix (12 chars) of the passphrase — matches the agent's keyFingerprint. */
async function sha256HexPrefix(input: string): Promise<string | null> {
  try {
    if (typeof crypto === 'undefined' || !crypto.subtle) return null
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 12)
  } catch {
    return null
  }
}

function generateStrongPassphrase(): string {
  const pick = <T,>(arr: T[]): T => {
    const buf = new Uint32Array(1)
    crypto.getRandomValues(buf)
    return arr[buf[0] % arr.length]
  }
  const words = [pick(WORDS), pick(WORDS), pick(WORDS), pick(WORDS)]
  const digits = String(crypto.getRandomValues(new Uint16Array(1))[0] % 1000).padStart(3, '0')
  return `${words.join('-')}-${digits}`
}

const STATE_META: Record<
  RecordingState,
  { label: string; className: string; pulse: boolean }
> = {
  armed: {
    label: 'armed',
    className: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400',
    pulse: true,
  },
  recording: {
    label: 'recording',
    className: 'border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-400',
    pulse: true,
  },
  completed: {
    label: 'completed',
    className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    pulse: false,
  },
  failed: {
    label: 'failed',
    className: 'border-zinc-500/30 bg-zinc-500/10 text-zinc-600 dark:text-zinc-400',
    pulse: false,
  },
  canceled: {
    label: 'canceled',
    className: 'border-zinc-500/30 bg-zinc-500/10 text-zinc-600 dark:text-zinc-400',
    pulse: false,
  },
}

function fmtElapsedSec(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
}

// ─────────────────────── decrypt help popover ───────────────────────

function DecryptHelpPopover() {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(DECRYPT_CMD)
      setCopied(true)
      toast.success('Decrypt command copied')
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error('Clipboard unavailable — select the text manually')
    }
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" className="glass-inset h-9 gap-2">
          <KeyRound className="h-4 w-4" aria-hidden />
          Decrypt help
        </Button>
      </PopoverTrigger>
      <PopoverContent className="glass-overlay w-[26rem] max-w-[calc(100vw-2rem)]" align="end">
        <div className="flex flex-col gap-3">
          <div>
            <p className="text-sm font-semibold">Decrypting .enc recordings</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Recordings upload as <span className="font-mono">{'<recordingId>'}.enc</span> — line 1 is a
              JSON header (<span className="font-mono">SENTRA-REC-1</span>, AES-256-GCM, PBKDF2-HMAC-SHA256,
              200 000 iterations, salt), followed by framed records
              (<span className="font-mono">[u32 len][12B nonce][ciphertext][16B tag]</span>). The key is
              derived only from your passphrase — it is never stored.
            </p>
          </div>
          <div className="glass-inset relative rounded-lg">
            <div className="flex items-center justify-between gap-2 border-b border-border/40 px-2.5 py-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                shell — where the repo is checked out
              </span>
              <Button size="sm" variant="ghost" className="h-7 gap-1 px-2" onClick={() => void copy()}>
                {copied ? (
                  <CheckCircle2 className="h-3 w-3 text-emerald-500" aria-hidden />
                ) : (
                  <Copy className="h-3 w-3" aria-hidden />
                )}
                Copy
              </Button>
            </div>
            <pre className="scroll-slim overflow-x-auto px-2.5 py-2 font-mono text-[11px] leading-relaxed text-emerald-700 dark:text-emerald-300">
              {DECRYPT_CMD}
            </pre>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            <span className="font-medium text-foreground">Key check:</span> each row shows
            <span className="mx-1 font-mono">sha256(passphrase)[0:12]</span>
            as its fingerprint — if it matches the preview you saw when scheduling, that passphrase
            decrypts the file.
          </p>
        </div>
      </PopoverContent>
    </Popover>
  )
}

// ─────────────────────── scheduler panel ────────────────────────────

interface SelectedSources {
  monitors: string[]
  cameras: string[]
  mics: string[]
}

function SourceChip({
  icon: Icon,
  label,
  selected,
  disabled,
  onToggle,
}: {
  icon: LucideIcon
  label: string
  selected: boolean
  disabled?: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={selected}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        'inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 text-xs font-medium outline-none transition-all focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:opacity-50',
        selected
          ? 'border border-primary/40 bg-primary/15 text-primary shadow-[inset_0_0_0_1px] shadow-primary/20'
          : 'glass-inset text-muted-foreground hover:bg-primary/10 hover:text-foreground',
      )}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {label}
      {selected ? <CheckCircle2 className="h-3 w-3" aria-hidden /> : null}
    </button>
  )
}

function Scheduler({
  device,
  onScheduled,
}: {
  device: Device | null
  onScheduled: (r: RecordingArtifact) => void
}) {
  // derived selection: follows the store's last-selected device until the
  // user explicitly overrides it in this panel (no sync setState-in-effect)
  const [overrideId, setOverrideId] = useState<string | null>(null)
  const devId = overrideId ?? device?.id ?? null
  const [label, setLabel] = useState('')
  const [minutes, setMinutes] = useState('15')
  const [sources, setSources] = useState<SelectedSources>({ monitors: [], cameras: [], mics: [] })
  const [passphrase, setPassphrase] = useState('')
  const [confirmPass, setConfirmPass] = useState('')
  const [showPass, setShowPass] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [fingerprint, setFingerprint] = useState<string | null>(null)

  const caps = device?.captures ?? null
  const hasCaps =
    !!caps && (caps.monitors.length > 0 || caps.cameras.length > 0 || caps.mics.length > 0)

  // live sha256(passphrase)[0:12] preview so the key can be verified later
  // (async — Web Crypto; render guards on passphrase so a cleared field never
  // shows a stale fingerprint)
  useEffect(() => {
    if (!passphrase) return
    let alive = true
    void sha256HexPrefix(passphrase).then((fp) => {
      if (alive) setFingerprint(fp)
    })
    return () => {
      alive = false
    }
  }, [passphrase])

  const durationSec = Math.max(1, Math.floor(Number(minutes) || 0)) * 60
  const passOk = passphrase.length >= 8
  const confirmOk = passphrase.length > 0 && passphrase === confirmPass
  const sourceCount = sources.monitors.length + sources.cameras.length + sources.mics.length
  const valid = !!devId && durationSec >= 60 && sourceCount > 0 && passOk && confirmOk

  const toggle = (kind: keyof SelectedSources, id: string) =>
    setSources((prev) => {
      const has = prev[kind].includes(id)
      return { ...prev, [kind]: has ? prev[kind].filter((x) => x !== id) : [...prev[kind], id] }
    })

  const schedule = useMutation({
    mutationFn: () =>
      api<RecordingArtifact>('/api/recordings', {
        method: 'POST',
        body: JSON.stringify({
          deviceId: devId,
          durationSec,
          monitors: sources.monitors.length > 0 ? sources.monitors : undefined,
          cameras: sources.cameras.length > 0 ? sources.cameras : undefined,
          mics: sources.mics.length > 0 ? sources.mics : undefined,
          passphrase,
          label: label.trim() || undefined,
        }),
      }),
    onSuccess: (r) => {
      toast.success('Recording scheduled', {
        description: `${device?.hostname ?? 'device'} • ${Math.round(durationSec / 60)} min • armed`,
      })
      onScheduled(r)
      // hygiene: never keep the passphrase around longer than needed
      setPassphrase('')
      setConfirmPass('')
    },
    onError: (e) =>
      toast.error('Failed to schedule recording', {
        description: e instanceof Error ? e.message : 'Unknown error',
      }),
  })

  return (
    <Panel className="card-sheen glass-hover flex flex-col gap-5 p-5 sm:p-6">
      <div>
        <h3 className="font-semibold">Schedule a recording</h3>
        <p className="text-sm text-muted-foreground">
          Armed on the device, recorded locally, uploaded encrypted when done.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Label className="text-xs uppercase tracking-wide text-muted-foreground">Device</Label>
        <DeviceSelector value={devId} onChange={setOverrideId} className="sm:w-full" />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor="rec-label" className="text-xs uppercase tracking-wide text-muted-foreground">
            Label
          </Label>
          <Input
            id="rec-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Nightly audit trail"
            className="h-11 md:h-9"
            maxLength={80}
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="rec-minutes" className="text-xs uppercase tracking-wide text-muted-foreground">
            Duration (minutes)
          </Label>
          <Input
            id="rec-minutes"
            type="number"
            min={1}
            max={1440}
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
            className="h-11 md:h-9"
          />
          <div className="flex flex-wrap gap-1.5">
            {DURATION_CHIPS.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMinutes(String(m))}
                className={cn(
                  'min-h-8 rounded-full px-2.5 text-[11px] font-semibold outline-none transition-all focus-visible:ring-2 focus-visible:ring-ring/60',
                  Number(minutes) === m
                    ? 'bg-primary/20 text-primary shadow-[inset_0_0_0_1px] shadow-primary/30'
                    : 'glass-inset text-muted-foreground hover:bg-primary/10 hover:text-foreground',
                )}
              >
                {m} min
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Label className="text-xs uppercase tracking-wide text-muted-foreground">
          Sources — at least one
        </Label>
        {hasCaps && caps ? (
          <div className="flex flex-col gap-2">
            {caps.monitors.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {caps.monitors.map((m) => (
                  <SourceChip
                    key={m.id}
                    icon={Monitor}
                    label={m.name}
                    selected={sources.monitors.includes(m.id)}
                    onToggle={() => toggle('monitors', m.id)}
                  />
                ))}
              </div>
            ) : null}
            {caps.cameras.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {caps.cameras.map((c) => (
                  <SourceChip
                    key={c.id}
                    icon={Camera}
                    label={c.name}
                    selected={sources.cameras.includes(c.id)}
                    onToggle={() => toggle('cameras', c.id)}
                  />
                ))}
              </div>
            ) : null}
            {caps.mics.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {caps.mics.map((m) => (
                  <SourceChip
                    key={m.id}
                    icon={Mic}
                    label={m.name}
                    selected={sources.mics.includes(m.id)}
                    onToggle={() => toggle('mics', m.id)}
                  />
                ))}
              </div>
            ) : null}
          </div>
        ) : (
          <p className="glass-inset flex items-start gap-2 rounded-xl px-3 py-2.5 text-xs text-muted-foreground">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" aria-hidden />
            This device did not report capture sources — the Python/Node agent is required before
            recording sources can be planned.
          </p>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor="rec-pass" className="text-xs uppercase tracking-wide text-muted-foreground">
            Passphrase (min 8)
          </Label>
          <div className="relative">
            <Input
              id="rec-pass"
              type={showPass ? 'text' : 'password'}
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder="••••••••••••"
              autoComplete="new-password"
              className="h-11 pr-20 md:h-9"
            />
            <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                aria-label="Generate strong passphrase"
                title="Generate strong passphrase"
                onClick={() => {
                  const gen = generateStrongPassphrase()
                  setPassphrase(gen)
                  setConfirmPass(gen)
                  setShowPass(true)
                  toast.success('Strong passphrase generated', {
                    description: 'Copy it somewhere safe — it cannot be recovered.',
                  })
                }}
              >
                <Wand2 className="h-4 w-4" aria-hidden />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                aria-label={showPass ? 'Hide passphrase' : 'Show passphrase'}
                onClick={() => setShowPass((v) => !v)}
              >
                {showPass ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
              </Button>
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="rec-pass-confirm" className="text-xs uppercase tracking-wide text-muted-foreground">
            Confirm passphrase
          </Label>
          <div className="relative">
            <Input
              id="rec-pass-confirm"
              type={showConfirm ? 'text' : 'password'}
              value={confirmPass}
              onChange={(e) => setConfirmPass(e.target.value)}
              autoComplete="new-password"
              className={cn(
                'h-11 pr-11 md:h-9',
                confirmPass.length > 0 && !confirmOk && 'border-rose-500/50',
              )}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute right-1 top-1/2 h-8 w-8 -translate-y-1/2"
              aria-label={showConfirm ? 'Hide confirmation' : 'Show confirmation'}
              onClick={() => setShowConfirm((v) => !v)}
            >
              {showConfirm ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
            </Button>
          </div>
          {confirmPass.length > 0 && !confirmOk ? (
            <p className="text-[11px] text-rose-500">Passphrases do not match.</p>
          ) : null}
        </div>
      </div>

      {/* live key fingerprint preview */}
      <div className="glass-inset flex flex-wrap items-center gap-2 rounded-xl px-3 py-2.5">
        <ShieldCheck className="h-4 w-4 shrink-0 text-primary" aria-hidden />
        <span className="text-xs text-muted-foreground">Key fingerprint (sha256·12)</span>
        {passphrase && fingerprint ? (
          <Badge variant="secondary" className="font-mono text-[11px] tabular-nums">
            {fingerprint}
          </Badge>
        ) : (
          <span className="text-xs text-muted-foreground/60">enter a passphrase…</span>
        )}
        <span className="ml-auto text-[11px] text-muted-foreground/70">
          compare with the row chip later to verify your key
        </span>
      </div>

      <Button
        size="lg"
        className="h-11 w-full"
        disabled={!valid || schedule.isPending}
        onClick={() => schedule.mutate()}
      >
        {schedule.isPending ? (
          <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
        ) : (
          <Radar className="h-5 w-5" aria-hidden />
        )}
        {schedule.isPending ? 'Arming…' : 'Schedule recording'}
      </Button>
      {!valid ? (
        <p className="text-center text-[11px] text-muted-foreground/70">
          {!devId
            ? 'select a device to continue'
            : durationSec < 60
              ? 'duration must be at least 1 minute'
              : sourceCount === 0
                ? 'pick at least one capture source'
                : !passOk
                  ? 'passphrase needs at least 8 characters'
                  : 'confirm the passphrase to arm'}
        </p>
      ) : null}
    </Panel>
  )
}

// ──────────────────────── recording row ─────────────────────────────

function RecordingRow({
  rec,
  hostname,
  now,
  onDownload,
  downloading,
  onCancel,
  canceling,
}: {
  rec: RecordingArtifact
  hostname: string
  now: number
  onDownload: (r: RecordingArtifact) => void
  downloading: boolean
  onCancel: (r: RecordingArtifact) => void
  canceling: boolean
}) {
  const sm = STATE_META[rec.state]
  const active = rec.state === 'armed' || rec.state === 'recording'
  const finished = rec.state === 'completed' || rec.state === 'failed' || rec.state === 'canceled'

  // interpolated elapsed for the live progress bar (socket updates reconcile)
  let elapsedSec: number | null = null
  if (rec.state === 'recording' && rec.startedAt) {
    elapsedSec = Math.min(rec.durationSec, Math.max(0, (now - new Date(rec.startedAt).getTime()) / 1000))
  } else if (rec.state === 'recording') {
    elapsedSec = rec.durationSec // running but startedAt unknown — show full
  } else if (rec.state === 'armed') {
    elapsedSec = 0
  }
  const pct = active && elapsedSec != null ? Math.min(100, Math.round((elapsedSec / rec.durationSec) * 100)) : null

  return (
    <div
      className={cn(
        'glass-inset glass-hover lift flex flex-col gap-2.5 rounded-2xl p-3.5',
        rec.state === 'recording' && 'ring-1 ring-rose-500/25',
        rec.state === 'armed' && 'ring-1 ring-amber-500/25',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <div className="glass flex h-8 w-8 shrink-0 items-center justify-center rounded-lg">
          <Disc3
            className={cn(
              'h-4 w-4',
              rec.state === 'recording' ? 'animate-spin text-rose-500' : 'text-muted-foreground',
            )}
            aria-hidden
          />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {rec.label || `Recording — ${hostname}`}
          </p>
          <p className="truncate text-[11px] text-muted-foreground">
            {hostname} · {Math.max(1, Math.round(rec.durationSec / 60))} min ·{' '}
            <span title={fmtDate(rec.createdAt)}>{timeAgo(rec.createdAt)}</span>
          </p>
        </div>
        <Badge variant="outline" className={cn('gap-1.5', sm.className)}>
          {sm.pulse ? (
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" aria-hidden />
          ) : null}
          {sm.label}
        </Badge>
      </div>

      {/* live progress */}
      {active ? (
        <div className="flex flex-col gap-1">
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct ?? 0}
            aria-label={`Recording progress — ${rec.label || hostname}`}
            className="glass h-2 w-full overflow-hidden rounded-full"
          >
            <div
              className={cn(
                'h-full rounded-full transition-[width] duration-1000 ease-linear',
                rec.state === 'recording'
                  ? 'bg-gradient-to-r from-rose-500 to-rose-400'
                  : 'bg-amber-400/70',
              )}
              style={{ width: `${Math.max(pct ?? 0, 1.5)}%` }}
            />
          </div>
          <div className="flex flex-wrap items-center gap-1.5 text-[11px] tabular-nums text-muted-foreground">
            <span className="font-mono">
              {rec.state === 'recording' && elapsedSec != null
                ? `${fmtElapsedSec(elapsedSec)} / ${fmtElapsedSec(rec.durationSec)}`
                : 'armed — waiting to start'}
            </span>
            {rec.state === 'recording' && rec.sizeBytes ? (
              <span className="font-mono">· {fmtBytes(rec.sizeBytes)} captured</span>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* completed / finished meta */}
      {!active ? (
        <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
          {rec.frames != null ? (
            <Badge variant="secondary" className="font-mono text-[10px] tabular-nums">
              {rec.frames} frames
            </Badge>
          ) : null}
          {rec.sizeBytes != null ? (
            <Badge variant="secondary" className="font-mono text-[10px] tabular-nums">
              {fmtBytes(rec.sizeBytes)}
            </Badge>
          ) : null}
          <Badge variant="outline" className="gap-1 border-emerald-500/30 bg-emerald-500/10 text-[10px] text-emerald-600 dark:text-emerald-400">
            <Lock className="h-3 w-3" aria-hidden /> {rec.encryption || 'AES-256-GCM'}
          </Badge>
          {rec.error ? (
            <span className="truncate text-rose-500" title={rec.error}>
              {rec.error}
            </span>
          ) : null}
          {rec.endedAt ? <span title={fmtDate(rec.endedAt)}>{timeAgo(rec.endedAt)}</span> : null}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {rec.keyFingerprint ? (
          <Badge
            variant="outline"
            className="border-border/60 bg-background/40 font-mono text-[10px] tabular-nums"
            title="sha256(passphrase)[0:12] — verify your key against this"
          >
            key {rec.keyFingerprint}
          </Badge>
        ) : null}
        <span className="truncate font-mono text-[10px] text-muted-foreground/60" title={rec.fileName ?? undefined}>
          {rec.fileName ?? rec.recordingId}
        </span>

        <div className="ml-auto flex items-center gap-2">
          {active ? (
            <Button
              size="sm"
              variant="outline"
              className="h-8 border-amber-500/40 text-amber-600 hover:bg-amber-500/10 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-300"
              disabled={canceling}
              onClick={() => onCancel(rec)}
            >
              {canceling ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <Square className="h-3.5 w-3.5" aria-hidden />
              )}
              Cancel
            </Button>
          ) : null}
          {rec.state === 'completed' ? (
            <Button
              size="sm"
              variant="outline"
              className="h-8 border-primary/40"
              disabled={downloading}
              onClick={() => onDownload(rec)}
            >
              {downloading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <Download className="h-3.5 w-3.5" aria-hidden />
              )}
              Download
            </Button>
          ) : null}
          {finished ? (
            <DeleteRecordingButton rec={rec} label={rec.label || hostname} />
          ) : null}
        </div>
      </div>
    </div>
  )
}

function DeleteRecordingButton({ rec, label }: { rec: RecordingArtifact; label: string }) {
  const dropRecording = useDash((s) => s.dropRecording)
  const qc = useQueryClient()
  const del = useMutation({
    mutationFn: () => api<{ ok: true }>(`/api/recordings/${rec.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      dropRecording(rec.id)
      qc.invalidateQueries({ queryKey: ['recordings'] })
      toast.success('Recording deleted', { description: 'row + encrypted file removed' })
    },
    onError: (e) =>
      toast.error('Failed to delete recording', {
        description: e instanceof Error ? e.message : 'Unknown error',
      }),
  })
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          size="icon"
          variant="outline"
          className="h-8 w-8 shrink-0 border-rose-500/30 text-rose-500 hover:bg-rose-500/10 hover:text-rose-600"
          aria-label={`Delete recording ${label}`}
          disabled={del.isPending}
        >
          {del.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
          )}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent className="glass-strong">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this recording?</AlertDialogTitle>
          <AlertDialogDescription>
            {label} — the encrypted .enc file is removed from the vault together with the row. A
            canceled/failed artifact cannot be recovered after deletion.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-white hover:bg-destructive/90"
            onClick={() => del.mutate()}
          >
            Delete permanently
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

// ──────────────────────────── view ──────────────────────────────────

export default function Recordings() {
  const qc = useQueryClient()
  const selectedDeviceId = useDash((s) => s.selectedDeviceId)
  const dropRecording = useDash((s) => s.dropRecording)
  const { data: devices } = useDevices()
  const recordingsQuery = useRecordings(null, 100)

  const [scheduled, setScheduled] = useState<RecordingArtifact | null>(null)
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [cancelingId, setCancelingId] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  // 1s ticker interpolates live progress between socket updates
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const hostnameOf = useMemo(() => {
    const map = new Map<string, string>()
    for (const d of devices ?? []) map.set(d.id, d.hostname)
    return map
  }, [devices])

  const rows = recordingsQuery.data ?? []
  const activeCount = rows.filter((r) => r.state === 'armed' || r.state === 'recording').length

  const cancel = useMutation({
    mutationFn: (r: RecordingArtifact) =>
      api<{ ok: true }>(`/api/recordings/${r.id}`, { method: 'DELETE' }),
    onSuccess: (_d, r) => {
      dropRecording(r.id)
      qc.invalidateQueries({ queryKey: ['recordings'] })
      toast.success('Cancel signal sent', {
        description: 'the agent stops recording and discards the artifact',
      })
    },
    onError: (e) =>
      toast.error('Failed to cancel recording', {
        description: e instanceof Error ? e.message : 'Unknown error',
      }),
    onSettled: () => setCancelingId(null),
  })

  const download = async (r: RecordingArtifact) => {
    setDownloadingId(r.id)
    try {
      const res = await fetch(`/api/recordings/${r.id}/download`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${r.recordingId}.enc`
      a.click()
      URL.revokeObjectURL(url)
      toast.success('Recording downloaded', {
        description: `${r.recordingId}.enc • ${fmtBytes(blob.size)} • decrypt with your passphrase`,
      })
    } catch (e) {
      toast.error('Download failed', {
        description: e instanceof Error ? e.message : 'Unknown error',
      })
    } finally {
      setDownloadingId(null)
    }
  }

  const deviceForScheduler = useMemo(
    () => (devices ?? []).find((d) => d.id === selectedDeviceId) ?? null,
    [devices, selectedDeviceId],
  )

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader
        title="Recordings"
        subtitle="Scheduled encrypted on-device capture — armed, recorded offline, uploaded when done"
        icon={<Disc3 className="h-5 w-5" />}
        actions={
          <>
            {activeCount > 0 ? (
              <Badge
                variant="outline"
                className={cn(
                  'gap-1.5',
                  rows.some((r) => r.state === 'recording')
                    ? 'border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-400'
                    : 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400',
                )}
              >
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" aria-hidden />
                {activeCount} active
              </Badge>
            ) : null}
            <DecryptHelpPopover />
          </>
        }
      />

      {/* transparency callout */}
      <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3">
        <div className="flex items-start gap-2.5">
          <Radar className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" aria-hidden />
          <div className="flex flex-col gap-1">
            <p className="text-sm text-amber-700 dark:text-amber-400">
              The device user is notified when a recording is armed and sees a persistent on-screen
              indicator while it records. Recording runs locally on the device — even if this
              dashboard or the network goes offline — and the encrypted file uploads when the device
              reconnects.
            </p>
            <p className="text-xs text-amber-700/70 dark:text-amber-400/70">
              Simulated agents cap recordings at 2 minutes; real agents record the full duration.
            </p>
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[420px_1fr]">
        <div className="flex flex-col gap-4">
          <Scheduler device={deviceForScheduler} onScheduled={setScheduled} />

          {/* success panel */}
          {scheduled ? (
            <div className="glass-inset flex flex-col gap-2 rounded-2xl border border-emerald-500/30 px-4 py-3.5">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" aria-hidden />
                <p className="text-sm font-medium">Recording armed</p>
                <Badge
                  variant="outline"
                  className={cn('ml-auto gap-1.5', STATE_META[scheduled.state].className)}
                >
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" aria-hidden />
                  {STATE_META[scheduled.state].label}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                {scheduled.label || 'Recording'} · {Math.max(1, Math.round(scheduled.durationSec / 60))} min on{' '}
                {hostnameOf.get(scheduled.deviceId) ?? scheduled.deviceId}
              </p>
              {scheduled.keyFingerprint ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-muted-foreground">key fingerprint</span>
                  <Badge variant="secondary" className="font-mono text-[11px] tabular-nums">
                    {scheduled.keyFingerprint}
                  </Badge>
                  <span className="text-[11px] text-muted-foreground/70">
                    store it with your passphrase to verify later
                  </span>
                </div>
              ) : null}
              <p className="font-mono text-[10px] text-muted-foreground/60">
                id {scheduled.recordingId}
              </p>
            </div>
          ) : null}
        </div>

        {/* recordings list */}
        <Panel className="flex min-w-0 flex-col gap-3 p-4 sm:p-5">
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-semibold">Recording vault</h3>
            {rows.length > 0 ? (
              <span className="text-xs text-muted-foreground">
                {rows.length} artifact{rows.length === 1 ? '' : 's'}
              </span>
            ) : null}
          </div>

          {recordingsQuery.isLoading ? (
            <LoadingBlock label="Loading recordings…" />
          ) : recordingsQuery.isError && rows.length === 0 ? (
            <ErrorBlock
              message={
                recordingsQuery.error instanceof Error
                  ? `Recordings unavailable — ${recordingsQuery.error.message}`
                  : 'Recordings unavailable'
              }
            />
          ) : rows.length === 0 ? (
            <EmptyState
              icon={<Disc3 className="h-8 w-8" />}
              title="No recordings yet"
              hint="Schedule one on the left — armed recordings appear here with live progress."
            />
          ) : (
            <div className="scroll-slim flex max-h-[720px] flex-col gap-2.5 overflow-y-auto pr-1">
              {rows.map((r) => (
                <RecordingRow
                  key={r.id}
                  rec={r}
                  hostname={hostnameOf.get(r.deviceId) ?? r.deviceId}
                  now={now}
                  downloading={downloadingId === r.id}
                  onDownload={(rec) => void download(rec)}
                  canceling={cancelingId === r.id}
                  onCancel={(rec) => {
                    setCancelingId(rec.id)
                    cancel.mutate(rec)
                  }}
                />
              ))}
            </div>
          )}
        </Panel>
      </div>
    </div>
  )
}
