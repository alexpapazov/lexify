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

const PENALIZE: TypedStrictness = { spelling: 'penalize', accents: 'penalize', articles: 'penalize' }
const RETYPE:   TypedStrictness = { spelling: 'retype',   accents: 'retype',   articles: 'retype' }
const ACCEPT:   TypedStrictness = { spelling: 'accept',   accents: 'accept',   articles: 'accept' }

describe('resolveTypedPenalty', () => {
  it('exact correct → no penalty, no retype', () => {
    const p = resolveTypedPenalty(res('correct', 'none'), PENALIZE)
    expect(p).toEqual({ weight: 0, category: null, accepted: true, requiresRetype: false })
  })

  it('accent slip: penalize = 0.2 penalty, retype, logged as accent', () => {
    const p = resolveTypedPenalty(res('almost', 'accent'), PENALIZE)
    expect(p.weight).toBe(0.2)
    expect(p.category).toBe('accent')
    expect(p.accepted).toBe(true)
    expect(p.requiresRetype).toBe(true)
  })

  it('accent slip: retype = 0 penalty but still accepted + retype + logged', () => {
    const p = resolveTypedPenalty(res('almost', 'accent'), RETYPE)
    expect(p.weight).toBe(0)
    expect(p.category).toBe('accent')
    expect(p.accepted).toBe(true)
    expect(p.requiresRetype).toBe(true)
  })

  it('accent slip: accept = 0 penalty, accepted, and NO retype', () => {
    const p = resolveTypedPenalty(res('almost', 'accent'), ACCEPT)
    expect(p.weight).toBe(0)
    expect(p.category).toBe('accent')
    expect(p.accepted).toBe(true)
    expect(p.requiresRetype).toBe(false)
  })

  it('article slip penalize = 0.2', () => {
    expect(resolveTypedPenalty(res('almost', 'article'), PENALIZE).weight).toBe(0.2)
    expect(resolveTypedPenalty(res('almost', 'article'), PENALIZE).category).toBe('article')
  })

  it('spelling (typo) slip penalize = 0.3, retype = 0, accept = 0 + no retype', () => {
    const penalize = resolveTypedPenalty(res('almost', 'typo'), PENALIZE)
    expect(penalize.weight).toBe(0.3)
    expect(penalize.category).toBe('spelling')
    expect(resolveTypedPenalty(res('almost', 'typo'), RETYPE).weight).toBe(0)
    expect(resolveTypedPenalty(res('almost', 'typo'), ACCEPT).requiresRetype).toBe(false)
  })

  it('per-category independence: penalize spelling only', () => {
    const s: TypedStrictness = { spelling: 'penalize', accents: 'accept', articles: 'accept' }
    expect(resolveTypedPenalty(res('almost', 'typo'), s).weight).toBe(0.3)
    expect(resolveTypedPenalty(res('almost', 'typo'), s).requiresRetype).toBe(true)
    expect(resolveTypedPenalty(res('almost', 'accent'), s).requiresRetype).toBe(false)
    expect(resolveTypedPenalty(res('almost', 'article'), s).requiresRetype).toBe(false)
  })

  it('non-toggleable almost (parenthetical) keeps a mild 0.2, not logged', () => {
    const p = resolveTypedPenalty(res('almost', 'parenthetical'), ACCEPT)
    expect(p.weight).toBe(0.2)
    expect(p.category).toBeNull()
    expect(p.accepted).toBe(true)
    expect(p.requiresRetype).toBe(true)
  })

  it('incorrect / wrong word → full 1.0, not accepted, retype', () => {
    const p = resolveTypedPenalty(res('incorrect', 'none'), PENALIZE)
    expect(p.weight).toBe(1)
    expect(p.accepted).toBe(false)
    expect(p.requiresRetype).toBe(true)
  })

  it('DEFAULT_TYPED_STRICTNESS is all penalize', () => {
    expect(DEFAULT_TYPED_STRICTNESS).toEqual({ spelling: 'penalize', accents: 'penalize', articles: 'penalize' })
  })
})
