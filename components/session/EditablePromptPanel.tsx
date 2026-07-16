'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * Displays prompt text in a panel. Double-click (or double-tap) to edit
 * inline. Enter saves; Esc cancels; submitting an empty string signals deletion.
 *
 * The parent is responsible for persisting the change — onEdit fires once
 * with the trimmed text ('' = delete). The parent should update the card
 * in state so the displayed text refreshes.
 */
export function EditablePromptPanel({
  text,
  onEdit,
}: {
  text:   string
  onEdit: (newText: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [value,   setValue]   = useState(text)
  const ref = useRef<HTMLTextAreaElement>(null)

  // Keep value in sync when the parent updates the card text (but not while editing).
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
    if (editing) {
      ref.current?.focus()
      ref.current?.select()
    }
  }, [editing])

  if (editing) {
    const isEmpty = !value.trim()
    return (
      // data-editing flattens the surrounding `.panel` (see globals.css) so inline
      // editing reads as flat text, not a raised/floating box.
      <div data-editing className="w-full flex flex-col items-center gap-1.5">
        <textarea
          ref={ref}
          value={value}
          rows={2}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
            if (e.key === 'Escape') cancel()
          }}
          onBlur={submit}
          className="text-2xl font-medium text-ink bg-transparent border-none outline-none resize-none text-center w-full leading-tight"
        />
        <p className="text-xs">
          {isEmpty
            ? <span className="text-danger/80">Leave blank to delete this card</span>
            : <span className="text-ink-faint">Enter to save · Esc to cancel</span>}
        </p>
      </div>
    )
  }

  return (
    <p
      className="text-2xl font-medium text-ink cursor-default select-none"
      onDoubleClick={start}
      title="Double-click to edit"
    >
      {text}
    </p>
  )
}
