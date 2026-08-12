'use client'

/**
 * components/MainContainer.tsx — the page container, which is `max-w-5xl` centred everywhere EXCEPT
 * the routes that own their own width.
 *
 * Settings is the exception: its section rail is pinned to the left edge of the viewport and the
 * content pane takes everything else, so a centred 1024px column would put the rail in the middle of
 * the screen and squeeze the wide editors (the goal calendar renders three months side by side).
 *
 * This is a component rather than a CSS breakout (`w-screen; margin-left: -50vw`) on purpose: `100vw`
 * includes the scrollbar width, so that trick overflows by ~15px on desktop and adds a horizontal
 * scrollbar to every settings page.
 */

import { usePathname } from 'next/navigation'

/** Routes that lay themselves out edge to edge. Prefixes, so sub-routes inherit it. */
const FULL_BLEED = ['/settings']

export function MainContainer({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const fullBleed = FULL_BLEED.some(p => pathname === p || pathname.startsWith(p + '/'))

  return (
    <main className={[
      'flex-1 w-full pb-[calc(2rem+env(safe-area-inset-bottom))]',
      fullBleed ? 'py-6' : 'px-4 py-8 max-w-5xl mx-auto',
    ].join(' ')}>
      {children}
    </main>
  )
}
