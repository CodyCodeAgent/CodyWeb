import type { UiProjectGroup, UiThread } from '../../types/codex'
import type { CodexThreadSummary } from '@codycodeagent/cody-web-core/session'

function toProjectName(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean)
  return parts.at(-1) || cwd || 'unknown-project'
}


function groupThreadsByProject(threads: UiThread[]): UiProjectGroup[] {
  const grouped = new Map<string, UiThread[]>()
  for (const thread of threads) {
    const rows = grouped.get(thread.projectName)
    if (rows) rows.push(thread)
    else grouped.set(thread.projectName, [thread])
  }

  return Array.from(grouped.entries())
    .map(([projectName, projectThreads]) => ({
      projectName,
      cwd: projectName,
      threads: projectThreads.sort(
        (a, b) => new Date(b.updatedAtIso).getTime() - new Date(a.updatedAtIso).getTime(),
      ),
    }))
    .sort((a, b) => {
      const aLast = new Date(a.threads[0]?.updatedAtIso ?? 0).getTime()
      const bLast = new Date(b.threads[0]?.updatedAtIso ?? 0).getTime()
      return bLast - aLast
    })
}

export function normalizeCatalogThreadGroups(threads: CodexThreadSummary[]): UiProjectGroup[] {
  return groupThreadsByProject(threads.map((thread): UiThread => ({
    id: thread.threadId,
    title: thread.name || thread.preview || 'Untitled thread',
    projectName: thread.cwd || toProjectName(thread.cwd),
    cwd: thread.cwd,
    createdAtIso: thread.createdAtIso,
    updatedAtIso: thread.updatedAtIso,
    preview: thread.preview,
    unread: false,
    inProgress: false,
  })))
}
