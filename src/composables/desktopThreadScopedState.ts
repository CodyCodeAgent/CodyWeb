export function shouldShowMessagesLoading(params: {
  loadedMessagesByThreadId: Record<string, boolean>
  threadId: string
  silent: boolean
}): boolean {
  if (!params.threadId || params.silent) return false
  return params.loadedMessagesByThreadId[params.threadId] !== true
}

export function markThreadMessagesLoaded(
  loadedMessagesByThreadId: Record<string, boolean>,
  threadId: string,
): Record<string, boolean> {
  if (!threadId || loadedMessagesByThreadId[threadId] === true) return loadedMessagesByThreadId
  return { ...loadedMessagesByThreadId, [threadId]: true }
}

export function setThreadLoadedVersion(
  loadedVersionByThreadId: Record<string, string>,
  threadId: string,
  version: string,
): Record<string, string> {
  if (!threadId || !version || loadedVersionByThreadId[threadId] === version) return loadedVersionByThreadId
  return { ...loadedVersionByThreadId, [threadId]: version }
}
