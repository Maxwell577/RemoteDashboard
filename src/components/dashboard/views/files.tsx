'use client'

import type { ChangeEvent } from 'react'
import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Download,
  EyeOff,
  FileArchive,
  FileCode,
  FileImage,
  FileTerminal,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderTree,
  History,
  Loader2,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
} from 'lucide-react'
import {
  api,
  type FileOperation,
  type FsDownload,
  type FsEntry,
  type FsListing,
} from '@/lib/types'
import { useDash } from '@/lib/store'
import {
  DeviceSelector,
  EmptyState,
  ErrorBlock,
  Panel,
  SectionHeader,
  fmtBytes,
  fmtDate,
  timeAgo,
} from '../shared'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico', 'tif', 'tiff']
const ARCHIVE_EXTS = ['zip', 'rar', '7z', 'tar', 'gz', 'iso', 'cab']
const EXEC_EXTS = ['exe', 'dll', 'bat', 'cmd', 'ps1', 'psm1', 'vbs', 'msi', 'jar']
const CODE_EXTS = [
  'ts', 'tsx', 'js', 'jsx', 'py', 'json', 'html', 'css', 'xml',
  'yml', 'yaml', 'sh', 'c', 'cpp', 'cs', 'java', 'sql',
]

function fileIcon(entry: FsEntry) {
  if (entry.type === 'directory') {
    return <Folder className="h-4 w-4 shrink-0 text-amber-500" />
  }
  const ext = (entry.ext ?? entry.name.split('.').pop() ?? '').toLowerCase()
  if (IMAGE_EXTS.includes(ext)) {
    return <FileImage className="h-4 w-4 shrink-0 text-teal-500" />
  }
  if (ARCHIVE_EXTS.includes(ext)) {
    return <FileArchive className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
  }
  if (EXEC_EXTS.includes(ext)) {
    return <FileTerminal className="h-4 w-4 shrink-0 text-emerald-500" />
  }
  if (CODE_EXTS.includes(ext)) {
    return <FileCode className="h-4 w-4 shrink-0 text-teal-600 dark:text-teal-400" />
  }
  return <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
}

function opBadgeClass(op: FileOperation['op']): string {
  switch (op) {
    case 'upload':
      return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
    case 'download':
    case 'mkdir':
      return 'border-teal-500/30 bg-teal-500/10 text-teal-600 dark:text-teal-400'
    case 'delete':
      return 'border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400'
    case 'rename':
    case 'modify':
      return 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400'
    default:
      return 'border-zinc-500/30 bg-zinc-500/10 text-zinc-600 dark:text-zinc-400'
  }
}

/** "C:\Users\alice" → [{ C: → "C:\" }, { Users → "C:\Users" }] */
function crumbs(path: string): { label: string; path: string }[] {
  const parts = path.split('\\').filter(Boolean)
  const out: { label: string; path: string }[] = []
  let acc = ''
  for (const part of parts) {
    acc = part.endsWith(':') ? `${part}\\` : acc.endsWith('\\') ? `${acc}${part}` : `${acc}\\${part}`
    out.push({ label: part, path: acc })
  }
  return out
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith('\\') ? `${dir}${name}` : `${dir}\\${name}`
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : 'Request failed'
}

export default function Files() {
  const qc = useQueryClient()
  const deviceId = useDash((s) => s.selectedDeviceId)
  const setSelectedDeviceId = useDash((s) => s.setSelectedDeviceId)

  const [path, setPath] = useState('C:\\')
  const [opsOpen, setOpsOpen] = useState(false)
  const [renameTarget, setRenameTarget] = useState<FsEntry | null>(null)
  const [renameName, setRenameName] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<FsEntry | null>(null)
  const [mkdirOpen, setMkdirOpen] = useState(false)
  const [mkdirName, setMkdirName] = useState('')

  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // reset the path when the selected device changes (render-time state adjustment)
  const [prevDeviceId, setPrevDeviceId] = useState<string | null>(deviceId)
  if (prevDeviceId !== deviceId) {
    setPrevDeviceId(deviceId)
    setPath('C:\\')
  }

  const listing = useQuery({
    queryKey: ['files', deviceId, path],
    queryFn: () =>
      api<FsListing>(`/api/files?deviceId=${deviceId}&path=${encodeURIComponent(path)}`),
    enabled: !!deviceId,
    refetchInterval: 20000,
  })

  const ops = useQuery({
    queryKey: ['fileops', deviceId],
    queryFn: () => api<FileOperation[]>(`/api/files/operations?deviceId=${deviceId}&limit=10`),
    enabled: !!deviceId,
    refetchInterval: 30000,
  })

  const invalidateFiles = () => {
    qc.invalidateQueries({ queryKey: ['files'] })
    qc.invalidateQueries({ queryKey: ['fileops'] })
  }

  const uploadMutation = useMutation({
    mutationFn: (v: { name: string; contentBase64: string }) => {
      if (!deviceId) return Promise.reject(new Error('No device selected'))
      return api<Record<string, unknown>>('/api/files/upload', {
        method: 'POST',
        body: JSON.stringify({
          deviceId,
          path,
          name: v.name,
          contentBase64: v.contentBase64,
        }),
      })
    },
    onSuccess: (_d, v) => {
      toast.success(`Uploaded ${v.name}`)
      invalidateFiles()
    },
    onError: (e) => toast.error('Upload failed', { description: errMsg(e) }),
  })

  const downloadMutation = useMutation({
    mutationFn: async (entry: FsEntry) => {
      if (!deviceId) throw new Error('No device selected')
      const data = await api<FsDownload>(
        `/api/files/download?deviceId=${deviceId}&path=${encodeURIComponent(entry.path)}`,
      )
      const bin = atob(data.contentBase64)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      const url = URL.createObjectURL(new Blob([bytes]))
      const a = document.createElement('a')
      a.href = url
      a.download = data.name || entry.name
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      return data
    },
    onSuccess: (data) => {
      toast.success(`Downloaded ${data.name}`, { description: fmtBytes(data.sizeBytes) })
      qc.invalidateQueries({ queryKey: ['fileops'] })
    },
    onError: (e) => toast.error('Download failed', { description: errMsg(e) }),
  })

  const renameMutation = useMutation({
    mutationFn: (v: { path: string; newName: string }) => {
      if (!deviceId) return Promise.reject(new Error('No device selected'))
      return api<Record<string, unknown>>('/api/files/rename', {
        method: 'POST',
        body: JSON.stringify({ deviceId, path: v.path, newName: v.newName }),
      })
    },
    onSuccess: (_d, v) => {
      toast.success('Renamed', { description: `${v.path} → ${v.newName}` })
      setRenameTarget(null)
      invalidateFiles()
    },
    onError: (e) => toast.error('Rename failed', { description: errMsg(e) }),
  })

  const deleteMutation = useMutation({
    mutationFn: (targetPath: string) => {
      if (!deviceId) return Promise.reject(new Error('No device selected'))
      return api<Record<string, unknown>>('/api/files/delete', {
        method: 'POST',
        body: JSON.stringify({ deviceId, path: targetPath }),
      })
    },
    onSuccess: (_d, targetPath) => {
      toast.success('Deleted', { description: targetPath })
      setDeleteTarget(null)
      invalidateFiles()
    },
    onError: (e) => toast.error('Delete failed', { description: errMsg(e) }),
  })

  const mkdirMutation = useMutation({
    mutationFn: (newPath: string) => {
      if (!deviceId) return Promise.reject(new Error('No device selected'))
      return api<Record<string, unknown>>('/api/files/mkdir', {
        method: 'POST',
        body: JSON.stringify({ deviceId, path: newPath }),
      })
    },
    onSuccess: (_d, newPath) => {
      toast.success('Folder created', { description: newPath })
      setMkdirOpen(false)
      setMkdirName('')
      invalidateFiles()
    },
    onError: (e) => toast.error('Create folder failed', { description: errMsg(e) }),
  })

  const onUploadPicked = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || !deviceId) return
    const reader = new FileReader()
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      const base64 = result.includes(',') ? result.slice(result.indexOf(',') + 1) : result
      uploadMutation.mutate({ name: file.name, contentBase64: base64 })
    }
    reader.onerror = () => toast.error('Could not read the selected file')
    reader.readAsDataURL(file)
  }

  const openEntry = (entry: FsEntry) => {
    if (entry.type === 'directory') {
      setPath(entry.path)
    } else if (!downloadMutation.isPending) {
      downloadMutation.mutate(entry)
    }
  }

  const header = (
    <SectionHeader
      title="File explorer"
      subtitle="Browse, transfer and manage files like Windows Explorer"
      icon={<FolderTree className="h-5 w-5" />}
      actions={
        <>
          <Button
            variant="ghost"
            size="icon"
            className="glass-inset h-11 w-11"
            aria-label="Refresh listing"
            onClick={() => {
              listing.refetch()
              ops.refetch()
            }}
          >
            <RefreshCw className={cn('h-4 w-4', listing.isFetching && 'animate-spin')} />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="glass-inset h-11 gap-2"
            disabled={!deviceId || uploadMutation.isPending}
            onClick={() => fileInputRef.current?.click()}
          >
            {uploadMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Upload className="h-4 w-4" />
            )}
            Upload
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="glass-inset h-11 gap-2"
            disabled={!deviceId}
            onClick={() => {
              setMkdirName('')
              setMkdirOpen(true)
            }}
          >
            <FolderPlus className="h-4 w-4" />
            New folder
          </Button>
        </>
      }
    />
  )

  if (!deviceId) {
    return (
      <div className="flex flex-col gap-4">
        {header}
        <EmptyState
          icon={<FolderTree className="h-10 w-10" />}
          title="Select a device to browse files"
          hint="Pick a machine to explore its drives, upload, download and manage files."
        />
      </div>
    )
  }

  const currentDrive = path.slice(0, 3)
  const crumbList = crumbs(listing.data?.path ?? path)
  const parent = listing.data?.parent ?? null
  const drives = listing.data?.drives ?? []
  const entries = listing.data?.entries ?? []

  return (
    <div className="flex flex-col gap-4">
      {header}
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        onChange={onUploadPicked}
        aria-hidden
      />

      {/* top bar: device / drive / breadcrumb / up */}
      <div className="flex flex-wrap items-center gap-2">
        <DeviceSelector
          value={deviceId}
          onChange={setSelectedDeviceId}
          className="sm:w-[240px]"
        />
        {drives.length > 0 && (
          <Select value={currentDrive} onValueChange={(v) => setPath(v)}>
            <SelectTrigger aria-label="Drive" className="h-11 w-[96px] shrink-0 font-mono text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="glass-strong">
              {drives.map((d) => (
                <SelectItem key={d} value={d} className="font-mono text-xs">
                  {d}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <nav
          aria-label="Current path"
          className="glass-inset flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto rounded-md scroll-slim"
        >
          {crumbList.map((c, i) => (
            <span key={c.path} className="flex items-center gap-0.5">
              {i > 0 && <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />}
              <button
                type="button"
                onClick={() => setPath(c.path)}
                className={cn(
                  'min-h-11 rounded-md px-2 py-1 font-mono text-xs transition-colors hover:bg-accent/50',
                  i === crumbList.length - 1
                    ? 'font-semibold text-foreground'
                    : 'text-muted-foreground',
                )}
              >
                {c.label}
              </button>
            </span>
          ))}
        </nav>
        <Button
          variant="ghost"
          size="icon"
          className="glass-inset h-11 w-11 shrink-0"
          aria-label="Go up one directory"
          disabled={!parent}
          onClick={() => parent && setPath(parent)}
        >
          <ArrowUp className="h-4 w-4" />
        </Button>
      </div>

      {/* listing table */}
      <Panel className="overflow-hidden p-0">
        <div className="max-h-[54vh] overflow-y-auto scroll-slim">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Size</TableHead>
                <TableHead>Modified</TableHead>
                <TableHead className="w-16">Hidden</TableHead>
                <TableHead className="pr-3 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {listing.isPending ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <TableRow key={`sk-${i}`}>
                    <TableCell className="pl-4">
                      <Skeleton className="h-4 w-48" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-4 w-14" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-4 w-14" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-4 w-36" />
                    </TableCell>
                    <TableCell />
                    <TableCell />
                  </TableRow>
                ))
              ) : listing.isError ? (
                <TableRow>
                  <TableCell colSpan={6}>
                    <div className="flex flex-col items-center gap-3 py-6">
                      <ErrorBlock message={errMsg(listing.error)} />
                      <Button variant="outline" size="sm" onClick={() => listing.refetch()}>
                        <RefreshCw className="h-4 w-4" />
                        Retry
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ) : entries.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-10 text-center text-sm text-muted-foreground">
                    This directory is empty.
                  </TableCell>
                </TableRow>
              ) : (
                entries.map((entry) => (
                  <TableRow
                    key={entry.path}
                    className="cursor-pointer"
                    onClick={() => openEntry(entry)}
                  >
                    <TableCell className="pl-4">
                      <button
                        type="button"
                        className="flex min-h-11 items-center gap-2 text-left"
                        title={entry.path}
                        onClick={(ev) => {
                          ev.stopPropagation()
                          openEntry(entry)
                        }}
                      >
                        {fileIcon(entry)}
                        <span className="max-w-56 truncate font-medium">{entry.name}</span>
                      </button>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {entry.type === 'directory'
                        ? 'Folder'
                        : (entry.ext ?? '').toUpperCase() || 'File'}
                    </TableCell>
                    <TableCell className="font-mono text-xs tabular-nums">
                      {entry.type === 'directory' ? '—' : fmtBytes(entry.sizeBytes)}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {fmtDate(entry.modifiedAt)}
                    </TableCell>
                    <TableCell>
                      {entry.hidden ? (
                        <EyeOff className="h-3.5 w-3.5 text-muted-foreground" aria-label="Hidden" />
                      ) : null}
                    </TableCell>
                    <TableCell className="pr-3 text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-11 w-11"
                            aria-label={`Actions for ${entry.name}`}
                            onClick={(ev) => ev.stopPropagation()}
                          >
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          className="glass-strong"
                          align="end"
                          onClick={(ev) => ev.stopPropagation()}
                        >
                          {entry.type === 'directory' ? (
                            <DropdownMenuItem onClick={() => setPath(entry.path)}>
                              <FolderOpen className="h-4 w-4" />
                              Open
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem
                              disabled={downloadMutation.isPending}
                              onClick={() => downloadMutation.mutate(entry)}
                            >
                              <Download className="h-4 w-4" />
                              Download
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem
                            onClick={() => {
                              setRenameTarget(entry)
                              setRenameName(entry.name)
                            }}
                          >
                            <Pencil className="h-4 w-4" />
                            Rename
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem variant="destructive" onClick={() => setDeleteTarget(entry)}>
                            <Trash2 className="h-4 w-4" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </Panel>

      {/* recent operations */}
      <Collapsible open={opsOpen} onOpenChange={setOpsOpen}>
        <Panel className="p-0">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex min-h-11 w-full items-center justify-between gap-2 px-4 py-3 text-sm font-medium"
            >
              <span className="flex items-center gap-2">
                <History className="h-4 w-4 text-muted-foreground" />
                Recent operations
                <Badge variant="secondary" className="glass-inset tabular-nums">
                  {ops.data?.length ?? 0}
                </Badge>
              </span>
              <ChevronDown
                className={cn('h-4 w-4 text-muted-foreground transition-transform', opsOpen && 'rotate-180')}
              />
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="max-h-64 overflow-y-auto px-2 pb-2 scroll-slim">
              {ops.isPending ? (
                <div className="flex flex-col gap-2 px-2 pb-2">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <Skeleton key={`opsk-${i}`} className="h-8 w-full" />
                  ))}
                </div>
              ) : (ops.data?.length ?? 0) === 0 ? (
                <p className="px-2 pb-3 text-xs text-muted-foreground">No file operations yet.</p>
              ) : (
                <div className="flex flex-col gap-1">
                  {(ops.data ?? []).map((op) => (
                    <div
                      key={op.id}
                      className="flex flex-wrap items-center gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-accent/40"
                    >
                      <span
                        className={cn(
                          'shrink-0 rounded-md border px-1.5 py-0.5 font-medium uppercase',
                          opBadgeClass(op.op),
                        )}
                      >
                        {op.op}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-mono" title={op.details ?? op.path}>
                        {op.details ?? op.path}
                      </span>
                      {op.sizeBytes != null && (
                        <span className="shrink-0 font-mono tabular-nums text-muted-foreground">
                          {fmtBytes(op.sizeBytes)}
                        </span>
                      )}
                      {op.status === 'failed' && (
                        <span className="shrink-0 text-rose-500 dark:text-rose-400">failed</span>
                      )}
                      <span className="shrink-0 text-muted-foreground">{timeAgo(op.createdAt)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </CollapsibleContent>
        </Panel>
      </Collapsible>

      {/* rename dialog */}
      <Dialog
        open={!!renameTarget}
        onOpenChange={(open) => {
          if (!open) setRenameTarget(null)
        }}
      >
        <DialogContent className="glass-strong sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Rename</DialogTitle>
            <DialogDescription className="break-all font-mono text-xs">
              {renameTarget?.path}
            </DialogDescription>
          </DialogHeader>
          <Input
            value={renameName}
            onChange={(e) => setRenameName(e.target.value)}
            placeholder="New name"
            className="h-11 font-mono"
            aria-label="New name"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && renameName.trim() && !renameMutation.isPending) {
                renameMutation.mutate({ path: renameTarget?.path ?? '', newName: renameName.trim() })
              }
            }}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRenameTarget(null)}>
              Cancel
            </Button>
            <Button
              className="bg-primary"
              disabled={!renameName.trim() || renameMutation.isPending}
              onClick={() => {
                if (renameTarget && renameName.trim()) {
                  renameMutation.mutate({ path: renameTarget.path, newName: renameName.trim() })
                }
              }}
            >
              {renameMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Pencil className="h-4 w-4" />
              )}
              Rename
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* new folder dialog */}
      <Dialog open={mkdirOpen} onOpenChange={setMkdirOpen}>
        <DialogContent className="glass-strong sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New folder</DialogTitle>
            <DialogDescription className="break-all font-mono text-xs">
              {path}
            </DialogDescription>
          </DialogHeader>
          <Input
            value={mkdirName}
            onChange={(e) => setMkdirName(e.target.value)}
            placeholder="Folder name"
            className="h-11 font-mono"
            aria-label="Folder name"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && mkdirName.trim() && !mkdirMutation.isPending) {
                mkdirMutation.mutate(joinPath(path, mkdirName.trim()))
              }
            }}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setMkdirOpen(false)}>
              Cancel
            </Button>
            <Button
              className="bg-primary"
              disabled={!mkdirName.trim() || mkdirMutation.isPending}
              onClick={() => mkdirName.trim() && mkdirMutation.mutate(joinPath(path, mkdirName.trim()))}
            >
              {mkdirMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <FolderPlus className="h-4 w-4" />
              )}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* delete confirm */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
      >
        <AlertDialogContent className="glass-strong">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleteTarget?.name}”?</AlertDialogTitle>
            <AlertDialogDescription className="break-all font-mono text-xs">
              {deleteTarget?.path}
            </AlertDialogDescription>
            <AlertDialogDescription>
              This permanently removes the item on the remote device. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault()
                if (deleteTarget) deleteMutation.mutate(deleteTarget.path)
              }}
            >
              {deleteMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
