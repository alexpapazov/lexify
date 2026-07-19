'use client'

/** A small segmented slider (Past/Present/Future, Due Now/Learning pipeline, …). */
export function Segmented<T extends string>({ options, value, onChange }: {
  options: { value: T; label: string }[]
  value: T
  onChange: (v: T) => void
}) {
  return (
    <div className="flex items-center gap-1 bg-surface-raised rounded-card p-1 w-fit">
      {options.map(o => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`px-3 py-1.5 rounded text-sm transition-colors ${
            value === o.value ? 'bg-accent text-white font-medium' : 'text-ink-muted hover:text-ink'
          }`}
        >{o.label}</button>
      ))}
    </div>
  )
}
