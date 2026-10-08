"use client"

import { useSyncExternalStore } from "react"

/** Stable no-op subscription for the mounted snapshot. */
const emptySubscribe = () => () => {}

/**
 * Returns true after the component has mounted on the client.
 * Hydration-safe gate for components that should never be server-rendered
 * (hidden dialogs, palette, portals) — server snapshot is false, client
 * snapshot is true, so SSR HTML and the hydration pass always agree.
 */
export function useMounted(): boolean {
  return useSyncExternalStore(emptySubscribe, () => true, () => false)
}
