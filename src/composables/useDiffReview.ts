import type { UiMessage } from '../types/codex'

export type UiDiffLineKind = 'add' | 'remove' | 'context' | 'meta'

export type UiDiffReviewLine = {
  kind: UiDiffLineKind
  content: string
  oldLineNumber: number | null
  newLineNumber: number | null
}

export type UiDiffSplitCellKind = UiDiffLineKind | 'empty'

export type UiDiffSplitCell = {
  kind: UiDiffSplitCellKind
  content: string
  lineNumber: number | null
}

export type UiDiffSplitRow = {
  old: UiDiffSplitCell
  new: UiDiffSplitCell
}

export type UiDiffReviewHunk = {
  header: string
  oldStart: number | null
  oldLines: number | null
  newStart: number | null
  newLines: number | null
  addedLines: number
  removedLines: number
  lines: UiDiffReviewLine[]
}

export type UiDiffReviewFile = {
  filePath: string
  oldPath: string | null
  status: string
  messageIds: string[]
  patch: string
  addedLines: number
  removedLines: number
  hunks: UiDiffReviewHunk[]
}

export type UiDiffReviewSummary = {
  fileCount: number
  hunkCount: number
  addedLines: number
  removedLines: number
  patch: string
}

export type UiDiffReview = {
  files: UiDiffReviewFile[]
  summary: UiDiffReviewSummary
}

export type UiDiffHunkLineSlice = {
  lines: UiDiffReviewLine[]
  hiddenCount: number
}

type MutableDiffFile = UiDiffReviewFile & {
  patchLines: string[]
}

type DiffPatchSource = {
  id: string
  patch: string
  fallbackDetails?: string[]
}

function stripDiffPath(value: string): string {
  const trimmed = value.trim()
  if (trimmed === '/dev/null') return trimmed
  if (trimmed.startsWith('a/') || trimmed.startsWith('b/')) return trimmed.slice(2)
  return trimmed
}

function readFallbackPaths(details: readonly string[]): string[] {
  return details
    .map((detail) => {
      if (detail.startsWith('status:')) return ''
      const separatorIndex = detail.indexOf(': ')
      const rawPath = separatorIndex >= 0 ? detail.slice(separatorIndex + 2) : detail
      const moveParts = rawPath.split(' -> ')
      return (moveParts.at(-1) || rawPath).trim()
    })
    .filter((value) => value.length > 0)
}

function statusFromDetailLabel(label: string): string {
  const normalized = label.trim().toLowerCase()
  if (['add', 'added', 'create', 'created', 'new'].includes(normalized)) return 'added'
  if (['delete', 'deleted', 'remove', 'removed'].includes(normalized)) return 'deleted'
  if (['rename', 'renamed', 'move', 'moved'].includes(normalized)) return 'renamed'
  return 'modified'
}

function fallbackFilesFromDetails(details: readonly string[], messageId: string): MutableDiffFile[] {
  const files: MutableDiffFile[] = []
  for (const detail of details) {
    const trimmed = detail.trim()
    if (!trimmed || trimmed.toLowerCase().startsWith('status:')) continue

    const separatorIndex = trimmed.indexOf(': ')
    const label = separatorIndex >= 0 ? trimmed.slice(0, separatorIndex) : 'update'
    const rawPath = separatorIndex >= 0 ? trimmed.slice(separatorIndex + 2) : trimmed
    const moveParts = rawPath.split(' -> ').map((part) => part.trim()).filter(Boolean)
    const filePath = moveParts.at(-1) || rawPath.trim()
    if (!filePath) continue

    const file = createFile(filePath, messageId, statusFromDetailLabel(label))
    if (moveParts.length > 1) {
      file.oldPath = moveParts[0] ?? null
      file.status = 'renamed'
    }
    files.push(file)
  }
  return files
}

function createFile(filePath: string, messageId: string, status = 'modified'): MutableDiffFile {
  return {
    filePath,
    oldPath: null,
    status,
    messageIds: [messageId],
    patch: '',
    patchLines: [],
    addedLines: 0,
    removedLines: 0,
    hunks: [],
  }
}

function parseHunkHeader(header: string): Pick<UiDiffReviewHunk, 'oldStart' | 'oldLines' | 'newStart' | 'newLines'> {
  const match = header.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?/u)
  if (!match) {
    return {
      oldStart: null,
      oldLines: null,
      newStart: null,
      newLines: null,
    }
  }

  return {
    oldStart: Number.parseInt(match[1] ?? '', 10),
    oldLines: Number.parseInt(match[2] ?? '1', 10),
    newStart: Number.parseInt(match[3] ?? '', 10),
    newLines: Number.parseInt(match[4] ?? '1', 10),
  }
}

function createHunk(header: string): UiDiffReviewHunk {
  return {
    header,
    ...parseHunkHeader(header),
    addedLines: 0,
    removedLines: 0,
    lines: [],
  }
}

function nextLineNumber(
  lines: UiDiffReviewLine[],
  field: 'oldLineNumber' | 'newLineNumber',
  start: number | null,
): number | null {
  if (start === null) return null
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const lineNumber = lines[index]?.[field]
    if (typeof lineNumber === 'number') return lineNumber + 1
  }
  return start
}

function pushDiffLine(file: MutableDiffFile, hunk: UiDiffReviewHunk, rawLine: string): void {
  let oldLineNumber: number | null = null
  let newLineNumber: number | null = null
  let kind: UiDiffLineKind = 'context'
  let content = rawLine

  if (rawLine.startsWith('+') && !rawLine.startsWith('+++')) {
    kind = 'add'
    content = rawLine.slice(1)
    newLineNumber = nextLineNumber(hunk.lines, 'newLineNumber', hunk.newStart)
    hunk.addedLines += 1
    file.addedLines += 1
  } else if (rawLine.startsWith('-') && !rawLine.startsWith('---')) {
    kind = 'remove'
    content = rawLine.slice(1)
    oldLineNumber = nextLineNumber(hunk.lines, 'oldLineNumber', hunk.oldStart)
    hunk.removedLines += 1
    file.removedLines += 1
  } else if (rawLine.startsWith(' ') || rawLine === '') {
    kind = 'context'
    content = rawLine.startsWith(' ') ? rawLine.slice(1) : rawLine
    oldLineNumber = nextLineNumber(hunk.lines, 'oldLineNumber', hunk.oldStart)
    newLineNumber = nextLineNumber(hunk.lines, 'newLineNumber', hunk.newStart)
  } else {
    kind = 'meta'
  }

  hunk.lines.push({
    kind,
    content,
    oldLineNumber,
    newLineNumber,
  })
}

function splitCellFromLine(line: UiDiffReviewLine, side: 'old' | 'new'): UiDiffSplitCell {
  return {
    kind: line.kind,
    content: line.content,
    lineNumber: side === 'old' ? line.oldLineNumber : line.newLineNumber,
  }
}

function emptySplitCell(): UiDiffSplitCell {
  return {
    kind: 'empty',
    content: '',
    lineNumber: null,
  }
}

function collectConsecutiveLines(lines: UiDiffReviewLine[], startIndex: number, kind: UiDiffLineKind): UiDiffReviewLine[] {
  const collected: UiDiffReviewLine[] = []
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line || line.kind !== kind) break
    collected.push(line)
  }
  return collected
}

export function buildSplitDiffRows(lines: UiDiffReviewLine[]): UiDiffSplitRow[] {
  const rows: UiDiffSplitRow[] = []

  for (let index = 0; index < lines.length;) {
    const line = lines[index]
    if (!line) break

    if (line.kind === 'remove') {
      const removedLines = collectConsecutiveLines(lines, index, 'remove')
      const addedLines = collectConsecutiveLines(lines, index + removedLines.length, 'add')
      const pairCount = Math.max(removedLines.length, addedLines.length)

      for (let pairIndex = 0; pairIndex < pairCount; pairIndex += 1) {
        const oldLine = removedLines[pairIndex]
        const newLine = addedLines[pairIndex]
        rows.push({
          old: oldLine ? splitCellFromLine(oldLine, 'old') : emptySplitCell(),
          new: newLine ? splitCellFromLine(newLine, 'new') : emptySplitCell(),
        })
      }

      index += removedLines.length + addedLines.length
      continue
    }

    if (line.kind === 'add') {
      rows.push({
        old: emptySplitCell(),
        new: splitCellFromLine(line, 'new'),
      })
      index += 1
      continue
    }

    rows.push({
      old: splitCellFromLine(line, 'old'),
      new: splitCellFromLine(line, 'new'),
    })
    index += 1
  }

  return rows
}

export function sliceDiffHunkLines(lines: UiDiffReviewLine[], limit: number): UiDiffHunkLineSlice {
  const normalizedLimit = Math.max(Math.trunc(limit), 0)
  if (normalizedLimit <= 0 || lines.length <= normalizedLimit) {
    return {
      lines,
      hiddenCount: 0,
    }
  }

  return {
    lines: lines.slice(0, normalizedLimit),
    hiddenCount: lines.length - normalizedLimit,
  }
}

function finalizeFile(file: MutableDiffFile | null, files: MutableDiffFile[]): void {
  if (!file) return
  file.patch = file.patchLines.join('\n').trimEnd()
  files.push(file)
}

function inferStatusFromPatch(file: MutableDiffFile): string {
  const patch = file.patchLines.join('\n')
  if (patch.includes('\nnew file mode ')) return 'added'
  if (patch.includes('\ndeleted file mode ')) return 'deleted'
  if (patch.includes('\nrename from ') || patch.includes('\nrename to ')) return 'renamed'
  return file.status
}

function parseUnifiedPatch(patch: string, messageId: string, fallbackPaths: string[]): MutableDiffFile[] {
  const files: MutableDiffFile[] = []
  const lines = patch.replace(/\r\n/gu, '\n').split('\n')
  let currentFile: MutableDiffFile | null = null
  let currentHunk: UiDiffReviewHunk | null = null
  let fallbackIndex = 0

  for (const rawLine of lines) {
    if (rawLine.startsWith('diff --git ')) {
      if (currentFile) {
        currentFile.status = inferStatusFromPatch(currentFile)
      }
      finalizeFile(currentFile, files)
      const parts = rawLine.split(/\s+/u)
      const oldPath = stripDiffPath(parts[2] ?? '')
      const newPath = stripDiffPath(parts[3] ?? oldPath)
      currentFile = createFile(newPath || fallbackPaths[fallbackIndex] || `Change ${messageId}`, messageId)
      currentFile.oldPath = oldPath && oldPath !== currentFile.filePath ? oldPath : null
      currentFile.patchLines.push(rawLine)
      currentHunk = null
      fallbackIndex += 1
      continue
    }

    if (!currentFile && rawLine.startsWith('@@')) {
      currentFile = createFile(fallbackPaths[fallbackIndex] || `Change ${messageId}`, messageId)
      fallbackIndex += 1
    }

    if (!currentFile) continue

    currentFile.patchLines.push(rawLine)

    if (rawLine.startsWith('--- ')) {
      const oldPath = stripDiffPath(rawLine.slice(4))
      currentFile.oldPath = oldPath !== '/dev/null' && oldPath !== currentFile.filePath ? oldPath : currentFile.oldPath
      continue
    }

    if (rawLine.startsWith('+++ ')) {
      const newPath = stripDiffPath(rawLine.slice(4))
      if (newPath !== '/dev/null') {
        currentFile.filePath = newPath
      }
      continue
    }

    if (rawLine.startsWith('rename from ')) {
      currentFile.oldPath = rawLine.slice('rename from '.length).trim()
      currentFile.status = 'renamed'
      continue
    }

    if (rawLine.startsWith('rename to ')) {
      currentFile.filePath = rawLine.slice('rename to '.length).trim()
      currentFile.status = 'renamed'
      continue
    }

    if (rawLine.startsWith('new file mode ')) {
      currentFile.status = 'added'
      continue
    }

    if (rawLine.startsWith('deleted file mode ')) {
      currentFile.status = 'deleted'
      continue
    }

    if (rawLine.startsWith('@@')) {
      currentHunk = createHunk(rawLine)
      currentFile.hunks.push(currentHunk)
      continue
    }

    if (currentHunk) {
      pushDiffLine(currentFile, currentHunk, rawLine)
    }
  }

  if (currentFile) {
    currentFile.status = inferStatusFromPatch(currentFile)
  }
  finalizeFile(currentFile, files)

  return files
}

function mergeFile(target: UiDiffReviewFile, source: UiDiffReviewFile): UiDiffReviewFile {
  return {
    ...target,
    oldPath: target.oldPath || source.oldPath,
    status: target.status === source.status ? target.status : 'modified',
    messageIds: Array.from(new Set([...target.messageIds, ...source.messageIds])),
    patch: [target.patch, source.patch].filter(Boolean).join('\n\n'),
    addedLines: target.addedLines + source.addedLines,
    removedLines: target.removedLines + source.removedLines,
    hunks: [...target.hunks, ...source.hunks],
  }
}

function buildDiffReviewFromSources(sources: readonly DiffPatchSource[]): UiDiffReview {
  const byPath = new Map<string, UiDiffReviewFile>()

  for (const source of sources) {
    const parsedFiles = source.patch.trim()
      ? parseUnifiedPatch(source.patch, source.id, readFallbackPaths(source.fallbackDetails ?? []))
      : []
    const filesForMessage = parsedFiles.length > 0
      ? parsedFiles
      : fallbackFilesFromDetails(source.fallbackDetails ?? [], source.id)

    for (const file of filesForMessage) {
      const immutableFile: UiDiffReviewFile = {
        ...file,
        patch: file.patch,
      }
      const existing = byPath.get(immutableFile.filePath)
      byPath.set(immutableFile.filePath, existing ? mergeFile(existing, immutableFile) : immutableFile)
    }
  }

  const files = Array.from(byPath.values()).sort((first, second) => first.filePath.localeCompare(second.filePath))
  const summary = files.reduce<UiDiffReviewSummary>(
    (accumulator, file) => ({
      fileCount: accumulator.fileCount + 1,
      hunkCount: accumulator.hunkCount + file.hunks.length,
      addedLines: accumulator.addedLines + file.addedLines,
      removedLines: accumulator.removedLines + file.removedLines,
      patch: '',
    }),
    {
      fileCount: 0,
      hunkCount: 0,
      addedLines: 0,
      removedLines: 0,
      patch: '',
    },
  )

  return {
    files,
    summary: {
      ...summary,
      patch: files.map((file) => file.patch).filter(Boolean).join('\n\n'),
    },
  }
}

/** Builds a review from Core-owned file-change transcript entries. */
export function buildDiffReview(messages: UiMessage[]): UiDiffReview {
  return buildDiffReviewFromSources(messages.flatMap((message) => {
    if (message.tool?.kind !== 'fileChange') return []
    return [{
      id: message.id,
      patch: message.tool.output ?? '',
      fallbackDetails: message.tool.details,
    }]
  }))
}

/** Builds an inspection-only review from a workspace snapshot, without
 * manufacturing a conversation message or merging it into the transcript. */
export function buildDiffReviewFromPatches(patches: readonly DiffPatchSource[]): UiDiffReview {
  return buildDiffReviewFromSources(patches)
}
