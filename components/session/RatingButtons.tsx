'use client'

import type { Rating } from '@/domain'

/**
 * Again / Hard / Good / Easy — shown for post-graduation reviews.
 * Pass `suggestedRating` to visually highlight the app's recommendation.
 * Pass `onAlmost` (Due Now self-graded only) to add an orange "Almost" between Again and Hard:
 * a near-miss — recalled it with a small slip (el cráno for el cráneo) — that shouldn't be
 * punished like a full lapse. The card takes a light penalty and re-shows this session.
 */
export function RatingButtons({
  onRate,
  suggestedRating,
  onAlmost,
}: {
  onRate: (r: Rating) => void
  suggestedRating?: Rating
  onAlmost?: () => void
}) {
  const btnClass = (color: string) => `border rounded-lg px-5 py-2 text-sm font-medium transition-colors ${color}`
  const buttons: { rating: Rating; label: string; color: string }[] = [
    { rating: 'again', label: 'Again', color: 'border-danger/60 text-danger hover:bg-danger/10'      },
    { rating: 'hard',  label: 'Hard',  color: 'border-warning/60 text-warning hover:bg-warning/10'   },
    { rating: 'good',  label: 'Good',  color: 'border-success/60 text-success hover:bg-success/10'   },
    { rating: 'easy',  label: 'Easy',  color: 'border-accent/60 text-accent-soft hover:bg-accent/10' },
  ]
  const rendered: { key: string; label: string; color: string; onClick: () => void }[] = buttons.map(
    ({ rating, label, color }) => ({ key: rating, label, color, onClick: () => onRate(rating) }),
  )
  if (onAlmost) {
    rendered.splice(1, 0, {
      key: 'almost', label: 'Almost',
      color: 'border-orange-400/60 text-orange-400 hover:bg-orange-400/10',
      onClick: onAlmost,
    })
  }
  return (
    <div className="flex gap-3 justify-center flex-wrap">
      {rendered.map(({ key, label, color, onClick }) => (
        <button key={key} onClick={onClick} className={btnClass(color)}
          title={key === 'almost' ? 'Recalled it with a small slip — light penalty, re-shows this session' : undefined}>
          {label}
        </button>
      ))}
    </div>
  )
}
