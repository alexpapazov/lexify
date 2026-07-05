import { resolveTypedPenalty } from '@/engine/grading'
import type { GradingResult, GradingStatus, GradingIssueType, TypedStrictness } from '@/domain'
import { DEFAULT_TYPED_STRICTNESS } from '@/domain'

function res(status: GradingStatus, issueType: GradingIssueType): GradingResult {
  return {
    status, issueType, reason: '',
    typedAnswer: 'x', expectedAnswer: 'y',
    correct: status === 'correct',
    normalizedUser: 'x', normalizedExpected: 'y',
  }
}

const STRICT: TypedStrictness = { spelling: true, accents: true, articles: true }
const LENIENT: TypedStrictness = { spelling: false, accents: false, articles: false }

describe('resolveTypedPenalty', () => {
  it('exact correct → no penalty, no retype', () => {
    const p = resolveTypedPenalty(res('correct', 'none'), STRICT)
    expect(p).toEqual({ weight: 0, category: null, accepted: true, requiresRetype: false })
  })

  it('accent slip: strict = 0.2 penalty, retype, logged as accent', () => {
    const p = resolveTypedPenalty(res('almost', 'accent'), STRICT)
    expect(p.weight).toBe(0.2)
    expect(p.category).toBe('accent')
    expect(p.accepted).toBe(true)
    expect(p.requiresRetype).toBe(true)
  })

  it('accent slip: lenient = 0 penalty but still accepted + retype + logged', () => {
    const p = resolveTypedPenalty(res('almost', 'accent'), LENIENT)
    expect(p.weight).toBe(0)
    expect(p.category).toBe('accent')
    expect(p.accepted).toBe(true)
    expect(p.requiresRetype).toBe(true)
  })

  it('article slip strict = 0.2', () => {
    expect(resolveTypedPenalty(res('almost', 'article'), STRICT).weight).toBe(0.2)
    expect(resolveTypedPenalty(res('almost', 'article'), STRICT).category).toBe('article')
  })

  it('spelling (typo) slip strict = 0.3, lenient = 0', () => {
    const strict = resolveTypedPenalty(res('almost', 'typo'), STRICT)
    expect(strict.weight).toBe(0.3)
    expect(strict.category).toBe('spelling')
    expect(resolveTypedPenalty(res('almost', 'typo'), LENIENT).weight).toBe(0)
  })

  it('per-category independence: strict spelling only', () => {
    const s: TypedStrictness = { spelling: true, accents: false, articles: false }
    expect(resolveTypedPenalty(res('almost', 'typo'), s).weight).toBe(0.3)
    expect(resolveTypedPenalty(res('almost', 'accent'), s).weight).toBe(0)
    expect(resolveTypedPenalty(res('almost', 'article'), s).weight).toBe(0)
  })

  it('non-toggleable almost (parenthetical) keeps a mild 0.2, not logged', () => {
    const p = resolveTypedPenalty(res('almost', 'parenthetical'), LENIENT)
    expect(p.weight).toBe(0.2)
    expect(p.category).toBeNull()
    expect(p.accepted).toBe(true)
  })

  it('incorrect / wrong word → full 1.0, not accepted, retype', () => {
    const p = resolveTypedPenalty(res('incorrect', 'none'), STRICT)
    expect(p.weight).toBe(1)
    expect(p.accepted).toBe(false)
    expect(p.requiresRetype).toBe(true)
  })

  it('DEFAULT_TYPED_STRICTNESS is all strict', () => {
    expect(DEFAULT_TYPED_STRICTNESS).toEqual({ spelling: true, accents: true, articles: true })
  })
})
