'use client'

import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Eraser, History, Loader2, Play, SquareTerminal, TriangleAlert } from 'lucide-react'
import { api, type CommandExecution, type SavedCommand } from '@/lib/types'
import { useDash } from '@/lib/store'
import {
  DeviceSelector,
  Panel,
  SectionHeader,
  StatusDot,
  timeAgo,
  useDevices,
} from '../shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

const QUICK_COMMANDS = [
  'sysinfo',
  'ipconfig /all',
  'Get-Process',
  'whoami /priv',
  'netstat -an',
  'Get-Volume',
  'qwinsta',
] as const

interface TerminalEntry {
  id: string
  command: string
  at: string
  status: 'running' | 'completed' | 'failed'
  output: string | null
  exitCode: number | null
  durationMs: number | null
}

function uid(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `e${Date.now()}${Math.random().toString(36).slice(2)}`
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : 'Request failed'
}

export default function Terminal() {
  const selectedDeviceId = useDash((s) => s.selectedDeviceId)
  const setSelectedDeviceId = useDash((s) => s.setSelectedDeviceId)
  const { data: devices } = useDevices()
  const device = devices?.find((d) => d.id === selectedDeviceId) ?? null
  const online = device?.status === 'online'

  const [input, setInput] = useState('')
  const [entries, setEntries] = useState<TerminalEntry[]>([])
  const [history, setHistory] = useState<string[]>([])
  const [histIdx, setHistIdx] = useState<number | null>(null)

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const saved = useQuery({
    queryKey: ['saved-commands'],
    queryFn: () => api<SavedCommand[]>('/api/saved-commands'),
  })

  // auto-scroll output to the bottom on new entries
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [entries])

  const runCmd = useMutation({
    mutationFn: async (v: { deviceId: string; command: string; entryId: string }) =>
      api<CommandExecution>('/api/commands', {
        method: 'POST',
        body: JSON.stringify({ deviceId: v.deviceId, command: v.command }),
      }),
    onSuccess: (data, v) => {
      const failed = data.status === 'failed' || data.status === 'timeout'
      setEntries((prev) =>
        prev.map((e) =>
          e.id === v.entryId
            ? {
                ...e,
                status: failed ? 'failed' : 'completed',
                output: data.output,
                exitCode: data.exitCode,
                durationMs: data.durationMs,
              }
            : e,
        ),
      )
      if (failed) {
        toast.error(`Command failed on ${device?.hostname ?? 'device'}`, {
          description: data.output?.slice(0, 200) || undefined,
        })
      }
    },
    onError: (error, v) => {
      const msg = errMsg(error)
      setEntries((prev) =>
        prev.map((e) => (e.id === v.entryId ? { ...e, status: 'failed', output: msg } : e)),
      )
      toast.error('Command failed', { description: msg })
    },
  })

  const submit = () => {
    const cmd = input.trim()
    if (!cmd || !selectedDeviceId || runCmd.isPending) return
    const id = uid()
    setEntries((prev) => [
      ...prev,
      {
        id,
        command: cmd,
        at: new Date().toISOString(),
        status: 'running',
        output: null,
        exitCode: null,
        durationMs: null,
      },
    ])
    setHistory((prev) => [...prev.slice(-49), cmd])
    setHistIdx(null)
    setInput('')
    runCmd.mutate({ deviceId: selectedDeviceId, command: cmd, entryId: id })
  }

  const recall = (dir: 1 | -1) => {
    if (history.length === 0) return
    if (dir === -1) {
      const next = histIdx === null ? history.length - 1 : Math.max(0, histIdx - 1)
      setHistIdx(next)
      setInput(history[next] ?? '')
      return
    }
    if (histIdx === null) return
    const next = histIdx + 1
    if (next >= history.length) {
      setHistIdx(null)
      setInput('')
    } else {
      setHistIdx(next)
      setInput(history[next] ?? '')
    }
  }

  const insertCommand = (cmd: string) => {
    setInput(cmd)
    inputRef.current?.focus()
  }

  // persisted execution history for this device (server-side)
  const cmdHistory = useQuery({
    queryKey: ['commands', selectedDeviceId],
    queryFn: () =>
      api<CommandExecution[]>(
        `/api/commands?deviceId=${encodeURIComponent(selectedDeviceId ?? '')}&limit=12`
      ),
    enabled: Boolean(selectedDeviceId),
    refetchInterval: 20000,
  })
  const [showHistory, setShowHistory] = useState(false)

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader
        title="Command console"
        subtitle="Execute PowerShell commands on a selected device"
        icon={<SquareTerminal className="h-5 w-5" />}
        actions={
          <>
            <Badge
              variant="secondary"
              className="glass-inset gap-1 tabular-nums"
              title="Commands executed this session"
            >
              <History className="h-3 w-3" />
              {history.length}
            </Badge>
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                'glass-inset h-11 gap-2',
                showHistory && 'border-primary/30 bg-primary/10 text-primary'
              )}
              disabled={!selectedDeviceId}
              aria-expanded={showHistory}
              onClick={() => setShowHistory((v) => !v)}
            >
              <History className="h-4 w-4" />
              History
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="glass-inset h-11 gap-2"
              disabled={entries.length === 0}
              onClick={() => {
                setEntries([])
                setHistIdx(null)
              }}
            >
              <Eraser className="h-4 w-4" />
              Clear
            </Button>
          </>
        }
      />

      {showHistory ? (
        <Panel className="p-3">
          <div className="mb-2 flex items-center justify-between px-1">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Recent executions on this device
            </p>
            <span className="text-[11px] text-muted-foreground">
              click a row to load it into the prompt
            </span>
          </div>
          {cmdHistory.isPending ? (
            <p className="px-1 py-3 text-xs text-muted-foreground">Loading history…</p>
          ) : (cmdHistory.data?.length ?? 0) === 0 ? (
            <p className="px-1 py-3 text-xs text-muted-foreground">
              No persisted executions yet.
            </p>
          ) : (
            <div className="scroll-slim max-h-52 divide-y overflow-y-auto rounded-xl">
              {(cmdHistory.data ?? []).map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => insertCommand(c.command)}
                  className="glass-inset flex min-h-11 w-full items-center gap-3 px-3 py-2 text-left transition-colors first:rounded-t-xl last:rounded-b-xl hover:bg-accent/50"
                >
                  <span
                    className={cn(
                      'inline-block size-2 shrink-0 rounded-full',
                      c.status === 'completed' && 'bg-emerald-500',
                      c.status === 'failed' && 'bg-rose-500',
                      c.status === 'timeout' && 'bg-amber-500',
                      (c.status === 'pending' || c.status === 'running') && 'animate-pulse bg-teal-500'
                    )}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs" title={c.command}>
                    {c.command}
                  </span>
                  <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                    exit {c.exitCode ?? '—'} · {c.durationMs ?? '—'}ms · {timeAgo(c.createdAt)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </Panel>
      ) : null}

      <div className="flex flex-col gap-4 lg:flex-row">
        {/* left column — device + quick/saved commands (always visible) */}
        <Panel className="flex w-full flex-col gap-4 p-4 lg:w-72 lg:shrink-0">
          <div className="flex flex-col gap-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Device
            </p>
            <DeviceSelector value={selectedDeviceId} onChange={setSelectedDeviceId} className="sm:w-full" />
          </div>

          <div className="flex flex-col gap-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Quick commands
            </p>
            <div className="flex flex-col gap-1.5">
              {QUICK_COMMANDS.map((cmd) => (
                <Button
                  key={cmd}
                  variant="ghost"
                  size="sm"
                  title={cmd}
                  className="glass-inset h-11 w-full justify-start text-left font-mono text-xs"
                  onClick={() => insertCommand(cmd)}
                >
                  {cmd}
                </Button>
              ))}
            </div>
          </div>

            <div className="flex flex-col gap-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Saved commands
              </p>
              {saved.isPending ? (
                <p className="text-xs text-muted-foreground">Loading…</p>
              ) : (saved.data?.length ?? 0) === 0 ? (
                <p className="text-xs text-muted-foreground">No saved commands yet</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {(saved.data ?? []).map((sc) => (
                    <button
                      key={sc.id}
                      type="button"
                      title={sc.command}
                      onClick={() => insertCommand(sc.command)}
                      className="glass-inset min-h-11 rounded-full px-3 text-xs font-medium transition-colors hover:bg-accent/50"
                    >
                      {sc.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </Panel>

          {/* right column — terminal */}
          <Panel className="flex min-w-0 flex-1 flex-col overflow-hidden p-0">
            <div className="terminal-glass flex items-center justify-between gap-2 px-4 py-2">
              <span className="truncate font-mono text-xs text-emerald-300">
                PS &gt; {device?.hostname ?? 'no device'}
              </span>
              <span className="flex shrink-0 items-center gap-2 text-xs text-zinc-400">
                <StatusDot online={online} />
                {online ? 'connected' : 'offline'}
              </span>
            </div>

            {!online && (
              <div className="flex items-center gap-2 border-b border-amber-500/20 bg-amber-500/10 px-4 py-2.5 text-xs text-amber-600 dark:text-amber-400">
                <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
                Device is offline — commands will fail until it reconnects
              </div>
            )}

            <div
              ref={scrollRef}
              className="terminal-glass scroll-slim h-[52vh] overflow-y-auto p-4 font-mono text-[13px] leading-relaxed"
            >
              {entries.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
                  <p className="text-sm text-zinc-400">
                    Connected to hub — select a device and run a command.
                  </p>
                  <span className="inline-block h-4 w-2 animate-pulse bg-emerald-400" aria-hidden />
                </div>
              ) : (
                <div className="flex flex-col gap-4">
                  {entries.map((e) => (
                    <div key={e.id} className="flex flex-col gap-1">
                      <p className="font-semibold text-emerald-300">PS C:\&gt; {e.command}</p>
                      {e.status === 'running' ? (
                        <p className="flex items-center gap-2 text-zinc-400">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          running…
                        </p>
                      ) : (
                        <p
                          className={cn(
                            'whitespace-pre-wrap',
                            e.status === 'failed' ? 'text-rose-300' : 'text-zinc-200',
                          )}
                        >
                          {e.output || '(no output)'}
                        </p>
                      )}
                      {e.status !== 'running' && (
                        <p className="text-[11px] text-zinc-500">
                          exit {e.exitCode ?? '—'} • {e.durationMs ?? '—'}ms • {timeAgo(e.at)}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="terminal-glass flex items-center gap-2 border-t border-white/5 p-3">
              <Input
                ref={inputRef}
                value={input}
                onChange={(ev) => setInput(ev.target.value)}
                onKeyDown={(ev) => {
                  if (ev.key === 'Enter') {
                    ev.preventDefault()
                    submit()
                  } else if (ev.key === 'ArrowUp') {
                    ev.preventDefault()
                    recall(-1)
                  } else if (ev.key === 'ArrowDown') {
                    ev.preventDefault()
                    recall(1)
                  }
                }}
                placeholder="e.g. Get-Process | Select-Object -First 10"
                className="h-11 min-w-0 flex-1 border-white/10 bg-white/5 font-mono text-[13px] text-zinc-100 placeholder:text-zinc-500"
                disabled={!selectedDeviceId}
                spellCheck={false}
                autoComplete="off"
                aria-label="PowerShell command"
              />
              <Button
                size="sm"
                className="h-11 shrink-0 gap-2 bg-primary px-4"
                disabled={!selectedDeviceId || runCmd.isPending || input.trim().length === 0}
                onClick={submit}
              >
                {runCmd.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Play className="h-4 w-4" />
                )}
                Run
              </Button>
            </div>
          </Panel>
      </div>
    </div>
  )
}
