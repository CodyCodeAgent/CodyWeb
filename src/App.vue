<template>
  <DesktopLayout
    :is-sidebar-collapsed="isEffectiveSidebarCollapsed"
    :class="themeRootClass"
    v-bind="themeAttributes"
  >
    <template #sidebar>
      <section class="sidebar-root" data-cody-region="sidebar-content">
          <div class="sidebar-brand">
            <span :data-skin-label="activeSkin.manifest.chromeLabel ?? ''">CODY / CONTROL</span>
        </div>
        <SidebarThreadControls
          v-if="!isEffectiveSidebarCollapsed"
          class="sidebar-thread-controls-host"
          :is-sidebar-collapsed="isEffectiveSidebarCollapsed"
          :is-auto-refresh-enabled="isAutoRefreshEnabled"
          :auto-refresh-button-label="autoRefreshButtonLabel"
          :show-new-thread-button="true"
          @toggle-sidebar="setSidebarCollapsed(!isSidebarCollapsed)"
          @toggle-auto-refresh="onToggleAutoRefreshTimer"
          @start-new-thread="onStartNewThreadFromToolbar"
        >
          <button
            class="sidebar-search-toggle toolbar-secondary"
            type="button"
            :disabled="areSidebarProjectsCollapsed || projectGroups.length === 0"
            :aria-label="t('app.collapseAllProjects')"
            :title="t('app.collapseAllProjects')"
            @click="collapseAllSidebarProjects"
          >
            <IconTablerChevronsUp class="sidebar-search-toggle-icon" />
          </button>
          <button
            class="sidebar-search-toggle toolbar-secondary"
            type="button"
            data-theme-toggle="true"
            :disabled="!canToggleColorMode"
            :aria-pressed="isDarkMode"
            :aria-label="canToggleColorMode ? (isDarkMode ? t('app.theme.light') : t('app.theme.dark')) : t('app.theme.unavailable')"
            :title="canToggleColorMode ? (isDarkMode ? t('app.theme.light') : t('app.theme.dark')) : t('app.theme.unavailable')"
            @click="toggleDarkMode"
          >
            <IconTablerSun v-if="isDarkMode" class="sidebar-search-toggle-icon" />
            <IconTablerMoon v-else class="sidebar-search-toggle-icon" />
          </button>
          <button
            class="sidebar-search-toggle toolbar-secondary"
            type="button"
            :aria-pressed="isSidebarSearchVisible"
            :aria-label="t('app.searchThreads')"
            :title="t('app.searchThreads')"
            @click="toggleSidebarSearch"
          >
            <IconTablerSearch class="sidebar-search-toggle-icon" />
          </button>
          <button
            class="sidebar-search-toggle toolbar-secondary"
            type="button"
            :aria-label="t('app.addProject')"
            :title="t('app.addProject')"
            @click="openDirectoryPicker"
          >
            <IconTablerFolder class="sidebar-search-toggle-icon" />
          </button>
          <button
            class="sidebar-search-toggle toolbar-secondary"
            type="button"
            :aria-pressed="isSettingsRoute"
            :aria-label="t('nav.settings')"
            :title="t('nav.settings')"
            @click="openSettings"
          >
            <IconTablerSettings class="sidebar-search-toggle-icon" />
          </button>
        </SidebarThreadControls>

        <div v-if="!isEffectiveSidebarCollapsed && isSidebarSearchVisible" class="sidebar-search-bar">
          <IconTablerSearch class="sidebar-search-bar-icon" />
          <input
            ref="sidebarSearchInputRef"
            v-model="sidebarSearchQuery"
            class="sidebar-search-input"
            type="text"
            :placeholder="t('app.filterThreads')"
            @keydown="onSidebarSearchKeydown"
          />
          <button
            v-if="sidebarSearchQuery.length > 0"
            class="sidebar-search-clear"
            type="button"
            :aria-label="t('app.clearSearch')"
            @click="clearSidebarSearch"
          >
            <IconTablerX class="sidebar-search-clear-icon" />
          </button>
        </div>

        <SidebarThreadTree class="sidebar-thread-tree-host" :groups="projectGroups" :project-display-name-by-id="projectDisplayNameById"
          v-if="!isEffectiveSidebarCollapsed"
          :skill-counts-by-cwd="skillCountsByCwd"
          :selected-thread-id="selectedThreadId" :is-loading="isLoadingThreads"
          :selected-project-name="selectedSidebarProjectName"
          :search-query="sidebarSearchQuery" :is-hidden-view="isHiddenView"
          :collapse-all-request="sidebarCollapseAllRequest"
          @select="onSelectThread"
          @hide="onHideThread" @restore="onRestoreThread" @fork="onForkThread"
          @compact="onCompactThread" @toggle-hidden-view="onToggleHiddenView"
          @rename-thread="onRenameThread" @select-project="onSelectProject" @start-new-thread="onStartNewThread" @rename-project="onRenameProject"
          @hide-project="onHideProject" @restore-project="onRestoreProject" @reorder-project="onReorderProject"
          @collapse-state-change="areSidebarProjectsCollapsed = $event"
          @open-project-skills="onOpenProjectSkills" />
      </section>
    </template>

    <template #content>
      <section class="content-root" data-cody-region="content">
        <div class="workspace-chrome" data-cody-region="workspace-chrome">
          <ContentHeader :title="contentTitle">
          <template #leading>
            <SidebarThreadControls
              v-if="isEffectiveSidebarCollapsed"
              class="sidebar-thread-controls-header-host"
              :is-sidebar-collapsed="isEffectiveSidebarCollapsed"
              :is-auto-refresh-enabled="isAutoRefreshEnabled"
              :auto-refresh-button-label="autoRefreshButtonLabel"
              :show-new-thread-button="true"
              @toggle-sidebar="setSidebarCollapsed(!isSidebarCollapsed)"
              @toggle-auto-refresh="onToggleAutoRefreshTimer"
              @start-new-thread="onStartNewThreadFromToolbar"
            >
              <button
                class="sidebar-search-toggle toolbar-secondary"
                type="button"
                data-theme-toggle="true"
                :disabled="!canToggleColorMode"
                :aria-pressed="isDarkMode"
                :aria-label="canToggleColorMode ? (isDarkMode ? t('app.theme.light') : t('app.theme.dark')) : t('app.theme.unavailable')"
                :title="canToggleColorMode ? (isDarkMode ? t('app.theme.light') : t('app.theme.dark')) : t('app.theme.unavailable')"
                @click="toggleDarkMode"
              >
                <IconTablerSun v-if="isDarkMode" class="sidebar-search-toggle-icon" />
                <IconTablerMoon v-else class="sidebar-search-toggle-icon" />
              </button>
              <button
                class="sidebar-search-toggle toolbar-secondary"
                type="button"
                :aria-label="t('app.addProject')"
                :title="t('app.addProject')"
                @click="openDirectoryPicker"
              >
                <IconTablerFolder class="sidebar-search-toggle-icon" />
              </button>
              <button
                class="sidebar-search-toggle toolbar-secondary"
                type="button"
                :aria-pressed="isSettingsRoute"
                :aria-label="t('nav.settings')"
                :title="t('nav.settings')"
                @click="openSettings"
              >
                <IconTablerSettings class="sidebar-search-toggle-icon" />
              </button>
            </SidebarThreadControls>
          </template>
          <template #actions>
            <button
              v-if="route.name === 'thread' && selectedThread && filteredMessages.length > 0"
              class="content-prompt-trigger"
              type="button"
              :aria-label="t('conversation.share.open')"
              :title="t('conversation.share.open')"
              :aria-pressed="isConversationShareSelecting"
              :data-active="isConversationShareSelecting ? 'true' : undefined"
              @click="toggleConversationShareSelection"
            >
              <IconTablerShare3 />
            </button>
            <button
              v-if="!isSettingsRoute && !isSkillsRoute"
              class="content-prompt-trigger"
              type="button"
              :aria-label="t('promptLibrary.open')"
              :title="t('promptLibrary.aria')"
              :aria-expanded="isPromptLibraryOpen"
              @click="isPromptLibraryOpen = true"
            >
              <IconTablerClipboardList />
            </button>
            <ThreadActivityPanel
              v-if="shouldShowWorkLogAction || allPendingServerRequests.length > 0"
              :messages="filteredMessages"
              :pending-requests="allPendingServerRequests"
              :cwd="selectedThread?.cwd ?? ''"
              :thread-id="selectedThreadId"
              @respond-server-request="onRespondServerRequest"
              @rollback-completed="onRollbackCompleted"
            />
            <div class="content-notifications-host">
              <BrowserNotificationsPanel
                :preference="browserNotifications.preference.value"
                :permission="browserNotifications.permission.value"
                :events="browserNotifications.events.value"
                :unread-count="browserNotifications.unreadCount.value"
                :is-supported="browserNotifications.isSupported.value"
                :last-error="browserNotifications.lastError.value"
                @update:preference="browserNotifications.setPreference"
                @request-permission="browserNotifications.requestPermission"
                @clear="browserNotifications.clearEvents"
              />
            </div>
          </template>
          </ContentHeader>

          <div
            class="workspace-context-bar"
            data-cody-region="contextbar"
            :data-context-mode="isSettingsRoute ? 'section' : 'workspace'"
            :aria-label="isSettingsRoute ? t('settings.aria') : t('app.workspaceContext')"
          >
            <template v-if="isSettingsRoute">
              <IconTablerSettings class="workspace-context-section-icon" aria-hidden="true" />
              <span><small>{{ t('settings.page.eyebrow') }}</small>{{ t('settings.page.title') }}</span>
            </template>
            <template v-else>
              <span class="workspace-context-live" aria-hidden="true" />
              <span><small>{{ t('app.workspace') }}</small>{{ newThreadProjectLabel || t('app.notSelected') }}</span>
              <span><small>{{ t('app.path') }}</small>{{ tokenFlameCwd || '—' }}</span>
              <span><small>{{ t('app.permissions') }}</small>{{ selectedPermissionMode }}</span>
              <button
                v-if="tokenFlameCwd"
                type="button"
                :aria-label="t('skills.openProject')"
                @click="openCurrentWorkspaceSkills"
              >
                <IconTablerClipboardList aria-hidden="true" />
                {{ activeWorkspaceSkillCount === null ? t('skills.title') : t('skills.count', { count: String(activeWorkspaceSkillCount) }) }}
              </button>
              <div v-if="route.name === 'thread'" class="workspace-view-toggle" role="group" :aria-label="t('codeWorkspace.viewAria')">
                <button type="button" :data-active="!isCodeView" @click="openChatView">{{ t('codeWorkspace.chat') }}</button>
                <button type="button" :data-active="isCodeView" @click="openCodeView({})">{{ t('codeWorkspace.code') }}</button>
              </div>
            </template>
          </div>
          <ThreadContextUsageBar
            v-if="!isHomeRoute && !isSettingsRoute && !isSkillsRoute"
            :usage="selectedThreadContextUsage"
          />
        </div>

        <div
          v-if="backendConnectionBannerVisible"
          class="backend-connection-banner"
          :data-tone="backendConnectionBannerTone"
          role="status"
          aria-live="polite"
        >
          <span class="backend-connection-dot" aria-hidden="true" />
          <div class="backend-connection-copy">
            <strong>{{ backendConnectionTitle }}</strong>
            <span>{{ backendConnectionMessage }}</span>
          </div>
          <button type="button" :disabled="backendHealthCheckInFlight" @click="checkBackendHealthNow">
            {{ backendHealthCheckInFlight ? t('app.backend.checking') : t('app.backend.retry') }}
          </button>
        </div>

        <RateLimitFloatingStatus
          :snapshot="rateLimitSnapshot"
          :is-loading="isLoadingRateLimits"
          @refresh="refreshRateLimits"
        />
        <TokenFlameWidget
          v-if="!isSettingsRoute && !isSkillsRoute"
          :cwd="tokenFlameCwd"
        />
        <MissionChecklist
          v-if="!isHomeRoute && !isSettingsRoute && !isSkillsRoute"
          :thread-id="selectedThreadId"
          :plan="selectedStructuredPlan"
          :is-turn-in-progress="isSelectedThreadInProgress"
          :has-pending-approval="selectedThreadServerRequests.length > 0"
        />

        <div v-if="desktopError" class="content-error" role="alert">
          <span class="content-error-text">{{ desktopError }}</span>
          <button class="content-error-dismiss" type="button" :aria-label="t('app.dismissError')" @click="clearError">
            <IconTablerX class="content-error-dismiss-icon" />
          </button>
        </div>

        <section class="content-body"><AppRouteContent
          v-bind="{ isSettingsRoute, isSkillsRoute, isHomeRoute, newThreadProjectOptions, skillsCwd, skillsProjectLabel,
            newThreadCwd, newThreadFolderOptions, composerThreadContextId, isSendingMessage,
            promptInsertion, availableModelIds, selectedModelId, selectedReasoningEffort, collaborationModeOptions,
            selectedCollaborationModeName, selectedPermissionMode, homeComposerBusyLabel, filteredMessages,
            isLoadingMessages, selectedThread, selectedMessageLoadError, selectedThreadScrollState, liveOverlay,
            selectedThreadServerRequests, threadComposerBusyLabel,
            isSelectedThreadInProgress, isInterruptingTurn, isCodeView, contextInsertion,
            conversationShareSelecting: isConversationShareSelecting, conversationShareSelectedMessageIds }"
          @select-thread="onSelectThread" @respond-server-request="onRespondServerRequest"
          @select-new-thread-folder="onSelectNewThreadFolder" @submit-message="onSubmitThreadMessage"
          @select-model="onSelectModel" @select-reasoning-effort="onSelectReasoningEffort"
          @select-collaboration-mode="onSelectCollaborationMode" @select-permission-mode="onSelectPermissionMode"
          @update-scroll-state="onUpdateThreadScrollState" @retry-load="onRetryLoadMessages" @interrupt="onInterruptTurn"
          @open-code="openCodeView" @ask-code="onAskCode" @confirm-share-selection="onConfirmConversationShareSelection"
          @cancel-share-selection="cancelConversationShareSelection"
        /></section>
      </section>
    </template>
  </DesktopLayout>

  <DirectoryPickerModal
    v-if="isDirectoryPickerOpen"
    :initial-path="directoryPickerInitialPath"
    @close="isDirectoryPickerOpen = false"
    @select="onSelectProjectDirectory"
  />

  <NewThreadSetupModal
    v-if="isNewThreadDialogOpen"
    :projects="newThreadProjectOptions"
    :initial-cwd="newThreadDialogInitialCwd"
    @close="isNewThreadDialogOpen = false"
    @create="onCreateNewThreadFromDialog"
  />
  <PromptLibraryDrawer
    :open="isPromptLibraryOpen"
    :cwd="tokenFlameCwd"
    @close="isPromptLibraryOpen = false"
    @insert="onInsertPrompt"
  />
  <ConversationShareDialog
    v-if="isConversationShareOpen && selectedThread"
    :thread-id="selectedThread.id"
    :thread-title="selectedThread.title"
    :project-name="selectedThread.projectName"
    :messages="filteredMessages"
    :initial-selected-message-ids="conversationShareSelectedMessageIds"
    configuration-only
    @close="closeConversationShareDialog"
    @reselect="reselectConversationShareMessages"
  />
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter, type LocationQueryRaw } from 'vue-router'
import DesktopLayout from './components/layout/DesktopLayout.vue'
import SidebarThreadTree from './components/sidebar/SidebarThreadTree.vue'
import ContentHeader from './components/content/ContentHeader.vue'
import ThreadActivityPanel from './components/content/ThreadActivityPanel.vue'
import ThreadContextUsageBar from './components/content/ThreadContextUsageBar.vue'
import DirectoryPickerModal from './components/content/DirectoryPickerModal.vue'
import NewThreadSetupModal, { type NewThreadProjectOption } from './components/content/NewThreadSetupModal.vue'
import RateLimitFloatingStatus from './components/content/RateLimitFloatingStatus.vue'
import TokenFlameWidget from './components/content/TokenFlameWidget.vue'
import MissionChecklist from './components/content/MissionChecklist.vue'
import BrowserNotificationsPanel from './components/content/BrowserNotificationsPanel.vue'
import PromptLibraryDrawer from './components/content/PromptLibraryDrawer.vue'
import SidebarThreadControls from './components/sidebar/SidebarThreadControls.vue'
import AppRouteContent from './components/layout/AppRouteContent.vue'
import IconTablerFolder from './components/icons/IconTablerFolder.vue'
import IconTablerClipboardList from './components/icons/IconTablerClipboardList.vue'
import IconTablerChevronsUp from './components/icons/IconTablerChevronsUp.vue'
import IconTablerShare3 from './components/icons/IconTablerShare3.vue'
import IconTablerMoon from './components/icons/IconTablerMoon.vue'

const ConversationShareDialog = defineAsyncComponent(() => import('./components/content/ConversationShareDialog.vue'))
import IconTablerSearch from './components/icons/IconTablerSearch.vue'
import IconTablerSettings from './components/icons/IconTablerSettings.vue'
import IconTablerSun from './components/icons/IconTablerSun.vue'
import IconTablerX from './components/icons/IconTablerX.vue'
import { fetchDefaultWorkspace } from './api/codexWorkspaceResourcesClient'
import {
  autoRefreshLabel,
  buildNewThreadFolderOptions,
  composerThreadContextId as buildComposerThreadContextId,
  directoryPickerInitialPath as buildDirectoryPickerInitialPath,
  filterAppConversationMessages,
  findNewThreadWorkspaceGroup,
  homeComposerBusyLabel as buildHomeComposerBusyLabel,
  knownThreadIds,
  newThreadProjectLabel as buildNewThreadProjectLabel,
  shouldShowThreadWorkLogAction,
  threadComposerBusyLabel as buildThreadComposerBusyLabel,
} from './composables/appShellRules'
import {
  loadDefaultNewThreadCwd,
  normalizeDefaultNewThreadCwd,
  saveDefaultNewThreadCwd,
} from './composables/desktopStateStorage'
import { DESKTOP_SETTING_KEYS, DESKTOP_STORAGE_KEYS } from './composables/desktopSettingsKeys'
import { useBrowserNotifications } from './composables/useBrowserNotifications'
import { useDesktopState } from './composables/useDesktopState'
import { useLocale } from './composables/useLocale'
import { useAppRouteOrchestration } from './composables/useAppRouteOrchestration'
import { fetchUserSetting, writeUserSetting } from './api/codexSettingsClient'
import { getSkillCatalog } from './api/codexComposerClient'
import { useTheme } from './theme/useTheme'
import type {
  ReasoningEffort,
  ThreadScrollState,
  UiComposerPermissionMode,
  UiComposerContextAttachment,
  UiComposerSubmitPayload,
  UiServerRequestReply,
  UiToolingRollbackFileResult,
} from './types/codex'
import type { PromptInsertion } from './composables/promptLibraryRules'

const MOBILE_SIDEBAR_BREAKPOINT = 700
const {
  projectGroups,
  projectDisplayNameById,
  selectedThread,
  selectedThreadScrollState,
  selectedThreadServerRequests,
  selectedThreadContextUsage,
  allPendingServerRequests,
  selectedLiveOverlay,
  selectedStructuredPlan,
  selectedMessageLoadError,
  selectedThreadId,
  isHiddenView,
  rateLimitSnapshot,
  availableModelIds,
  selectedModelId,
  selectedReasoningEffort,
  selectedPermissionMode,
  collaborationModeOptions,
  selectedCollaborationModeName,
  messages,
  isLoadingThreads,
  isLoadingMessages,
  hasLoadedSelectedMessages,
  isSendingMessage,
  isInterruptingTurn,
  isLoadingRateLimits,
  isAutoRefreshEnabled,
  autoRefreshSecondsLeft,
  error: desktopError,
  clearError,
  refreshAll,
  refreshRateLimits,
  selectThread,
  loadMessages,
  setThreadScrollState,
  hideThreadById,
  restoreThreadById,
  forkThreadById,
  compactThreadById,
  setHiddenView,
  renameThreadById,
  sendMessageToSelectedThread,
  sendMessageToNewThread,
  interruptSelectedThreadTurn,
  setSelectedModelId,
  setSelectedReasoningEffort,
  setSelectedCollaborationModeName,
  setSelectedPermissionMode,
  respondToPendingServerRequest,
  renameProject,
  hideProject,
  restoreProject,
  reorderProject,
  toggleAutoRefreshTimer,
  startRealtimeSync,
  stopRealtimeSync,
  recordRollbackAudit,
} = useDesktopState()
const browserNotifications = useBrowserNotifications()
const {
  isDarkTheme: isDarkMode,
  availableColorModes,
  activeSkin,
  themeRootClass,
  themeAttributes,
  applyCurrentTheme,
  toggleLightDark,
} = useTheme()
const { t } = useLocale()
const canToggleColorMode = computed(() => availableColorModes.value.length === 2)

const route = useRoute()
const router = useRouter()
const hasInitialized = ref(false)
const newThreadCwd = ref(loadDefaultNewThreadCwd())
const pendingNewThreadName = ref('')
const newThreadDialogInitialCwd = ref('')
const isNewThreadDialogOpen = ref(false)
const isDirectoryPickerOpen = ref(false)
const isPromptLibraryOpen = ref(false)
const isConversationShareOpen = ref(false)
const isConversationShareSelecting = ref(false)
const conversationShareSelectedMessageIds = ref<string[]>([])
const promptInsertion = ref<PromptInsertion | null>(null)
const contextInsertion = ref<UiComposerContextAttachment | null>(null)
const isSidebarCollapsed = ref(loadSidebarCollapsed())
const isMobileViewport = ref(false)
const sidebarSearchQuery = ref('')
const isSidebarSearchVisible = ref(false)
const sidebarCollapseAllRequest = ref(0)
const areSidebarProjectsCollapsed = ref(false)
const skillCountsByCwd = ref<Record<string, number>>({})
const sidebarSearchInputRef = ref<HTMLInputElement | null>(null)

function collapseAllSidebarProjects(): void {
  sidebarCollapseAllRequest.value += 1
}

function toggleConversationShareSelection(): void {
  if (isConversationShareSelecting.value) {
    cancelConversationShareSelection()
    return
  }
  isConversationShareOpen.value = false
  conversationShareSelectedMessageIds.value = []
  isConversationShareSelecting.value = true
}

function cancelConversationShareSelection(): void {
  isConversationShareSelecting.value = false
  conversationShareSelectedMessageIds.value = []
}

function onConfirmConversationShareSelection(messageIds: string[]): void {
  if (messageIds.length === 0) return
  conversationShareSelectedMessageIds.value = messageIds
  isConversationShareSelecting.value = false
  isConversationShareOpen.value = true
}

function closeConversationShareDialog(): void {
  isConversationShareOpen.value = false
  conversationShareSelectedMessageIds.value = []
}

function reselectConversationShareMessages(): void {
  isConversationShareOpen.value = false
  isConversationShareSelecting.value = true
}

const {
  routeThreadId,
  isHomeRoute,
  isSettingsRoute,
  isSkillsRoute,
  skillsCwd,
  skillsProjectLabel,
  contentTitle,
} = useAppRouteOrchestration({
  projectGroups,
  projectDisplayNameById,
  selectedThread,
  newThreadCwd,
  translate: t,
})

function onInsertPrompt(insertion: PromptInsertion): void {
  promptInsertion.value = { ...insertion, id: Date.now() }
}

function openCodeView(location: { path?: string; line?: number; mode?: 'file' | 'diff' }): void {
  if (route.name !== 'thread' || !routeThreadId.value) return
  const query: LocationQueryRaw = { ...route.query, view: 'code' }
  if (location.path) query.path = location.path
  if (location.line && location.line > 1) query.line = String(location.line)
  if (location.mode === 'diff') query.mode = 'diff'
  void router.push({ name: 'thread', params: { threadId: routeThreadId.value }, query })
}

function openChatView(): void {
  if (route.name !== 'thread' || !routeThreadId.value) return
  const query = { ...route.query }
  delete query.view
  delete query.path
  delete query.line
  delete query.mode
  void router.push({ name: 'thread', params: { threadId: routeThreadId.value }, query })
}

function onAskCode(attachment: UiComposerContextAttachment): void {
  contextInsertion.value = attachment
}

const knownThreadIdSet = computed(() => knownThreadIds(projectGroups.value))
const isEffectiveSidebarCollapsed = computed(() => isSidebarCollapsed.value || isMobileViewport.value)
const isCodeView = computed(() => route.name === 'thread' && route.query.view === 'code')
const autoRefreshButtonLabel = computed(() => autoRefreshLabel({
  isEnabled: isAutoRefreshEnabled.value,
  secondsLeft: autoRefreshSecondsLeft.value,
}))
const filteredMessages = computed(() => filterAppConversationMessages(messages.value))
const liveOverlay = computed(() => selectedLiveOverlay.value)
const composerThreadContextId = computed(() => buildComposerThreadContextId({
  isHomeRoute: isHomeRoute.value,
  selectedThreadId: selectedThreadId.value,
}))
const isSelectedThreadInProgress = computed(() => !isHomeRoute.value && selectedThread.value?.inProgress === true)
const homeComposerBusyLabel = computed(() => buildHomeComposerBusyLabel(isSendingMessage.value))
const threadComposerBusyLabel = computed(() => buildThreadComposerBusyLabel({
  isSendingMessage: isSendingMessage.value,
  isSelectedThreadInProgress: isSelectedThreadInProgress.value,
}))
const shouldShowWorkLogAction = computed(() => shouldShowThreadWorkLogAction({
  isHomeRoute: isHomeRoute.value,
  isSettingsRoute: isSettingsRoute.value,
  selectedThreadId: selectedThreadId.value,
}))
const directoryPickerInitialPath = computed(() => buildDirectoryPickerInitialPath({
  newThreadCwd: newThreadCwd.value,
  selectedThread: selectedThread.value,
}))
const newThreadProjectOptions = computed<NewThreadProjectOption[]>(() =>
  newThreadFolderOptions.value.map((option) => ({
    cwd: option.value,
    label: option.label,
  })),
)
const newThreadFolderOptions = computed(() => buildNewThreadFolderOptions({
  groups: projectGroups.value,
  projectDisplayNameById: projectDisplayNameById.value,
  selectedCwd: newThreadCwd.value,
}))
const newThreadWorkspaceGroup = computed(() =>
  findNewThreadWorkspaceGroup(projectGroups.value, newThreadCwd.value)
)
const selectedSidebarProjectName = computed(() =>
  selectedThread.value?.projectName || newThreadWorkspaceGroup.value?.projectName || newThreadCwd.value,
)
const newThreadProjectLabel = computed(() => buildNewThreadProjectLabel({
  group: newThreadWorkspaceGroup.value,
  newThreadCwd: newThreadCwd.value,
  projectDisplayNameById: projectDisplayNameById.value,
}))
const tokenFlameCwd = computed(() => selectedThread.value?.cwd?.trim() || newThreadCwd.value)
const activeWorkspaceSkillCount = computed(() => {
  const count = skillCountsByCwd.value[tokenFlameCwd.value]
  return typeof count === 'number' ? count : null
})
const backendConnectionState = ref<'online' | 'offline' | 'restored'>('online')
const backendHealthCheckInFlight = ref(false)
const backendLastError = ref('')
const backendConnectionBannerVisible = computed(() => backendConnectionState.value !== 'online')
const backendConnectionBannerTone = computed(() => backendConnectionState.value === 'offline' ? 'warning' : 'success')
const backendConnectionTitle = computed(() => backendConnectionState.value === 'offline'
  ? t('app.backend.offlineTitle')
  : t('app.backend.restoredTitle'))
const backendConnectionMessage = computed(() => {
  if (backendConnectionState.value === 'offline') {
    return backendLastError.value
      ? t('app.backend.offlineWithError', { error: backendLastError.value })
      : t('app.backend.offlineBody')
  }
  return t('app.backend.restoredBody')
})
let hasHydratedDefaultNewThreadCwd = false
let backendHealthInterval: number | null = null
let backendHealthRestoreTimer: number | null = null

onMounted(() => {
  applyCurrentTheme()
  updateMobileViewport()
  window.addEventListener('keydown', onWindowKeyDown)
  window.addEventListener('resize', updateMobileViewport)
  browserNotifications.start()
  startBackendHealthMonitor()
  void initialize()
})

onUnmounted(() => {
  window.removeEventListener('keydown', onWindowKeyDown)
  window.removeEventListener('resize', updateMobileViewport)
  browserNotifications.stop()
  stopBackendHealthMonitor()
  stopRealtimeSync()
})

function startBackendHealthMonitor(): void {
  void checkBackendHealth()
  backendHealthInterval = window.setInterval(() => {
    void checkBackendHealth()
  }, 5_000)
}

function stopBackendHealthMonitor(): void {
  if (backendHealthInterval !== null) {
    window.clearInterval(backendHealthInterval)
    backendHealthInterval = null
  }
  if (backendHealthRestoreTimer !== null) {
    window.clearTimeout(backendHealthRestoreTimer)
    backendHealthRestoreTimer = null
  }
}

function checkBackendHealthNow(): void {
  void checkBackendHealth()
}

async function checkBackendHealth(): Promise<void> {
  if (backendHealthCheckInFlight.value) return
  backendHealthCheckInFlight.value = true
  const controller = new AbortController()
  const timeoutId = window.setTimeout(() => controller.abort(), 3_000)
  try {
    const response = await fetch('/codex-api/meta/version', {
      cache: 'no-store',
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    markBackendOnline()
  } catch (error) {
    markBackendOffline(error)
  } finally {
    window.clearTimeout(timeoutId)
    backendHealthCheckInFlight.value = false
  }
}

function markBackendOnline(): void {
  backendLastError.value = ''
  if (backendConnectionState.value === 'offline') {
    backendConnectionState.value = 'restored'
    if (backendHealthRestoreTimer !== null) window.clearTimeout(backendHealthRestoreTimer)
    backendHealthRestoreTimer = window.setTimeout(() => {
      backendConnectionState.value = 'online'
      backendHealthRestoreTimer = null
    }, 4_000)
    void refreshAll({ loadSelectedMessages: false }).catch(() => undefined)
    return
  }
  if (backendConnectionState.value !== 'restored') {
    backendConnectionState.value = 'online'
  }
}

function markBackendOffline(error: unknown): void {
  if (backendHealthRestoreTimer !== null) {
    window.clearTimeout(backendHealthRestoreTimer)
    backendHealthRestoreTimer = null
  }
  backendConnectionState.value = 'offline'
  backendLastError.value = error instanceof Error && error.name !== 'AbortError'
    ? error.message
    : ''
}

function updateMobileViewport(): void {
  isMobileViewport.value = window.innerWidth <= MOBILE_SIDEBAR_BREAKPOINT
}

function toggleSidebarSearch(): void {
  isSidebarSearchVisible.value = !isSidebarSearchVisible.value
  if (isSidebarSearchVisible.value) {
    nextTick(() => sidebarSearchInputRef.value?.focus())
  } else {
    sidebarSearchQuery.value = ''
  }
}

function clearSidebarSearch(): void {
  sidebarSearchQuery.value = ''
  sidebarSearchInputRef.value?.focus()
}

function onSidebarSearchKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    isSidebarSearchVisible.value = false
    sidebarSearchQuery.value = ''
  }
}

function openDirectoryPicker(): void {
  isDirectoryPickerOpen.value = true
}

function openSettings(): void {
  if (route.name === 'settings') return
  void router.push({ name: 'settings' })
}

function onOpenProjectSkills(payload: { cwd: string; projectName: string }): void {
  const cwd = payload.cwd.trim()
  if (!cwd) return
  setNewThreadCwd(cwd)
  void router.push({ name: 'skills', query: { cwd } })
}

function openCurrentWorkspaceSkills(): void {
  const cwd = tokenFlameCwd.value.trim()
  if (!cwd) return
  setNewThreadCwd(cwd)
  void router.push({ name: 'skills', query: { cwd } })
}

function onSelectProjectDirectory(path: string): void {
  const normalizedPath = path.trim()
  if (!normalizedPath) return

  openNewThreadDialog(normalizedPath)
  isDirectoryPickerOpen.value = false
}

function openNewThreadDialog(initialCwd = ''): void {
  newThreadDialogInitialCwd.value = initialCwd.trim() || newThreadCwd.value || selectedThread.value?.cwd || ''
  isNewThreadDialogOpen.value = true
}

function onCreateNewThreadFromDialog(payload: { cwd: string; projectName: string; threadName: string }): void {
  const cwd = payload.cwd.trim()
  if (!cwd) return

  const projectName = payload.projectName.trim()
  if (projectName) {
    renameProject(cwd, projectName)
  }

  newThreadCwd.value = cwd
  persistDefaultNewThreadCwd(cwd)
  pendingNewThreadName.value = payload.threadName.trim()
  isNewThreadDialogOpen.value = false

  if (isHomeRoute.value) return
  void router.push({ name: 'home' })
}

function onSelectThread(threadId: string): void {
  if (!threadId) return
  if (route.name === 'thread' && routeThreadId.value === threadId) return
  void router.push({ name: 'thread', params: { threadId } })
}

function onRetryLoadMessages(): void {
  const threadId = selectedThreadId.value
  if (!threadId) return
  void loadMessages(threadId)
}

function onHideThread(threadId: string): void {
  void hideThreadById(threadId)
}

function onRestoreThread(threadId: string): void {
  void restoreThreadById(threadId)
}

function onForkThread(threadId: string): void {
  void forkThreadById(threadId).then((forkedThreadId) => {
    if (forkedThreadId) {
      void router.push({ name: 'thread', params: { threadId: forkedThreadId } })
    }
  })
}

function onCompactThread(threadId: string): void {
  void compactThreadById(threadId)
}

function onToggleHiddenView(nextValue: boolean): void {
  void setHiddenView(nextValue).then(() => {
    if (selectedThreadId.value) {
      void router.replace({ name: 'thread', params: { threadId: selectedThreadId.value } })
      return
    }
    void router.replace({ name: 'home' })
  })
}

function onRenameThread(payload: { threadId: string; title: string }): void {
  void renameThreadById(payload.threadId, payload.title)
}

function onStartNewThread(projectName: string): void {
  const projectGroup = projectGroups.value.find((group) => group.projectName === projectName)
  const projectCwd = projectGroup?.cwd?.trim() || projectGroup?.threads[0]?.cwd?.trim() || ''
  openNewThreadDialog(projectCwd)
}

function onSelectProject(projectName: string): void {
  const projectGroup = projectGroups.value.find((group) => group.projectName === projectName)
  const projectCwd = projectGroup?.cwd?.trim() || projectGroup?.threads[0]?.cwd?.trim() || ''
  if (projectCwd) {
    setNewThreadCwd(projectCwd)
  }
  if (route.name !== 'home') {
    void router.push({ name: 'home' })
  }
}

function onStartNewThreadFromToolbar(): void {
  openNewThreadDialog(selectedThread.value?.cwd?.trim() ?? '')
}

function onRenameProject(payload: { projectName: string; displayName: string }): void {
  renameProject(payload.projectName, payload.displayName)
}

function onHideProject(projectName: string): void {
  void hideProject(projectName)
}

function onRestoreProject(projectName: string): void {
  void restoreProject(projectName)
}

function onReorderProject(payload: { projectName: string; toIndex: number }): void {
  reorderProject(payload.projectName, payload.toIndex)
}

function onUpdateThreadScrollState(payload: { threadId: string; state: ThreadScrollState }): void {
  setThreadScrollState(payload.threadId, payload.state)
}

function onRespondServerRequest(payload: UiServerRequestReply): void {
  void respondToPendingServerRequest(payload)
}

function onRollbackCompleted(result: UiToolingRollbackFileResult): void {
  recordRollbackAudit(result)
}

function onToggleAutoRefreshTimer(): void {
  toggleAutoRefreshTimer()
}

function setSidebarCollapsed(nextValue: boolean): void {
  if (isSidebarCollapsed.value === nextValue) return
  isSidebarCollapsed.value = nextValue
  saveSidebarCollapsed(nextValue)
}

function toggleDarkMode(): void {
  toggleLightDark()
}

function onWindowKeyDown(event: KeyboardEvent): void {
  if (event.defaultPrevented) return
  if (!event.ctrlKey && !event.metaKey) return
  if (event.shiftKey || event.altKey) return
  if (event.key.toLowerCase() !== 'b') return
  event.preventDefault()
  setSidebarCollapsed(!isSidebarCollapsed.value)
}

function onSubmitThreadMessage(payload: UiComposerSubmitPayload): void {
  if (isHomeRoute.value) {
    void submitFirstMessageForNewThread(payload)
    return
  }
  void sendMessageToSelectedThread(payload)
}

function onSelectNewThreadFolder(cwd: string): void {
  setNewThreadCwd(cwd)
}

function onSelectModel(modelId: string): void {
  setSelectedModelId(modelId)
}

function onSelectReasoningEffort(effort: ReasoningEffort | ''): void {
  setSelectedReasoningEffort(effort)
}

function onSelectCollaborationMode(name: string): void {
  setSelectedCollaborationModeName(name)
}

function onSelectPermissionMode(mode: UiComposerPermissionMode): void {
  setSelectedPermissionMode(mode)
}

function onInterruptTurn(): void {
  void interruptSelectedThreadTurn()
}

function loadSidebarCollapsed(): boolean {
  if (typeof window === 'undefined') return false
  return window.localStorage.getItem(DESKTOP_STORAGE_KEYS.sidebarCollapsed) === '1'
}

function saveSidebarCollapsed(value: boolean): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(DESKTOP_STORAGE_KEYS.sidebarCollapsed, value ? '1' : '0')
}

function setNewThreadCwd(cwd: string): void {
  const normalizedCwd = normalizeDefaultNewThreadCwd(cwd)
  if (!normalizedCwd || newThreadCwd.value === normalizedCwd) return
  newThreadCwd.value = normalizedCwd
  persistDefaultNewThreadCwd(normalizedCwd)
}

function persistDefaultNewThreadCwd(cwd: string): void {
  const normalizedCwd = normalizeDefaultNewThreadCwd(cwd)
  saveDefaultNewThreadCwd(normalizedCwd)
  if (!hasHydratedDefaultNewThreadCwd) return
  void writeUserSetting(DESKTOP_SETTING_KEYS.defaultNewThreadCwd, normalizedCwd).catch(() => {
    // Keep the browser-local default if remote settings persistence fails.
  })
}

async function hydrateDefaultNewThreadCwdFromSettingsStore(): Promise<void> {
  if (hasHydratedDefaultNewThreadCwd) return
  hasHydratedDefaultNewThreadCwd = true

  try {
    const setting = await fetchUserSetting<unknown>(DESKTOP_SETTING_KEYS.defaultNewThreadCwd)
    const remoteCwd = normalizeDefaultNewThreadCwd(setting?.value)
    if (remoteCwd) {
      newThreadCwd.value = remoteCwd
      saveDefaultNewThreadCwd(remoteCwd)
      return
    }
  } catch {
    // Keep the browser-local/default workspace value when settings cannot be read.
  }

  const localCwd = normalizeDefaultNewThreadCwd(newThreadCwd.value)
  if (localCwd) {
    saveDefaultNewThreadCwd(localCwd)
    void writeUserSetting(DESKTOP_SETTING_KEYS.defaultNewThreadCwd, localCwd).catch(() => {
      // Keep the browser-local default if the initial remote write fails.
    })
  }
}

async function initialize(): Promise<void> {
  startRealtimeSync()
  await hydrateDefaultNewThreadCwdFromSettingsStore()
  await refreshAll({ loadSelectedMessages: false })
  await ensureNewThreadWorkspace()
  hasInitialized.value = true
  await syncThreadSelectionWithRoute()
}

async function ensureNewThreadWorkspace(): Promise<void> {
  if (newThreadCwd.value.trim()) return

  const firstKnownWorkspace = newThreadFolderOptions.value[0]?.value?.trim() ?? ''
  if (firstKnownWorkspace) {
    setNewThreadCwd(firstKnownWorkspace)
    return
  }

  try {
    const workspace = await fetchDefaultWorkspace()
    setNewThreadCwd(workspace.cwd)
  } catch {
    // Keep the home route usable even if the dev server cannot expose its cwd.
  }
}

async function syncThreadSelectionWithRoute(): Promise<void> {
  if (route.name === 'home' || route.name === 'settings' || route.name === 'skills') {
    if (selectedThreadId.value !== '') {
      void selectThread('')
    }
    return
  }

  if (route.name === 'thread') {
    const threadId = routeThreadId.value
    if (!threadId) return

    if (!knownThreadIdSet.value.has(threadId)) {
      await router.replace({ name: 'home' })
      return
    }

    if (
      selectedThreadId.value === threadId &&
      (isLoadingMessages.value || hasLoadedSelectedMessages.value)
    ) {
      return
    }

    // Selection is synchronous; message hydration continues in the background.
    // This keeps route changes latest-wins when users move through threads quickly.
    void selectThread(threadId)
  }
}

watch(
  () => [route.name, routeThreadId.value] as const,
  async () => {
    if (!hasInitialized.value) return
    await syncThreadSelectionWithRoute()
  },
)

watch(
  () => selectedThreadId.value,
  async (threadId) => {
    isConversationShareOpen.value = false
    isConversationShareSelecting.value = false
    conversationShareSelectedMessageIds.value = []
    if (!hasInitialized.value) return
    if (isHomeRoute.value || isSettingsRoute.value || isSkillsRoute.value) return

    if (!threadId) {
      if (route.name !== 'home') {
        await router.replace({ name: 'home' })
      }
      return
    }

    if (route.name === 'thread' && routeThreadId.value === threadId) return
    await router.replace({ name: 'thread', params: { threadId } })
  },
)

watch(
  () => newThreadFolderOptions.value,
  (options) => {
    if (options.length === 0) {
      if (!newThreadCwd.value.trim()) {
        void ensureNewThreadWorkspace()
      }
      return
    }
    const hasSelected = options.some((option) => option.value === newThreadCwd.value)
    if (!hasSelected) {
      setNewThreadCwd(options[0].value)
    }
  },
  { immediate: true },
)

watch(
  () => projectGroups.value.map((group) => group.cwd?.trim() || group.threads[0]?.cwd?.trim() || '').filter(Boolean),
  async (cwds) => {
    if (cwds.length === 0) {
      skillCountsByCwd.value = {}
      return
    }
    try {
      const entries = await getSkillCatalog(cwds)
      skillCountsByCwd.value = Object.fromEntries(entries.map((entry) => [entry.cwd, entry.skills.length]))
    } catch {
      // Skill counts are a progressive enhancement; the entry remains available without them.
    }
  },
  { immediate: true },
)

async function submitFirstMessageForNewThread(payload: UiComposerSubmitPayload): Promise<void> {
  try {
    const threadName = pendingNewThreadName.value.trim()
    const threadId = await sendMessageToNewThread(payload, newThreadCwd.value)
    if (!threadId) return
    pendingNewThreadName.value = ''
    if (threadName) {
      void renameThreadById(threadId, threadName).catch(() => {
        // Rename errors are already reflected in desktop state; keep the new thread visible.
      })
    }
    await router.replace({ name: 'thread', params: { threadId } })
  } catch {
    // Error is already reflected in state.
  }
}
</script>

<style scoped>
@reference "./style.css";

.sidebar-root {
  @apply min-h-full py-4 px-2 flex flex-col gap-2 select-none;
}

.sidebar-root input,
.sidebar-root textarea {
  @apply select-text;
}

.content-root {
  @apply relative h-full min-h-0 w-full flex flex-col overflow-y-hidden overflow-x-visible theme-bg-panel;
}

.sidebar-thread-controls-host {
  @apply mt-1 -translate-y-px px-2 pb-1;
}

.sidebar-search-toggle {
  @apply h-6.75 w-6.75 rounded-md border border-transparent bg-transparent theme-muted flex items-center justify-center transition hover:theme-border hover:theme-bg-subtle;
}

.sidebar-search-toggle[aria-pressed='true']:not([data-theme-toggle='true']) {
  @apply theme-border theme-bg-control theme-muted;
}

#app .sidebar-search-toggle:disabled,
#app .sidebar-search-toggle:disabled:hover {
  cursor: not-allowed;
  opacity: 0.42;
  transform: none;
  border-color: transparent;
  background: transparent;
}

.sidebar-search-toggle-icon {
  @apply w-4 h-4;
}

.sidebar-search-bar {
  @apply flex items-center gap-1.5 mx-2 px-2 py-1 rounded-md border theme-border theme-bg-panel transition-colors focus-within:border-zinc-400;
}

.sidebar-search-bar-icon {
  @apply w-3.5 h-3.5 theme-muted shrink-0;
}

.sidebar-search-input {
  @apply flex-1 min-w-0 bg-transparent text-sm theme-text placeholder-zinc-400 outline-none border-none p-0;
}

.sidebar-search-clear {
  @apply w-4 h-4 rounded theme-muted flex items-center justify-center transition hover:theme-muted;
}

.sidebar-search-clear-icon {
  @apply w-3.5 h-3.5;
}

.sidebar-thread-controls-header-host {
  @apply ml-1;
}

.content-notifications-host {
  @apply flex items-center;
}

.content-prompt-trigger {
  @apply relative inline-flex h-9 w-9 items-center justify-center rounded-md border theme-border theme-bg-panel theme-muted shadow-sm transition hover:border-[var(--color-accent)] hover:theme-bg-subtle hover:theme-text focus-visible:outline-2 focus-visible:outline-offset-2;
}

.content-prompt-trigger::after {
  position: absolute;
  right: .35rem;
  bottom: .28rem;
  width: .27rem;
  height: .27rem;
  border-radius: 999px;
  background: var(--color-accent);
  box-shadow: 0 0 7px color-mix(in srgb, var(--color-accent) 64%, transparent);
  content: '';
}

.content-prompt-trigger svg { @apply h-4 w-4; }

.content-prompt-trigger[data-active='true'] {
  border-color: var(--color-accent);
  background: color-mix(in srgb, var(--color-accent) 12%, var(--color-panel));
  color: var(--color-accent);
}

.workspace-context-bar {
  display: flex;
  min-height: 2.5rem;
  align-items: center;
  gap: 1.1rem;
  overflow-x: auto;
  border-bottom: 1px solid var(--color-border);
  background: color-mix(in srgb, var(--color-panel) 72%, transparent);
  padding: 0.4rem 1rem;
  color: var(--color-text-muted);
  scrollbar-width: none;
}

.workspace-context-bar > span:not(.workspace-context-live) {
  display: flex;
  min-width: 0;
  max-width: 24rem;
  align-items: baseline;
  gap: 0.4rem;
  overflow: hidden;
  font-family: var(--font-mono);
  font-size: 0.68rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workspace-context-bar small {
  color: color-mix(in srgb, var(--color-text-muted) 64%, transparent);
  font-size: 0.58rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.workspace-context-live {
  width: 0.45rem;
  height: 0.45rem;
  flex: 0 0 auto;
  border-radius: 50%;
  background: var(--color-success);
  box-shadow: 0 0 10px var(--color-success);
}

.workspace-context-bar button {
  margin-left: auto;
  flex: 0 0 auto;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-elevated);
  padding: 0.35rem 0.65rem;
  color: var(--color-text);
  font-size: 0.7rem;
}

.workspace-view-toggle {
  display: inline-flex;
  flex: 0 0 auto;
  gap: 0.2rem;
  padding: 0.18rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-background);
}

.workspace-view-toggle button {
  min-height: 1.75rem;
  margin-left: 0;
  border: 0;
  padding: 0.2rem 0.55rem;
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
}

.workspace-view-toggle button[data-active='true'] {
  background: var(--color-control);
  color: var(--color-text);
  box-shadow: inset 0 -2px 0 var(--color-accent);
}

@media (max-width: 700px) {
  .toolbar-secondary {
    display: none;
  }

  .workspace-context-bar > span:nth-of-type(3) {
    display: none;
  }

}

.content-body {
  @apply flex-1 min-h-0 w-full flex flex-col gap-3 pt-1 pb-4 overflow-y-hidden overflow-x-visible;
}

.content-error {
  @apply mx-0 mt-1 flex shrink-0 items-start gap-2 rounded-lg border theme-border-danger theme-bg-danger-soft px-3 py-2 text-sm theme-text-danger;
}

.backend-connection-banner {
  @apply mx-0 mt-1 flex shrink-0 items-center gap-3 rounded-lg border px-3 py-2 text-sm;
  background: color-mix(in srgb, var(--color-warning) 10%, var(--color-panel));
  border-color: color-mix(in srgb, var(--color-warning) 36%, var(--color-border));
  color: var(--color-text);
}

.backend-connection-banner[data-tone='success'] {
  background: color-mix(in srgb, var(--color-success) 10%, var(--color-panel));
  border-color: color-mix(in srgb, var(--color-success) 36%, var(--color-border));
}

.backend-connection-dot {
  @apply h-2.5 w-2.5 shrink-0 rounded-full;
  background: var(--color-warning);
  animation: backend-connection-pulse 1.5s ease-in-out infinite;
}

.backend-connection-banner[data-tone='success'] .backend-connection-dot {
  background: var(--color-success);
  animation: none;
}

.backend-connection-copy {
  @apply grid min-w-0 flex-1 gap-0.5;
}

.backend-connection-copy strong {
  @apply text-sm font-semibold;
  color: var(--color-text);
}

.backend-connection-copy span {
  @apply truncate text-xs;
  color: var(--color-text-muted);
}

.backend-connection-banner button {
  @apply shrink-0 rounded-md border px-2.5 py-1 text-xs font-medium transition disabled:cursor-wait disabled:opacity-60;
  background: var(--color-surface);
  border-color: var(--color-border);
  color: var(--color-text);
}

.backend-connection-banner button:hover:not(:disabled) {
  background: var(--color-elevated);
}

@keyframes backend-connection-pulse {
  0%, 100% {
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--color-warning) 34%, transparent);
  }
  50% {
    box-shadow: 0 0 0 0.45rem color-mix(in srgb, var(--color-warning) 0%, transparent);
  }
}

.content-error-text {
  @apply min-w-0 flex-1;
}

.content-error-dismiss {
  @apply -mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-rose-500 transition hover:theme-bg-danger-soft hover:theme-text-danger;
}

.content-error-dismiss-icon {
  @apply h-3.5 w-3.5;
}

.content-grid {
  @apply flex-1 min-h-0 flex flex-col gap-3;
}

.new-thread-grid {
  @apply items-center justify-center gap-6 overflow-hidden;
  position: relative;
  isolation: isolate;
}

.new-thread-grid::before {
  content: '';
  position: absolute;
  inset: 7% 8% 10%;
  z-index: -1;
  pointer-events: none;
  background-image:
    linear-gradient(var(--telemetry-grid) 1px, transparent 1px),
    linear-gradient(90deg, var(--telemetry-grid) 1px, transparent 1px);
  background-size: 42px 42px;
  mask-image: radial-gradient(circle at 50% 52%, black 4%, transparent 70%);
  opacity: 0.44;
}

.content-workbench {
  @apply flex-1 min-h-0 flex gap-3 px-0;
}

.content-thread {
  @apply flex flex-1 flex-col min-h-0 overflow-visible;
}

.content-thread :deep(.conversation-root) {
  @apply flex-1;
}

.new-thread-empty {
  @apply shrink-0 flex flex-col items-center justify-center px-6 py-4 text-center;
  max-width: 48rem;
}

.new-thread-hero {
  @apply m-0 font-semibold;
  font-size: clamp(2.6rem, 6vw, 5.4rem);
  line-height: 0.94;
  letter-spacing: -0.065em;
  color: var(--color-text);
}

.new-thread-kicker {
  @apply mb-5 inline-flex items-center gap-2 font-mono text-[0.67rem] font-semibold uppercase;
  color: var(--color-text-muted);
  letter-spacing: 0.16em;
}

.new-thread-kicker-signal {
  width: 0.55rem;
  height: 0.55rem;
  border-radius: 50%;
  background: var(--color-success);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--color-success) 13%, transparent), 0 0 16px color-mix(in srgb, var(--color-success) 55%, transparent);
}

.new-thread-subtitle {
  @apply mt-5 mb-4 max-w-xl text-sm leading-6;
  color: var(--color-text-muted);
}

.new-thread-folder-dropdown {
  @apply text-sm;
  color: var(--color-text-muted);
}

.new-thread-folder-dropdown :deep(.composer-dropdown-trigger) {
  @apply h-9 px-3 text-sm leading-none;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel);
}

.new-thread-folder-dropdown :deep(.composer-dropdown-value) {
  @apply leading-[1.05];
}

.new-thread-folder-dropdown :deep(.composer-dropdown-chevron) {
  @apply h-4 w-4 mt-0;
}

</style>
