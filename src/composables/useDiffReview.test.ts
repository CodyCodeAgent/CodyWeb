import { describe, expect, it } from 'vitest'
import { buildDiffReview, buildDiffReviewFromPatches, buildSplitDiffRows, sliceDiffHunkLines } from './useDiffReview'
import type { UiMessage } from '../types/codex'

function fileChangeMessage(id: string, output: string, details: string[] = []): UiMessage {
  return {
    id,
    role: 'system',
    text: '',
    tool: {
      kind: 'fileChange',
      title: 'File changes',
      status: 'completed',
      summary: 'files changed',
      details,
      output,
      outputLabel: 'Diff',
    },
  }
}

describe('useDiffReview', () => {
  it('builds a workspace-snapshot review without manufacturing a conversation message', () => {
    const review = buildDiffReviewFromPatches([{
      id: 'workspace-snapshot',
      patch: ['diff --git a/src/example.ts b/src/example.ts', '--- a/src/example.ts', '+++ b/src/example.ts', '@@ -1 +1 @@', '-old', '+new'].join('\n'),
    }])

    expect(review.files).toHaveLength(1)
    expect(review.files[0]).toMatchObject({ filePath: 'src/example.ts', messageIds: ['workspace-snapshot'] })
  })

  it('parses file and hunk structure from unified diffs', () => {
    const review = buildDiffReview([
      fileChangeMessage(
        'change-1',
        [
          'diff --git a/src/example.ts b/src/example.ts',
          'index 1111111..2222222 100644',
          '--- a/src/example.ts',
          '+++ b/src/example.ts',
          '@@ -1,3 +1,4 @@',
          ' import value from "./value"',
          '-const name = "old"',
          '+const name = "new"',
          '+const enabled = true',
          ' export { name }',
        ].join('\n'),
      ),
    ])

    expect(review.summary).toMatchObject({
      fileCount: 1,
      hunkCount: 1,
      addedLines: 2,
      removedLines: 1,
    })
    expect(review.files[0]).toMatchObject({
      filePath: 'src/example.ts',
      status: 'modified',
      addedLines: 2,
      removedLines: 1,
    })
    expect(review.files[0]?.hunks[0]?.lines.map((line) => [line.kind, line.oldLineNumber, line.newLineNumber])).toEqual([
      ['context', 1, 1],
      ['remove', 2, null],
      ['add', null, 2],
      ['add', null, 3],
      ['context', 3, 4],
    ])
  })

  it('uses file change details as fallback paths for hunk-only patches', () => {
    const review = buildDiffReview([
      fileChangeMessage('change-2', '@@ -10 +10 @@\n-old\n+new', ['status: completed', 'update: src/fallback.ts']),
    ])

    expect(review.files).toHaveLength(1)
    expect(review.files[0]?.filePath).toBe('src/fallback.ts')
    expect(review.files[0]?.hunks[0]).toMatchObject({
      header: '@@ -10 +10 @@',
      oldStart: 10,
      newStart: 10,
      addedLines: 1,
      removedLines: 1,
    })
  })

  it('uses file change details when the app-server item has no diff output', () => {
    const review = buildDiffReview([
      fileChangeMessage('change-empty-output', '', [
        'status: completed',
        'update: src/settings.ts',
        'rename: src/OldWidget.vue -> src/Widget.vue',
        'delete: src/removed.ts',
      ]),
    ])

    expect(review.summary).toMatchObject({
      fileCount: 3,
      hunkCount: 0,
      addedLines: 0,
      removedLines: 0,
    })
    expect(review.files.map((file) => [file.filePath, file.oldPath, file.status])).toEqual([
      ['src/removed.ts', null, 'deleted'],
      ['src/settings.ts', null, 'modified'],
      ['src/Widget.vue', 'src/OldWidget.vue', 'renamed'],
    ])
  })

  it('aggregates repeated changes to the same file', () => {
    const review = buildDiffReview([
      fileChangeMessage('change-3', '@@ -1 +1 @@\n-a\n+b', ['update: src/same.ts']),
      fileChangeMessage('change-4', '@@ -4 +4 @@\n-c\n+d', ['update: src/same.ts']),
    ])

    expect(review.files).toHaveLength(1)
    expect(review.files[0]).toMatchObject({
      filePath: 'src/same.ts',
      messageIds: ['change-3', 'change-4'],
      addedLines: 2,
      removedLines: 2,
    })
    expect(review.summary.hunkCount).toBe(2)
  })

  it('pairs adjacent removed and added lines for split diffs', () => {
    const review = buildDiffReview([
      fileChangeMessage(
        'change-5',
        [
          'diff --git a/src/example.ts b/src/example.ts',
          '--- a/src/example.ts',
          '+++ b/src/example.ts',
          '@@ -1,4 +1,4 @@',
          ' const keep = true',
          '-const oldOne = 1',
          '-const oldTwo = 2',
          '+const newOne = 1',
          ' export { keep }',
        ].join('\n'),
      ),
    ])

    const rows = buildSplitDiffRows(review.files[0]?.hunks[0]?.lines ?? [])

    expect(rows.map((row) => [row.old.kind, row.old.content, row.new.kind, row.new.content])).toEqual([
      ['context', 'const keep = true', 'context', 'const keep = true'],
      ['remove', 'const oldOne = 1', 'add', 'const newOne = 1'],
      ['remove', 'const oldTwo = 2', 'empty', ''],
      ['context', 'export { keep }', 'context', 'export { keep }'],
    ])
  })

  it('slices large hunk line lists for lightweight previews', () => {
    const lines = buildDiffReview([
      fileChangeMessage(
        'change-6',
        [
          'diff --git a/src/large.ts b/src/large.ts',
          '--- a/src/large.ts',
          '+++ b/src/large.ts',
          '@@ -1,5 +1,5 @@',
          ' one',
          ' two',
          ' three',
          ' four',
          ' five',
        ].join('\n'),
      ),
    ]).files[0]?.hunks[0]?.lines ?? []

    expect(sliceDiffHunkLines(lines, 3)).toEqual({
      lines: lines.slice(0, 3),
      hiddenCount: 2,
    })
    expect(sliceDiffHunkLines(lines, 10)).toEqual({
      lines,
      hiddenCount: 0,
    })
    expect(sliceDiffHunkLines(lines, 0)).toEqual({
      lines,
      hiddenCount: 0,
    })
  })
})
