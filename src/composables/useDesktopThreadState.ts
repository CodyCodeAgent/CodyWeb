import { computed, ref } from 'vue'
import type { ConversationScrollState } from '@codycodeagent/cody-web-core/conversation'
import type { UiMessage, UiProjectGroup, UiThread } from '../types/codex'
import {
  loadProjectDisplayNames,
  loadProjectOrder,
  loadReadStateMap,
  loadSelectedThreadId,
  loadThreadScrollStateMap,
  saveSelectedThreadId,
} from './desktopStateStorage'
import { flattenThreads } from './threadGroupState'

export function useDesktopThreadState() {
  const projectGroups = ref<UiProjectGroup[]>([])
  const sourceGroups = ref<UiProjectGroup[]>([])
  const optimisticThreadById = ref<Record<string, UiThread>>({})
  const selectedThreadId = ref(loadSelectedThreadId())
  const isHiddenView = ref(false)
  const persistedMessagesByThreadId = ref<Record<string, UiMessage[]>>({})
  const inProgressById = ref<Record<string, boolean>>({})
  const eventUnreadByThreadId = ref<Record<string, boolean>>({})
  const readStateByThreadId = ref<Record<string, string>>(loadReadStateMap())
  const scrollStateByThreadId = ref<Record<string, ConversationScrollState>>(loadThreadScrollStateMap())
  const projectOrder = ref<string[]>(loadProjectOrder())
  const projectDisplayNameById = ref<Record<string, string>>(loadProjectDisplayNames())
  const loadedVersionByThreadId = ref<Record<string, string>>({})
  const loadedMessagesByThreadId = ref<Record<string, boolean>>({})
  const resumedThreadById = ref<Record<string, boolean>>({})
  const allThreads = computed(() => flattenThreads(projectGroups.value))
  const selectedThread = computed(() => allThreads.value.find((thread) => thread.id === selectedThreadId.value) ?? null)
  const selectedThreadScrollState = computed<ConversationScrollState | null>(() => scrollStateByThreadId.value[selectedThreadId.value] ?? null)

  function setSelectedThreadId(threadId: string): void {
    if (selectedThreadId.value === threadId) return
    selectedThreadId.value = threadId
    saveSelectedThreadId(threadId)
  }

  return {
    projectGroups, sourceGroups, optimisticThreadById, selectedThreadId, isHiddenView,
    persistedMessagesByThreadId,
    inProgressById, eventUnreadByThreadId, readStateByThreadId, scrollStateByThreadId,
    projectOrder, projectDisplayNameById, loadedVersionByThreadId, loadedMessagesByThreadId,
    resumedThreadById, allThreads, selectedThread, selectedThreadScrollState, setSelectedThreadId,
  }
}
