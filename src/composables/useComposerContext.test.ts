import { describe, expect, it } from 'vitest'
import {
  findComposerTrigger,
  materializeComposerContextText,
} from '@codycodeagent/cody-web-core/composer'
import {
  getContextOptionsForQuery,
  summarizeDiffContext,
  summarizeFileContext,
  summarizeFolderContext,
  summarizePreviewContext,
  summarizeProblemsContext,
  summarizeRecentThreadsContext,
  summarizeTerminalContext,
  summarizeTestResultsContext,
  summarizeWorkspaceRulesContext,
} from './useComposerContext'
import type {
  UiPortsSnapshot,
  UiProjectGroup,
  UiTerminalSessionList,
  UiToolingDiffSnapshot,
  UiWorkspaceFileContent,
  UiWorkspaceFileList,
  UiWorkspaceScriptRun,
  UiWorkspaceSnapshot,
  UiWorkspaceValidationRunHistory,
  WorkspaceComposerContext,
} from '../types/codex'

describe('useComposerContext helpers', () => {
  it('detects an @ context trigger before the cursor', () => {
    expect(findComposerTrigger('please inspect @di', 'please inspect @di'.length, '@')).toEqual({
      query: 'di',
      start: 'please inspect '.length,
      end: 'please inspect @di'.length,
    })
    expect(findComposerTrigger('email@example.com', 'email@example.com'.length, '@')).toBeNull()
    expect(findComposerTrigger('no trigger here', 'no trigger here'.length, '@')).toBeNull()
  })

  it('builds file context options from @file:path queries', () => {
    expect(getContextOptionsForQuery('file:src/App.vue')).toEqual([
      {
        kind: 'file',
        label: '@file:src/App.vue',
        description: 'Attach one workspace file by path',
        filePath: 'src/App.vue',
      },
    ])
    expect(getContextOptionsForQuery('file:')[0]).toMatchObject({
      kind: 'file',
      label: '@file:<path>',
    })
    expect(getContextOptionsForQuery('').map((option) => option.kind)).toEqual([
      'file',
      'diff',
      'folder',
      'workspace-rules',
      'terminal',
      'problems',
      'test-results',
      'preview',
      'recent-thread',
    ])
  })

  it('summarizes a diff snapshot with status and patch fences', () => {
    const snapshot: UiToolingDiffSnapshot = {
      cwd: '/repo',
      repoRoot: '/repo',
      generatedAtIso: '2026-07-05T00:00:00.000Z',
      status: ' M src/App.vue',
      patch: 'diff --git a/src/App.vue b/src/App.vue\n+hello',
    }

    const summary = summarizeDiffContext(snapshot)

    expect(summary.content).toContain('Git status:')
    expect(summary.content).toContain('```diff')
    expect(summary.content).toContain('+hello')
    expect(summary.metadata.patchLength).toBe(snapshot.patch.length)
  })

  it('summarizes folder entries with kind and size', () => {
    const listing: UiWorkspaceFileList = {
      cwd: '/repo',
      root: '/repo',
      path: '',
      parentPath: '',
      truncated: false,
      entries: [
        {
          name: 'src',
          path: 'src',
          kind: 'directory',
          sizeBytes: 0,
          modifiedAtIso: '2026-07-05T00:00:00.000Z',
        },
        {
          name: 'package.json',
          path: 'package.json',
          kind: 'file',
          sizeBytes: 1234,
          modifiedAtIso: '2026-07-05T00:00:00.000Z',
        },
      ],
    }

    const summary = summarizeFolderContext(listing)

    expect(summary.content).toContain('dir  src')
    expect(summary.content).toContain('file package.json 1,234 bytes')
    expect(summary.metadata.entryCount).toBe(2)
  })

  it('summarizes file content with metadata and a language fence', () => {
    const file: UiWorkspaceFileContent = {
      cwd: '/repo',
      root: '/repo',
      path: 'src/App.vue',
      name: 'App.vue',
      sizeBytes: 42,
      modifiedAtIso: '2026-07-05T00:00:00.000Z',
      content: '<template />',
      truncated: false,
      isBinary: false,
    }

    const summary = summarizeFileContext(file)

    expect(summary.content).toContain('Path: src/App.vue')
    expect(summary.content).toContain('````vue')
    expect(summary.content).toContain('<template />')
    expect(summary.metadata.path).toBe('src/App.vue')
  })

  it('summarizes workspace rules with bounded project context excerpts', () => {
    const snapshot: UiWorkspaceSnapshot = {
      cwd: '/repo',
      repoRoot: '/repo',
      isGitRepo: true,
      branch: 'main',
      upstream: '',
      generatedAtIso: '2026-07-05T00:00:00.000Z',
      gitStatus: {
        dirtyFileCount: 1,
        stagedFileCount: 0,
        unstagedFileCount: 1,
        untrackedFileCount: 0,
        conflictedFileCount: 0,
        files: [],
      },
      packageManager: 'npm',
      scripts: [{ name: 'test', command: 'vitest run' }],
      validationPlan: {
        generatedAtIso: '2026-07-05T00:00:00.000Z',
        items: [
          {
            id: 'test',
            kind: 'test',
            title: 'Run tests',
            priority: 'required',
            source: 'workspace_config',
            status: 'ready',
            command: 'npm test',
            scriptName: 'test',
            targetUrl: null,
            reason: 'Configured validation command.',
            evidence: {
              status: 'missing',
              runAtIso: null,
              durationMs: null,
              exitCode: null,
              problemCount: 0,
              testSummary: null,
              coverageSummary: null,
            },
          },
        ],
        requiredCount: 1,
        recommendedCount: 0,
        optionalCount: 0,
        coveredCount: 0,
        failedCount: 0,
        missingEvidenceCount: 1,
      },
      projectContext: {
        generatedAtIso: '2026-07-05T00:00:00.000Z',
        presentCount: 2,
        warnings: ['No workspace-local skills found.'],
        sources: [
          {
            id: 'agents-md',
            kind: 'agents',
            title: 'AGENTS.md',
            path: 'AGENTS.md',
            present: true,
            bytes: 48,
            excerpt: 'Use concise engineering notes.\nNever expose secrets.',
            truncated: false,
            summary: 'AGENTS.md: Use concise engineering notes.',
          },
          {
            id: 'aiignore',
            kind: 'ai_ignore',
            title: '.aiignore',
            path: '.aiignore',
            present: true,
            bytes: 12,
            excerpt: 'tmp/**',
            truncated: false,
            summary: '.aiignore: tmp/**',
          },
        ],
      },
      workspaceConfig: {
        path: '/repo/.cody-web-ui.yml',
        loaded: true,
        errors: [],
        trust: 'trusted',
        sandboxMode: 'danger',
        approvalPolicy: 'never',
        defaultModel: '',
        reasoningEffort: '',
        collaborationMode: '',
        commandPolicy: {
          allow: ['npm test'],
          deny: ['rm -rf'],
        },
        validationCommands: [{ name: 'build', command: 'npm run build' }],
        knownPorts: [{ name: 'web', port: 5173, url: 'http://127.0.0.1:5173', required: true }],
        portPolicy: {
          allow: ['5173'],
          deny: [],
          allowExternal: false,
          allowWildcard: false,
        },
        notifications: {
          enabled: false,
          events: [],
          channels: [],
        },
        theme: {
          skinId: '',
          accentColor: '',
          density: '',
          layoutPresetId: '',
          followSystem: null,
        },
        sensitivePaths: ['.env'],
        ignorePatterns: ['tmp/**'],
      },
      configFiles: {
        codyWebUi: true,
        agents: false,
        aiIgnore: true,
        gitIgnore: true,
      },
      warnings: ['danger sandbox'],
    }

    const summary = summarizeWorkspaceRulesContext(snapshot)

    expect(summary.content).toContain('test: vitest run')
    expect(summary.content).toContain('build: npm run build')
    expect(summary.content).toContain('required ready test: npm test')
    expect(summary.content).toContain('web: 5173 required http://127.0.0.1:5173')
    expect(summary.content).toContain('present | agents | AGENTS.md')
    expect(summary.content).toContain('Use concise engineering notes.')
    expect(summary.content).toContain('sensitivePaths: .env')
    expect(summary.metadata.validationCommandCount).toBe(1)
    expect(summary.metadata.projectContextPresentCount).toBe(2)
  })

  it('summarizes terminal session output tails', () => {
    const snapshot: UiTerminalSessionList = {
      cwd: '/repo',
      root: '/repo',
      generatedAtIso: '2026-07-05T00:00:00.000Z',
      sessions: [
        {
          id: 'session-1',
          cwd: '/repo',
          root: '/repo',
          packageManager: 'npm',
          scriptName: 'dev',
          command: 'npm run dev',
          status: 'running',
          pid: 123,
          startedAtIso: '2026-07-05T00:00:00.000Z',
          endedAtIso: null,
          durationMs: null,
          exitCode: null,
          signal: null,
          output: 'ready on 5173',
          truncated: false,
        },
      ],
    }

    const summary = summarizeTerminalContext(snapshot)

    expect(summary.content).toContain('npm run dev')
    expect(summary.content).toContain('ready on 5173')
    expect(summary.metadata.sessionCount).toBe(1)
  })

  it('summarizes preview ports and warnings', () => {
    const snapshot: UiPortsSnapshot = {
      cwd: '/repo',
      root: '/repo',
      generatedAtIso: '2026-07-05T00:00:00.000Z',
      ports: [
        {
          protocol: 'tcp',
          host: '127.0.0.1',
          port: 5173,
          address: '127.0.0.1:5173',
          processName: 'node',
          pid: 123,
          url: 'http://127.0.0.1:5173',
          exposure: 'loopback',
          policy: {
            status: 'allowed',
            severity: 'success',
            port: 5173,
            exposure: 'loopback',
            matchedRule: 'allow:5173',
            reason: 'Port 5173 is allowed.',
          },
        },
      ],
      knownPorts: [{ name: 'web', port: 5173, url: 'http://127.0.0.1:5173', required: true }],
      policy: {
        allow: ['5173'],
        deny: [],
        allowExternal: false,
        allowWildcard: false,
      },
      warnings: [],
    }

    const summary = summarizePreviewContext(snapshot)

    expect(summary.content).toContain('http://127.0.0.1:5173')
    expect(summary.content).toContain('exposure=loopback')
    expect(summary.content).toContain('policy=allowed:allow:5173')
    expect(summary.metadata.activePortCount).toBe(1)
  })

  it('summarizes validation problems and test results from run history', () => {
    const run: UiWorkspaceScriptRun = {
      cwd: '/repo',
      repoRoot: '/repo',
      packageManager: 'npm',
      scriptName: 'test',
      command: 'npm test',
      status: 'failed',
      exitCode: 1,
      signal: null,
      startedAtIso: '2026-07-05T00:00:00.000Z',
      endedAtIso: '2026-07-05T00:00:01.000Z',
      durationMs: 1000,
      stdout: '',
      stderr: 'src/App.vue:10:5 test failed',
      output: 'src/App.vue:10:5 test failed',
      truncated: false,
      problems: [
        {
          id: 'problem-1',
          severity: 'error',
          source: 'generic',
          message: 'test failed',
          filePath: 'src/App.vue',
          line: 10,
          column: 5,
          command: 'npm test',
          rawLine: 'src/App.vue:10:5 test failed',
        },
      ],
    }
    const history: UiWorkspaceValidationRunHistory = {
      cwd: '/repo',
      repoRoot: '/repo',
      generatedAtIso: '2026-07-05T00:00:02.000Z',
      runs: [run],
      truncated: false,
    }

    const problems = summarizeProblemsContext(history)
    const results = summarizeTestResultsContext(history)

    expect(problems.content).toContain('ERROR src/App.vue:10:5 test failed')
    expect(problems.metadata.problemCount).toBe(1)
    expect(results.content).toContain('Status: failed')
    expect(results.content).toContain('npm test')
    expect(results.metadata.failedRunCount).toBe(1)
  })

  it('summarizes recent threads for the active workspace', () => {
    const groups: UiProjectGroup[] = [
      {
        projectName: 'repo',
        cwd: '/repo',
        threads: [
          {
            id: 'thread-1',
            title: 'Fix tests',
            projectName: 'repo',
            cwd: '/repo',
            createdAtIso: '2026-07-05T00:00:00.000Z',
            updatedAtIso: '2026-07-05T00:01:00.000Z',
            preview: 'Need to fix tests',
            unread: false,
            inProgress: true,
          },
        ],
      },
    ]

    const summary = summarizeRecentThreadsContext(groups, '/repo')

    expect(summary.content).toContain('Fix tests')
    expect(summary.content).toContain('running')
    expect(summary.metadata.threadCount).toBe(1)
  })

  it('materializes selected contexts after the user draft', () => {
    const context: WorkspaceComposerContext = {
      id: 'diff:1',
      kind: 'diff',
      label: '@diff',
      description: 'Current git status and patch',
      content: 'Patch body',
      createdAtIso: '2026-07-05T00:00:00.000Z',
      metadata: {},
    }

    expect(materializeComposerContextText('review this', [context])).toBe(
      'review this\n\n## Attached Workspace Context\n\n### @diff\nCurrent git status and patch\nPatch body',
    )
    expect(materializeComposerContextText('review this', [])).toBe('review this')
  })
})
