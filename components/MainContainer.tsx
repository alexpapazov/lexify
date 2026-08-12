/**
 * components/MainContainer.tsx — the page container.
 *
 * Pages span the full window inside a **shared gutter** (`px-5 md:px-10 lg:px-20`) that the navbar
 * uses too — so the logo, the nav row and every page's content sit on the same two vertical lines,
 * with nothing reaching past them. The gutter is padding rather than a `max-w-*` cap so the band
 * tracks the window instead of stranding a fixed-width column in the middle of a large display.
 *
 * **Change the gutter in BOTH places or the alignment silently breaks** — `components/nav/Navbar.tsx`
 * carries the same classes.
 *
 * Pages that genuinely want a narrow measure — a single study card, an empty state, a short form —
 * set their own `max-w-* mx-auto` inside this. Width is opt-IN to narrow rather than opt-in to wide,
 * which is the opposite of how it worked before.
 *
 * This is a component (not a CSS breakout like `w-screen; margin-left:-50vw`) because `100vw`
 * includes the scrollbar and that trick overflows by ~15px on desktop.
 */

export function MainContainer({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex-1 w-full px-5 md:px-10 lg:px-20 py-6 pb-[calc(2rem+env(safe-area-inset-bottom))]">
      {children}
    </main>
  )
}
