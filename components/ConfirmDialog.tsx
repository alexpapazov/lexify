'use client'

export function ConfirmDialog({ message, onConfirm, onCancel }: {
  message:   string
  onConfirm: () => void
  onCancel:  () => void
}) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="panel w-full max-w-sm space-y-4 mx-4">
        <p className="text-ink text-sm leading-relaxed">{message}</p>
        <div className="flex gap-3">
          <button onClick={onConfirm} className="btn-primary flex-1 bg-danger hover:bg-danger/80">Yes, reset</button>
          <button onClick={onCancel}  className="btn-ghost flex-1">Cancel</button>
        </div>
      </div>
    </div>
  )
}
