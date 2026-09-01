import { describe, expect, it } from 'vitest'
import { normalizeComposerTurnInput, normalizeNewThreadTurnInput, normalizeThreadTextTurnInput } from './desktopTurnState'

describe('desktop turn input adapter', () => {
  it('normalizes composer input without owning Turn lifecycle', () => {
    expect(normalizeComposerTurnInput({ text: '  hello  ', images: [], skills: [] })).toMatchObject({ text: 'hello', hasContent: true })
    expect(normalizeThreadTextTurnInput(' thread-1 ', ' next ')).toMatchObject({ threadId: 'thread-1', text: 'next', hasContent: true })
    expect(normalizeNewThreadTurnInput({ text: 'start', images: [], skills: [] }, ' /workspace ')).toMatchObject({ targetCwd: '/workspace', hasContent: true })
  })
})
