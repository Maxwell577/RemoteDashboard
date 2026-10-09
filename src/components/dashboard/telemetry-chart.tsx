'use client'

import { useMemo } from 'react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { TelemetryBucket } from '@/hooks/use-telemetry-history'
import { cn } from '@/lib/utils'

/** Accent tokens for the three utilization metrics (emerald / teal / fuchsia). */
export const TELEMETRY_LINES = [
  { key: 'cpu', label: 'CPU', color: '#10b981', id: 'teleCpu' },
  { key: 'memory', label: 'Memory', color: '#14b8a6', id: 'teleMem' },
  { key: 'disk', label: 'Disk', color: '#d946ef', id: 'teleDisk' },
] as const

export interface TelemetryLineKey {
  key: (typeof TELEMETRY_LINES)[number]['key']
}

function fmtClock(t: number, withDate: boolean): string {
  const d = new Date(t)
  const time = d.toTimeString().slice(0, 5)
  if (!withDate) return time
  return `${d.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' })} ${time}`
}

/**
 * Glass-styled utilization history chart (recharts AreaChart) over bucketed
 * telemetry data. Renders gradient areas for each requested metric.
 */
export function TelemetryChart({
  data,
  metrics,
  height = 190,
  showLegend = true,
  className,
  ariaLabel,
}: {
  data: TelemetryBucket[]
  /** Which metric lines to draw (subset order preserved). */
  metrics: TelemetryLineKey['key'][]
  height?: number
  showLegend?: boolean
  className?: string
  ariaLabel?: string
}) {
  const lines = useMemo(
    () => TELEMETRY_LINES.filter((l) => metrics.includes(l.key)),
    [metrics],
  )
  const span = data.length > 1 ? data[data.length - 1].t - data[0].t : 0
  const withDate = span > 3 * 3_600_000

  return (
    <div
      className={cn('text-muted-foreground', className)}
      style={{ height }}
      role="img"
      aria-label={ariaLabel ?? `Utilization history chart${data.length ? `, ${data.length} samples` : ' (no data yet)'}`}
    >
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
          <defs>
            {lines.map((l) => (
              <linearGradient key={l.id} id={l.id} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={l.color} stopOpacity={0.32} />
                <stop offset="100%" stopColor={l.color} stopOpacity={0.02} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid stroke="#888" strokeOpacity={0.15} vertical={false} />
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={['dataMin', 'dataMax']}
            tickFormatter={(t: number) => fmtClock(t, withDate)}
            tick={{ fill: 'currentColor', fontSize: 10 }}
            axisLine={false}
            tickLine={false}
            minTickGap={44}
          />
          <YAxis
            domain={[0, 100]}
            ticks={[0, 25, 50, 75, 100]}
            width={34}
            tickFormatter={(v: number) => `${v}%`}
            tick={{ fill: 'currentColor', fontSize: 10 }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip
            labelFormatter={(t) => fmtClock(Number(t), true)}
            formatter={(value, name) =>
              typeof value === 'number' ? [`${value.toFixed(1)} %`, String(name)] : [String(value), String(name)]
            }
            contentStyle={{
              background: 'color-mix(in oklab, var(--card) 86%, transparent)',
              border: '1px solid color-mix(in oklab, var(--border) 70%, transparent)',
              borderRadius: 12,
              backdropFilter: 'blur(12px)',
              fontSize: 12,
              color: 'var(--foreground)',
              boxShadow: '0 8px 30px rgb(0 0 0 / 0.12)',
            }}
            labelStyle={{ color: 'var(--muted-foreground)', fontSize: 11, marginBottom: 2 }}
          />
          {showLegend ? (
            <Legend
              verticalAlign="top"
              height={26}
              iconType="plainline"
              iconSize={14}
              formatter={(value) => (
                <span className="text-xs text-muted-foreground">{value}</span>
              )}
            />
          ) : null}
          {lines.map((l) => (
            <Area
              key={l.key}
              type="monotone"
              dataKey={l.key}
              name={l.label}
              stroke={l.color}
              strokeWidth={2}
              fill={`url(#${l.id})`}
              dot={false}
              activeDot={{ r: 3, strokeWidth: 0 }}
              isAnimationActive={false}
              connectNulls
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
