/**
 * The Lexify brand lockup — the A1 "language character bubble" mark (語 in a speech bubble) beside
 * the Lexi/fy logotype. Geometry and colours match brand/mark-bubble.svg exactly; keep them in sync
 * (scripts/generate-icons.mjs regenerates the standalone SVG + every app icon from the same art).
 */

const PRIMARY = '#4A48D8'       // bubble fill
const FY = '#8684F0'            // lighter indigo on the "fy"
// Georgia carries no CJK glyphs, so name real CJK serif families or 語 falls back to a tofu box.
const SERIF = "Georgia, 'Times New Roman', 'Hiragino Mincho ProN', 'Songti SC', 'Yu Mincho', serif"

// The bubble BODY occupies y 2–38 of the 52-unit box (centre 20); the tail fills the rest down to 50.
// So the box centre (26) sits 6 units below the body's centre — flex `items-center` would leave the
// bubble visibly riding high above the wordmark. Nudging the mark down by those 6 units lines the body
// up with the text and lets the tail hang below the baseline, which is how the original artwork reads.
// Nudged past pure body-centring (6) to 10: the wordmark's own optical centre sits a little above its
// line box (cap-height weight, descender in "y"), so matching geometry alone still left the bubble
// reading high. 10 lines them up to the eye.
const BODY_OFFSET = 10 / 52

// Dropping the mark by BODY_OFFSET moves the bubble but not the wordmark, which stays at the flex
// centre — leaving the text riding above the bubble's body. This brings the text back down onto it:
// after the shift the body centre sits at markSize·(BODY_OFFSET + 20/52 − 1/2) below centre, i.e.
// markSize·4/52. Expressed against markSize so the lockup holds together at any size.
const TEXT_OFFSET = 4 / 52

/** Just the bubble mark, no wordmark. `size` is the full SVG box (the bubble body is ~73% of it). */
function LexifyMark({ size = 26, className = '', align = false }: { size?: number; className?: string; align?: boolean }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 52 52" fill="none" className={className} aria-hidden="true"
      style={align ? { transform: `translateY(${(size * BODY_OFFSET).toFixed(2)}px)` } : undefined}
    >
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
      <LexifyMark size={markSize} align />
      <span
        className="font-semibold tracking-tight text-ink text-[17px] leading-none"
        style={{ transform: `translateY(${(markSize * TEXT_OFFSET).toFixed(2)}px)` }}
      >
        Lexi<span style={{ color: FY }}>fy</span>
      </span>
    </span>
  )
}
