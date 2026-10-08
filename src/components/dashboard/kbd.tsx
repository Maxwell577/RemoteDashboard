import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** Styled keyboard key cap used for shortcut hints (⌘K etc). */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'pointer-events-none inline-flex h-5 min-w-5 select-none items-center justify-center gap-0.5 rounded border border-border/70 bg-background/60 px-1 font-sans text-[10px] font-semibold tracking-wide text-muted-foreground shadow-sm',
        className
      )}
    >
      {children}
    </kbd>
  )
}

/** Platform-aware modifier label (⌘ on Apple, Ctrl elsewhere). */
export function ModKey() {
  if (typeof navigator === 'undefined') return null
  return <>{/mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl'}</>
}
