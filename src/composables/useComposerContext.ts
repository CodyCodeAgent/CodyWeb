import { computed, ref } from 'vue'
import {
  findComposerTrigger,
  type ComposerTrigger,
} from '@codycodeagent/cody-web-core/composer'
import { fetchTerminalSessions } from '../api/codexTerminalClient'
import {
  fetchWorkspacePorts,
  fetchWorkspaceDiff,
  fetchWorkspaceFile,
  fetchWorkspaceFiles,
  fetchWorkspaceSnapshot,
  fetchWorkspaceValidationRuns,
} from '../api/codexWorkspaceResourcesClient'
import { getThreadGroups } from '../api/codexThreadClient'
import type {
  UiComposerContextKind,
  UiPortsSnapshot,
  UiProjectGroup,
  UiTerminalSessionList,
  UiToolingDiffSnapshot,
  UiWorkspaceFileContent,
  UiWorkspaceFileList,
  UiWorkspaceSnapshot,
  UiWorkspaceValidationRunHistory,
  WorkspaceComposerContext,
} from '../types/codex'

export type UiComposerContextOption = {
  kind: UiComposerContextKind
  label: string
  description: string
  filePath?: string
}

const MAX_CONTEXT_CHARS = 48000
const MAX_FOLDER_ENTRIES = 120

export const COMPOSER_CONTEXT_OPTIONS: UiComposerContextOption[] = [
  {
    kind: 'file',
    label: '@file:<path>',
    description: 'Attach one workspace file by path',
  },
  {
    kind: 'diff',
    label: '@diff',
    description: 'Current git status and patch',
  },
  {
    kind: 'folder',
    label: '@folder',
    description: 'Top-level workspace tree',
  },
  {
    kind: 'workspace-rules',
    label: '@workspace-rules',
    description: 'Workspace scripts, config, ports, and warnings',
  },
  {
    kind: 'terminal',
    label: '@terminal',
    description: 'Recent workspace terminal sessions and output tails',
  },
  {
    kind: 'problems',
    label: '@problems',
    description: 'Parsed diagnostics from recent validation runs',
  },
  {
    kind: 'test-results',
    label: '@test-results',
    description: 'Recent validation commands, status, and output excerpts',
  },
  {
    kind: 'preview',
    label: '@preview',
    description: 'Listening ports and preview URLs',
  },
  {
    kind: 'recent-thread',
    label: '@recent-thread',
    description: 'Recent Codex threads in this workspace',
  },
]

function truncateContext(value: string, limit = MAX_CONTEXT_CHARS): { content: string; truncated: boolean } {
  if (value.length <= limit) return { content: value, truncated: false }
  const omitted = value.length - limit
  return {
    content: `${value.slice(0, limit)}\n\n[Truncated ${omitted.toLocaleString()} characters from this context.]`,
    truncated: true,
  }
}

function contextSelectionKey(context: WorkspaceComposerContext): string {
  if (context.kind !== 'file') return context.kind
  const filePath = typeof context.metadata.path === 'string' ? context.metadata.path : context.label
  return `${context.kind}:${filePath}`
}

function optionSelectionKey(option: UiComposerContextOption): string {
  return option.kind === 'file' ? `${option.kind}:${option.filePath ?? ''}` : option.kind
}

function languageFromPath(path: string): string {
  const extension = path.split('.').pop()?.toLowerCase() ?? ''
  const known: Record<string, string> = {
    css: 'css',
    html: 'html',
    js: 'javascript',
    json: 'json',
    jsx: 'jsx',
    md: 'markdown',
    ts: 'typescript',
    tsx: 'tsx',
    vue: 'vue',
    yml: 'yaml',
    yaml: 'yaml',
  }
  return known[extension] ?? 'text'
}

export function getContextOptionsForQuery(query: string): UiComposerContextOption[] {
  const normalizedQuery = query.toLowerCase()
  const filePrefix = 'file:'
  if (normalizedQuery.startsWith(filePrefix)) {
    const filePath = query.slice(filePrefix.length).trim()
    if (!filePath) {
      return [
        {
          kind: 'file',
          label: '@file:<path>',
          description: 'Type a workspace-relative path after @file:',
        },
      ]
    }
    return [
      {
        kind: 'file',
        label: `@file:${filePath}`,
        description: 'Attach one workspace file by path',
        filePath,
      },
    ]
  }

  return COMPOSER_CONTEXT_OPTIONS.filter((option) => {
    if (!normalizedQuery) return true
    return (
      option.kind.includes(normalizedQuery) ||
      option.label.toLowerCase().includes(normalizedQuery) ||
      option.description.toLowerCase().includes(normalizedQuery)
    )
  })
}

export function summarizeDiffContext(snapshot: UiToolingDiffSnapshot): {
  content: string
  metadata: WorkspaceComposerContext['metadata']
} {
  const status = snapshot.status.trim() || '(clean)'
  const patch = snapshot.patch.trim() || '(no patch)'
  const truncated = truncateContext(patch)
  return {
    content: [
      `Generated at: ${snapshot.generatedAtIso}`,
      `Repo root: ${snapshot.repoRoot}`,
      '',
      'Git status:',
      '```text',
      status,
      '```',
      '',
      'Patch:',
      '```diff',
      truncated.content,
      '```',
    ].join('\n'),
    metadata: {
      repoRoot: snapshot.repoRoot,
      statusLength: snapshot.status.length,
      patchLength: snapshot.patch.length,
      truncated: truncated.truncated,
    },
  }
}

export function summarizeFolderContext(listing: UiWorkspaceFileList): {
  content: string
  metadata: WorkspaceComposerContext['metadata']
} {
  const entries = listing.entries.slice(0, MAX_FOLDER_ENTRIES)
  const lines = entries.map((entry) => {
    const marker = entry.kind === 'directory' ? 'dir ' : 'file'
    const size = entry.kind === 'file' ? ` ${entry.sizeBytes.toLocaleString()} bytes` : ''
    return `${marker.padEnd(4, ' ')} ${entry.path}${size}`
  })
  const truncated = listing.truncated || listing.entries.length > entries.length
  if (truncated) {
    lines.push(`[Truncated ${Math.max(0, listing.entries.length - entries.length).toLocaleString()} entries.]`)
  }

  return {
    content: [
      `Workspace root: ${listing.root}`,
      `Path: ${listing.path || '.'}`,
      '',
      'Entries:',
      '```text',
      lines.length > 0 ? lines.join('\n') : '(empty)',
      '```',
    ].join('\n'),
    metadata: {
      root: listing.root,
      path: listing.path || '.',
      entryCount: listing.entries.length,
      truncated,
    },
  }
}

export function summarizeFileContext(file: UiWorkspaceFileContent): {
  content: string
  metadata: WorkspaceComposerContext['metadata']
} {
  const language = languageFromPath(file.path)
  const binaryMessage = file.isBinary ? '[Binary file omitted by workspace file reader.]' : file.content
  const content = file.truncated && !file.isBinary ? `${binaryMessage}\n\n[File content was truncated by reader.]` : binaryMessage
  return {
    content: [
      `Workspace root: ${file.root}`,
      `Path: ${file.path}`,
      `Size: ${file.sizeBytes.toLocaleString()} bytes`,
      `Modified: ${file.modifiedAtIso}`,
      `Binary: ${String(file.isBinary)}`,
      `Truncated: ${String(file.truncated)}`,
      '',
      'Content:',
      `\`\`\`\`${language}`,
      content,
      '````',
    ].join('\n'),
    metadata: {
      root: file.root,
      path: file.path,
      sizeBytes: file.sizeBytes,
      truncated: file.truncated,
      isBinary: file.isBinary,
    },
  }
}

export function summarizeTerminalContext(snapshot: UiTerminalSessionList): {
  content: string
  metadata: WorkspaceComposerContext['metadata']
} {
  const sessions = snapshot.sessions.slice(0, 5)
  const blocks = sessions.map((session) => {
    const outputTail = session.output.length > 12000
      ? `[Output tail]\n${session.output.slice(-12000)}`
      : session.output || '(no output captured)'
    return [
      `Session: ${session.id}`,
      `Script: ${session.scriptName}`,
      `Command: ${session.command}`,
      `Status: ${session.status}`,
      `Started: ${session.startedAtIso}`,
      `Ended: ${session.endedAtIso ?? '(running)'}`,
      `Exit: ${session.exitCode === null ? '(none)' : String(session.exitCode)}`,
      `Truncated: ${String(session.truncated)}`,
      '',
      'Output:',
      '```text',
      outputTail,
      '```',
    ].join('\n')
  })

  return {
    content: [
      `Generated at: ${snapshot.generatedAtIso}`,
      `Workspace root: ${snapshot.root}`,
      '',
      sessions.length > 0 ? blocks.join('\n\n---\n\n') : 'No terminal sessions captured for this workspace.',
    ].join('\n'),
    metadata: {
      root: snapshot.root,
      sessionCount: snapshot.sessions.length,
      includedSessionCount: sessions.length,
    },
  }
}

export function summarizePreviewContext(snapshot: UiPortsSnapshot): {
  content: string
  metadata: WorkspaceComposerContext['metadata']
} {
  const activePorts = snapshot.ports.map((port) =>
    [
      `${port.url}`,
      `process=${port.processName}`,
      `pid=${String(port.pid)}`,
      `address=${port.address}`,
      `exposure=${port.exposure}`,
      `policy=${port.policy.status}${port.policy.matchedRule ? `:${port.policy.matchedRule}` : ''}`,
    ].join(' '),
  )
  const knownPorts = snapshot.knownPorts.map((port) =>
    `${port.name}: ${String(port.port)}${port.required ? ' required' : ''}${port.url ? ` ${port.url}` : ''}`,
  )
  const warnings = snapshot.warnings.length > 0 ? snapshot.warnings : ['(none)']

  return {
    content: [
      `Generated at: ${snapshot.generatedAtIso}`,
      `Workspace root: ${snapshot.root}`,
      '',
      'Active listening ports:',
      '```text',
      activePorts.length > 0 ? activePorts.join('\n') : '(none)',
      '```',
      '',
      'Known preview ports:',
      '```text',
      knownPorts.length > 0 ? knownPorts.join('\n') : '(none)',
      '```',
      '',
      'Warnings:',
      '```text',
      warnings.join('\n'),
      '```',
    ].join('\n'),
    metadata: {
      root: snapshot.root,
      activePortCount: snapshot.ports.length,
      knownPortCount: snapshot.knownPorts.length,
      warningCount: snapshot.warnings.length,
    },
  }
}

export function summarizeProblemsContext(history: UiWorkspaceValidationRunHistory): {
  content: string
  metadata: WorkspaceComposerContext['metadata']
} {
  const problems = history.runs.flatMap((run) =>
    run.problems.map((problem) => ({
      ...problem,
      runCommand: run.command,
      runStatus: run.status,
      runEndedAtIso: run.endedAtIso,
    })),
  ).slice(0, 50)
  const lines = problems.map((problem) => {
    const location = problem.filePath
      ? `${problem.filePath}${problem.line === null ? '' : `:${String(problem.line)}`}${problem.column === null ? '' : `:${String(problem.column)}`}`
      : 'command output'
    return `${problem.severity.toUpperCase()} ${location} ${problem.message} [${problem.source}; ${problem.runCommand}; ${problem.runEndedAtIso}]`
  })

  return {
    content: [
      `Generated at: ${history.generatedAtIso}`,
      `Repo root: ${history.repoRoot}`,
      `Recent validation runs inspected: ${String(history.runs.length)}`,
      '',
      'Parsed problems:',
      '```text',
      lines.length > 0 ? lines.join('\n') : 'No parsed problems captured in recent validation runs.',
      '```',
    ].join('\n'),
    metadata: {
      repoRoot: history.repoRoot,
      runCount: history.runs.length,
      problemCount: problems.length,
      truncated: history.truncated,
    },
  }
}

export function summarizeTestResultsContext(history: UiWorkspaceValidationRunHistory): {
  content: string
  metadata: WorkspaceComposerContext['metadata']
} {
  const runs = history.runs.slice(0, 8)
  const blocks = runs.map((run) => {
    const output = run.output.length > 16000 ? `${run.output.slice(0, 16000)}\n\n[Output truncated for context.]` : run.output
    return [
      `Script: ${run.scriptName}`,
      `Command: ${run.command}`,
      `Status: ${run.status}`,
      `Exit: ${run.exitCode === null ? '(none)' : String(run.exitCode)}`,
      `Started: ${run.startedAtIso}`,
      `Ended: ${run.endedAtIso}`,
      `Duration: ${String(run.durationMs)}ms`,
      `Problems: ${String(run.problems.length)}`,
      `Truncated: ${String(run.truncated)}`,
      '',
      'Output:',
      '```text',
      output || '(no output captured)',
      '```',
    ].join('\n')
  })

  return {
    content: [
      `Generated at: ${history.generatedAtIso}`,
      `Repo root: ${history.repoRoot}`,
      '',
      blocks.length > 0 ? blocks.join('\n\n---\n\n') : 'No validation runs captured yet.',
    ].join('\n'),
    metadata: {
      repoRoot: history.repoRoot,
      runCount: history.runs.length,
      includedRunCount: runs.length,
      failedRunCount: history.runs.filter((run) => run.status !== 'passed').length,
      truncated: history.truncated,
    },
  }
}

export function summarizeRecentThreadsContext(groups: UiProjectGroup[], cwd: string): {
  content: string
  metadata: WorkspaceComposerContext['metadata']
} {
  const targetCwd = cwd.trim()
  const threads = groups
    .filter((group) => !targetCwd || group.cwd === targetCwd)
    .flatMap((group) => group.threads.map((thread) => ({ ...thread, groupName: group.projectName })))
    .sort((first, second) => second.updatedAtIso.localeCompare(first.updatedAtIso))
    .slice(0, 10)
  const lines = threads.map((thread) =>
    [
      thread.updatedAtIso,
      thread.inProgress ? 'running' : 'idle',
      thread.title,
      `id=${thread.id}`,
      `project=${thread.groupName}`,
      `preview=${thread.preview || '(none)'}`,
    ].join(' | '),
  )

  return {
    content: [
      `Workspace: ${targetCwd || '(all)'}`,
      '',
      'Recent threads:',
      '```text',
      lines.length > 0 ? lines.join('\n') : 'No recent threads found for this workspace.',
      '```',
    ].join('\n'),
    metadata: {
      cwd: targetCwd,
      threadCount: threads.length,
    },
  }
}

export function summarizeWorkspaceRulesContext(snapshot: UiWorkspaceSnapshot): {
  content: string
  metadata: WorkspaceComposerContext['metadata']
} {
  const config = snapshot.workspaceConfig
  const scripts = snapshot.scripts.map((script) => `${script.name}: ${script.command}`)
  const validation = config.validationCommands.map((command) => `${command.name}: ${command.command}`)
  const ports = config.knownPorts.map((port) => {
    const url = port.url ? ` ${port.url}` : ''
    return `${port.name}: ${port.port}${port.required ? ' required' : ''}${url}`
  })
  const validationPlan = snapshot.validationPlan.items.map((item) => {
    const target = item.command || item.targetUrl || '(manual)'
    return `${item.priority} ${item.status} ${item.kind}: ${target}`
  })
  const contextSources = snapshot.projectContext.sources.map((source) =>
    [
      source.present ? 'present' : 'missing',
      source.kind,
      source.path,
      source.summary,
    ].join(' | '),
  )
  const contextExcerpts = snapshot.projectContext.sources
    .filter((source) => source.present && source.excerpt.trim().length > 0)
    .slice(0, 8)
    .flatMap((source) => [
      `### ${source.title} (${source.path})`,
      '```text',
      source.excerpt.trim(),
      '```',
      '',
    ])
  const warnings = snapshot.warnings.length > 0 ? snapshot.warnings : ['(none)']

  return {
    content: [
      `Generated at: ${snapshot.generatedAtIso}`,
      `Repo root: ${snapshot.repoRoot}`,
      `Branch: ${snapshot.branch || '(unknown)'}`,
      '',
      'Workspace config:',
      '```yaml',
      `path: ${config.path ?? '(none)'}`,
      `loaded: ${String(config.loaded)}`,
      `trust: ${config.trust}`,
      `sandboxMode: ${config.sandboxMode}`,
      `approvalPolicy: ${config.approvalPolicy || '(default)'}`,
      `collaborationMode: ${config.collaborationMode || '(default)'}`,
      `defaultModel: ${config.defaultModel || '(default)'}`,
      `reasoningEffort: ${config.reasoningEffort || '(default)'}`,
      `commandPolicy.allow: ${config.commandPolicy.allow.join(', ') || '(none)'}`,
      `commandPolicy.deny: ${config.commandPolicy.deny.join(', ') || '(none)'}`,
      `sensitivePaths: ${config.sensitivePaths.join(', ') || '(none)'}`,
      `ignorePatterns: ${config.ignorePatterns.join(', ') || '(none)'}`,
      '```',
      '',
      'Scripts:',
      '```text',
      scripts.length > 0 ? scripts.join('\n') : '(none)',
      '```',
      '',
      'Validation commands:',
      '```text',
      validation.length > 0 ? validation.join('\n') : '(none)',
      '```',
      '',
      'Validation plan:',
      '```text',
      validationPlan.length > 0 ? validationPlan.join('\n') : '(none)',
      '```',
      '',
      'Known ports:',
      '```text',
      ports.length > 0 ? ports.join('\n') : '(none)',
      '```',
      '',
      'Project context sources:',
      '```text',
      contextSources.length > 0 ? contextSources.join('\n') : '(none)',
      '```',
      '',
      'Project context excerpts:',
      contextExcerpts.length > 0 ? contextExcerpts.join('\n') : '(none)',
      '',
      'Warnings:',
      '```text',
      warnings.join('\n'),
      '```',
    ].join('\n'),
    metadata: {
      repoRoot: snapshot.repoRoot,
      scriptCount: snapshot.scripts.length,
      validationCommandCount: config.validationCommands.length,
      knownPortCount: config.knownPorts.length,
      validationPlanItemCount: snapshot.validationPlan.items.length,
      projectContextSourceCount: snapshot.projectContext.sources.length,
      projectContextPresentCount: snapshot.projectContext.presentCount,
      warningCount: snapshot.warnings.length,
    },
  }
}

async function buildContextAttachment(
  option: UiComposerContextOption,
  cwd: string,
): Promise<WorkspaceComposerContext> {
  const createdAtIso = new Date().toISOString()
  if (option.kind === 'file') {
    const filePath = option.filePath?.trim()
    if (!filePath) {
      throw new Error('Type @file:<workspace-relative-path> to attach a file')
    }
    const summary = summarizeFileContext(await fetchWorkspaceFile(cwd, filePath))
    return {
      id: `${option.kind}:${filePath}:${createdAtIso}`,
      kind: option.kind,
      label: `@file:${filePath}`,
      description: option.description,
      content: summary.content,
      createdAtIso,
      metadata: summary.metadata,
    }
  }

  if (option.kind === 'diff') {
    const summary = summarizeDiffContext(await fetchWorkspaceDiff(cwd))
    return {
      id: `${option.kind}:${createdAtIso}`,
      kind: option.kind,
      label: option.label,
      description: option.description,
      content: summary.content,
      createdAtIso,
      metadata: summary.metadata,
    }
  }

  if (option.kind === 'folder') {
    const summary = summarizeFolderContext(await fetchWorkspaceFiles(cwd))
    return {
      id: `${option.kind}:${createdAtIso}`,
      kind: option.kind,
      label: option.label,
      description: option.description,
      content: summary.content,
      createdAtIso,
      metadata: summary.metadata,
    }
  }

  if (option.kind === 'terminal') {
    const summary = summarizeTerminalContext(await fetchTerminalSessions(cwd))
    return {
      id: `${option.kind}:${createdAtIso}`,
      kind: option.kind,
      label: option.label,
      description: option.description,
      content: summary.content,
      createdAtIso,
      metadata: summary.metadata,
    }
  }

  if (option.kind === 'preview') {
    const summary = summarizePreviewContext(await fetchWorkspacePorts(cwd))
    return {
      id: `${option.kind}:${createdAtIso}`,
      kind: option.kind,
      label: option.label,
      description: option.description,
      content: summary.content,
      createdAtIso,
      metadata: summary.metadata,
    }
  }

  if (option.kind === 'problems') {
    const summary = summarizeProblemsContext(await fetchWorkspaceValidationRuns(cwd, 10))
    return {
      id: `${option.kind}:${createdAtIso}`,
      kind: option.kind,
      label: option.label,
      description: option.description,
      content: summary.content,
      createdAtIso,
      metadata: summary.metadata,
    }
  }

  if (option.kind === 'test-results') {
    const summary = summarizeTestResultsContext(await fetchWorkspaceValidationRuns(cwd, 10))
    return {
      id: `${option.kind}:${createdAtIso}`,
      kind: option.kind,
      label: option.label,
      description: option.description,
      content: summary.content,
      createdAtIso,
      metadata: summary.metadata,
    }
  }

  if (option.kind === 'recent-thread') {
    const summary = summarizeRecentThreadsContext(await getThreadGroups(false), cwd)
    return {
      id: `${option.kind}:${createdAtIso}`,
      kind: option.kind,
      label: option.label,
      description: option.description,
      content: summary.content,
      createdAtIso,
      metadata: summary.metadata,
    }
  }

  const summary = summarizeWorkspaceRulesContext(await fetchWorkspaceSnapshot(cwd))
  return {
    id: `${option.kind}:${createdAtIso}`,
    kind: option.kind,
    label: option.label,
    description: option.description,
    content: summary.content,
    createdAtIso,
    metadata: summary.metadata,
  }
}

export function useComposerContext() {
  const selectedContexts = ref<WorkspaceComposerContext[]>([])
  const contextError = ref('')
  const isLoadingContext = ref(false)
  const activeTrigger = ref<ComposerTrigger | null>(null)

  const filteredContexts = computed(() => {
    const trigger = activeTrigger.value
    if (!trigger) return []

    const selectedKeys = new Set(selectedContexts.value.map((context) => contextSelectionKey(context)))
    return getContextOptionsForQuery(trigger.query).filter((option) => !selectedKeys.has(optionSelectionKey(option)))
  })

  const isContextMenuOpen = computed(() => activeTrigger.value !== null)

  function updateContextTrigger(text: string, cursor: number): void {
    activeTrigger.value = findComposerTrigger(text, cursor, '@')
  }

  async function selectContext(
    option: UiComposerContextOption,
    draft: string,
    cwd: string,
  ): Promise<{ text: string; cursor: number }> {
    const trigger = activeTrigger.value
    if (!trigger) return { text: draft, cursor: draft.length }

    const normalizedCwd = cwd.trim()
    if (!normalizedCwd) {
      contextError.value = 'Select a workspace before attaching context'
      return { text: draft, cursor: draft.length }
    }

    isLoadingContext.value = true
    contextError.value = ''
    try {
      const targetKey = optionSelectionKey(option)
      const exists = selectedContexts.value.some((context) => contextSelectionKey(context) === targetKey)
      if (!exists) {
        selectedContexts.value = [...selectedContexts.value, await buildContextAttachment(option, normalizedCwd)]
      }

      const before = draft.slice(0, trigger.start)
      const after = draft.slice(trigger.end)
      const needsSpace = before.length > 0 && !/\s$/u.test(before) && after.length > 0 && !/^\s/u.test(after)
      const nextText = `${before}${needsSpace ? ' ' : ''}${after}`.replace(/[ \t]{2,}/gu, ' ')
      const nextCursor = Math.min(before.length + (needsSpace ? 1 : 0), nextText.length)
      activeTrigger.value = null
      return { text: nextText, cursor: nextCursor }
    } catch (error) {
      contextError.value = error instanceof Error ? error.message : 'Failed to attach workspace context'
      return { text: draft, cursor: draft.length }
    } finally {
      isLoadingContext.value = false
    }
  }

  function removeContext(context: WorkspaceComposerContext): void {
    selectedContexts.value = selectedContexts.value.filter((selected) => selected.id !== context.id)
  }

  function addContextAttachment(context: WorkspaceComposerContext): void {
    const targetKey = contextSelectionKey(context)
    selectedContexts.value = [
      ...selectedContexts.value.filter((selected) => contextSelectionKey(selected) !== targetKey),
      context,
    ]
    contextError.value = ''
    activeTrigger.value = null
  }

  function closeContextMenu(): void {
    activeTrigger.value = null
  }

  function resetContexts(): void {
    selectedContexts.value = []
    activeTrigger.value = null
    contextError.value = ''
    isLoadingContext.value = false
  }

  return {
    selectedContexts,
    filteredContexts,
    isContextMenuOpen,
    isLoadingContext,
    contextError,
    updateContextTrigger,
    selectContext,
    addContextAttachment,
    removeContext,
    closeContextMenu,
    resetContexts,
  }
}
