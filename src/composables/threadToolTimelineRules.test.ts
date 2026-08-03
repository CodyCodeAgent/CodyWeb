import { describe, expect, it } from 'vitest'
import type { UiToolTimelineEntry } from '../types/codex'
import {
  buildFileChangeMessageGroups,
  buildToolOutputPreview,
  fileChangeCountLabel,
  fileChangeMessageDetails,
  fileChangeUpdateLabel,
  formatToolStatus,
  isToolFailureStatus,
  isToolOutputTruncated,
  isToolTimelineExpandedByDefault,
  toolOutputToggleLabel,
  toolStatusTone,
} from './threadToolTimelineRules'
import type { UiMessage } from '../types/codex'

function tool(overrides: Partial<UiToolTimelineEntry> = {}): UiToolTimelineEntry {
  return {
    kind: 'command',
    title: 'Command',
    status: 'completed',
    summary: 'Done',
    details: [],
    ...overrides,
  }
}

function fileChangeMessage(id: string, count: number, status = 'completed'): UiMessage {
  return {
    id,
    role: 'assistant',
    text: '',
    tool: {
      kind: 'fileChange',
      title: 'File changes',
      status,
      summary: `${String(count)} file${count === 1 ? '' : 's'} changed`,
      details: [`status: ${status}`, ...Array.from({ length: count }, (_, index) => `update: src/file-${String(index + 1)}.ts`)],
      output: `diff-${id}`,
      outputLabel: 'Diff',
    },
  }
}

describe('thread tool timeline rules', () => {
  it('formats status labels', () => {
    expect(formatToolStatus('')).toBe('unknown')
    expect(formatToolStatus('in_progress')).toBe('In Progress')
    expect(formatToolStatus('ready-to-merge')).toBe('Ready To Merge')
  })

  it('classifies status tone', () => {
    expect(isToolFailureStatus('tool failed')).toBe(true)
    expect(isToolFailureStatus('cancelled')).toBe(true)
    expect(isToolFailureStatus('completed')).toBe(false)

    expect(toolStatusTone('')).toBe('neutral')
    expect(toolStatusTone('failed')).toBe('danger')
    expect(toolStatusTone('running')).toBe('working')
    expect(toolStatusTone('applied')).toBe('success')
    expect(toolStatusTone('queued')).toBe('neutral')
  })

  it('keeps file change timelines collapsed by default', () => {
    expect(isToolTimelineExpandedByDefault(tool())).toBe(true)
    expect(isToolTimelineExpandedByDefault(tool({ kind: 'fileChange' }))).toBe(false)
  })

  it('previews long tool output before rendering the full block', () => {
    expect(isToolOutputTruncated('one\ntwo', 3, 100)).toBe(false)
    expect(isToolOutputTruncated('one\ntwo\nthree\nfour', 3, 100)).toBe(true)
    expect(isToolOutputTruncated('abcdef', 10, 5)).toBe(true)
    expect(buildToolOutputPreview('one\ntwo\nthree\nfour', 2, 100)).toBe('one\ntwo')
    expect(buildToolOutputPreview('abcdef', 10, 3)).toBe('abc')
    expect(toolOutputToggleLabel(false)).toBe('Show full output')
    expect(toolOutputToggleLabel(true)).toBe('Show preview')
  })

  it('groups only consecutive standalone file-change messages', () => {
    const first = fileChangeMessage('change-1', 4)
    const second = fileChangeMessage('change-2', 3)
    const third = fileChangeMessage('change-3', 1)
    const groups = buildFileChangeMessageGroups([
      first,
      second,
      { id: 'reply', role: 'assistant', text: 'Validation complete' },
      third,
    ])

    expect(groups).toHaveLength(2)
    expect(groups[0]).toMatchObject({ headId: 'change-1', messageIds: ['change-1', 'change-2'], fileCount: 7, updateCount: 2, status: 'completed' })
    expect(groups[1]).toMatchObject({ headId: 'change-3', messageIds: ['change-3'], fileCount: 1, updateCount: 1 })
    expect(fileChangeMessageDetails(first)).toEqual([
      'update: src/file-1.ts',
      'update: src/file-2.ts',
      'update: src/file-3.ts',
      'update: src/file-4.ts',
    ])
    expect(fileChangeCountLabel(1)).toBe('1 file')
    expect(fileChangeCountLabel(7)).toBe('7 files')
    expect(fileChangeUpdateLabel(2)).toBe('2 updates')
  })

  it('keeps failures visible in a grouped status and avoids grouping mixed-content messages', () => {
    const failed = fileChangeMessage('change-failed', 1, 'failed')
    const recovered = fileChangeMessage('change-recovered', 2, 'completed')
    const mixed = { ...fileChangeMessage('change-with-text', 1), text: 'Files were updated.' }
    const groups = buildFileChangeMessageGroups([failed, recovered, mixed])

    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ messageIds: ['change-failed', 'change-recovered'], status: 'failed' })
  })
})
