import Link from 'next/link'

export default function HomePage() {
  return (
    <div className="flex flex-col items-start gap-10 pt-16">
      <div className="space-y-4 max-w-2xl">
        <h1 className="text-4xl font-semibold text-ink leading-tight">
          Welcome!<br />
          <span className="text-ink-muted font-normal">Ready to learn?</span>
        </h1>
        <p className="text-ink-muted text-lg leading-relaxed">
          Build vocabulary that sticks. Words move through recognition, reverse recall,
          and typed production before graduating into long-term spaced review.
        </p>
        <div className="flex gap-3 pt-2">
          <Link href="/study" className="btn-primary">Start studying</Link>
          <Link href="/upload" className="btn-ghost">Add a deck</Link>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4 w-full max-w-lg">
        {[
          { label: 'Unlearned', value: '—', color: 'text-ink-muted' },
          { label: 'Learning',  value: '—', color: 'text-warning'   },
          { label: 'Review',    value: '—', color: 'text-success'   },
        ].map(({ label, value, color }) => (
          <div key={label} className="panel text-center space-y-1">
            <div className={`text-2xl font-semibold ${color}`}>{value}</div>
            <div className="text-xs text-ink-muted uppercase tracking-wider">{label}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
