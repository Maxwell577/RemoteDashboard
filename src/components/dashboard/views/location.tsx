'use client'

import { useMemo } from 'react'
import dynamic from 'next/dynamic'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Loader2, LocateFixed, MapPin } from 'lucide-react'
import { api, type Device, type LocationPing } from '@/lib/types'
import { useDash } from '@/lib/store'
import { cn } from '@/lib/utils'
import {
  EmptyState,
  ErrorBlock,
  LoadingBlock,
  Panel,
  SectionHeader,
  StatusDot,
  timeAgo,
  useDevices,
} from '../shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

// react-leaflet touches window — CSR only
const DeviceMap = dynamic(() => import('./location-map'), {
  ssr: false,
  loading: () => (
    <div className="glass-inset flex h-[420px] w-full items-center justify-center rounded-xl">
      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      <span className="ml-2 text-sm text-muted-foreground">Loading map…</span>
    </div>
  ),
})

function sourceBadgeClass(source: LocationPing['source']): string {
  switch (source) {
    case 'gps':
      return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
    case 'wifi':
      return 'border-teal-500/30 bg-teal-500/10 text-teal-600 dark:text-teal-400'
    case 'ip':
      return 'border-zinc-500/30 bg-zinc-500/10 text-zinc-600 dark:text-zinc-400'
  }
}

export default function LocationView() {
  const qc = useQueryClient()
  const selectedDeviceId = useDash((s) => s.selectedDeviceId)
  const setSelectedDeviceId = useDash((s) => s.setSelectedDeviceId)
  const devicesQuery = useDevices()

  const devices = devicesQuery.data ?? []
  const hasAnyDevice = devices.length > 0

  const locationQuery = useQuery({
    queryKey: ['location', selectedDeviceId],
    queryFn: () =>
      api<{ device: Device; pings: LocationPing[] }>(
        `/api/location?deviceId=${encodeURIComponent(String(selectedDeviceId))}`
      ),
    enabled: !!selectedDeviceId,
    refetchInterval: 30_000,
  })

  const pingFix = useMutation({
    mutationFn: () =>
      api<LocationPing>('/api/location/ping', {
        method: 'POST',
        body: JSON.stringify({ deviceId: selectedDeviceId }),
      }),
    onSuccess: (p) => {
      qc.invalidateQueries({ queryKey: ['location'] })
      toast.success('Fresh location fix received', {
        description: `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)} • ±${p.accuracyM ?? '?'} m • ${p.label ?? p.source}`,
      })
    },
    onError: (e) =>
      toast.error('Location fix failed', {
        description: e instanceof Error ? e.message : 'Unknown error',
      }),
  })

  const pings = locationQuery.data?.pings ?? []

  // latest accuracy per device (from selected device's trail only)
  const selectedAccuracy = useMemo(() => {
    if (!selectedDeviceId || pings.length === 0) return null
    const sorted = [...pings].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )
    return sorted[0]?.accuracyM ?? null
  }, [pings, selectedDeviceId])

  const devicesWithFix = useMemo(
    () => devices.filter((d) => d.locationLat != null && d.locationLon != null),
    [devices]
  )

  if (devicesQuery.isLoading) {
    return (
      <div className="flex flex-col gap-4">
        <SectionHeader
          title="Device location"
          subtitle="IP-based geolocation of your fleet"
          icon={<MapPin className="h-5 w-5" />}
        />
        <LoadingBlock label="Loading fleet…" />
      </div>
    )
  }

  if (devicesQuery.isError) {
    return (
      <div className="flex flex-col gap-4">
        <SectionHeader
          title="Device location"
          subtitle="IP-based geolocation of your fleet"
          icon={<MapPin className="h-5 w-5" />}
        />
        <ErrorBlock
          message={
            devicesQuery.error instanceof Error ? devicesQuery.error.message : 'Failed to load devices'
          }
        />
      </div>
    )
  }

  if (!hasAnyDevice) {
    return (
      <div className="flex flex-col gap-4">
        <SectionHeader
          title="Device location"
          subtitle="IP-based geolocation of your fleet"
          icon={<MapPin className="h-5 w-5" />}
        />
        <EmptyState
          icon={<MapPin className="h-10 w-10" />}
          title="No location data yet"
          hint="Enroll an agent or wait for the next heartbeat to see devices on the map."
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader
        title="Device location"
        subtitle="IP-based geolocation of your fleet"
        icon={<MapPin className="h-5 w-5" />}
        actions={
          <Button
            className="h-11 md:h-9"
            disabled={!selectedDeviceId || pingFix.isPending}
            onClick={() => {
              if (!selectedDeviceId) {
                toast.warning('Select a device first')
                return
              }
              pingFix.mutate()
            }}
          >
            {pingFix.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <LocateFixed className="h-4 w-4" />
            )}
            Request fresh fix
          </Button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        {/* map */}
        <Panel className="glass-hover overflow-hidden p-4 lg:col-span-2">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h3 className="font-semibold">Fleet map</h3>
            <span className="text-xs text-muted-foreground">
              {devicesWithFix.length} of {devices.length} device{devices.length === 1 ? '' : 's'} with a fix
            </span>
          </div>
          <DeviceMap devices={devices} pings={pings} />
        </Panel>

        {/* devices + fix history */}
        <div className="flex flex-col gap-4">
          <Panel className="glass-hover p-4">
            <h3 className="font-semibold">Devices</h3>
            <div className="mt-3 flex max-h-64 flex-col gap-1.5 overflow-y-auto scroll-slim">
              {devices.map((d) => {
                const isSel = d.id === selectedDeviceId
                return (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => setSelectedDeviceId(d.id)}
                    className={cn(
                      'glass-inset glass-hover flex min-h-11 items-center gap-2 rounded-xl px-3 py-2 text-left',
                      isSel && 'border-primary/40 ring-1 ring-primary/30'
                    )}
                  >
                    <StatusDot online={d.status === 'online'} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{d.hostname}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {d.locationLabel ?? d.friendlyName ?? d.osName}
                      </p>
                    </div>
                    {d.id === selectedDeviceId && selectedAccuracy != null ? (
                      <Badge variant="outline" className="text-[10px]">
                        ±{Math.round(selectedAccuracy)} m
                      </Badge>
                    ) : d.locationLat != null ? (
                      <Badge
                        variant="outline"
                        className="border-emerald-500/30 bg-emerald-500/10 text-[10px] text-emerald-600 dark:text-emerald-400"
                      >
                        fixed
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-[10px] text-muted-foreground">
                        no fix
                      </Badge>
                    )}
                  </button>
                )
              })}
            </div>
          </Panel>

          <Panel className="glass-hover p-4">
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-semibold">Fix history</h3>
              {selectedDeviceId ? (
                <span className="text-xs text-muted-foreground">{pings.length} fixes</span>
              ) : null}
            </div>
            <div className="mt-3">
              {!selectedDeviceId ? (
                <p className="glass-inset rounded-xl px-3 py-6 text-center text-sm text-muted-foreground">
                  Select a device to see its fix history
                </p>
              ) : locationQuery.isLoading ? (
                <LoadingBlock label="Loading fixes…" />
              ) : locationQuery.isError ? (
                <ErrorBlock
                  message={
                    locationQuery.error instanceof Error
                      ? locationQuery.error.message
                      : 'Failed to load fix history'
                  }
                />
              ) : pings.length === 0 ? (
                <p className="glass-inset rounded-xl px-3 py-6 text-center text-sm text-muted-foreground">
                  No fixes recorded yet — request a fresh fix above
                </p>
              ) : (
                <div className="flex max-h-56 flex-col gap-1.5 overflow-y-auto scroll-slim">
                  {pings.map((p) => (
                    <div
                      key={p.id}
                      className="glass-inset glass-hover flex items-center gap-2 rounded-xl px-3 py-2"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-mono text-xs">
                          {p.lat.toFixed(4)}, {p.lon.toFixed(4)}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {timeAgo(p.createdAt)}
                          {p.accuracyM != null ? ` • ±${Math.round(p.accuracyM)} m` : ''}
                        </p>
                      </div>
                      <Badge variant="outline" className={cn('text-[10px]', sourceBadgeClass(p.source))}>
                        {p.source}
                      </Badge>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Panel>
        </div>
      </div>
    </div>
  )
}
