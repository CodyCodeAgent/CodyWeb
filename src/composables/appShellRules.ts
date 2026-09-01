import type { UiMessage, UiProjectGroup, UiThread } from '../types/codex'

export type AppShellFolderOption = {
  value: string
  label: string
}

export function basenameFromPath(value: string): string {
  const parts = value.split('/').filter(Boolean)
  return parts.at(-1) ?? value
}

export function normalizeAppMessageType(rawType: string | undefined, role: string): string {
  const normalized = (rawType ?? '').trim()
  if (normalized.length > 0) return normalized
  return role.trim() || 'message'
}

export function isVisibleAppConversationMessage(message: Pick<UiMessage, 'messageType' | 'role' | 'outbox'>): boolean {
  const type = normalizeAppMessageType(message.messageType, message.role)
  // A failed pre-admission command is owned by the retryable composer outbox.
  // Keeping it in the transcript as well would give one logical message two
  // presentation owners and render it twice.
  if (message.role === 'user' && message.outbox?.status === 'failed') return false
  if (type === 'worked') return true
  return type !== 'turnActivity.live' && type !== 'turnError.live' && type !== 'agentReasoning.live'
}

export function filterAppConversationMessages(messages: UiMessage[]): UiMessage[] {
  return messages.filter(isVisibleAppConversationMessage)
}

export function knownThreadIds(groups: UiProjectGroup[]): Set<string> {
  const ids = new Set<string>()
  for (const group of groups) {
    for (const thread of group.threads) {
      ids.add(thread.id)
    }
  }
  return ids
}

export function appContentTitle(input: {
  isHomeRoute: boolean
  isSettingsRoute?: boolean
  selectedThread: Pick<UiThread, 'title'> | null | undefined
}): string {
  if (input.isSettingsRoute) return 'Settings'
  if (input.isHomeRoute) return 'New thread'
  return input.selectedThread?.title ?? 'Choose a thread'
}

export function autoRefreshLabel(input: {
  isEnabled: boolean
  secondsLeft: number
}): string {
  return input.isEnabled
    ? `Auto refresh in ${String(input.secondsLeft)}s`
    : 'Enable 4s refresh'
}

export function composerThreadContextId(input: {
  isHomeRoute: boolean
  selectedThreadId: string
}): string {
  return input.isHomeRoute ? '__new-thread__' : input.selectedThreadId
}

export function shouldShowThreadWorkLogAction(input: {
  isHomeRoute: boolean
  isSettingsRoute: boolean
  selectedThreadId: string
}): boolean {
  return !input.isHomeRoute && !input.isSettingsRoute && input.selectedThreadId.trim().length > 0
}

export function threadComposerBusyLabel(input: {
  isSendingMessage: boolean
  isSelectedThreadInProgress: boolean
}): string {
  if (!input.isSendingMessage) return ''
  return input.isSelectedThreadInProgress ? 'Sending guidance...' : 'Starting response...'
}

export function homeComposerBusyLabel(isSendingMessage: boolean): string {
  return isSendingMessage ? 'Creating thread...' : ''
}

export function directoryPickerInitialPath(input: {
  newThreadCwd: string
  selectedThread: Pick<UiThread, 'cwd'> | null | undefined
}): string {
  return input.newThreadCwd || input.selectedThread?.cwd || ''
}

export function buildNewThreadFolderOptions(input: {
  groups: UiProjectGroup[]
  projectDisplayNameById: Record<string, string>
  selectedCwd: string
}): AppShellFolderOption[] {
  const options: AppShellFolderOption[] = []
  const seenCwds = new Set<string>()

  for (const group of input.groups) {
    const cwd = group.threads[0]?.cwd?.trim() ?? ''
    if (!cwd || seenCwds.has(cwd)) continue
    seenCwds.add(cwd)
    options.push({
      value: cwd,
      label: input.projectDisplayNameById[group.projectName] ?? basenameFromPath(group.projectName),
    })
  }

  const selectedCwd = input.selectedCwd.trim()
  if (selectedCwd && !seenCwds.has(selectedCwd)) {
    options.unshift({
      value: selectedCwd,
      label: input.projectDisplayNameById[selectedCwd] ?? basenameFromPath(selectedCwd),
    })
  }

  return options
}

export function findNewThreadWorkspaceGroup(
  groups: UiProjectGroup[],
  newThreadCwd: string,
): UiProjectGroup | null {
  return groups.find((group) =>
    group.cwd === newThreadCwd || group.threads.some((thread) => thread.cwd === newThreadCwd),
  ) ?? null
}

export function newThreadProjectLabel(input: {
  group: UiProjectGroup | null
  newThreadCwd: string
  projectDisplayNameById: Record<string, string>
}): string {
  if (!input.group) return basenameFromPath(input.newThreadCwd)
  return input.projectDisplayNameById[input.group.projectName] ?? basenameFromPath(input.group.projectName)
}
