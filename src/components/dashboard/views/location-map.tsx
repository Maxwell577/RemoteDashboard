'use client'

import { useEffect, useMemo } from 'react'
import {
  CircleMarker,
  MapContainer,
  Polyline,
  Popup,
  TileLayer,
  Tooltip,
  useMap,
} from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import type { Device, LocationPing } from '@/lib/types'
import { timeAgo } from '../shared'

const ONLINE_COLOR = '#10b981' // emerald-500
const OFFLINE_COLOR = '#71717a' // zinc-500
const PATH_COLOR = '#14b8a6' // teal-500 (primary-family)

function FitBounds({ devices }: { devices: Device[] }) {
  const map = useMap()
  const points = useMemo(
    () =>
      devices.filter(
        (d): d is Device & { locationLat: number; locationLon: number } =>
          d.locationLat != null && d.locationLon != null
      ),
    [devices]
  )
  // stable string key so polling refetches don't reset the user's pan/zoom
  const boundsKey = useMemo(
    () => points.map((d) => `${d.id}:${d.locationLat},${d.locationLon}`).join('|'),
    [points]
  )

  useEffect(() => {
    if (points.length === 0) return
    const lats = points.map((d) => d.locationLat)
    const lons = points.map((d) => d.locationLon)
    map.fitBounds(
      [
        [Math.min(...lats), Math.min(...lons)],
        [Math.max(...lats), Math.max(...lons)],
      ],
      { padding: [40, 40], maxZoom: 14 }
    )
  }, [map, boundsKey, points])

  return null
}

export interface DeviceMapProps {
  devices: Device[]
  /** fresh fixes for the currently selected device (dashed trail) */
  pings?: LocationPing[]
}

export default function DeviceMap({ devices, pings }: DeviceMapProps) {
  const withFix = useMemo(
    () =>
      devices.filter(
        (d): d is Device & { locationLat: number; locationLon: number } =>
          d.locationLat != null && d.locationLon != null
      ),
    [devices]
  )

  // chronological trail for the selected device
  const trail = useMemo(() => {
    if (!pings || pings.length < 2) return []
    return [...pings]
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      .map((p) => [p.lat, p.lon] as [number, number])
  }, [pings])

  const latestAccuracyByDevice = useMemo(() => {
    const map = new Map<string, number | null>()
    const sorted = [...(pings ?? [])].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    )
    for (const p of sorted) map.set(p.deviceId, p.accuracyM) // last write wins = newest
    return map
  }, [pings])

  return (
    <MapContainer
      center={[-26.35, 31.2]}
      zoom={9}
      scrollWheelZoom
      className="z-0 h-[420px] w-full rounded-xl"
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
      />

      {trail.length >= 2 ? (
        <Polyline
          positions={trail}
          pathOptions={{ color: PATH_COLOR, weight: 2, opacity: 0.6, dashArray: '6 8' }}
        />
      ) : null}

      {withFix.map((d) => {
        const online = d.status === 'online'
        const color = online ? ONLINE_COLOR : OFFLINE_COLOR
        const accuracy = latestAccuracyByDevice.get(d.id)
        return (
          <CircleMarker
            key={d.id}
            center={[d.locationLat, d.locationLon]}
            radius={9}
            pathOptions={{ color, fillColor: color, fillOpacity: 0.85, weight: 2 }}
          >
            <Tooltip direction="top" offset={[0, -8]} opacity={1}>
              <span className="text-xs font-medium">{d.hostname}</span>
            </Tooltip>
            <Popup>
              <div className="flex min-w-[180px] flex-col gap-1 text-xs">
                <p className="text-sm font-semibold">{d.hostname}</p>
                <p className="text-muted-foreground">
                  {d.locationLabel ?? d.friendlyName ?? d.osName}
                </p>
                <p className="font-mono">
                  {d.locationLat.toFixed(4)}, {d.locationLon.toFixed(4)}
                </p>
                {accuracy != null ? <p>accuracy ±{Math.round(accuracy)} m</p> : null}
                <p className="text-muted-foreground">last fix: {timeAgo(d.lastSeen)}</p>
                <p className="text-muted-foreground">
                  {online ? 'online' : 'offline'} • {d.deviceType}
                </p>
              </div>
            </Popup>
          </CircleMarker>
        )
      })}

      <FitBounds devices={devices} />
    </MapContainer>
  )
}
