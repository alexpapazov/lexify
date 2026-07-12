import { activeProductionTrack, type EnabledTracks } from '@/lib/sessionLimits'

const tracks = (o: Partial<EnabledTracks>): EnabledTracks => ({ typed: false, recall: false, reverse: false, smart: false, ...o })

describe('activeProductionTrack', () => {
  it('prefers smart when it is enabled (typed/smart are mutually exclusive)', () => {
    expect(activeProductionTrack(tracks({ smart: true }))).toBe('smart')
    expect(activeProductionTrack(tracks({ smart: true, typed: true }))).toBe('smart')
  })

  it('falls back to typed when only typed is enabled', () => {
    expect(activeProductionTrack(tracks({ typed: true }))).toBe('typed')
  })

  it('returns null when neither production track is enabled', () => {
    expect(activeProductionTrack(tracks({ recall: true, reverse: true }))).toBeNull()
  })

  it('a typed-lane card is reviewable on smart after the migration (the ghost-card fix)', () => {
    // Pair migrated to smart (typed off, smart on); a ladder-graduated card only has typed_due_at.
    // activeProductionTrack routes it to the smart lane so it is not dropped from the queue.
    expect(activeProductionTrack(tracks({ smart: true, typed: false }))).toBe('smart')
  })
})
