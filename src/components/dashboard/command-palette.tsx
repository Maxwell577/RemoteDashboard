'use client'

import { useEffect } from 'react'
import { useTheme } from 'next-themes'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Bell,
  Camera,
  Cpu,
  Disc3,
  FolderTree,
  History,
  Keyboard,
  LayoutDashboard,
  LocateFixed,
  MonitorSmartphone,
  Moon,
  RadioTower,
  ScrollText,
  Settings,
  SquareTerminal,
  Sun,
  Clapperboard,
  MapPin,
  RefreshCw,
  Terminal,
  CheckCheck,
} from 'lucide-react'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command'
import { api, type Alert, type CommandExecution, type Device } from '@/lib/types'
import { useDash, type ViewId } from '@/lib/store'
import { useDevices } from './shared'
import { cn } from '@/lib/utils'
import { Kbd, ModKey } from './kbd'

const NAV_ITEMS: { view: ViewId; label: string; icon: typeof LayoutDashboard }[] = [
  { view: 'overview', label: 'Overview', icon: LayoutDashboard },
  { view: 'devices', label: 'Devices', icon: MonitorSmartphone },
  { view: 'terminal', label: 'Terminal', icon: SquareTerminal },
  { view: 'files', label: 'File explorer', icon: FolderTree },
  { view: 'processes', label: 'Process manager', icon: Cpu },
  { view: 'media', label: 'Streams', icon: Clapperboard },
  { view: 'recordings', label: 'Recordings', icon: Disc3 },
  { view: 'network', label: 'Network capture', icon: RadioTower },
  { view: 'location', label: 'Location', icon: MapPin },
  { view: 'alerts', label: 'Alerts', icon: Bell },
  { view: 'audit', label: 'Audit log', icon: ScrollText },
  { view: 'settings', label: 'Settings', icon: Settings },
]

/**
 * Global ⌘K palette: navigate views, jump to a device, run quick actions.
 * Open state lives in the store so the topbar button can trigger it too.
 */
export default function CommandPalette() {
  const open = useDash((s) => s.paletteOpen)
  const setOpen = useDash((s) => s.setPaletteOpen)
  const setView = useDash((s) => s.setView)
  const selectedDeviceId = useDash((s) => s.selectedDeviceId)
  const setSelectedDeviceId = useDash((s) => s.setSelectedDeviceId)
  const { data: devices } = useDevices()
  const qc = useQueryClient()
  const { resolvedTheme, setTheme } = useTheme()

  // recent executions for the "Run again" group — fetched only while open
  const recent = useQuery({
    queryKey: ['commands', 'palette'] as const,
    queryFn: () => api<CommandExecution[]>('/api/commands?limit=12'),
    enabled: open,
    staleTime: 10_000,
  })
  const recentCommands = (() => {
    const seen = new Set<string>()
    const out: CommandExecution[] = []
    for (const c of recent.data ?? []) {
      const key = `${c.deviceId}::${c.command}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(c)
      if (out.length >= 5) break
    }
    return out
  })()

  // global hotkey
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setOpen(!useDash.getState().paletteOpen)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setOpen])

  const run = (fn: () => void | Promise<void>) => {
    setOpen(false)
    void fn()
  }

  const goDevice = (d: Device) =>
    run(() => {
      setSelectedDeviceId(d.id)
      setView('terminal')
    })

  const rerun = (c: CommandExecution) =>
    run(() => {
      setSelectedDeviceId(c.deviceId)
      useDash.getState().setPendingCommand({ command: c.command, deviceId: c.deviceId })
      setView('terminal')
      toast.info('Loaded into terminal — press Enter to run')
    })

  const screenshot = async () => {
    if (!selectedDeviceId) {
      toast.warning('Select a device first')
      setView('devices')
      return
    }
    try {
      const asset = await api<{ id: string }>('/api/media/screenshot', {
        method: 'POST',
        body: JSON.stringify({ deviceId: selectedDeviceId }),
      })
      toast.success('Screenshot captured — see Media view')
      qc.invalidateQueries({ queryKey: ['media'] })
      qc.setQueryData(['last-screenshot'], asset.id)
      setView('media')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Screenshot failed')
    }
  }

  const ackAll = async () => {
    try {
      const alerts = await api<Alert[]>('/api/alerts?limit=100&unackOnly=1')
      for (const a of alerts) {
        await api(`/api/alerts/${a.id}/ack`, { method: 'POST' }).catch(() => undefined)
      }
      toast.success(`Acknowledged ${alerts.length} alert${alerts.length === 1 ? '' : 's'}`)
      qc.invalidateQueries({ queryKey: ['alerts'] })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to ack alerts')
    }
  }

  const freshFix = async () => {
    if (!selectedDeviceId) {
      toast.warning('Select a device first')
      setView('devices')
      return
    }
    try {
      await api('/api/location/ping', {
        method: 'POST',
        body: JSON.stringify({ deviceId: selectedDeviceId }),
      })
      toast.success('Fresh location fix received')
      qc.invalidateQueries({ queryKey: ['location'] })
      setView('location')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Location fix failed')
    }
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Command palette"
      description="Navigate, jump to devices and run quick actions"
      className="glass-strong animate-in fade-in zoom-in-95 duration-200 [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-widest [&_[cmdk-input]]:text-sm"
    >
      <CommandInput placeholder="Type a command or search devices…" />
      <CommandList className="scroll-slim">
        <CommandEmpty>No results found.</CommandEmpty>

        <CommandGroup heading="Navigate">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon
            return (
              <CommandItem
                key={item.view}
                value={`go ${item.label}`}
                onSelect={() => run(() => setView(item.view))}
                className="gap-2.5 rounded-lg aria-selected:bg-primary/15 aria-selected:text-primary"
              >
                <Icon className="size-4" aria-hidden />
                <span>{item.label}</span>
                <span className="ml-auto text-[10px] uppercase tracking-wider text-muted-foreground/60">
                  view
                </span>
              </CommandItem>
            )
          })}
        </CommandGroup>

        <CommandSeparator />

        {recentCommands.length > 0 ? (
          <>
            <CommandGroup heading="Run again (recent commands)">
              {recentCommands.map((c) => {
                const host = (devices ?? []).find((d) => d.id === c.deviceId)?.hostname
                return (
                  <CommandItem
                    key={c.id}
                    value={`rerun ${c.command} ${host ?? ''}`}
                    onSelect={() => rerun(c)}
                    className="gap-2.5 rounded-lg aria-selected:bg-primary/15 aria-selected:text-primary"
                  >
                    <History className="size-4 shrink-0" aria-hidden />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs" title={c.command}>
                      {c.command}
                    </span>
                    <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground/60">
                      {host ?? 'unknown'}
                      <span
                        className={cn(
                          'inline-block size-1.5 rounded-full',
                          c.status === 'completed'
                            ? 'bg-emerald-500'
                            : c.status === 'running' || c.status === 'pending'
                              ? 'bg-amber-500'
                              : 'bg-rose-500',
                        )}
                        aria-hidden
                      />
                    </span>
                  </CommandItem>
                )
              })}
            </CommandGroup>
            <CommandSeparator />
          </>
        ) : null}

        <CommandGroup heading="Jump to device (opens terminal)">
          {(devices ?? []).map((d) => (
            <CommandItem
              key={d.id}
              value={`device ${d.hostname} ${d.friendlyName ?? ''} ${d.osName}`}
              onSelect={() => goDevice(d)}
              className="gap-2.5 rounded-lg aria-selected:bg-primary/15 aria-selected:text-primary"
            >
              <Terminal className="size-4" aria-hidden />
              <span className="font-medium">{d.hostname}</span>
              <span className="text-xs text-muted-foreground">{d.osName}</span>
              <span
                className={`ml-auto inline-block size-2 rounded-full ${
                  d.status === 'online' ? 'bg-emerald-500' : 'bg-zinc-400'
                }`}
                aria-hidden
              />
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Actions">
          <CommandItem
            value="screenshot capture now"
            onSelect={() => run(screenshot)}
            className="gap-2.5 rounded-lg aria-selected:bg-primary/15 aria-selected:text-primary"
          >
            <Camera className="size-4" aria-hidden />
            <span>Take screenshot{selectedDeviceId ? ' (selected device)' : ''}</span>
          </CommandItem>
          <CommandItem
            value="location fix refresh gps"
            onSelect={() => run(freshFix)}
            className="gap-2.5 rounded-lg aria-selected:bg-primary/15 aria-selected:text-primary"
          >
            <LocateFixed className="size-4" aria-hidden />
            <span>Request fresh location fix</span>
          </CommandItem>
          <CommandItem
            value="ack acknowledge all alerts"
            onSelect={() => run(ackAll)}
            className="gap-2.5 rounded-lg aria-selected:bg-primary/15 aria-selected:text-primary"
          >
            <CheckCheck className="size-4" aria-hidden />
            <span>Acknowledge all alerts</span>
          </CommandItem>
          <CommandItem
            value="refresh data invalidate cache"
            onSelect={() =>
              run(() => {
                qc.invalidateQueries()
                toast.success('All data refreshed')
              })
            }
            className="gap-2.5 rounded-lg aria-selected:bg-primary/15 aria-selected:text-primary"
          >
            <RefreshCw className="size-4" aria-hidden />
            <span>Refresh all data</span>
          </CommandItem>
          <CommandItem
            value="theme dark light toggle mode"
            onSelect={() =>
              run(() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark'))
            }
            className="gap-2.5 rounded-lg aria-selected:bg-primary/15 aria-selected:text-primary"
          >
            {resolvedTheme === 'dark' ? (
              <Sun className="size-4" aria-hidden />
            ) : (
              <Moon className="size-4" aria-hidden />
            )}
            <span>Toggle light / dark theme</span>
          </CommandItem>
          <CommandItem
            value="keyboard shortcuts help hotkeys"
            onSelect={() =>
              run(() => useDash.getState().setHelpOpen(true))
            }
            className="gap-2.5 rounded-lg aria-selected:bg-primary/15 aria-selected:text-primary"
          >
            <Keyboard className="size-4" aria-hidden />
            <span>Keyboard shortcuts</span>
            <span className="ml-auto flex shrink-0 items-center gap-0.5">
              <Kbd>?</Kbd>
            </span>
          </CommandItem>
        </CommandGroup>
      </CommandList>
      <div className="flex items-center justify-center gap-1.5 border-t border-border/40 px-4 py-2 text-[11px] text-muted-foreground">
        <Kbd>
          <ModKey />
        </Kbd>
        <Kbd>K</Kbd>
        <span className="mr-2">palette</span>
        <Kbd>Alt</Kbd>
        <Kbd>1-9</Kbd>
        <span className="mr-2">views</span>
        <Kbd>?</Kbd>
        <span>shortcuts</span>
      </div>
    </CommandDialog>
  )
}
