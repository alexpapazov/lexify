'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * Inline answer text (e.g. "Answer: <this>"). Double-click/double-tap to
 * edit in place. Enter saves; Esc cancels; submitting an empty string
 * signals deletion (handled by the parent's onEdit, same contract as
 * EditablePromptPanel).
 */
export function EditableAnswerText({
  text,
  onEdit,
  className = 'font-mono text-ink',
}: {
  text:   string
  onEdit: (newText: string) => void
  /** Type styling for both the resting text and the editor, so the control can sit inside panels
   *  that aren't the default mono/ink (e.g. the dictation reveal's large green answer). */
  className?: string
}) {
  const [editing, setEditing] = useState(false)
  const [value,   setValue]   = useState(text)
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!editing) setValue(text)
  }, [text, editing])

  function start() {
    setValue(text)
    setEditing(true)
  }

  function submit() {
    setEditing(false)
    const trimmed = value.trim()
    if (trimmed !== text) onEdit(trimmed)
  }

  function cancel() {
    setEditing(false)
    setValue(text)
  }

  useEffect(() => {
    if (!editing) return
    // Defer a frame so a synchronous focus+select doesn't drop the first character with CJK input
    // methods (the IME is still processing the click that opened the editor).
    const id = requestAnimationFrame(() => { ref.current?.focus(); ref.current?.select() })
    return () => cancelAnimationFrame(id)
  }, [editing])

  if (editing) {
    return (
      <input
        ref={ref}
        value={value}
        onChange={e => setValue(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.preventDefault(); submit() }
          if (e.key === 'Escape') cancel()
        }}
        onBlur={submit}
        className={`${className} bg-transparent border-b border-ink-faint/40 outline-none text-center`}
        style={{ width: `${Math.max(value.length, 4)}ch` }}
      />
    )
  }

  return (
    <span
      className={`${className} cursor-default select-none`}
      onDoubleClick={start}
      title="Double-click to edit"
    >
      {text}
    </span>
  )
}
