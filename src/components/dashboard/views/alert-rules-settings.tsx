'use client'

/**
 * Alert rules engine — Settings section.
 * CRUD for threshold rules (Setting blob "alertRules" via /api/alert-rules),
 * a master switch wired into AppSettings.alertRulesEnabled, and an
 * "Evaluate now" probe that runs the engine over the live metrics on screen.
 */
import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Cpu,
  Gauge,
  HardDrive,
  Loader2,
  MemoryStick,
  Play,
  Plus,
  RotateCcw,
  Siren,
  Trash2,
  type LucideIcon,
} from 'lucide-react'
import {
  api,
  describeRule,
  METRIC_LABELS,
  type AlertMetric,
  type AlertRule,
  type AlertRuleOp,
  type Device,
  type DeviceMetrics,
} from '@/lib/types'
import { useDash } from '@/lib/store'
import { cn } from '@/lib/utils'
import { LoadingBlock, Panel, SectionHeader } from '../shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

// ───────────────────────────── atoms ─────────────────────────────────

const METRIC_META: Record<AlertMetric, { icon: LucideIcon; chip: string }> = {
  cpu: { icon: Cpu, chip: 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400' },
  memory: { icon: MemoryStick, chip: 'border-teal-500/30 bg-teal-500/10 text-teal-600 dark:text-teal-400' },
  disk: { icon: HardDrive, chip: 'border-fuchsia-500/30 bg-fuchsia-500/10 text-fuchsia-600 dark:text-fuchsia-400' },
}

function severityBadgeClass(sev: AlertRule['severity']): string {
  switch (sev) {
    case 'critical':
      return 'border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400'
    case 'warning':
      return 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400'
    default:
      return 'border-teal-500/30 bg-teal-500/10 text-teal-600 dark:text-teal-400'
  }
}

interface DraftRule {
  name: string
  metric: AlertMetric
  op: AlertRuleOp
  threshold: number
  severity: AlertRule['severity']
  cooldownMin: number
}

const EMPTY_DRAFT: DraftRule = {
  name: '',
  metric: 'cpu',
  op: 'gt',
  threshold: 80,
  severity: 'warning',
  cooldownMin: 15,
}

// ───────────────────────── rule editor dialog ────────────────────────

function RuleDialog({
  open,
  onOpenChange,
  initial,
  onSubmit,
  editing,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  initial: DraftRule
  editing: boolean
  onSubmit: (d: DraftRule) => void
}) {
  // keyed remount re-seeds the draft from props on every open/edit target
  // change (avoids setState-in-effect sync)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <DialogContent className="glass-strong rounded-2xl sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <Gauge className="size-4 text-primary" aria-hidden />
              {editing ? 'Edit rule' : 'New alert rule'}
            </DialogTitle>
            <DialogDescription>
              Fires when a device heartbeat crosses the threshold. Rate-limited per device.
            </DialogDescription>
          </DialogHeader>
          <RuleForm
            key={editing ? `edit-${initial.name}-${initial.threshold}` : 'new'}
            initial={initial}
            onSubmit={onSubmit}
            onCancel={() => onOpenChange(false)}
            editing={editing}
          />
        </DialogContent>
      ) : null}
    </Dialog>
  )
}

function RuleForm({
  initial,
  onSubmit,
  onCancel,
  editing,
}: {
  initial: DraftRule
  onSubmit: (d: DraftRule) => void
  onCancel: () => void
  editing: boolean
}) {
  const [draft, setDraft] = useState<DraftRule>(initial)
  const valid = draft.name.trim().length > 0 && draft.threshold >= 0 && draft.threshold <= 100

  return (
    <>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="rule-name" className="text-xs uppercase tracking-wide text-muted-foreground">
            Rule name
          </Label>
          <Input
            id="rule-name"
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            placeholder="High CPU load"
            maxLength={80}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">Metric</Label>
            <Select
              value={draft.metric}
              onValueChange={(v) => setDraft((d) => ({ ...d, metric: v as AlertMetric }))}
            >
              <SelectTrigger aria-label="Metric">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="glass-strong">
                {(Object.keys(METRIC_LABELS) as AlertMetric[]).map((m) => (
                  <SelectItem key={m} value={m}>
                    {METRIC_LABELS[m]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">Condition</Label>
            <Select
              value={draft.op}
              onValueChange={(v) => setDraft((d) => ({ ...d, op: v as AlertRuleOp }))}
            >
              <SelectTrigger aria-label="Condition">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="glass-strong">
                <SelectItem value="gt">above</SelectItem>
                <SelectItem value="lt">below</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="rule-threshold" className="text-xs uppercase tracking-wide text-muted-foreground">
              Threshold %
            </Label>
            <Input
              id="rule-threshold"
              type="number"
              min={0}
              max={100}
              value={String(draft.threshold)}
              onChange={(e) => {
                const n = Number(e.target.value)
                setDraft((d) => ({ ...d, threshold: Number.isFinite(n) ? n : 0 }))
              }}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">Severity</Label>
            <Select
              value={draft.severity}
              onValueChange={(v) => setDraft((d) => ({ ...d, severity: v as DraftRule['severity'] }))}
            >
              <SelectTrigger aria-label="Severity">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="glass-strong">
                <SelectItem value="info">info</SelectItem>
                <SelectItem value="warning">warning</SelectItem>
                <SelectItem value="critical">critical</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="rule-cooldown" className="text-xs uppercase tracking-wide text-muted-foreground">
              Cooldown min
            </Label>
            <Input
              id="rule-cooldown"
              type="number"
              min={1}
              max={10080}
              value={String(draft.cooldownMin)}
              onChange={(e) => {
                const n = Number(e.target.value)
                setDraft((d) => ({ ...d, cooldownMin: Number.isFinite(n) && n > 0 ? Math.floor(n) : 15 }))
              }}
            />
          </div>
        </div>
      </div>

      <DialogFooter className="gap-2">
        <Button variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={!valid}
          onClick={() => onSubmit({ ...draft, name: draft.name.trim() })}
        >
          {editing ? 'Save rule' : 'Add rule'}
        </Button>
      </DialogFooter>
    </>
  )
}

// ───────────────────────────── section ───────────────────────────────

export default function AlertRulesSettings({
  engineEnabled,
  onToggleEngine,
}: {
  engineEnabled: boolean
  onToggleEngine: (v: boolean) => Promise<void>
}) {
  const qc = useQueryClient()
  const rulesQuery = useQuery({
    queryKey: ['alert-rules'],
    queryFn: () => api<AlertRule[]>('/api/alert-rules'),
  })
  const { data: devices } = useQuery({
    queryKey: ['devices'],
    queryFn: () => api<Device[]>('/api/devices'),
    refetchInterval: 10000,
  })
  const metricsByDevice = useDash((s) => s.metricsByDevice)

  const [rules, setRules] = useState<AlertRule[] | null>(null)
  const [saving, setSaving] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [evaluating, setEvaluating] = useState(false)

  useEffect(() => {
    if (rulesQuery.data) setRules((prev) => prev ?? rulesQuery.data)
  }, [rulesQuery.data])

  const serverRules = rulesQuery.data ?? []
  const dirty = rules !== null && JSON.stringify(rules) !== JSON.stringify(serverRules)

  async function persist(next: AlertRule[]) {
    setSaving(true)
    try {
      const saved = await api<AlertRule[]>('/api/alert-rules', {
        method: 'PUT',
        body: JSON.stringify(next),
      })
      setRules(saved)
      qc.setQueryData(['alert-rules'], saved)
      toast.success('Alert rules saved', {
        description: `${saved.filter((r) => r.enabled).length} of ${saved.length} enabled`,
      })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save rules')
    } finally {
      setSaving(false)
    }
  }

  function upsertRule(draft: DraftRule) {
    setRules((prev) => {
      const base = prev ?? []
      if (editingId) {
        return base.map((r) => (r.id === editingId ? { ...r, ...draft } : r))
      }
      const id = `rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
      return [...base, { id, enabled: true, ...draft }]
    })
  }

  async function resetDefaults() {
    setSaving(true)
    try {
      const saved = await api<AlertRule[]>('/api/alert-rules', { method: 'POST' })
      setRules(saved)
      qc.setQueryData(['alert-rules'], saved)
      toast.success('Default rules restored')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to reset rules')
    } finally {
      setSaving(false)
    }
  }

  /** Run the engine over the live metrics currently on screen. */
  async function evaluateNow() {
    const entries = (devices ?? [])
      .filter((d) => d.status === 'online' && metricsByDevice[d.id])
      .map((d) => ({ ...metricsByDevice[d.id], deviceId: d.id, hostname: d.hostname }))
    if (entries.length === 0) {
      toast.info('No live telemetry to evaluate', {
        description: 'Wait for a device heartbeat, then try again.',
      })
      return
    }
    setEvaluating(true)
    try {
      const res = await api<{
        fired: { id: string; title: string }[]
        results: { hostname: string; fired: number }[]
        engineEnabled: boolean
      }>('/api/alert-rules/evaluate', {
        method: 'POST',
        body: JSON.stringify({ entries }),
      })
      const firedCount = res.fired.length
      const checked = res.results.length
      if (firedCount > 0) {
        toast.warning(`Engine fired ${firedCount} alert${firedCount === 1 ? '' : 's'}`, {
          description: res.fired.map((f) => f.title).join(' · '),
        })
      } else {
        toast.success(`Evaluated ${checked} device${checked === 1 ? '' : 's'} — no thresholds crossed`, {
          description: engineEnabled ? 'All devices are within their rule thresholds.' : 'The engine is switched off.',
        })
      }
      qc.invalidateQueries({ queryKey: ['alerts'] })
      qc.invalidateQueries({ queryKey: ['audit'] })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Evaluation failed')
    } finally {
      setEvaluating(false)
    }
  }

  const enabledCount = (rules ?? []).filter((r) => r.enabled).length
  const busy = saving || rulesQuery.isLoading

  const list = useMemo(() => rules ?? [], [rules])

  return (
    <Panel className="card-sheen glass-hover relative overflow-hidden p-6">
      <div
        aria-hidden
        className="pointer-events-none absolute -right-14 -top-14 h-36 w-36 rounded-full bg-primary/5 blur-2xl"
      />
      <div className="flex flex-wrap items-start gap-3">
        <div className="glass-inset flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-primary">
          <Siren className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold leading-tight">Alert rules engine</h3>
          <p className="text-sm text-muted-foreground">
            Threshold rules evaluated on every device heartbeat — breaches raise alerts, rate-limited by a per-device cooldown.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge
            variant="outline"
            className={cn(
              'font-mono text-[10px]',
              engineEnabled
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                : 'border-zinc-400/40 text-zinc-500 dark:text-zinc-400',
            )}
          >
            {engineEnabled ? 'engine on' : 'engine off'}
          </Badge>
          <Switch
            checked={engineEnabled}
            onCheckedChange={(v) => void onToggleEngine(v)}
            aria-label="Enable alert rules engine"
          />
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-2">
        {rulesQuery.isLoading ? (
          <LoadingBlock label="Loading rules…" />
        ) : rulesQuery.isError ? (
          <p className="text-sm text-destructive">
            {rulesQuery.error instanceof Error ? rulesQuery.error.message : 'Failed to load rules'}
          </p>
        ) : list.length === 0 ? (
          <p className="glass-inset rounded-xl px-3 py-6 text-center text-sm text-muted-foreground">
            No rules defined — add one below.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {list.map((rule, i) => {
              const meta = METRIC_META[rule.metric]
              const Icon = meta.icon
              return (
                <li
                  key={rule.id}
                  className="glass-inset flex items-center gap-3 rounded-xl px-3 py-2.5"
                  style={{ animation: `animate-in-up 300ms cubic-bezier(0.22,1,0.36,1) ${i * 40}ms both` }}
                >
                  <span
                    className={cn(
                      'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border',
                      meta.chip,
                    )}
                    aria-hidden
                  >
                    <Icon className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium leading-tight">{rule.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {describeRule(rule)} · cooldown {rule.cooldownMin} min
                    </p>
                  </div>
                  <Badge
                    variant="outline"
                    className={cn('shrink-0 text-[10px] capitalize', severityBadgeClass(rule.severity))}
                  >
                    {rule.severity}
                  </Badge>
                  <Switch
                    checked={rule.enabled}
                    onCheckedChange={(v) =>
                      setRules((prev) => (prev ?? []).map((r) => (r.id === rule.id ? { ...r, enabled: v } : r)))
                    }
                    aria-label={`${rule.enabled ? 'Disable' : 'Enable'} rule ${rule.name}`}
                  />
                  <div className="flex shrink-0 items-center gap-0.5">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8 text-muted-foreground hover:text-foreground"
                      aria-label={`Edit rule ${rule.name}`}
                      onClick={() => {
                        setEditingId(rule.id)
                        setDialogOpen(true)
                      }}
                    >
                      <Gauge className="size-3.5" aria-hidden />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8 text-muted-foreground hover:text-destructive"
                      aria-label={`Delete rule ${rule.name}`}
                      onClick={() => {
                        setRules((prev) => (prev ?? []).filter((r) => r.id !== rule.id))
                      }}
                    >
                      <Trash2 className="size-3.5" aria-hidden />
                    </Button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          className="h-9 gap-1.5"
          disabled={busy}
          onClick={() => {
            setEditingId(null)
            setDialogOpen(true)
          }}
        >
          <Plus className="size-3.5" aria-hidden /> Add rule
        </Button>
        <Button size="sm" variant="outline" className="h-9 gap-1.5" disabled={busy || evaluating} onClick={() => void evaluateNow()}>
          {evaluating ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Play className="size-3.5" aria-hidden />}
          Evaluate now
        </Button>
        <Button size="sm" variant="ghost" className="h-9 gap-1.5 text-muted-foreground" disabled={busy} onClick={() => void resetDefaults()}>
          <RotateCcw className="size-3.5" aria-hidden /> Reset defaults
        </Button>
        <div className="ml-auto flex items-center gap-3">
          {dirty ? <span className="text-xs text-amber-600 dark:text-amber-400">unsaved changes</span> : null}
          <Button size="sm" className="h-9 min-w-24" disabled={!dirty || saving} onClick={() => void persist(list)}>
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {enabledCount} of {list.length} rules armed · maintenance windows suppress rule alerts · evaluate now uses the telemetry currently on screen.
      </p>

      <RuleDialog
        open={dialogOpen}
        onOpenChange={(o) => {
          setDialogOpen(o)
          if (!o) setEditingId(null)
        }}
        initial={
          editingId
            ? (() => {
                const r = list.find((x) => x.id === editingId)
                return r
                  ? {
                      name: r.name,
                      metric: r.metric,
                      op: r.op,
                      threshold: r.threshold,
                      severity: r.severity,
                      cooldownMin: r.cooldownMin,
                    }
                  : EMPTY_DRAFT
              })()
            : EMPTY_DRAFT
        }
        editing={editingId !== null}
        onSubmit={upsertRule}
      />
    </Panel>
  )
}
