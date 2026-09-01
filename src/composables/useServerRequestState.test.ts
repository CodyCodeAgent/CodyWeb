import { ref } from 'vue'
import { describe, expect, it } from 'vitest'
import { normalizeServerRequest } from '@codycodeagent/cody-web-core/presentation'
import { useServerRequestState } from './useServerRequestState'

describe('useServerRequestState', () => {
  it('projects Core-normalized pending requests for the selected thread', () => {
    const selectedThreadId = ref('thread-1')
    const state = useServerRequestState(selectedThreadId)
    const request = normalizeServerRequest({ id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1' } })
    expect(request).not.toBeNull()
    state.upsert(request!)
    expect(state.selected.value.map((request) => request.id)).toEqual([7])
    state.remove(7)
    expect(state.all.value).toEqual([])
  })
})
