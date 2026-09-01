import { computed, ref, type Ref } from 'vue'
import { fetchPendingServerRequests, respondServerRequest } from '../api/codexBridgeClient'
import type { UiServerRequest, UiServerRequestReply } from '../types/codex'
import {
  flattenServerRequests,
  normalizeServerRequest,
  removeServerRequestById,
  selectServerRequestsForThread,
  upsertServerRequest,
} from '@codycodeagent/cody-web-core/presentation'

export function useServerRequestState(selectedThreadId: Ref<string>, onError?: (message: string) => void) {
  const byThreadId = ref<Record<string, UiServerRequest[]>>({})
  const selected = computed(() => selectServerRequestsForThread(byThreadId.value, selectedThreadId.value))
  const all = computed(() => flattenServerRequests(byThreadId.value))
  function upsert(request: UiServerRequest): void { byThreadId.value = upsertServerRequest(byThreadId.value, request) }
  function remove(requestId: number): void { byThreadId.value = removeServerRequestById(byThreadId.value, requestId) }
  async function load(): Promise<void> {
    try {
      for (const row of await fetchPendingServerRequests()) {
        const request = normalizeServerRequest(row)
        if (request) upsert(request)
      }
    } catch {
      // Pending approvals are also delivered through realtime events.
    }
  }
  async function respond(reply: UiServerRequestReply): Promise<void> {
    try {
      await respondServerRequest({ id: reply.id, approvalScope: reply.approvalScope, result: reply.result, error: reply.error })
      remove(reply.id)
    } catch (error) {
      onError?.(error instanceof Error ? error.message : 'Failed to reply to server request')
    }
  }
  return { byThreadId, selected, all, upsert, remove, load, respond }
}
