/**
 * components/MainContainer.tsx — the page container.
 *
 * Pages run EDGE TO EDGE, using the same gutters as the navbar (`px-5 md:px-8`) so a page's content
 * lines up with the Lexify logo and the avatar. There is no width cap: the top bar is full-bleed, and
 * a centred 1024px column under a full-width bar left most of the screen empty.
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
    <main className="flex-1 w-full px-5 md:px-8 py-6 pb-[calc(2rem+env(safe-area-inset-bottom))]">
      {children}
    </main>
  )
}
