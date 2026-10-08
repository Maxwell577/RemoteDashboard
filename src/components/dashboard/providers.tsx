'use client'

import { useState, useSyncExternalStore, type ReactNode } from 'react'
import { ThemeProvider, useTheme } from 'next-themes'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'

/** Stable no-op subscription for the mounted snapshot. */
const emptySubscribe = () => () => {}

/**
 * App-level providers: next-themes (class strategy), react-query, sonner toasts.
 * Mounted once from the root layout.
 */
export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 5000,
          },
        },
      }),
  )

  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem
      disableTransitionOnChange
    >
      <QueryClientProvider client={queryClient}>
        {children}
        <ThemedToaster />
      </QueryClientProvider>
    </ThemeProvider>
  )
}

/** Sonner toaster that follows the resolved app theme (hydration-safe). */
function ThemedToaster() {
  const { resolvedTheme } = useTheme()
  const mounted = useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  )

  const theme: 'light' | 'dark' | 'system' =
    mounted && resolvedTheme === 'light'
      ? 'light'
      : mounted && resolvedTheme === 'dark'
        ? 'dark'
        : 'system'

  return <Toaster richColors position="top-right" theme={theme} />
}
