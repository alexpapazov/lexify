// Guided product tour steps, in page order. `anchor` (a data-tour="…" attribute on a
// page element) is spotlighted when present; steps without one just navigate + explain.
export interface TourStep {
  path:   string
  anchor?: string
  title:  string
  body:   string
}

export const TOUR_STEPS: TourStep[] = [
  { path: '/study', anchor: 'due-now', title: 'Study — your home base',
    body: '“Study all due” starts a session with every card that’s ready for review right now. The number is how many are waiting.' },
  { path: '/study', anchor: 'coming-up', title: 'Coming up',
    body: 'A forecast of your review workload over the next couple of weeks, so you can see busy days before they arrive.' },
  { path: '/study', anchor: 'todays-goals', title: 'Today’s goals',
    body: 'Your daily new-word target per language — set during setup, and changeable anytime in Settings.' },
  { path: '/library', anchor: 'library-counter', title: 'Library',
    body: 'Everything you’re learning. The counters up top summarize your cards by status: unlearned, learning, graduated, and due.' },
  { path: '/library', title: 'Organizing your library',
    body: 'Group decks into folders, and drag decks or folders to reorder them. Open any card’s ⓘ menu to view and edit its details, audio, and schedule.' },
  { path: '/browse', title: 'Browse',
    body: 'This is where you can add sets created by other users to your own library.' },
  { path: '/upload', title: 'Upload',
    body: 'Create a new set of cards here — add your own, or use the card-making AI agent to generate them for you.' },
  { path: '/agents', title: 'Agents',
    body: 'The hub for agents that can automate making edits to the cards in your library.' },
  { path: '/progress', anchor: 'projected-due', title: 'Analytics',
    body: 'Track your progress and your future word load. The Projected Due Now load chart forecasts how many reviews you’ll have each day going forward.' },
  { path: '/settings', anchor: 'settings-theme', title: 'Settings — appearance',
    body: 'Switch between light and dark mode here, or replay this tour anytime.' },
  { path: '/settings', anchor: 'settings-ladder', title: 'Learning ladders',
    body: 'The heart of Lexify: the sequence of exercises a card climbs before it graduates. Set a default and customize it per language.' },
  { path: '/settings', anchor: 'settings-sync', title: 'Language sync',
    body: 'Rules that auto-generate linked vocabulary in another language pair as you study — e.g. a French card can spawn its Korean equivalent.' },
  { path: '/settings', anchor: 'settings-timezone', title: 'Time zone',
    body: 'Sets when “today” starts for your daily goals and card scheduling — worth getting right if you study late at night.' },
  { path: '/study', anchor: 'avatar', title: 'Your account',
    body: 'Your avatar (top-right) is where you do profile-related stuff — name, photo, and sign out. That’s the tour!' },
]
