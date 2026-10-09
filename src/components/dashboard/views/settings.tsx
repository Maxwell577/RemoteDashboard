'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Clapperboard,
  Cloud,
  Copy,
  Download,
  Eye,
  EyeOff,
  KeyRound,
  BellRing,
  ShieldCheck,
  TerminalSquare,
  TriangleAlert,
  UserPlus,
  type LucideIcon,
} from 'lucide-react'
import { api, type AppSettings } from '@/lib/types'
import { useDash } from '@/lib/store'
import { cn } from '@/lib/utils'
import { ErrorBlock, LoadingBlock, Panel, SectionHeader } from '../shared'
import AlertRulesSettings from './alert-rules-settings'
import SavedCommands from './saved-commands'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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

// ─────────────────────────── section shell ──────────────────────────

function SectionCard({
  icon: Icon,
  title,
  description,
  dirty,
  saving,
  onSave,
  children,
  className,
}: {
  icon: LucideIcon
  title: string
  description: string
  dirty: boolean
  saving: boolean
  onSave: () => void
  children: ReactNode
  className?: string
}) {
  return (
    <Panel className={cn('glass-hover flex flex-col p-6', className)}>
      <div className="flex items-start gap-3">
        <div className="glass-inset flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-primary">
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <h3 className="font-semibold leading-tight">{title}</h3>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
      </div>

      <div className="mt-4 flex flex-1 flex-col gap-4">{children}</div>

      <div className="mt-5 flex items-center justify-end gap-3">
        {dirty ? (
          <span className="text-xs text-amber-600 dark:text-amber-400">unsaved changes</span>
        ) : null}
        <Button
          size="sm"
          className="h-9 min-w-24"
          disabled={!dirty || saving}
          onClick={onSave}
        >
          {saving ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </Panel>
  )
}

function SwitchRow({
  id,
  label,
  description,
  checked,
  onChange,
}: {
  id: string
  label: string
  description?: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="glass-inset flex min-h-11 items-center justify-between gap-4 rounded-xl px-3 py-2.5">
      <div className="min-w-0">
        <Label htmlFor={id} className="cursor-pointer text-sm">
          {label}
        </Label>
        {description ? (
          <p className="text-xs text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  )
}

/**
 * Browser-local alert sound preference (NOT part of the server settings blob —
 * it lives in localStorage via the zustand store and syncs with the topbar speaker button).
 */
function BrowserSoundRow() {
  const alertSound = useDash((s) => s.alertSound)
  const setAlertSound = useDash((s) => s.setAlertSound)
  return (
    <SwitchRow
      id="alerts-browser-sound"
      label="Alert sound in this browser"
      description="short audible blip on new realtime alerts — device-local, not saved to the server"
      checked={alertSound}
      onChange={setAlertSound}
    />
  )
}

/**
 * Browser-local presence sound (device connect / disconnect transitions).
 * Same localStorage pattern as the alert sound.
 */
function PresenceSoundRow() {
  const presenceSound = useDash((s) => s.presenceSound)
  const setPresenceSound = useDash((s) => s.setPresenceSound)
  return (
    <SwitchRow
      id="presence-browser-sound"
      label="Sound on device connect / disconnect"
      description="rising blip when an agent comes online, falling when it drops — device-local"
      checked={presenceSound}
      onChange={setPresenceSound}
    />
  )
}

// ─────────────────────── agent enrollment kit ───────────────────────

function AgentEnrollment({ hubUrl, heartbeatSec }: { hubUrl: string; heartbeatSec: number }) {
  const hub = hubUrl?.trim() || 'http://127.0.0.1:3003'
  const installCmd = `$hub = "${hub}"            # realtime hub endpoint
$token = "<your-hub-token>"   # x-hub-token shared secret (keep private)
irm "$hub/agent/install.ps1" -OutFile "$env:TEMP\\sentra-install.ps1"
pwsh -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\\sentra-install.ps1" -Hub $hub -Token $token`

  const copyCmd = async () => {
    try {
      await navigator.clipboard.writeText(installCmd)
      toast.success('Install command copied', {
        description: 'Paste into an elevated PowerShell window on the target machine.',
      })
    } catch {
      toast.error('Clipboard unavailable — select the text manually')
    }
  }

  const downloadConfig = () => {
    const config = {
      hubUrl: hub,
      socketPath: '/',
      heartbeatIntervalSec: heartbeatSec,
      encryption: { algorithm: 'AES-256-GCM', keySource: 'dashboard capturePassword' },
      capabilities: [
        'exec', 'fs:list', 'fs:download', 'fs:upload', 'fs:delete', 'fs:rename', 'fs:mkdir',
        'ps:list', 'ps:action', 'media:screenshot', 'media:record', 'media:stop',
        'net:start', 'net:stop', 'location:fix', 'screen:live:start', 'screen:live:stop',
      ],
      notes: 'SentraRMM agent config — the agent binary ships separately in the open-source repo.',
      generatedAt: new Date().toISOString(),
    }
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' }),
    )
    const a = document.createElement('a')
    a.href = url
    a.download = 'sentra-agent.config.json'
    a.click()
    URL.revokeObjectURL(url)
    toast.success('Agent config downloaded', { description: 'sentra-agent.config.json' })
  }

  return (
    <Panel className="glass-hover p-6">
      <div className="flex items-start gap-3">
        <div className="glass-inset flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-primary">
          <UserPlus className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <h3 className="font-semibold leading-tight">Agent enrollment</h3>
          <p className="text-sm text-muted-foreground">
            Generate the install command + config your Windows agent consumes.
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-3">
        <div className="glass-inset relative rounded-xl">
          <div className="flex items-center justify-between gap-2 border-b border-border/40 px-3 py-2">
            <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              <TerminalSquare className="h-3.5 w-3.5" /> PowerShell — run as Administrator
            </span>
            <Button size="sm" variant="ghost" className="h-8 gap-1.5 px-2" onClick={() => void copyCmd()}>
              <Copy className="h-3.5 w-3.5" /> Copy
            </Button>
          </div>
          <pre className="scroll-slim overflow-x-auto px-3 py-2.5 font-mono text-xs leading-relaxed text-emerald-700 dark:text-emerald-300">
            {installCmd}
          </pre>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" className="h-9 gap-1.5" onClick={downloadConfig}>
            <Download className="h-3.5 w-3.5" /> Download agent config
          </Button>
          <Badge variant="secondary" className="font-mono text-[10px]">hub: {hub}</Badge>
          <Badge variant="secondary" className="font-mono text-[10px]">heartbeat: {heartbeatSec}s</Badge>
        </div>

        <p className="text-xs text-muted-foreground">
          The agent binary ships separately in the open-source repository — this kit generates the
          config + install command it consumes. New enrollments raise an info alert (configurable
          above) and appear in Devices automatically.
        </p>
      </div>
    </Panel>
  )
}

// ─────────────────────────── view ─────────────────────────────────────

export default function SettingsView() {
  const qc = useQueryClient()
  const settingsQuery = useQuery({
    queryKey: ['settings'],
    queryFn: () => api<AppSettings>('/api/settings'),
  })

  const [form, setForm] = useState<AppSettings | null>(null)
  const [showPassword, setShowPassword] = useState(false)
  const [savingSection, setSavingSection] = useState<string | null>(null)

  // sync local form from query data (first load wins — keeps in-progress edits)
  useEffect(() => {
    if (!settingsQuery.data) return
    setForm((prev) => prev ?? settingsQuery.data)
  }, [settingsQuery.data])

  const data = settingsQuery.data ?? null

  function update<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev))
  }

  function isDirty(keys: (keyof AppSettings)[]): boolean {
    if (!form || !data) return false
    return keys.some((k) => form[k] !== data[k])
  }

  const save = useMutation({
    mutationFn: (partial: Partial<AppSettings>) =>
      api<AppSettings>('/api/settings', {
        method: 'PUT',
        body: JSON.stringify(partial),
      }),
    onSuccess: (saved) => {
      qc.setQueryData(['settings'], saved)
      toast.success('Settings saved')
    },
    onError: (e) =>
      toast.error('Save failed', {
        description: e instanceof Error ? e.message : 'Unknown error',
      }),
  })

  async function saveSection(section: string, partial: Partial<AppSettings>) {
    setSavingSection(section)
    try {
      await save.mutateAsync(partial)
    } finally {
      setSavingSection(null)
    }
  }

  if (settingsQuery.isLoading || (!form && !settingsQuery.isError)) {
    return (
      <div className="flex flex-col gap-4">
        <SectionHeader
          title="Settings"
          subtitle="Security, capture defaults, notifications & integrations"
          icon={<ShieldCheck className="h-5 w-5" />}
        />
        <LoadingBlock label="Loading settings…" />
      </div>
    )
  }

  if (settingsQuery.isError || !form) {
    return (
      <div className="flex flex-col gap-4">
        <SectionHeader
          title="Settings"
          subtitle="Security, capture defaults, notifications & integrations"
          icon={<ShieldCheck className="h-5 w-5" />}
        />
        <ErrorBlock
          message={
            settingsQuery.error instanceof Error
              ? settingsQuery.error.message
              : 'Failed to load settings'
          }
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader
        title="Settings"
        subtitle="Security, capture defaults, notifications & integrations"
        icon={<ShieldCheck className="h-5 w-5" />}
      />

      <div className="grid gap-4 lg:grid-cols-2 lg:gap-6">
        {/* 1. Security */}
        <SectionCard
          icon={KeyRound}
          title="Security"
          description="Capture encryption and execution hygiene"
          dirty={isDirty(['capturePassword', 'inMemoryModeDefault'])}
          saving={savingSection === 'security'}
          onSave={() =>
            void saveSection('security', {
              capturePassword: form.capturePassword,
              inMemoryModeDefault: form.inMemoryModeDefault,
            })
          }
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="capture-password" className="text-xs uppercase tracking-wide text-muted-foreground">
              Capture password
            </Label>
            <div className="relative">
              <Input
                id="capture-password"
                type={showPassword ? 'text' : 'password'}
                value={form.capturePassword}
                onChange={(e) => update('capturePassword', e.target.value)}
                placeholder="••••••••••••"
                autoComplete="new-password"
                className="h-11 pr-11 md:h-9"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute right-1 top-1/2 h-8 w-8 -translate-y-1/2"
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                onClick={() => setShowPassword((v) => !v)}
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              used to encrypt screenshots, recordings and pcapng on devices
            </p>
          </div>

          <SwitchRow
            id="in-memory-default"
            label="In-memory execution default"
            description="run captures without dropping temp files"
            checked={form.inMemoryModeDefault}
            onChange={(v) => update('inMemoryModeDefault', v)}
          />
        </SectionCard>

        {/* 2. Capture defaults */}
        <SectionCard
          icon={Clapperboard}
          title="Capture defaults"
          description="Default quality and artifact retention"
          dirty={isDirty(['defaultStreamQuality', 'retentionDays'])}
          saving={savingSection === 'capture'}
          onSave={() =>
            void saveSection('capture', {
              defaultStreamQuality: form.defaultStreamQuality,
              retentionDays: form.retentionDays,
            })
          }
        >
          <div className="flex flex-col gap-2">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">
              Default stream quality
            </Label>
            <Select
              value={form.defaultStreamQuality}
              onValueChange={(v) =>
                update('defaultStreamQuality', v as AppSettings['defaultStreamQuality'])
              }
            >
              <SelectTrigger className="h-11 w-full md:h-9" aria-label="Default stream quality">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="glass-strong">
                <SelectItem value="480p">480p</SelectItem>
                <SelectItem value="720p">720p</SelectItem>
                <SelectItem value="1080p">1080p</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="retention-days" className="text-xs uppercase tracking-wide text-muted-foreground">
              Retention (days)
            </Label>
            <Input
              id="retention-days"
              type="number"
              min={1}
              max={3650}
              value={String(form.retentionDays)}
              onChange={(e) => {
                const n = Number(e.target.value)
                update('retentionDays', Number.isFinite(n) && n > 0 ? Math.floor(n) : 1)
              }}
              className="h-11 md:h-9"
            />
            <p className="text-xs text-muted-foreground">
              artifacts older than this are purged from the device vault
            </p>
          </div>
        </SectionCard>

        {/* 3. Notifications */}
        <SectionCard
          icon={BellRing}
          title="Notifications"
          description="Fleet events worth a toast (and an alert row)"
          dirty={isDirty(['alertsOnOffline', 'alertsOnNewDevice'])}
          saving={savingSection === 'notifications'}
          onSave={() =>
            void saveSection('notifications', {
              alertsOnOffline: form.alertsOnOffline,
              alertsOnNewDevice: form.alertsOnNewDevice,
            })
          }
        >
          <SwitchRow
            id="alerts-on-offline"
            label="Alert when a device goes offline"
            description="raises a warning alert + toast when an agent stops checking in"
            checked={form.alertsOnOffline}
            onChange={(v) => update('alertsOnOffline', v)}
          />
          <SwitchRow
            id="alerts-on-new-device"
            label="Alert on new device enrollment"
            description="raises an info alert when a new agent registers"
            checked={form.alertsOnNewDevice}
            onChange={(v) => update('alertsOnNewDevice', v)}
          />
          <BrowserSoundRow />
          <PresenceSoundRow />
        </SectionCard>

        {/* 3-b. Alert rules engine — wide */}
        <div className="lg:col-span-2">
          <AlertRulesSettings
            engineEnabled={form.alertRulesEnabled}
            onToggleEngine={async (v) => {
              await saveSection('alert-rules-engine', { alertRulesEnabled: v })
            }}
          />
        </div>

        {/* 3-c. Agent enrollment — wide */}
        <div className="lg:col-span-2">
          {form ? (
            <AgentEnrollment hubUrl={form.hubUrl} heartbeatSec={form.heartbeatIntervalSec} />
          ) : null}
        </div>

        {/* 4. Integrations */}
        <SectionCard
          icon={Cloud}
          title="Integrations"
          description="Supabase artifact storage & realtime hub endpoint"
          dirty={isDirty(['supabaseUrl', 'supabaseBucket', 'hubUrl'])}
          saving={savingSection === 'integrations'}
          onSave={() =>
            void saveSection('integrations', {
              supabaseUrl: form.supabaseUrl,
              supabaseBucket: form.supabaseBucket,
              hubUrl: form.hubUrl,
            })
          }
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="supabase-url" className="text-xs uppercase tracking-wide text-muted-foreground">
              Supabase URL
            </Label>
            <Input
              id="supabase-url"
              value={form.supabaseUrl}
              onChange={(e) => update('supabaseUrl', e.target.value)}
              placeholder="https://xxxx.supabase.co"
              className="h-11 md:h-9"
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="supabase-bucket" className="text-xs uppercase tracking-wide text-muted-foreground">
              Supabase bucket
            </Label>
            <Input
              id="supabase-bucket"
              value={form.supabaseBucket}
              onChange={(e) => update('supabaseBucket', e.target.value)}
              placeholder="sentrarmm-artifacts"
              className="h-11 md:h-9"
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="hub-url" className="text-xs uppercase tracking-wide text-muted-foreground">
              Realtime hub URL
            </Label>
            <Input
              id="hub-url"
              value={form.hubUrl}
              onChange={(e) => update('hubUrl', e.target.value)}
              placeholder="http://127.0.0.1:3003"
              className="h-11 font-mono md:h-9"
            />
          </div>

          <p className="text-xs text-muted-foreground">
            Cloudflare Pages + Supabase deployment targets are configured here after you provide
            credentials.
          </p>
        </SectionCard>

        {/* 5. Saved commands — wide */}
        <div className="lg:col-span-2">
          <SavedCommands />
        </div>

        {/* 6. About — wide */}
        <Panel className="glass-hover p-6 lg:col-span-2">
          <div className="flex items-start gap-3">
            <div className="glass-inset flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-primary">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="font-semibold leading-tight">
                About <span className="text-gradient">SentraRMM v0.1.8</span>
              </h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Open-source, authorized-use RMM for your own fleet and security assessments.
              </p>

              <div className="mt-4 flex flex-wrap items-center gap-2">
                {['Next.js 16', 'Socket.IO hub', 'Prisma/SQLite → Supabase-ready', 'Cloudflare Pages-ready'].map(
                  (chip) => (
                    <Badge key={chip} variant="secondary" className="text-xs">
                      {chip}
                    </Badge>
                  )
                )}
              </div>

              <div className="mt-4 flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                <p className="text-sm text-amber-700 dark:text-amber-400">
                  This console must only be used on systems you own or are authorized to assess.
                </p>
              </div>
            </div>
          </div>
        </Panel>
      </div>
    </div>
  )
}
