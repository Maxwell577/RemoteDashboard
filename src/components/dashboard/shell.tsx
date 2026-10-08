'use client'

import { useEffect, useState, type ComponentType } from 'react'
import {
  Bell,
  Clapperboard,
  Cpu,
  FolderTree,
  Keyboard,
  LayoutDashboard,
  MapPin,
  Menu,
  MonitorSmartphone,
  RadioTower,
  ScrollText,
  Settings as SettingsIcon,
  ShieldCheck,
  SquareTerminal,
  Search,
  Volume2,
  VolumeX,
  type LucideIcon,
} from 'lucide-react'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useDash, type ViewId } from '@/lib/store'
import { cn } from '@/lib/utils'
import { StatusDot, useDevices } from './shared'
import Realtime from './realtime'
import ThemeToggle from './theme-toggle'
import CommandPalette from './command-palette'
import ShortcutsDialog, { HOTKEY_VIEWS } from './shortcuts-dialog'
import NotificationCenter from './notification-center'
import { Kbd, ModKey } from './kbd'
import Overview from './views/overview'
import Devices from './views/devices'
import Terminal from './views/terminal'
import Files from './views/files'
import Processes from './views/processes'
import Media from './views/media'
import Network from './views/network'
import Location from './views/location'
import Alerts from './views/alerts'
import Audit from './views/audit'
import Settings from './views/settings'

// ─────────────────────────── view registry ──────────────────────────

const VIEWS: Record<ViewId, { label: string; component: ComponentType }> = {
  overview: { label: 'Overview', component: Overview },
  devices: { label: 'Devices', component: Devices },
  terminal: { label: 'Terminal', component: Terminal },
  files: { label: 'Files', component: Files },
  processes: { label: 'Processes', component: Processes },
  media: { label: 'Media', component: Media },
  network: { label: 'Network', component: Network },
  location: { label: 'Location', component: Location },
  alerts: { label: 'Alerts', component: Alerts },
  audit: { label: 'Audit', component: Audit },
  settings: { label: 'Settings', component: Settings },
}

const NAV: { group: string; items: { view: ViewId; label: string; icon: LucideIcon }[] }[] = [
  {
    group: 'Monitor',
    items: [
      { view: 'overview', label: 'Overview', icon: LayoutDashboard },
      { view: 'devices', label: 'Devices', icon: MonitorSmartphone },
    ],
  },
  {
    group: 'Control',
    items: [
      { view: 'terminal', label: 'Terminal', icon: SquareTerminal },
      { view: 'files', label: 'Files', icon: FolderTree },
      { view: 'processes', label: 'Processes', icon: Cpu },
    ],
  },
  {
    group: 'Capture',
    items: [
      { view: 'media', label: 'Media', icon: Clapperboard },
      { view: 'network', label: 'Network', icon: RadioTower },
      { view: 'location', label: 'Location', icon: MapPin },
    ],
  },
  {
    group: 'Ops',
    items: [
      { view: 'alerts', label: 'Alerts', icon: Bell },
      { view: 'audit', label: 'Audit', icon: ScrollText },
      { view: 'settings', label: 'Settings', icon: SettingsIcon },
    ],
  },
]

// ─────────────────────────── sidebar atoms ──────────────────────────

function Brand() {
  return (
    <div className="flex items-center gap-3 px-1">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-lg shadow-emerald-500/25">
        <ShieldCheck className="h-5 w-5" aria-hidden />
      </div>
      <div className="min-w-0 leading-tight">
        <p className="truncate text-base font-bold tracking-tight">
          Sentra<span className="text-gradient">RMM</span>
        </p>
        <p className="truncate text-[11px] text-muted-foreground">
          remote management console
        </p>
      </div>
    </div>
  )
}

function NavList({ onNavigate }: { onNavigate: (v: ViewId) => void }) {
  const view = useDash((s) => s.view)
  const unread = useDash((s) => s.unreadAlerts)

  return (
    <nav className="flex flex-col gap-4" aria-label="Dashboard sections">
      {NAV.map((group) => (
        <div key={group.group} className="flex flex-col gap-1">
          <p className="px-3 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/70">
            {group.group}
          </p>
          {group.items.map((item) => {
            const active = view === item.view
            const Icon = item.icon
            return (
              <button
                key={item.view}
                type="button"
                onClick={() => onNavigate(item.view)}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'relative flex min-h-[44px] w-full items-center gap-3 rounded-xl px-3 text-sm font-medium outline-none transition-all focus-visible:ring-2 focus-visible:ring-ring/50',
                  active
                    ? 'border border-primary/25 bg-primary/15 text-primary shadow-inner'
                    : 'border border-transparent text-muted-foreground hover:bg-primary/10 hover:text-foreground',
                )}
              >
                {active ? (
                  <span
                    aria-hidden
                    className="absolute -left-3 top-1/2 h-5 w-1 -translate-y-1/2 rounded-r-full bg-primary shadow-[0_0_10px] shadow-primary/70"
                  />
                ) : null}
                <Icon className="size-[18px] shrink-0" aria-hidden />
                <span>{item.label}</span>
                {item.view === 'alerts' && unread > 0 ? (
                  <span className="ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-destructive px-1.5 text-[10px] font-bold leading-none text-white">
                    {unread > 99 ? '99+' : unread}
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>
      ))}
    </nav>
  )
}

function HubPill() {
  const hubOnline = useDash((s) => s.hubOnline)
  return (
    <div className="glass-inset flex items-center gap-2 rounded-full px-3 py-2">
      <StatusDot online={hubOnline} />
      <span
        className={cn(
          'text-xs font-medium',
          hubOnline
            ? 'text-emerald-600 dark:text-emerald-400'
            : 'text-zinc-500 dark:text-zinc-400',
        )}
      >
        {hubOnline ? 'Hub online' : 'Hub offline'}
      </span>
    </div>
  )
}

function SidebarFooter() {
  return (
    <div className="mt-auto flex flex-col gap-2">
      <HubPill />
      <p className="text-center text-[11px] text-muted-foreground">
        v0.1.5 • open source
      </p>
    </div>
  )
}

// ──────────────────────────── dashboard shell ───────────────────────

export default function DashboardShell() {
  const view = useDash((s) => s.view)
  const setView = useDash((s) => s.setView)
  const hubOnline = useDash((s) => s.hubOnline)
  const setPaletteOpen = useDash((s) => s.setPaletteOpen)
  const alertSound = useDash((s) => s.alertSound)
  const setAlertSound = useDash((s) => s.setAlertSound)
  const setHelpOpen = useDash((s) => s.setHelpOpen)
  const [navOpen, setNavOpen] = useState(false)
  const { data: devices } = useDevices()

  // Global hotkeys: Alt+1…9/0 switch views, "?" opens the shortcuts dialog.
  // Ignored while typing in inputs or when the command palette is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const typing =
        !!target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      if (typing || useDash.getState().paletteOpen || e.metaKey || e.ctrlKey)
        return
      if (e.altKey) {
        const hit = HOTKEY_VIEWS.find((v) => v.key === e.key)
        if (hit) {
          e.preventDefault()
          useDash.getState().setView(hit.view)
        }
        return
      }
      if (e.key === '?') {
        e.preventDefault()
        setHelpOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setHelpOpen])

  const deviceList = devices ?? []
  const onlineCount = deviceList.filter((d) => d.status === 'online').length
  const ActiveView = VIEWS[view].component

  const navigate = (v: ViewId) => {
    setView(v)
    setNavOpen(false)
  }

  return (
    <div className="flex min-h-screen flex-col">
      <div className="mesh-bg" aria-hidden />
      <Realtime />
      <CommandPalette />
      <ShortcutsDialog />

      {/* Topbar */}
      <header className="glass-strong sticky top-0 z-40 h-14 w-full">
        <div className="flex h-full items-center gap-2 px-3 sm:px-4 lg:pl-[17.5rem] lg:pr-6">
          <Button
            variant="ghost"
            size="icon"
            className="size-11 lg:hidden"
            aria-label="Open navigation menu"
            onClick={() => setNavOpen(true)}
          >
            <Menu className="size-5" aria-hidden />
          </Button>
          <h1 className="truncate text-sm font-semibold tracking-tight sm:text-base">
            {VIEWS[view].label}
          </h1>

          {/* Command palette trigger */}
          <button
            type="button"
            aria-label="Open command palette"
            onClick={() => setPaletteOpen(true)}
            className="glass-inset ml-3 hidden h-9 min-w-0 items-center gap-2 rounded-full px-3.5 text-xs text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground md:flex md:w-56 lg:w-64"
          >
            <Search className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate">Search views & devices…</span>
            <span className="ml-auto flex shrink-0 items-center gap-0.5">
              <Kbd>
                <ModKey />
              </Kbd>
              <Kbd>K</Kbd>
            </span>
          </button>
          <Button
            variant="ghost"
            size="icon"
            className="size-11 md:hidden"
            aria-label="Open command palette"
            onClick={() => setPaletteOpen(true)}
          >
            <Search className="size-[18px]" aria-hidden />
          </Button>

          <div className="ml-auto flex items-center gap-2">
            <div className="glass-inset hidden items-center gap-2 rounded-full px-3 py-1.5 sm:flex">
              <StatusDot online={hubOnline} />
              <span
                className={cn(
                  'text-xs font-medium',
                  hubOnline
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : 'text-zinc-500 dark:text-zinc-400',
                )}
              >
                {hubOnline ? 'Hub online' : 'Hub offline'}
              </span>
            </div>

            <NotificationCenter />

            <Button
              variant="ghost"
              size="icon"
              className="size-11"
              aria-label={alertSound ? 'Mute alert sound' : 'Unmute alert sound'}
              title={alertSound ? 'Alert sound on — click to mute' : 'Alert sound muted — click to enable'}
              onClick={() => setAlertSound(!alertSound)}
            >
              {alertSound ? (
                <Volume2 className="size-[18px] text-emerald-600 dark:text-emerald-400" aria-hidden />
              ) : (
                <VolumeX className="size-[18px] text-zinc-500" aria-hidden />
              )}
            </Button>

            <Button
              variant="ghost"
              size="icon"
              className="hidden size-11 sm:inline-flex"
              aria-label="Keyboard shortcuts"
              title="Keyboard shortcuts (?)"
              onClick={() => setHelpOpen(true)}
            >
              <Keyboard className="size-[18px]" aria-hidden />
            </Button>

            <ThemeToggle />
          </div>
        </div>
      </header>

      {/* Desktop sidebar */}
      <aside className="glass-strong fixed bottom-0 left-0 top-14 z-30 hidden w-64 lg:block">
        <div className="scroll-slim flex h-full flex-col gap-5 overflow-y-auto p-4">
          <Brand />
          <NavList onNavigate={setView} />
          <SidebarFooter />
        </div>
      </aside>

      {/* Mobile sidebar (sheet) */}
      <Sheet open={navOpen} onOpenChange={setNavOpen}>
        <SheetContent side="left" className="glass-strong w-[280px]">
          <SheetTitle className="sr-only">SentraRMM navigation</SheetTitle>
          <SheetDescription className="sr-only">
            Switch between dashboard views
          </SheetDescription>
          <div className="scroll-slim flex h-full flex-col gap-5 overflow-y-auto p-4 pt-8">
            <Brand />
            <NavList onNavigate={navigate} />
            <SidebarFooter />
          </div>
        </SheetContent>
      </Sheet>

      {/* Content column */}
      <div className="flex w-full min-w-0 flex-1 flex-col lg:pl-64">
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          <div
            key={view}
            className="animate-in fade-in slide-in-from-bottom-2 duration-300"
          >
            <ActiveView />
          </div>
        </main>

        {/* Sticky footer */}
        <footer className="mt-auto pb-[env(safe-area-inset-bottom)]">
          <div className="mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8">
            <div className="glass my-4 flex flex-col gap-1.5 rounded-2xl px-4 py-3 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
              <span>SentraRMM — authorized-use remote management console</span>
              <span className="flex flex-wrap items-center gap-1.5">
                <span className="font-semibold text-foreground">
                  {onlineCount}/{deviceList.length}
                </span>
                <span>devices online</span>
                <span className="text-muted-foreground/50" aria-hidden>
                  •
                </span>
                <span
                  className={cn(
                    'font-medium',
                    hubOnline
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : 'text-zinc-500 dark:text-zinc-400',
                  )}
                >
                  hub {hubOnline ? 'online' : 'offline'}
                </span>
                <Badge
                  variant="outline"
                  className="ml-1 hidden border-border/60 bg-background/40 text-[10px] md:inline-flex"
                >
                  {hubOnline ? 'realtime connected' : 'polling'}
                </Badge>
              </span>
            </div>
          </div>
        </footer>
      </div>
    </div>
  )
}
