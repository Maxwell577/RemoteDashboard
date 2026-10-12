'use client'

import {
  Bell,
  Clapperboard,
  Cpu,
  Disc3,
  FolderTree,
  LayoutDashboard,
  MapPin,
  MonitorSmartphone,
  RadioTower,
  ScrollText,
  Settings as SettingsIcon,
  SquareTerminal,
  type LucideIcon,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useDash, type ViewId } from '@/lib/store'
import { Kbd, ModKey } from './kbd'

/** Flat view order used for Alt+1…Alt+9 / Alt+0 hotkeys (index 0-9). */
export const HOTKEY_VIEWS: {
  view: ViewId
  key: string
  label: string
  icon: LucideIcon
}[] = [
  { view: 'overview', key: '1', label: 'Overview', icon: LayoutDashboard },
  { view: 'devices', key: '2', label: 'Devices', icon: MonitorSmartphone },
  { view: 'terminal', key: '3', label: 'Terminal', icon: SquareTerminal },
  { view: 'files', key: '4', label: 'Files', icon: FolderTree },
  { view: 'processes', key: '5', label: 'Processes', icon: Cpu },
  { view: 'media', key: '6', label: 'Streams', icon: Clapperboard },
  { view: 'network', key: '7', label: 'Network', icon: RadioTower },
  { view: 'location', key: '8', label: 'Location', icon: MapPin },
  { view: 'alerts', key: '9', label: 'Alerts', icon: Bell },
  { view: 'audit', key: '0', label: 'Audit log', icon: ScrollText },
]

function Row({ keys, label }: { keys: React.ReactNode[]; label: string }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="flex shrink-0 items-center gap-1">
        {keys.map((k, i) => (
          <Kbd key={i}>{k}</Kbd>
        ))}
      </span>
    </div>
  )
}

export default function ShortcutsDialog() {
  const open = useDash((s) => s.helpOpen)
  const setOpen = useDash((s) => s.setHelpOpen)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="glass-strong scroll-slim max-h-[85vh] overflow-y-auto rounded-2xl sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Work faster without leaving the keyboard.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <section>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/70">
              General
            </p>
            <div className="glass-inset divide-y divide-border/40 rounded-xl px-3">
              <Row
                label="Command palette"
                keys={[<ModKey key="mod" />, <span key="k">K</span>]}
              />
              <Row label="This help dialog" keys={['?']} />
              <Row label="Close dialogs / palette" keys={['Esc']} />
            </div>
          </section>

          <section>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/70">
              Navigate views
            </p>
            <div className="glass-inset grid grid-cols-1 gap-x-4 px-3 sm:grid-cols-2">
              {HOTKEY_VIEWS.map((v) => {
                const Icon = v.icon
                return (
                  <div
                    key={v.view}
                    className="flex items-center justify-between gap-2 py-1.5"
                  >
                    <span className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
                      <Icon className="size-3.5 shrink-0" aria-hidden />
                      <span className="truncate">{v.label}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1">
                      <Kbd>
                        Alt
                      </Kbd>
                      <Kbd>{v.key}</Kbd>
                    </span>
                  </div>
                )
              })}
              <div className="flex items-center justify-between gap-2 py-1.5">
                <span className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
                  <Disc3 className="size-3.5 shrink-0" aria-hidden />
                  <span className="truncate">Recordings</span>
                </span>
                <span className="text-[10px] text-muted-foreground/60">via palette</span>
              </div>
              <div className="flex items-center justify-between gap-2 py-1.5">
                <span className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
                  <SettingsIcon className="size-3.5 shrink-0" aria-hidden />
                  <span className="truncate">Settings</span>
                </span>
                <span className="text-[10px] text-muted-foreground/60">
                  via palette
                </span>
              </div>
            </div>
          </section>

          <section>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/70">
              Terminal
            </p>
            <div className="glass-inset divide-y divide-border/40 rounded-xl px-3">
              <Row label="Run command" keys={[<span key="e">Enter</span>]} />
              <Row
                label="Recall history"
                keys={[<span key="u">↑</span>, <span key="d">↓</span>]}
              />
            </div>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  )
}
