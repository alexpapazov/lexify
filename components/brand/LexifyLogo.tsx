/**
 * The Lexify brand lockup — the A1 "language character bubble" mark (語 in a speech bubble) beside
 * the Lexi/fy logotype. Geometry and colours match brand/mark-bubble.svg exactly; keep them in sync
 * (scripts/generate-icons.mjs regenerates the standalone SVG + every app icon from the same art).
 */

const PRIMARY = '#4A48D8'       // bubble fill
const FY = '#8684F0'            // lighter indigo on the "fy"
// Georgia carries no CJK glyphs, so name real CJK serif families or 語 falls back to a tofu box.
const SERIF = "Georgia, 'Times New Roman', 'Hiragino Mincho ProN', 'Songti SC', 'Yu Mincho', serif"

/** Just the bubble mark, no wordmark. `size` is the full SVG box (the bubble body is ~73% of it). */
export function LexifyMark({ size = 26, className = '' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 52 52" fill="none" className={className} aria-hidden="true">
      <rect x="2" y="2" width="46" height="36" rx="10" fill={PRIMARY} />
      <polygon points="9,38 2,50 22,38" fill={PRIMARY} />
      <text x="25" y="28" textAnchor="middle" fontSize="20" fill="#ffffff" fontFamily={SERIF}>語</text>
    </svg>
  )
}

/** Mark + logotype. The wordmark stays real text so it inherits the app's font and stays selectable. */
export function LexifyLogo({ markSize = 26, className = '' }: { markSize?: number; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <LexifyMark size={markSize} />
      <span className="font-semibold tracking-tight text-ink text-[17px] leading-none">
        Lexi<span style={{ color: FY }}>fy</span>
      </span>
    </span>
  )
}
