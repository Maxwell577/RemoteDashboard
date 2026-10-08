'use client'

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Download, ScrollText } from 'lucide-react'
import { api, type AuditLog } from '@/lib/types'
import { useDash } from '@/lib/store'
import { cn } from '@/lib/utils'
import {
  DeviceSelector,
  EmptyState,
  ErrorBlock,
  LoadingBlock,
  Panel,
  SectionHeader,
  fmtDate,
  timeAgo,
  useDevices,
} from '../shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

type SeverityFilter = 'all' | AuditLog['severity']
type LimitOption = '50' | '100' | '200'

function actionBadgeClass(action: string): string {
  if (action.startsWith('command.'))
    return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
  if (action.startsWith('file.'))
    return 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400'
  if (action.startsWith('network.'))
    return 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400'
  if (action.startsWith('media.') || action.startsWith('location.'))
    return 'border-teal-500/30 bg-teal-500/10 text-teal-600 dark:text-teal-400'
  if (action.startsWith('device.'))
    return 'border-zinc-500/30 bg-zinc-500/10 text-zinc-600 dark:text-zinc-400'
  return 'border-border bg-secondary text-secondary-foreground'
}

function severityBadgeClass(severity: AuditLog['severity']): string {
  switch (severity) {
    case 'critical':
      return 'border-rose-500/30 bg-rose-500/15 text-rose-600 dark:text-rose-400'
    case 'warning':
      return 'border-amber-500/30 bg-amber-500/15 text-amber-600 dark:text-amber-400'
    case 'info':
      return 'border-zinc-500/30 bg-zinc-500/15 text-zinc-600 dark:text-zinc-400'
  }
}

function csvEscape(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

export default function AuditView() {
  const selectedDeviceId = useDash((s) => s.selectedDeviceId)
  const setSelectedDeviceId = useDash((s) => s.setSelectedDeviceId)
  const { data: devices } = useDevices()

  const [severity, setSeverity] = useState<SeverityFilter>('all')
  const [limit, setLimit] = useState<LimitOption>('100')

  const auditQuery = useQuery({
    queryKey: ['audit', selectedDeviceId, severity, limit],
    queryFn: () =>
      api<AuditLog[]>(
        `/api/audit?limit=${limit}${
          selectedDeviceId ? `&deviceId=${encodeURIComponent(selectedDeviceId)}` : ''
        }`
      ),
    refetchInterval: 30_000,
  })

  const hostById = useMemo(
    () => new Map((devices ?? []).map((d) => [d.id, d.hostname])),
    [devices]
  )

  // severity is filtered client-side (API contract has no severity param)
  const rows = useMemo(() => {
    const all = auditQuery.data ?? []
    return severity === 'all' ? all : all.filter((r) => r.severity === severity)
  }, [auditQuery.data, severity])

  function exportCsv() {
    if (rows.length === 0) {
      toast.info('Nothing to export')
      return
    }
    const header = ['time', 'actor', 'action', 'severity', 'device', 'detail']
    const lines = [
      header.join(','),
      ...rows.map((r) =>
        [
          r.createdAt,
          r.actor,
          r.action,
          r.severity,
          r.deviceId ? (hostById.get(r.deviceId) ?? r.deviceId) : '',
          r.detail ?? '',
        ]
          .map(csvEscape)
          .join(',')
      ),
    ]
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'audit-log.csv'
    a.click()
    URL.revokeObjectURL(url)
    toast.success(`Exported ${rows.length} audit entries`, {
      description: 'audit-log.csv',
    })
  }

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader
        title="Audit log"
        subtitle="Every action taken through this console"
        icon={<ScrollText className="h-5 w-5" />}
        actions={
          <>
            <DeviceSelector value={selectedDeviceId} onChange={setSelectedDeviceId} />
            <Select value={severity} onValueChange={(v) => setSeverity(v as SeverityFilter)}>
              <SelectTrigger className="w-[120px]" aria-label="Severity filter">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="glass-strong">
                <SelectItem value="all">All severities</SelectItem>
                <SelectItem value="info">Info</SelectItem>
                <SelectItem value="warning">Warning</SelectItem>
                <SelectItem value="critical">Critical</SelectItem>
              </SelectContent>
            </Select>
            <Select value={limit} onValueChange={(v) => setLimit(v as LimitOption)}>
              <SelectTrigger className="w-[100px]" aria-label="Row limit">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="glass-strong">
                <SelectItem value="50">50 rows</SelectItem>
                <SelectItem value="100">100 rows</SelectItem>
                <SelectItem value="200">200 rows</SelectItem>
              </SelectContent>
            </Select>
            <Button size="sm" variant="outline" className="h-11 md:h-9" onClick={exportCsv}>
              <Download className="h-4 w-4" /> CSV
            </Button>
          </>
        }
      />

      <Panel className="glass-hover p-4 sm:p-6">
        {auditQuery.isLoading ? (
          <LoadingBlock label="Loading audit trail…" />
        ) : auditQuery.isError ? (
          <ErrorBlock
            message={
              auditQuery.error instanceof Error ? auditQuery.error.message : 'Failed to load audit log'
            }
          />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<ScrollText className="h-8 w-8" />}
            title="No audit entries"
            hint="Actions you take through the console will appear here."
          />
        ) : (
          <div className="max-h-[60vh] overflow-auto scroll-slim">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Detail</TableHead>
                  <TableHead>Device</TableHead>
                  <TableHead>Severity</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id} className="glass-hover">
                    <TableCell className="whitespace-nowrap font-mono text-xs" title={timeAgo(r.createdAt)}>
                      {fmtDate(r.createdAt)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs">{r.actor}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className={cn('font-mono text-[11px]', actionBadgeClass(r.action))}>
                        {r.action}
                      </Badge>
                    </TableCell>
                    <TableCell className="max-w-xs">
                      <span className="block truncate text-xs text-muted-foreground" title={r.detail ?? ''}>
                        {r.detail ?? '—'}
                      </span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs">
                      {r.deviceId ? (hostById.get(r.deviceId) ?? r.deviceId.slice(0, 10)) : '—'}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={cn('text-[10px]', severityBadgeClass(r.severity))}>
                        {r.severity}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Panel>
    </div>
  )
}
