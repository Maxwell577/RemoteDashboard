'use client'

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Copy, Plus, ScrollText, SquareTerminal, Trash2 } from 'lucide-react'
import { api, type SavedCommand } from '@/lib/types'
import { Panel, timeAgo } from '../shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/**
 * Saved Commands manager — create / browse / delete reusable PowerShell
 * snippets that appear as one-click chips in the Terminal view.
 */
export default function SavedCommands() {
  const qc = useQueryClient()
  const { data: commands, isPending } = useQuery({
    queryKey: ['saved-commands'],
    queryFn: () => api<SavedCommand[]>('/api/saved-commands'),
  })

  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [description, setDescription] = useState('')
  const [category, setCategory] = useState('general')

  const reset = () => {
    setName('')
    setCommand('')
    setDescription('')
    setCategory('general')
  }

  const create = useMutation({
    mutationFn: () =>
      api<SavedCommand>('/api/saved-commands', {
        method: 'POST',
        body: JSON.stringify({ name, command, description: description || undefined, category }),
      }),
    onSuccess: (sc) => {
      toast.success(`Saved "${sc.name}" — available in the Terminal`)
      qc.invalidateQueries({ queryKey: ['saved-commands'] })
      setOpen(false)
      reset()
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Failed to save command'),
  })

  const remove = useMutation({
    mutationFn: (id: string) => api<{ ok: true }>(`/api/saved-commands/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('Command deleted')
      qc.invalidateQueries({ queryKey: ['saved-commands'] })
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Failed to delete command'),
  })

  const copy = async (sc: SavedCommand) => {
    try {
      await navigator.clipboard.writeText(sc.command)
      toast.success('Command copied to clipboard')
    } catch {
      toast.error('Clipboard unavailable')
    }
  }

  const canSave = name.trim().length > 0 && command.trim().length > 0

  return (
    <Panel className="glass-hover p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="glass-inset flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-primary">
            <ScrollText className="h-5 w-5" />
          </div>
          <div>
            <h3 className="font-semibold leading-tight">Saved commands</h3>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Reusable snippets shown as one-click chips in the Terminal.
            </p>
          </div>
        </div>
        <Button size="sm" className="h-11 gap-2 bg-primary md:h-9" onClick={() => setOpen(true)}>
          <Plus className="h-4 w-4" />
          New command
        </Button>
      </div>

      <div className="scroll-slim mt-4 max-h-64 space-y-2 overflow-y-auto pr-1">
        {isPending ? (
          <p className="py-3 text-sm text-muted-foreground">Loading…</p>
        ) : (commands?.length ?? 0) === 0 ? (
          <p className="glass-inset rounded-xl px-4 py-6 text-center text-sm text-muted-foreground">
            No saved commands yet — create one and it will light up in the Terminal instantly.
          </p>
        ) : (
          (commands ?? []).map((sc) => (
            <div
              key={sc.id}
              className="glass-inset group flex min-h-11 items-center gap-3 rounded-xl px-3 py-2"
            >
              <SquareTerminal className="size-4 shrink-0 text-primary" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{sc.name}</p>
                <p className="truncate font-mono text-[11px] text-muted-foreground" title={sc.command}>
                  {sc.command}
                </p>
              </div>
              <Badge variant="secondary" className="hidden shrink-0 text-[10px] sm:inline-flex">
                {sc.category}
              </Badge>
              <span className="hidden shrink-0 text-[11px] text-muted-foreground lg:inline">
                {timeAgo(sc.createdAt)}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="size-8 shrink-0"
                aria-label={`Copy ${sc.name}`}
                onClick={() => copy(sc)}
              >
                <Copy className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-8 shrink-0 text-destructive hover:text-destructive"
                aria-label={`Delete ${sc.name}`}
                disabled={remove.isPending}
                onClick={() => remove.mutate(sc.id)}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))
        )}
      </div>

      <Dialog
        open={open}
        onOpenChange={(v) => {
          setOpen(v)
          if (!v) reset()
        }}
      >
        <DialogContent className="glass-strong sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New saved command</DialogTitle>
            <DialogDescription>
              Store a PowerShell snippet for one-click execution from the Terminal.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-1">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="sc-name" className="text-xs uppercase tracking-wide text-muted-foreground">
                Name
              </Label>
              <Input
                id="sc-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Disk usage summary"
                className="h-11"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label
                htmlFor="sc-command"
                className="text-xs uppercase tracking-wide text-muted-foreground"
              >
                Command
              </Label>
              <Input
                id="sc-command"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="e.g. Get-PSDrive -PSProvider FileSystem"
                className="h-11 font-mono text-xs"
                spellCheck={false}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label
                htmlFor="sc-desc"
                className="text-xs uppercase tracking-wide text-muted-foreground"
              >
                Description (optional)
              </Label>
              <Input
                id="sc-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What does it do?"
                className="h-11"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label
                htmlFor="sc-cat"
                className="text-xs uppercase tracking-wide text-muted-foreground"
              >
                Category
              </Label>
              <Input
                id="sc-cat"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="general / diagnostics / security"
                className="h-11"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              className="bg-primary"
              disabled={!canSave || create.isPending}
              onClick={() => create.mutate()}
            >
              {create.isPending ? 'Saving…' : 'Save command'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Panel>
  )
}
