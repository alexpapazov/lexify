'use client'

import type { Rating } from '@/domain'

/**
 * Again / Hard / Good / Easy — shown for post-graduation reviews.
 * Pass `suggestedRating` to visually highlight the app's recommendation.
 */
export function RatingButtons({
  onRate,
  suggestedRating,
}: {
  onRate: (r: Rating) => void
  suggestedRating?: Rating
}) {
  const buttons: { rating: Rating; label: string; color: string }[] = [
    { rating: 'again', label: 'Again', color: 'border-danger/60 text-danger hover:bg-danger/10'      },
    { rating: 'hard',  label: 'Hard',  color: 'border-warning/60 text-warning hover:bg-warning/10'   },
    { rating: 'good',  label: 'Good',  color: 'border-success/60 text-success hover:bg-success/10'   },
    { rating: 'easy',  label: 'Easy',  color: 'border-accent/60 text-accent-soft hover:bg-accent/10' },
  ]
  return (
    <div className="flex gap-3 justify-center">
      {buttons.map(({ rating, label, color }) => (
        <button
          key={rating}
          onClick={() => onRate(rating)}
          className={`border rounded-lg px-5 py-2 text-sm font-medium transition-colors ${color}`}
        >
          {label}
        </button>
      ))}
    </div>
  )
}
