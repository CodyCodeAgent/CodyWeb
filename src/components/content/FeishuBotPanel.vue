<template>
  <div class="feishu-panel">
    <aside
      v-if="showTransportWarning"
      class="feishu-alert feishu-transport-warning"
      data-tone="warning"
      role="status"
      aria-live="polite"
    >
      <div>
        <strong>{{ t('settings.feishu.transportWarning.title') }}</strong>
        <p>{{ t('settings.feishu.transportWarning.body') }}</p>
      </div>
    </aside>

    <div v-if="isLoading" class="feishu-loading" role="status" aria-live="polite">
      <span class="feishu-loading-bar" />
      <span class="feishu-loading-bar" />
      <span>{{ t('settings.feishu.loading') }}</span>
    </div>

    <div v-else-if="loadError" class="feishu-alert" data-tone="danger" role="alert">
      <div>
        <strong>{{ t('settings.feishu.loadFailed') }}</strong>
        <p>{{ loadError }}</p>
      </div>
      <button type="button" @click="loadData">{{ t('settings.feishu.retry') }}</button>
    </div>

    <template v-else>
      <div class="feishu-toolbar">
        <div>
          <strong>{{ t('settings.feishu.botCount', { count: String(bots.length) }) }}</strong>
          <span>{{ t('settings.feishu.botCountHint') }}</span>
        </div>
        <div class="feishu-toolbar-actions">
          <button class="feishu-secondary-button" type="button" :disabled="isRefreshing" @click="refreshBotState">
            {{ isRefreshing ? t('settings.feishu.refreshing') : t('settings.feishu.refresh') }}
          </button>
          <button class="feishu-primary-button" type="button" @click="startCreate">
            {{ t('settings.feishu.addBot') }}
          </button>
        </div>
      </div>

      <div v-if="actionError" class="feishu-alert" data-tone="danger" role="alert">
        <div><strong>{{ t('settings.feishu.actionFailed') }}</strong><p>{{ actionError }}</p></div>
      </div>
      <p v-if="successMessage" class="feishu-alert" data-tone="success" role="status" aria-live="polite">
        {{ successMessage }}
      </p>

      <section class="feishu-platform-session" aria-live="polite">
        <div>
          <strong>{{ t('settings.feishu.platformSession.title') }}</strong>
          <span v-if="isPlatformSessionLoading">{{ t('settings.feishu.platformSession.checking') }}</span>
          <span v-else-if="platformSession?.valid && platformSession.account">
            {{ platformSession.account.userName }} · {{ platformSession.account.tenantName }}
          </span>
          <span v-else-if="platformSession?.configured">{{ t('settings.feishu.platformSession.expired') }}</span>
          <span v-else>{{ t('settings.feishu.platformSession.empty') }}</span>
          <small v-if="platformSession?.error">{{ platformSession.error }}</small>
        </div>
        <button
          v-if="platformSession?.configured"
          class="feishu-secondary-button"
          type="button"
          :disabled="isClearingPlatformSession || isQrSetupActive"
          @click="clearPlatformSession"
        >
          {{ isClearingPlatformSession ? t('settings.feishu.platformSession.clearing') : t('settings.feishu.platformSession.clear') }}
        </button>
      </section>

      <div v-if="bots.length === 0 && !isCreating" class="feishu-empty">
        <strong>{{ t('settings.feishu.emptyBotsTitle') }}</strong>
        <p>{{ t('settings.feishu.emptyBotsBody') }}</p>
        <button class="feishu-primary-button" type="button" @click="startCreate">
          {{ t('settings.feishu.addFirstBot') }}
        </button>
      </div>

      <div v-else class="feishu-layout">
        <div class="feishu-bot-list" :aria-label="t('settings.feishu.botListAria')">
          <button
            v-for="bot in bots"
            :key="bot.id"
            class="feishu-bot-card"
            :class="{ 'is-active': !isCreating && selectedBotId === bot.id }"
            type="button"
            :disabled="isQrSetupActive"
            :aria-pressed="!isCreating && selectedBotId === bot.id"
            @click="selectBot(bot)"
          >
            <span class="feishu-bot-card-heading">
              <strong>{{ bot.name }}</strong>
              <span class="feishu-status" :data-status="bot.status">
                <span class="feishu-status-dot" aria-hidden="true" />
                {{ statusLabel(bot.status) }}
              </span>
            </span>
            <span class="feishu-bot-tenant">{{ bot.tenantName || t('settings.feishu.tenantUnknown') }}</span>
            <span class="feishu-bot-platform">{{ platformLabel(bot.platform) }}</span>
            <span class="feishu-bot-app-id">{{ bot.appId }}</span>
            <span v-if="!bot.enabled" class="feishu-bot-disabled">{{ t('settings.feishu.disabled') }}</span>
          </button>
          <button v-if="isCreating" class="feishu-bot-card is-active" type="button" aria-pressed="true">
            <span class="feishu-bot-card-heading"><strong>{{ t('settings.feishu.newBot') }}</strong></span>
            <span class="feishu-bot-app-id">{{ t('settings.feishu.notSaved') }}</span>
          </button>
        </div>

        <div class="feishu-detail">
          <form class="feishu-form" @submit.prevent="isCreating && createMode === 'qr' ? beginQrSetup() : saveDraft()">
            <header class="feishu-detail-header">
              <div>
                <h3>{{ isCreating && createMode === 'qr' ? t('settings.feishu.qr.title') : isCreating ? t('settings.feishu.createTitle') : t('settings.feishu.editTitle') }}</h3>
                <p>{{ isCreating && createMode === 'qr' ? t('settings.feishu.qr.hint') : isCreating ? t('settings.feishu.createHint') : t('settings.feishu.editHint') }}</p>
              </div>
              <div v-if="isCreating" class="feishu-create-modes" role="tablist" :aria-label="t('settings.feishu.qr.modeAria')">
                <button type="button" role="tab" :aria-selected="createMode === 'qr'" :class="{ 'is-active': createMode === 'qr' }" @click="switchCreateMode('qr')">
                  {{ t('settings.feishu.qr.mode') }}
                </button>
                <button type="button" role="tab" :aria-selected="createMode === 'manual'" :class="{ 'is-active': createMode === 'manual' }" @click="switchCreateMode('manual')">
                  {{ t('settings.feishu.manualMode') }}
                </button>
              </div>
              <label v-else class="feishu-enabled-switch">
                <input v-model="draft.enabled" type="checkbox" />
                <span>{{ draft.enabled ? t('settings.feishu.enabled') : t('settings.feishu.disabled') }}</span>
              </label>
            </header>

            <template v-if="isCreating && createMode === 'qr'">
              <div v-if="!qrSetupJob" class="feishu-qr-intro">
                <ol aria-label="扫码创建步骤">
                  <li><strong>1</strong><span>{{ t('settings.feishu.qr.stepScan') }}</span></li>
                  <li><strong>2</strong><span>{{ t('settings.feishu.qr.stepConfigure') }}</span></li>
                  <li><strong>3</strong><span>{{ t('settings.feishu.qr.stepReady') }}</span></li>
                </ol>
                <p>{{ t('settings.feishu.qr.description') }}</p>
              </div>

              <div v-if="!qrSetupJob" class="feishu-form-grid">
                <label class="feishu-qr-name-field">
                  <span>{{ t('settings.feishu.field.name') }} *</span>
                  <input ref="nameInput" v-model.trim="draft.name" required autocomplete="off" :placeholder="t('settings.feishu.field.namePlaceholder')" />
                </label>
                <details class="feishu-existing-apps">
                  <summary>{{ t('settings.feishu.existingApps.show') }}</summary>
                  <p>{{ t('settings.feishu.existingApps.hint') }}</p>
                  <div class="feishu-existing-app-id">
                    <label>
                      <span>{{ t('settings.feishu.existingApps.appId') }}</span>
                      <input v-model.trim="draft.appId" autocomplete="off" spellcheck="false" placeholder="cli_…" />
                    </label>
                    <button class="feishu-secondary-button" type="button" :disabled="isSaving || !draft.appId.startsWith('cli_')" @click="adoptAppById">
                      {{ t('settings.feishu.existingApps.scanToAdopt') }}
                    </button>
                  </div>
                  <small>{{ t('settings.feishu.existingApps.appIdHint') }}</small>
                  <button class="feishu-secondary-button" type="button" :disabled="isExistingAppsLoading || !platformSession?.valid" @click="loadExistingApps">
                    {{ isExistingAppsLoading ? t('settings.feishu.existingApps.loading') : t('settings.feishu.existingApps.show') }}
                  </button>
                  <ul v-if="existingApps.length">
                    <li v-for="app in existingApps" :key="app.appId">
                      <span><strong>{{ app.name }}</strong><code>{{ app.appId }}</code></span>
                      <button class="feishu-secondary-button" type="button" :disabled="isSaving" @click="adoptExistingApp(app)">{{ t('settings.feishu.existingApps.adopt') }}</button>
                    </li>
                  </ul>
                  <span v-else-if="hasLoadedExistingApps">{{ t('settings.feishu.existingApps.empty') }}</span>
                </details>
                <fieldset class="feishu-availability-field">
                  <legend>{{ t('settings.feishu.availability.title') }}</legend>
                  <p>{{ t('settings.feishu.availability.hint') }}</p>
                  <div class="feishu-availability-options">
                    <label v-for="option in availabilityOptions" :key="option.value">
                      <input v-model="draft.availabilityMode" type="radio" name="feishu-availability" :value="option.value" />
                      <span><strong>{{ option.label }}</strong><small>{{ option.description }}</small></span>
                    </label>
                  </div>
                  <label v-if="draft.availabilityMode === 'members'">
                    <span>{{ t('settings.feishu.availability.memberIds') }}</span>
                    <textarea v-model="draft.availabilityMemberIdsText" rows="3" spellcheck="false" :placeholder="t('settings.feishu.availability.memberIdsPlaceholder')" />
                  </label>
                  <label v-if="draft.availabilityMode === 'groups'">
                    <span>{{ t('settings.feishu.availability.groupIds') }}</span>
                    <textarea v-model="draft.availabilityGroupIdsText" rows="3" spellcheck="false" :placeholder="t('settings.feishu.availability.groupIdsPlaceholder')" />
                  </label>
                </fieldset>
                <label class="feishu-allowlist-field">
                  <span>{{ t('settings.feishu.field.allowedOpenIds') }}</span>
                  <textarea v-model="draft.allowedOpenIdsText" rows="3" spellcheck="false" :placeholder="t('settings.feishu.field.allowedOpenIdsPlaceholder')" />
                  <small>{{ t('settings.feishu.qr.allowlistHint') }}</small>
                </label>
                <label class="feishu-open-access-field">
                  <input v-model="draft.allowAllUsers" type="checkbox" />
                  <span><strong>{{ t('settings.feishu.field.allowAllUsers') }}</strong><small>{{ t('settings.feishu.field.allowAllUsersHint') }}</small></span>
                </label>
                <fieldset class="feishu-mention-mode-field">
                  <legend>{{ t('settings.feishu.field.p2pMode') }}</legend>
                  <p>{{ t('settings.feishu.field.p2pModeHint') }}</p>
                  <div class="feishu-mention-mode-options">
                    <label v-for="mode in p2pModeOptions" :key="`qr-p2p-${mode.value}`">
                      <input v-model="draft.p2pMode" type="radio" name="feishu-qr-p2p-mode" :value="mode.value" />
                      <span><strong>{{ mode.label }}</strong><small>{{ mode.description }}</small></span>
                    </label>
                  </div>
                </fieldset>
                <fieldset class="feishu-mention-mode-field">
                  <legend>{{ t('settings.feishu.field.groupMentionMode') }}</legend>
                  <div class="feishu-mention-mode-options">
                    <label v-for="mode in mentionModeOptions" :key="`qr-${mode.value}`" :data-risk="mode.value === 'bound' ? 'high' : 'normal'">
                      <input v-model="draft.groupMentionMode" type="radio" name="feishu-qr-group-mention-mode" :value="mode.value" />
                      <span><strong>{{ mode.label }}</strong><small>{{ mode.description }}</small></span>
                    </label>
                  </div>
                </fieldset>
              </div>

              <section v-else class="feishu-qr-progress" aria-live="polite">
                <div class="feishu-qr-progress-heading">
                  <span class="feishu-qr-spinner" :data-done="qrSetupJob.status === 'completed'" aria-hidden="true" />
                  <div><strong>{{ qrSetupJob.statusMessage }}</strong><small>{{ qrStatusLabel(qrSetupJob.status) }}</small></div>
                </div>
                <img v-if="qrSetupJob.qrDataUrl" class="feishu-qr-code" :src="qrSetupJob.qrDataUrl" :alt="t('settings.feishu.qr.codeAlt')" width="320" height="320" />
                <p v-if="qrSetupJob.qrDataUrl" class="feishu-qr-expiry">{{ qrExpiryLabel(qrSetupJob.qrExpiresAtIso) }}</p>
                <dl v-if="qrSetupJob.account" class="feishu-qr-account">
                  <div><dt>{{ t('settings.feishu.qr.account') }}</dt><dd>{{ qrSetupJob.account.userName }}<small v-if="qrSetupJob.account.email">{{ qrSetupJob.account.email }}</small></dd></div>
                  <div><dt>{{ t('settings.feishu.qr.tenant') }}</dt><dd>{{ qrSetupJob.account.tenantName }}</dd></div>
                </dl>
                <section class="feishu-setup-proofs" :aria-label="t('settings.feishu.qr.proofs.title')">
                  <header>
                    <strong>{{ t('settings.feishu.qr.proofs.title') }}</strong>
                    <small>{{ setupProofs.filter((proof) => proof.passed).length }} / {{ setupProofs.length }}</small>
                  </header>
                  <ul>
                    <li v-for="proof in setupProofs" :key="proof.id" :data-passed="proof.passed">
                      <span aria-hidden="true">{{ proof.passed ? '✓' : '·' }}</span>
                      <strong>{{ proof.label }}</strong>
                      <small>{{ proof.passed ? t('settings.feishu.qr.proofs.verified') : t('settings.feishu.qr.proofs.pending') }}</small>
                    </li>
                  </ul>
                </section>
                <div v-if="qrSetupJob.canConfirmIdentity" class="feishu-alert" data-tone="warning" role="status">
                  <div>
                    <strong>{{ t('settings.feishu.qr.identityConfirmTitle') }}</strong>
                    <p>{{ t('settings.feishu.qr.identityConfirmHint') }}</p>
                  </div>
                </div>
                <div v-if="qrSetupJob.error" class="feishu-alert" data-tone="danger" role="alert"><div><strong>{{ t('settings.feishu.qr.failed') }}</strong><p>{{ qrSetupJob.error }}</p></div></div>
                <div v-if="qrSetupJob.warnings.length" class="feishu-alert" data-tone="warning" role="status"><div><strong>{{ t('settings.feishu.qr.warnings') }}</strong><p>{{ qrSetupJob.warnings.join('；') }}</p></div></div>
              </section>

              <footer class="feishu-form-actions">
                <button class="feishu-secondary-button" type="button" :disabled="isSaving" @click="cancelCreate">{{ t('settings.feishu.cancel') }}</button>
                <button v-if="qrSetupJob?.canConfirmIdentity" class="feishu-primary-button" type="button" :disabled="isSaving" @click="confirmQrIdentity">
                  {{ isSaving ? t('settings.feishu.qr.identityConfirming') : t('settings.feishu.qr.identityConfirm') }}
                </button>
                <button v-if="qrSetupJob?.canCancel" class="feishu-danger-button" type="button" @click="cancelQrSetup">{{ t('settings.feishu.qr.cancel') }}</button>
                <button v-if="qrSetupJob?.canRetry" class="feishu-primary-button" type="button" @click="retryQrSetup">{{ t('settings.feishu.qr.retryConfig') }}</button>
                <button v-if="!qrSetupJob || ['expired', 'cancelled'].includes(qrSetupJob.status) || (qrSetupJob.status === 'failed' && !qrSetupJob.canRetry)" class="feishu-primary-button" type="submit" :disabled="isSaving">
                  {{ isSaving ? t('settings.feishu.qr.starting') : t('settings.feishu.qr.start') }}
                </button>
              </footer>
            </template>

            <template v-else>
            <label v-if="isCreating" class="feishu-enabled-switch feishu-manual-enabled-switch">
              <input v-model="draft.enabled" type="checkbox" />
              <span>{{ draft.enabled ? t('settings.feishu.enabled') : t('settings.feishu.disabled') }}</span>
            </label>
            <p v-if="hasOpenAccess" class="feishu-alert" data-tone="warning" role="alert">
              {{ t('settings.feishu.openAccessWarning') }}
            </p>

            <div class="feishu-form-grid">
              <label>
                <span>{{ t('settings.feishu.field.name') }} *</span>
                <input ref="nameInput" v-model.trim="draft.name" required autocomplete="off" :placeholder="t('settings.feishu.field.namePlaceholder')" />
              </label>
              <label>
                <span>{{ t('settings.feishu.field.appId') }} *</span>
                <input ref="appIdInput" v-model.trim="draft.appId" required autocomplete="off" spellcheck="false" placeholder="cli_…" />
              </label>
              <fieldset class="feishu-mention-mode-field feishu-platform-field">
                <legend>{{ t('settings.feishu.field.platform') }} *</legend>
                <p>{{ t('settings.feishu.field.platformHint') }}</p>
                <div class="feishu-mention-mode-options">
                  <label v-for="platform in platformOptions" :key="platform.value">
                    <input v-model="draft.platform" type="radio" name="feishu-platform" :value="platform.value" />
                    <span><strong>{{ platform.label }}</strong><small>{{ platform.description }}</small></span>
                  </label>
                </div>
              </fieldset>
              <label class="feishu-secret-field">
                <span>{{ t('settings.feishu.field.appSecret') }}<template v-if="isCreating"> *</template></span>
                <span class="feishu-secret-input">
                  <input
                    ref="secretInput"
                    v-model="draft.appSecret"
                    :type="showSecret ? 'text' : 'password'"
                    :required="isCreating"
                    autocomplete="new-password"
                    :placeholder="secretPlaceholder"
                  />
                  <button type="button" :aria-label="showSecret ? t('settings.feishu.hideSecret') : t('settings.feishu.showSecret')" @click="showSecret = !showSecret">
                    {{ showSecret ? t('settings.feishu.hide') : t('settings.feishu.show') }}
                  </button>
                </span>
                <small>{{ t('settings.feishu.field.secretHint') }}</small>
              </label>
              <label class="feishu-allowlist-field">
                <span>{{ t('settings.feishu.field.allowedOpenIds') }}</span>
                <textarea v-model="draft.allowedOpenIdsText" rows="4" spellcheck="false" :placeholder="t('settings.feishu.field.allowedOpenIdsPlaceholder')" />
                <small>{{ t('settings.feishu.field.allowedOpenIdsHint') }}</small>
              </label>
              <label class="feishu-allowlist-field">
                <span>{{ t('settings.feishu.field.allowedChatIds') }}</span>
                <textarea v-model="draft.allowedChatIdsText" rows="3" spellcheck="false" :placeholder="t('settings.feishu.field.allowedChatIdsPlaceholder')" />
                <small>{{ t('settings.feishu.field.allowedChatIdsHint') }}</small>
              </label>
              <label class="feishu-open-access-field">
                <input v-model="draft.allowAllUsers" type="checkbox" />
                <span><strong>{{ t('settings.feishu.field.allowAllUsers') }}</strong><small>{{ t('settings.feishu.field.allowAllUsersHint') }}</small></span>
              </label>
              <fieldset class="feishu-mention-mode-field">
                <legend>{{ t('settings.feishu.field.p2pMode') }}</legend>
                <p>{{ t('settings.feishu.field.p2pModeHint') }}</p>
                <div class="feishu-mention-mode-options">
                  <label v-for="mode in p2pModeOptions" :key="`p2p-${mode.value}`">
                    <input v-model="draft.p2pMode" type="radio" name="feishu-p2p-mode" :value="mode.value" />
                    <span><strong>{{ mode.label }}</strong><small>{{ mode.description }}</small></span>
                  </label>
                </div>
              </fieldset>
              <fieldset class="feishu-mention-mode-field">
                <legend>{{ t('settings.feishu.field.groupMentionMode') }}</legend>
                <p>{{ t('settings.feishu.field.groupMentionModeHint') }}</p>
                <div class="feishu-mention-mode-options">
                  <label v-for="mode in mentionModeOptions" :key="mode.value" :data-risk="mode.value === 'bound' ? 'high' : 'normal'">
                    <input v-model="draft.groupMentionMode" type="radio" name="feishu-group-mention-mode" :value="mode.value" />
                    <span><strong>{{ mode.label }}</strong><small>{{ mode.description }}</small></span>
                  </label>
                </div>
              </fieldset>
            </div>
            <p v-if="draft.groupMentionMode === 'bound'" class="feishu-alert" data-tone="warning" role="alert">
              {{ t('settings.feishu.groupMentionBoundWarning') }}
            </p>

            <fieldset v-if="selectedBot && !isCreating" class="feishu-delete-options">
              <legend>{{ t('settings.feishu.deleteMode.title') }}</legend>
              <p>{{ t('settings.feishu.deleteMode.hint') }}</p>
              <label>
                <input v-model="deleteRemoteAction" type="radio" name="feishu-delete-mode" value="keep" />
                <span><strong>{{ t('settings.feishu.deleteMode.keep') }}</strong><small>{{ t('settings.feishu.deleteMode.keepHint') }}</small></span>
              </label>
              <label data-risk="high">
                <input v-model="deleteRemoteAction" type="radio" name="feishu-delete-mode" value="disable" />
                <span><strong>{{ t('settings.feishu.deleteMode.disable') }}</strong><small>{{ t('settings.feishu.deleteMode.disableHint') }}</small></span>
              </label>
            </fieldset>

            <footer class="feishu-form-actions">
              <button
                v-if="selectedBot && !isCreating"
                class="feishu-danger-button feishu-delete-bot-button"
                type="button"
                :disabled="isSaving || isDeleting"
                @click="deleteSelectedBot"
              >
                {{ isDeleting ? t('settings.feishu.deleting') : t('settings.feishu.deleteBot') }}
              </button>
              <button v-if="isCreating" class="feishu-secondary-button" type="button" :disabled="isSaving" @click="cancelCreate">
                {{ t('settings.feishu.cancel') }}
              </button>
              <button
                v-if="selectedBot && !isCreating"
                class="feishu-secondary-button"
                type="button"
                :disabled="isSaving || reconnectingBotId === selectedBot.id || !selectedBot.enabled"
                @click="reconnectSelected"
              >
                {{ reconnectingBotId === selectedBot.id ? t('settings.feishu.reconnecting') : t('settings.feishu.reconnect') }}
              </button>
              <button class="feishu-primary-button" type="submit" :disabled="isSaving">
                {{ isSaving ? t('settings.feishu.saving') : t('settings.feishu.save') }}
              </button>
            </footer>
            </template>
          </form>

          <section v-if="selectedBot && !isCreating" class="feishu-health" :aria-label="t('settings.feishu.healthAria')">
            <dl>
              <div><dt>{{ t('settings.feishu.connection') }}</dt><dd>{{ statusLabel(selectedBot.status) }}</dd></div>
              <div><dt>{{ t('settings.feishu.lastConnected') }}</dt><dd>{{ formatTime(selectedBot.lastConnectedAtIso) }}</dd></div>
              <div><dt>{{ t('settings.feishu.lastHeartbeat') }}</dt><dd>{{ formatTime(selectedBot.lastHeartbeatAtIso) }}</dd></div>
              <div><dt>{{ t('settings.feishu.tenant') }}</dt><dd>{{ selectedBot.tenantName || t('settings.feishu.tenantUnknown') }}</dd></div>
              <div><dt>{{ t('settings.feishu.platform') }}</dt><dd>{{ selectedBot.platform === 'lark' ? 'Lark' : t('settings.feishu.platformFeishu') }}</dd></div>
              <div><dt>{{ t('settings.feishu.secret') }}</dt><dd>{{ selectedBot.secretConfigured ? t('settings.feishu.configured') : t('settings.feishu.missing') }}</dd></div>
            </dl>
            <p v-if="selectedBot.lastError" class="feishu-last-error" role="alert">
              <strong>{{ t('settings.feishu.lastError') }}</strong>
              <span>{{ selectedBot.lastError }}</span>
            </p>
          </section>

          <section v-if="selectedBot && !isCreating" class="feishu-diagnostics" :aria-label="t('settings.feishu.diagnostics.aria')">
            <header>
              <div>
                <h3>{{ t('settings.feishu.diagnostics.title') }}</h3>
                <p>{{ t('settings.feishu.diagnostics.hint') }}</p>
              </div>
              <div class="feishu-diagnostics-actions">
                <button class="feishu-primary-button feishu-live-diagnostic-button" type="button" :disabled="isConnectivityLoading" @click="runConnectivityDiagnostic(selectedBot.id)">
                  {{ isConnectivityLoading ? t('settings.feishu.connectivity.running') : t('settings.feishu.connectivity.run') }}
                </button>
                <button class="feishu-secondary-button" type="button" :disabled="isDiagnosticsLoading" @click="loadDiagnostics(selectedBot.id)">
                  {{ isDiagnosticsLoading ? t('settings.feishu.diagnostics.refreshing') : t('settings.feishu.diagnostics.refresh') }}
                </button>
              </div>
            </header>
            <div v-if="connectivityError" class="feishu-alert" data-tone="danger" role="alert">
              <div><strong>{{ t('settings.feishu.connectivity.requestFailed') }}</strong><p>{{ connectivityError }}</p></div>
            </div>
            <section v-if="connectivityReport" class="feishu-connectivity-report" :data-status="connectivityReport.ok ? 'pass' : 'fail'" aria-live="polite">
              <header>
                <div>
                  <strong>{{ connectivityReport.ok ? t('settings.feishu.connectivity.healthy') : t('settings.feishu.connectivity.unhealthy') }}</strong>
                  <small>{{ t('settings.feishu.connectivity.summary', { time: formatTime(connectivityReport.generatedAtIso), latency: String(connectivityReport.latencyMs) }) }}</small>
                </div>
              </header>
              <ul>
                <li v-for="check in connectivityReport.checks" :key="check.id" :data-status="check.status">
                  <span class="feishu-connectivity-dot" aria-hidden="true" />
                  <span><strong>{{ connectivityCheckLabel(check.id) }}</strong><small>{{ check.message }}</small></span>
                  <b>{{ check.status === 'pass' ? t('settings.feishu.connectivity.pass') : t('settings.feishu.connectivity.fail') }}</b>
                </li>
              </ul>
            </section>
            <div v-if="diagnosticsError" class="feishu-alert" data-tone="danger" role="alert">
              <div><strong>{{ t('settings.feishu.diagnostics.loadFailed') }}</strong><p>{{ diagnosticsError }}</p></div>
            </div>
            <p v-if="isDiagnosticsLoading && !diagnostics" class="feishu-diagnostics-loading" role="status" aria-live="polite">
              {{ t('settings.feishu.diagnostics.loading') }}
            </p>
            <template v-else-if="diagnostics">
              <p class="feishu-diagnostics-generated" role="status" aria-live="polite">
                {{ t('settings.feishu.diagnostics.updated', { time: formatTime(diagnostics.generatedAtIso) }) }}
              </p>
              <div class="feishu-diagnostic-counts">
                <article>
                  <h4>{{ t('settings.feishu.diagnostics.outbox') }}</h4>
                  <dl>
                    <div><dt>{{ t('settings.feishu.diagnostics.pending') }}</dt><dd>{{ diagnostics.counts.outbox.pending }}</dd></div>
                    <div><dt>{{ t('settings.feishu.diagnostics.sending') }}</dt><dd>{{ diagnostics.counts.outbox.sending }}</dd></div>
                    <div><dt>{{ t('settings.feishu.diagnostics.sent') }}</dt><dd>{{ diagnostics.counts.outbox.sent }}</dd></div>
                    <div><dt>{{ t('settings.feishu.diagnostics.retrying') }}</dt><dd :data-tone="diagnostics.counts.outbox.failed ? 'danger' : 'neutral'">{{ diagnostics.counts.outbox.failed }}</dd></div>
                    <div><dt>{{ t('settings.feishu.diagnostics.deadLettered') }}</dt><dd :data-tone="diagnostics.counts.outbox.deadLettered ? 'danger' : 'neutral'">{{ diagnostics.counts.outbox.deadLettered }}</dd></div>
                  </dl>
                </article>
                <article>
                  <h4>{{ t('settings.feishu.diagnostics.turns') }}</h4>
                  <dl>
                    <div><dt>{{ t('settings.feishu.diagnostics.queued') }}</dt><dd>{{ diagnostics.counts.turns.queued }}</dd></div>
                    <div><dt>{{ t('settings.feishu.diagnostics.running') }}</dt><dd>{{ diagnostics.counts.turns.running }}</dd></div>
                    <div><dt>{{ t('settings.feishu.diagnostics.completed') }}</dt><dd>{{ diagnostics.counts.turns.completed }}</dd></div>
                    <div><dt>{{ t('settings.feishu.diagnostics.failed') }}</dt><dd :data-tone="diagnostics.counts.turns.failed ? 'danger' : 'neutral'">{{ diagnostics.counts.turns.failed }}</dd></div>
                    <div><dt>{{ t('settings.feishu.diagnostics.cancelled') }}</dt><dd>{{ diagnostics.counts.turns.cancelled }}</dd></div>
                  </dl>
                </article>
                <article>
                  <h4>{{ t('settings.feishu.diagnostics.cards') }}</h4>
                  <dl>
                    <div><dt>{{ t('settings.feishu.diagnostics.creating') }}</dt><dd>{{ diagnostics.counts.cards.creating }}</dd></div>
                    <div><dt>{{ t('settings.feishu.diagnostics.streaming') }}</dt><dd>{{ diagnostics.counts.cards.streaming }}</dd></div>
                    <div><dt>{{ t('settings.feishu.diagnostics.completed') }}</dt><dd>{{ diagnostics.counts.cards.completed }}</dd></div>
                    <div><dt>{{ t('settings.feishu.diagnostics.failed') }}</dt><dd :data-tone="diagnostics.counts.cards.failed ? 'danger' : 'neutral'">{{ diagnostics.counts.cards.failed }}</dd></div>
                    <div><dt>{{ t('settings.feishu.diagnostics.cancelled') }}</dt><dd>{{ diagnostics.counts.cards.cancelled }}</dd></div>
                  </dl>
                </article>
                <article>
                  <h4>{{ t('settings.feishu.diagnostics.audit') }}</h4>
                  <dl>
                    <div><dt>{{ t('settings.feishu.diagnostics.success') }}</dt><dd>{{ diagnostics.counts.audit.success }}</dd></div>
                    <div><dt>{{ t('settings.feishu.diagnostics.failed') }}</dt><dd :data-tone="diagnostics.counts.audit.failed ? 'danger' : 'neutral'">{{ diagnostics.counts.audit.failed }}</dd></div>
                  </dl>
                </article>
              </div>

              <div class="feishu-diagnostic-recents">
                <article>
                  <h4>{{ t('settings.feishu.diagnostics.failedDeliveries') }}</h4>
                  <p v-if="diagnostics.recentFailedDeliveries.length === 0" class="feishu-diagnostics-empty">{{ t('settings.feishu.diagnostics.noFailures') }}</p>
                  <ul v-else>
                    <li v-for="item in diagnostics.recentFailedDeliveries" :key="item.id">
                      <span><strong>{{ item.kind }}</strong><time :datetime="item.updatedAtIso">{{ formatTime(item.updatedAtIso) }}</time></span>
                      <span>{{ t('settings.feishu.diagnostics.attempts', { count: String(item.attempts) }) }}</span>
                      <span v-if="item.deadLetteredAtIso" data-tone="danger">{{ t('settings.feishu.diagnostics.deadLettered') }}</span>
                      <code v-if="item.error">{{ item.error }}</code>
                      <button class="feishu-secondary-button" type="button" :disabled="Boolean(retryingDeliveryId)" @click="retryDelivery(item.id)">
                        {{ retryingDeliveryId === item.id ? t('settings.feishu.diagnostics.retryingNow') : t('settings.feishu.diagnostics.retryNow') }}
                      </button>
                    </li>
                  </ul>
                </article>
                <article>
                  <h4>{{ t('settings.feishu.diagnostics.recentRuntime') }}</h4>
                  <ul>
                    <li v-for="(turn, index) in diagnostics.recentTurns" :key="`turn-${turn.updatedAtIso}-${index}`">
                      <span><strong>{{ t('settings.feishu.diagnostics.turn') }}</strong><time :datetime="turn.updatedAtIso">{{ formatTime(turn.updatedAtIso) }}</time></span>
                      <span>{{ diagnosticStatusLabel(turn.status) }}</span>
                      <code v-if="turn.error">{{ turn.error }}</code>
                    </li>
                    <li v-for="(card, index) in diagnostics.recentCards" :key="`card-${card.updatedAtIso}-${index}`">
                      <span><strong>{{ card.purpose || t('settings.feishu.diagnostics.card') }}</strong><time :datetime="card.updatedAtIso">{{ formatTime(card.updatedAtIso) }}</time></span>
                      <span>{{ diagnosticStatusLabel(card.status) }} · v{{ card.version }}</span>
                    </li>
                  </ul>
                  <p v-if="diagnostics.recentTurns.length + diagnostics.recentCards.length === 0" class="feishu-diagnostics-empty">{{ t('settings.feishu.diagnostics.noActivity') }}</p>
                </article>
                <article>
                  <h4>{{ t('settings.feishu.diagnostics.recentAudit') }}</h4>
                  <p v-if="diagnostics.recentAuditLogs.length === 0" class="feishu-diagnostics-empty">{{ t('settings.feishu.diagnostics.noAudit') }}</p>
                  <ul v-else>
                    <li v-for="(audit, index) in diagnostics.recentAuditLogs" :key="`${audit.createdAtIso}-${index}`">
                      <span><strong>{{ audit.action }}</strong><time :datetime="audit.createdAtIso">{{ formatTime(audit.createdAtIso) }}</time></span>
                      <span :data-tone="audit.success ? 'success' : 'danger'">{{ audit.success ? t('settings.feishu.diagnostics.success') : t('settings.feishu.diagnostics.failed') }}</span>
                      <code v-if="audit.error">{{ audit.error }}</code>
                    </li>
                  </ul>
                </article>
              </div>
              <p class="feishu-diagnostics-privacy">{{ t('settings.feishu.diagnostics.privacy') }}</p>
            </template>
          </section>

          <section v-if="selectedBot && !isCreating" class="feishu-auto-routes">
            <header>
              <div>
                <h3>{{ t('settings.feishu.autoRoutesTitle') }}</h3>
                <p>{{ t('settings.feishu.autoRoutesHint') }}</p>
              </div>
              <span>{{ selectedAutoRoutes.length }}</span>
            </header>
            <div v-if="selectedAutoRoutes.length === 0" class="feishu-empty feishu-empty-compact">
              <strong>{{ t('settings.feishu.autoRoutesEmptyTitle') }}</strong>
              <p>{{ t('settings.feishu.autoRoutesEmptyBody') }}</p>
            </div>
            <ul v-else>
              <li v-for="route in selectedAutoRoutes" :key="route.id" :data-enabled="String(route.enabled)">
                <div class="feishu-auto-route-heading">
                  <span class="feishu-status" :data-status="route.enabled ? 'connected' : 'disconnected'">
                    <span class="feishu-status-dot" aria-hidden="true" />
                    {{ route.enabled ? t('settings.feishu.autoRouteEnabled') : t('settings.feishu.autoRoutePaused') }}
                  </span>
                  <strong>{{ route.name }}</strong>
                  <span>{{ route.projectName || route.projectCwd }} · {{ route.sessionTitle || route.sessionId }}</span>
                </div>
                <dl>
                  <div><dt>{{ t('settings.feishu.autoRouteSource') }}</dt><dd>{{ route.sourceSenderId === '*' ? t('settings.feishu.autoRouteAnyBot') : route.sourceSenderId }}</dd></div>
                  <div><dt>{{ t('settings.feishu.autoRouteCard') }}</dt><dd>{{ route.cardTitle }}</dd></div>
                  <div><dt>{{ t('settings.feishu.autoRouteFields') }}</dt><dd>{{ route.requiredKeywords.join(' · ') || t('settings.feishu.autoRouteTitleOnly') }}</dd></div>
                  <div><dt>{{ t('settings.feishu.autoRouteInstruction') }}</dt><dd>{{ route.instruction }}</dd></div>
                  <div class="feishu-auto-route-package">
                    <dt>{{ t('settings.feishu.autoRouteScenarioPackage') }}</dt>
                    <dd>
                      <select
                        :value="route.scenarioPackageId"
                        :disabled="updatingAutoRouteId === route.id"
                        :aria-label="t('settings.feishu.autoRouteScenarioPackage')"
                        @change="updateAutoRouteScenarioPackage(route, ($event.target as HTMLSelectElement).value)"
                      >
                        <option value="">{{ t('settings.feishu.autoRouteScenarioPackageNone') }}</option>
                        <option v-for="item in scenarioPackagesForRoute(route)" :key="item.id" :value="item.id">
                          {{ item.title }}{{ item.primarySkill ? ` · ${item.primarySkill.displayName || item.primarySkill.name}` : '' }}
                        </option>
                      </select>
                      <small>{{ scenarioPackageForRoute(route)?.primarySkill
                        ? t('settings.feishu.autoRouteScenarioPackageSkill', { skill: scenarioPackageForRoute(route)?.primarySkill?.displayName || scenarioPackageForRoute(route)?.primarySkill?.name || '' })
                        : t('settings.feishu.autoRouteScenarioPackageAutodiscover') }}</small>
                    </dd>
                  </div>
                  <div><dt>{{ t('settings.feishu.autoRouteActivity') }}</dt><dd>{{ t('settings.feishu.autoRouteMatchCount', { count: String(route.matchCount) }) }} · {{ formatTime(route.lastMatchedAtIso) }}</dd></div>
                </dl>
                <div class="feishu-auto-route-actions">
                  <button
                    class="feishu-secondary-button"
                    type="button"
                    role="switch"
                    :aria-checked="route.enabled"
                    :disabled="updatingAutoRouteId === route.id"
                    @click="toggleAutoRoute(route)"
                  >
                    {{ route.enabled ? t('settings.feishu.autoRoutePause') : t('settings.feishu.autoRouteEnable') }}
                  </button>
                  <button
                    class="feishu-danger-button"
                    type="button"
                    :disabled="removingAutoRouteId === route.id"
                    @click="removeAutoRoute(route)"
                  >
                    {{ removingAutoRouteId === route.id ? t('settings.feishu.autoRouteRemoving') : t('settings.feishu.autoRouteRemove') }}
                  </button>
                </div>
              </li>
            </ul>
          </section>

          <section v-if="selectedBot && !isCreating" class="feishu-bindings">
            <header>
              <div>
                <h3>{{ t('settings.feishu.bindingsTitle') }}</h3>
                <p>{{ t('settings.feishu.bindingsHint') }}</p>
              </div>
              <span>{{ selectedBindings.length }}</span>
            </header>
            <div v-if="selectedBindings.length === 0" class="feishu-empty feishu-empty-compact">
              <strong>{{ t('settings.feishu.emptyBindingsTitle') }}</strong>
              <p>{{ t('settings.feishu.emptyBindingsBody') }}</p>
            </div>
            <ul v-else>
              <li v-for="binding in selectedBindings" :key="binding.id">
                <div class="feishu-binding-main">
                  <strong>{{ binding.projectName || binding.projectCwd }}</strong>
                  <span>{{ binding.sessionTitle || binding.sessionId || t('settings.feishu.newSession') }}</span>
                  <code>{{ bindingScopeLabel(binding) }} · {{ binding.collaborationMode || 'default' }} · {{ (binding.permissionMode || 'yolo').toUpperCase() }} · {{ binding.threadId || binding.chatId }}</code>
                </div>
                <div class="feishu-binding-meta">
                  <time :datetime="binding.lastMessageAtIso || undefined">{{ formatTime(binding.lastMessageAtIso) }}</time>
                  <button
                    class="feishu-danger-button"
                    type="button"
                    :disabled="removingBindingId === binding.id"
                    @click="unbind(binding)"
                  >
                    {{ removingBindingId === binding.id ? t('settings.feishu.unbinding') : t('settings.feishu.unbind') }}
                  </button>
                </div>
              </li>
            </ul>
          </section>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import {
  adoptFeishuOpenPlatformApp,
  cancelFeishuQrSetup,
  confirmFeishuQrSetupIdentity,
  clearFeishuOpenPlatformSession,
  createFeishuBot,
  deleteFeishuBot,
  diagnoseFeishuBot,
  fetchFeishuDiagnostics,
  fetchFeishuAutoRoutes,
  fetchFeishuBindings,
  fetchFeishuBots,
  fetchFeishuQrSetup,
  fetchFeishuQrSetups,
  fetchFeishuOpenPlatformSession,
  fetchFeishuOpenPlatformApps,
  reconnectFeishuBot,
  removeFeishuBinding,
  removeFeishuAutoRoute,
  retryFeishuDelivery,
  retryFeishuQrSetup,
  setFeishuAutoRouteEnabled,
  setFeishuAutoRouteScenarioPackage,
  startFeishuQrSetup,
  updateFeishuBot,
  type FeishuBinding,
  type FeishuAutoRoute,
  type FeishuBot,
  type FeishuBotStatus,
  type FeishuConnectivityReport,
  type FeishuDiagnostics,
  type FeishuGroupMentionMode,
  type FeishuP2pMode,
  type FeishuQrSetupJob,
  type FeishuOpenPlatformSession,
  type FeishuOpenPlatformApp,
} from '../../api/codexFeishuClient'
import { fetchPromptTemplates } from '../../api/codexPromptLibraryClient'
import { normalizePromptTemplates, type PromptTemplate } from '../../composables/promptLibraryRules'
import { useLocale } from '../../composables/useLocale'
import { isRemotePlainHttpLocation } from '../../composables/feishuTransport'

type BotDraft = {
  name: string
  appId: string
  appSecret: string
  platform: 'feishu' | 'lark'
  enabled: boolean
  allowAllUsers: boolean
  availabilityMode: 'creator' | 'members' | 'groups' | 'all'
  availabilityMemberIdsText: string
  availabilityGroupIdsText: string
  allowedOpenIdsText: string
  allowedChatIdsText: string
  groupMentionMode: FeishuGroupMentionMode
  p2pMode: FeishuP2pMode
}

const { locale, t } = useLocale()
const showTransportWarning = typeof window !== 'undefined' && isRemotePlainHttpLocation(window.location)
const bots = ref<FeishuBot[]>([])
const bindings = ref<FeishuBinding[]>([])
const autoRoutes = ref<FeishuAutoRoute[]>([])
const scenarioPackages = ref<PromptTemplate[]>([])
const diagnostics = ref<FeishuDiagnostics | null>(null)
const connectivityReport = ref<FeishuConnectivityReport | null>(null)
const selectedBotId = ref('')
const isCreating = ref(false)
const createMode = ref<'qr' | 'manual'>('qr')
const qrSetupJob = ref<FeishuQrSetupJob | null>(null)
const platformSession = ref<FeishuOpenPlatformSession | null>(null)
const existingApps = ref<FeishuOpenPlatformApp[]>([])
const isLoading = ref(true)
const isSaving = ref(false)
const isDeleting = ref(false)
const deleteRemoteAction = ref<'keep' | 'disable'>('keep')
const isRefreshing = ref(false)
const isPlatformSessionLoading = ref(false)
const isClearingPlatformSession = ref(false)
const isExistingAppsLoading = ref(false)
const hasLoadedExistingApps = ref(false)
const isDiagnosticsLoading = ref(false)
const isConnectivityLoading = ref(false)
const reconnectingBotId = ref('')
const removingBindingId = ref('')
const removingAutoRouteId = ref('')
const updatingAutoRouteId = ref('')
const retryingDeliveryId = ref('')
const loadError = ref('')
const diagnosticsError = ref('')
const connectivityError = ref('')
const actionError = ref('')
const successMessage = ref('')
const showSecret = ref(false)
const nameInput = ref<HTMLInputElement | null>(null)
const appIdInput = ref<HTMLInputElement | null>(null)
const secretInput = ref<HTMLInputElement | null>(null)
const draft = reactive<BotDraft>(emptyDraft())
let diagnosticsRequestToken = 0
let pollingTimer: ReturnType<typeof setInterval> | null = null
let reconnectPollTimer: ReturnType<typeof setTimeout> | null = null
let qrSetupPollTimer: ReturnType<typeof setTimeout> | null = null

const selectedBot = computed(() => bots.value.find((bot) => bot.id === selectedBotId.value) ?? null)
const selectedBindings = computed(() => bindings.value.filter((binding) => binding.botId === selectedBotId.value))
const selectedAutoRoutes = computed(() => autoRoutes.value.filter((route) => route.botId === selectedBotId.value))

function scenarioPackagesForRoute(route: FeishuAutoRoute): PromptTemplate[] {
  return scenarioPackages.value.filter((item) => item.scope === 'global' || item.workspaceCwd === route.projectCwd)
}

function scenarioPackageForRoute(route: FeishuAutoRoute): PromptTemplate | null {
  return scenarioPackages.value.find((item) => item.id === route.scenarioPackageId) ?? null
}
const secretPlaceholder = computed(() => isCreating.value || !selectedBot.value?.secretConfigured
  ? t('settings.feishu.field.secretPlaceholder')
  : t('settings.feishu.field.secretKeepPlaceholder'))
const hasOpenAccess = computed(() => draft.enabled && draft.allowAllUsers)
const isQrSetupActive = computed(() => Boolean(qrSetupJob.value && ['starting', 'awaiting_scan', 'authorizing', 'confirming_identity', 'creating_app', 'configuring', 'connecting'].includes(qrSetupJob.value.status)))
const mentionModeOptions = computed(() => ([
  { value: 'always', label: t('settings.feishu.groupMentionMode.always'), description: t('settings.feishu.groupMentionMode.alwaysHint') },
  { value: 'topic', label: t('settings.feishu.groupMentionMode.topic'), description: t('settings.feishu.groupMentionMode.topicHint') },
  { value: 'bound', label: t('settings.feishu.groupMentionMode.bound'), description: t('settings.feishu.groupMentionMode.boundHint') },
] satisfies Array<{ value: FeishuGroupMentionMode; label: string; description: string }>))
const p2pModeOptions = computed(() => ([
  { value: 'topic', label: t('settings.feishu.p2pMode.topic'), description: t('settings.feishu.p2pMode.topicHint') },
  { value: 'chat', label: t('settings.feishu.p2pMode.chat'), description: t('settings.feishu.p2pMode.chatHint') },
] satisfies Array<{ value: FeishuP2pMode; label: string; description: string }>))
const availabilityOptions = computed(() => ([
  { value: 'creator', label: t('settings.feishu.availability.creator'), description: t('settings.feishu.availability.creatorHint') },
  { value: 'members', label: t('settings.feishu.availability.members'), description: t('settings.feishu.availability.membersHint') },
  { value: 'groups', label: t('settings.feishu.availability.groups'), description: t('settings.feishu.availability.groupsHint') },
  { value: 'all', label: t('settings.feishu.availability.all'), description: t('settings.feishu.availability.allHint') },
] satisfies Array<{ value: BotDraft['availabilityMode']; label: string; description: string }>))
const platformOptions = computed(() => ([
  { value: 'feishu', label: t('settings.feishu.platform.feishu'), description: t('settings.feishu.platform.feishuHint') },
  { value: 'lark', label: t('settings.feishu.platform.lark'), description: t('settings.feishu.platform.larkHint') },
] satisfies Array<{ value: BotDraft['platform']; label: string; description: string }>))
const setupProofs = computed(() => {
  const checks = qrSetupJob.value?.checks
  const all = (...keys: Array<keyof NonNullable<typeof checks>>) => Boolean(checks && keys.every((key) => checks[key]))
  return [
    { id: 'credentials', label: t('settings.feishu.qr.proofs.credentials'), passed: all('credentialsSaved') },
    { id: 'account', label: t('settings.feishu.qr.proofs.account'), passed: all('accountVerified') },
    { id: 'permissions', label: t('settings.feishu.qr.proofs.permissions'), passed: all('scopesVerified', 'botAbilityVerified', 'appEnabledVerified') },
    { id: 'events', label: t('settings.feishu.qr.proofs.events'), passed: all('messageEventVerified', 'eventLongConnectionVerified') },
    { id: 'callbacks', label: t('settings.feishu.qr.proofs.callbacks'), passed: all('cardCallbackVerified', 'callbackLongConnectionVerified') },
    { id: 'release', label: t('settings.feishu.qr.proofs.release'), passed: all('versionPublishedVerified', 'visibilityVerified') },
    { id: 'connection', label: t('settings.feishu.qr.proofs.connection'), passed: all('sdkConnectionVerified', 'botIdentityVerified') },
    { id: 'probe', label: t('settings.feishu.qr.proofs.probe'), passed: all('liveProbeVerified') },
  ]
})

function emptyDraft(): BotDraft {
  return {
    name: '', appId: '', appSecret: '', platform: 'feishu', enabled: false, allowAllUsers: false,
    availabilityMode: 'creator', availabilityMemberIdsText: '', availabilityGroupIdsText: '',
    allowedOpenIdsText: '', allowedChatIdsText: '', groupMentionMode: 'always', p2pMode: 'topic',
  }
}

function setDraft(next: BotDraft): void {
  Object.assign(draft, next)
}

function botDraft(bot: FeishuBot): BotDraft {
  return {
    name: bot.name,
    appId: bot.appId,
    appSecret: '',
    platform: bot.platform,
    enabled: bot.enabled,
    allowAllUsers: bot.allowAllUsers,
    availabilityMode: 'creator',
    availabilityMemberIdsText: '',
    availabilityGroupIdsText: '',
    allowedOpenIdsText: bot.allowedOpenIds.join('\n'),
    allowedChatIdsText: (bot.allowedChatIds ?? []).join('\n'),
    groupMentionMode: bot.groupMentionMode,
    p2pMode: bot.p2pMode === 'chat' ? 'chat' : 'topic',
  }
}

function replaceBot(bot: FeishuBot): void {
  const index = bots.value.findIndex((item) => item.id === bot.id)
  if (index >= 0) bots.value.splice(index, 1, bot)
  else bots.value.push(bot)
}

function restoreSetupJob(job: FeishuQrSetupJob): void {
  isCreating.value = true
  createMode.value = 'qr'
  selectedBotId.value = ''
  setDraft(emptyDraft())
  draft.name = job.name
  qrSetupJob.value = job
  actionError.value = ''
  successMessage.value = ''
  if (isActiveQrStatus(job.status)) scheduleQrSetupPoll()
}

function selectBot(bot: FeishuBot): void {
  const changedBot = selectedBotId.value !== bot.id
  selectedBotId.value = bot.id
  isCreating.value = false
  showSecret.value = false
  actionError.value = ''
  successMessage.value = ''
  deleteRemoteAction.value = 'keep'
  if (changedBot) diagnostics.value = null
  if (changedBot) connectivityReport.value = null
  connectivityError.value = ''
  setDraft(botDraft(bot))
  void loadDiagnostics(bot.id)
}

async function startCreate(): Promise<void> {
  isCreating.value = true
  createMode.value = 'qr'
  qrSetupJob.value = null
  selectedBotId.value = ''
  showSecret.value = false
  actionError.value = ''
  successMessage.value = ''
  deleteRemoteAction.value = 'keep'
  setDraft(emptyDraft())
  diagnostics.value = null
  diagnosticsError.value = ''
  connectivityReport.value = null
  connectivityError.value = ''
  try {
    const resumable = (await fetchFeishuQrSetups()).find((job) => isActiveQrStatus(job.status) || job.status === 'failed')
    if (resumable) {
      restoreSetupJob(resumable)
    }
  } catch {
    // Recovery is best-effort; a fresh QR flow remains available.
  }
  await nextTick()
  nameInput.value?.focus()
}

async function cancelCreate(): Promise<void> {
  if (qrSetupJob.value?.canCancel) {
    try { qrSetupJob.value = await cancelFeishuQrSetup(qrSetupJob.value.id) } catch { /* The server may already have finished. */ }
  }
  stopQrSetupPolling()
  isCreating.value = false
  const fallback = bots.value[0]
  if (fallback) selectBot(fallback)
}

async function switchCreateMode(mode: 'qr' | 'manual'): Promise<void> {
  if (createMode.value === mode) return
  if (qrSetupJob.value?.canCancel) {
    qrSetupJob.value = await cancelFeishuQrSetup(qrSetupJob.value.id).catch(() => qrSetupJob.value)
  }
  stopQrSetupPolling()
  qrSetupJob.value = null
  createMode.value = mode
  actionError.value = ''
  await nextTick()
  nameInput.value?.focus()
}

async function beginQrSetup(): Promise<void> {
  actionError.value = ''
  successMessage.value = ''
  if (!draft.name) return nameInput.value?.focus()
  const allowedOpenIds = parseOpenIds(draft.allowedOpenIdsText)
  const memberIds = parseOpenIds(draft.availabilityMemberIdsText)
  const groupIds = parseOpenIds(draft.availabilityGroupIdsText)
  if (draft.availabilityMode === 'members' && memberIds.length === 0) return
  if (draft.availabilityMode === 'groups' && groupIds.length === 0) return
  if (draft.availabilityMode === 'all' && !window.confirm(t('settings.feishu.availability.allConfirm'))) return
  if (draft.allowAllUsers && !window.confirm(t('settings.feishu.qr.openAccessConfirm'))) return
  isSaving.value = true
  try {
    qrSetupJob.value = await startFeishuQrSetup({
      name: draft.name,
      allowAllUsers: draft.allowAllUsers,
      allowedOpenIds,
      groupMentionMode: draft.groupMentionMode,
      p2pMode: draft.p2pMode,
      availability: { mode: draft.availabilityMode, memberIds, groupIds },
    })
    handleQrSetupUpdate(qrSetupJob.value)
  } catch (error) {
    actionError.value = errorMessage(error)
  } finally {
    isSaving.value = false
  }
}

async function loadExistingApps(): Promise<void> {
  if (isExistingAppsLoading.value) return
  isExistingAppsLoading.value = true
  actionError.value = ''
  try {
    existingApps.value = await fetchFeishuOpenPlatformApps()
    hasLoadedExistingApps.value = true
  } catch (error) {
    actionError.value = errorMessage(error)
  } finally {
    isExistingAppsLoading.value = false
  }
}

async function adoptExistingApp(app: FeishuOpenPlatformApp): Promise<void> {
  if (isSaving.value) return
  if (!window.confirm(t('settings.feishu.existingApps.confirm', { name: app.name }))) return
  isSaving.value = true
  actionError.value = ''
  try {
    const name = draft.name || app.name
    const memberIds = parseOpenIds(draft.availabilityMemberIdsText)
    const groupIds = parseOpenIds(draft.availabilityGroupIdsText)
    if (draft.availabilityMode === 'members' && memberIds.length === 0) return
    if (draft.availabilityMode === 'groups' && groupIds.length === 0) return
    if (draft.availabilityMode === 'all' && !window.confirm(t('settings.feishu.availability.allConfirm'))) return
    draft.name = name
    qrSetupJob.value = await adoptFeishuOpenPlatformApp({
      appId: app.appId,
      name,
      allowAllUsers: draft.allowAllUsers,
      allowedOpenIds: parseOpenIds(draft.allowedOpenIdsText),
      groupMentionMode: draft.groupMentionMode,
      p2pMode: draft.p2pMode,
      availability: { mode: draft.availabilityMode, memberIds, groupIds },
    })
    handleQrSetupUpdate(qrSetupJob.value)
  } catch (error) {
    actionError.value = errorMessage(error)
  } finally {
    isSaving.value = false
  }
}

async function adoptAppById(): Promise<void> {
  if (!draft.appId.startsWith('cli_')) return
  if (!draft.name) {
    actionError.value = t('settings.feishu.existingApps.nameRequired')
    return nameInput.value?.focus()
  }
  await adoptExistingApp({ appId: draft.appId, name: draft.name, description: null })
}

function stopQrSetupPolling(): void {
  if (qrSetupPollTimer) clearTimeout(qrSetupPollTimer)
  qrSetupPollTimer = null
}

function scheduleQrSetupPoll(): void {
  stopQrSetupPolling()
  const job = qrSetupJob.value
  if (!job || !isQrSetupActive.value) return
  qrSetupPollTimer = setTimeout(() => {
    void fetchFeishuQrSetup(job.id).then((next) => {
      handleQrSetupUpdate(next)
    }).catch((error) => {
      actionError.value = errorMessage(error)
      scheduleQrSetupPoll()
    })
  }, 1_000)
}

function isActiveQrStatus(status: FeishuQrSetupJob['status']): boolean {
  return ['starting', 'awaiting_scan', 'authorizing', 'confirming_identity', 'creating_app', 'configuring', 'connecting'].includes(status)
}

function handleQrSetupUpdate(job: FeishuQrSetupJob): void {
  qrSetupJob.value = job
  if (job.status === 'completed' && job.bot) {
    finishQrSetup(job.bot)
    return
  }
  if (isActiveQrStatus(job.status)) scheduleQrSetupPoll()
  else stopQrSetupPolling()
}

function finishQrSetup(bot: FeishuBot): void {
  if (!bot) return
  stopQrSetupPolling()
  qrSetupJob.value = null
  replaceBot(bot)
  selectBot(bot)
  successMessage.value = t('settings.feishu.qr.completed')
  startReconnectPolling(bot.id)
}

async function cancelQrSetup(): Promise<void> {
  const job = qrSetupJob.value
  if (!job) return
  try {
    qrSetupJob.value = await cancelFeishuQrSetup(job.id)
    stopQrSetupPolling()
  } catch (error) {
    actionError.value = errorMessage(error)
  }
}

async function retryQrSetup(): Promise<void> {
  const job = qrSetupJob.value
  if (!job) return
  actionError.value = ''
  try {
    qrSetupJob.value = await retryFeishuQrSetup(job.id)
    handleQrSetupUpdate(qrSetupJob.value)
  } catch (error) {
    actionError.value = errorMessage(error)
  }
}

async function confirmQrIdentity(): Promise<void> {
  const job = qrSetupJob.value
  if (!job?.canConfirmIdentity || isSaving.value) return
  isSaving.value = true
  actionError.value = ''
  try {
    qrSetupJob.value = await confirmFeishuQrSetupIdentity(job.id)
    handleQrSetupUpdate(qrSetupJob.value)
  } catch (error) {
    actionError.value = errorMessage(error)
  } finally {
    isSaving.value = false
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : t('settings.feishu.unknownError')
}

async function loadData(): Promise<void> {
  isLoading.value = true
  loadError.value = ''
  try {
    const [nextBots, nextBindings, nextAutoRoutes] = await Promise.all([fetchFeishuBots(), fetchFeishuBindings(), fetchFeishuAutoRoutes()])
    bots.value = nextBots
    bindings.value = nextBindings
    autoRoutes.value = nextAutoRoutes
    void loadScenarioPackages()
    const nextSetups = await fetchFeishuQrSetups().catch(() => [])
    const resumable = nextSetups.find((job) => isActiveQrStatus(job.status) || job.status === 'failed')
    if (resumable && !isCreating.value) {
      restoreSetupJob(resumable)
      return
    }
    const current = nextBots.find((bot) => bot.id === selectedBotId.value) ?? nextBots[0]
    if (current && !isCreating.value) selectBot(current)
  } catch (error) {
    loadError.value = errorMessage(error)
  } finally {
    isLoading.value = false
  }
}

async function loadScenarioPackages(): Promise<void> {
  try {
    const stored = await fetchPromptTemplates()
    scenarioPackages.value = stored.length > 0 ? normalizePromptTemplates(stored) : []
  } catch {
    // 场景包属于自动路由的增强配置，加载失败不应阻塞机器人主体配置页。
    scenarioPackages.value = []
  }
}

async function loadPlatformSession(): Promise<void> {
  isPlatformSessionLoading.value = true
  try {
    platformSession.value = await fetchFeishuOpenPlatformSession()
  } catch (error) {
    platformSession.value = { configured: false, valid: false, account: null, error: errorMessage(error) }
  } finally {
    isPlatformSessionLoading.value = false
  }
}

async function clearPlatformSession(): Promise<void> {
  if (isClearingPlatformSession.value || isQrSetupActive.value) return
  isClearingPlatformSession.value = true
  actionError.value = ''
  try {
    await clearFeishuOpenPlatformSession()
    platformSession.value = { configured: false, valid: false, account: null, error: null }
    successMessage.value = t('settings.feishu.platformSession.cleared')
  } catch (error) {
    actionError.value = errorMessage(error)
  } finally {
    isClearingPlatformSession.value = false
  }
}

function parseOpenIds(value: string): string[] {
  return [...new Set(value.split(/[\s,;]+/).map((item) => item.trim()).filter(Boolean))]
}

function platformLabel(platform: FeishuBot['platform']): string {
  return t(platform === 'lark' ? 'settings.feishu.platform.lark' : 'settings.feishu.platform.feishu')
}

async function saveDraft(): Promise<void> {
  actionError.value = ''
  successMessage.value = ''
  if (!draft.name) return nameInput.value?.focus()
  if (!draft.appId) return appIdInput.value?.focus()
  if (isCreating.value && !draft.appSecret) return secretInput.value?.focus()
  const allowedOpenIds = parseOpenIds(draft.allowedOpenIdsText)
  const allowedChatIds = parseOpenIds(draft.allowedChatIdsText)
  if (draft.enabled && draft.allowAllUsers && !window.confirm(t('settings.feishu.openAccessConfirm'))) return
  isSaving.value = true
  try {
    const input = {
      name: draft.name,
      appId: draft.appId,
      platform: draft.platform,
      enabled: draft.enabled,
      allowAllUsers: draft.allowAllUsers,
      allowedOpenIds,
      allowedChatIds,
      groupMentionMode: draft.groupMentionMode,
      p2pMode: draft.p2pMode,
      ...(draft.appSecret ? { appSecret: draft.appSecret } : {}),
    }
    const saved = isCreating.value
      ? await createFeishuBot(input)
      : await updateFeishuBot(selectedBotId.value, input)
    replaceBot(saved)
    selectedBotId.value = saved.id
    isCreating.value = false
    setDraft(botDraft(saved))
    showSecret.value = false
    successMessage.value = t('settings.feishu.saved')
  } catch (error) {
    actionError.value = errorMessage(error)
  } finally {
    isSaving.value = false
  }
}

async function reconnectSelected(): Promise<void> {
  const bot = selectedBot.value
  if (!bot || reconnectingBotId.value) return
  actionError.value = ''
  successMessage.value = ''
  reconnectingBotId.value = bot.id
  try {
    replaceBot(await reconnectFeishuBot(bot.id))
    successMessage.value = t('settings.feishu.reconnectStarted')
    startReconnectPolling(bot.id)
  } catch (error) {
    actionError.value = errorMessage(error)
  } finally {
    reconnectingBotId.value = ''
  }
}

async function deleteSelectedBot(): Promise<void> {
  const bot = selectedBot.value
  if (!bot || isDeleting.value) return
  const confirmKey = deleteRemoteAction.value === 'disable'
    ? 'settings.feishu.deleteBotAndDisableConfirm'
    : 'settings.feishu.deleteBotConfirm'
  if (!window.confirm(t(confirmKey, { name: bot.name }))) return
  actionError.value = ''
  successMessage.value = ''
  isDeleting.value = true
  try {
    const result = await deleteFeishuBot(bot.id, deleteRemoteAction.value)
    bots.value = bots.value.filter((item) => item.id !== bot.id)
    bindings.value = bindings.value.filter((item) => item.botId !== bot.id)
    autoRoutes.value = autoRoutes.value.filter((item) => item.botId !== bot.id)
    diagnostics.value = null
    connectivityReport.value = null
    selectedBotId.value = ''
    const fallback = bots.value[0]
    if (fallback) selectBot(fallback)
    else setDraft(emptyDraft())
    successMessage.value = t(result.remoteDisabled ? 'settings.feishu.deletedAndDisabled' : 'settings.feishu.deleted')
  } catch (error) {
    actionError.value = errorMessage(error)
  } finally {
    isDeleting.value = false
  }
}

async function refreshBotState(): Promise<void> {
  if (isRefreshing.value || isLoading.value || isCreating.value || document.hidden) return
  isRefreshing.value = true
  try {
    const [nextBots, nextBindings, nextAutoRoutes] = await Promise.all([fetchFeishuBots(), fetchFeishuBindings(), fetchFeishuAutoRoutes()])
    bots.value = nextBots
    bindings.value = nextBindings
    autoRoutes.value = nextAutoRoutes
    const current = nextBots.find((bot) => bot.id === selectedBotId.value)
    if (!current && nextBots[0]) selectBot(nextBots[0])
    else if (current) void loadDiagnostics(current.id)
    loadError.value = ''
  } catch (error) {
    actionError.value = errorMessage(error)
  } finally {
    isRefreshing.value = false
  }
}

function startReconnectPolling(botId: string, attempt = 0): void {
  if (reconnectPollTimer) clearTimeout(reconnectPollTimer)
  if (attempt >= 10) return
  reconnectPollTimer = setTimeout(() => {
    if (document.hidden || selectedBotId.value !== botId) {
      startReconnectPolling(botId, attempt + 1)
      return
    }
    void fetchFeishuBots().then((nextBots) => {
      bots.value = nextBots
      const bot = nextBots.find((item) => item.id === botId)
      if (bot?.status === 'connected' || bot?.status === 'error') {
        reconnectPollTimer = null
        void loadDiagnostics(botId)
        return
      }
      startReconnectPolling(botId, attempt + 1)
    }).catch(() => startReconnectPolling(botId, attempt + 1))
  }, 2_000)
}

async function loadDiagnostics(botId: string): Promise<void> {
  if (!botId) return
  const token = ++diagnosticsRequestToken
  isDiagnosticsLoading.value = true
  diagnosticsError.value = ''
  try {
    const next = await fetchFeishuDiagnostics(botId)
    if (token === diagnosticsRequestToken && selectedBotId.value === botId) diagnostics.value = next
  } catch (error) {
    if (token === diagnosticsRequestToken && selectedBotId.value === botId) diagnosticsError.value = errorMessage(error)
  } finally {
    if (token === diagnosticsRequestToken) isDiagnosticsLoading.value = false
  }
}

async function retryDelivery(outboxId: string): Promise<void> {
  const botId = selectedBotId.value
  if (!botId || retryingDeliveryId.value) return
  retryingDeliveryId.value = outboxId
  diagnosticsError.value = ''
  try {
    await retryFeishuDelivery(botId, outboxId)
    successMessage.value = t('settings.feishu.diagnostics.retryQueued')
    await loadDiagnostics(botId)
  } catch (error) {
    diagnosticsError.value = errorMessage(error)
  } finally {
    retryingDeliveryId.value = ''
  }
}

async function runConnectivityDiagnostic(botId: string): Promise<void> {
  if (!botId || isConnectivityLoading.value) return
  isConnectivityLoading.value = true
  connectivityError.value = ''
  try {
    const report = await diagnoseFeishuBot(botId)
    if (selectedBotId.value === botId) connectivityReport.value = report
    const refreshed = await fetchFeishuBots().catch(() => [])
    const refreshedBot = refreshed.find((bot) => bot.id === botId)
    if (refreshedBot) replaceBot(refreshedBot)
    void loadDiagnostics(botId)
  } catch (error) {
    if (selectedBotId.value === botId) connectivityError.value = errorMessage(error)
  } finally {
    isConnectivityLoading.value = false
  }
}

async function unbind(binding: FeishuBinding): Promise<void> {
  if (!window.confirm(t('settings.feishu.unbindConfirm', { project: binding.projectName || binding.projectCwd }))) return
  actionError.value = ''
  successMessage.value = ''
  removingBindingId.value = binding.id
  try {
    await removeFeishuBinding(binding.id)
    bindings.value = bindings.value.filter((item) => item.id !== binding.id)
    successMessage.value = t('settings.feishu.unbound')
  } catch (error) {
    actionError.value = errorMessage(error)
  } finally {
    removingBindingId.value = ''
  }
}

async function toggleAutoRoute(route: FeishuAutoRoute): Promise<void> {
  if (updatingAutoRouteId.value) return
  actionError.value = ''
  successMessage.value = ''
  updatingAutoRouteId.value = route.id
  try {
    const updated = await setFeishuAutoRouteEnabled(route.id, !route.enabled)
    const index = autoRoutes.value.findIndex((item) => item.id === route.id)
    if (index >= 0) autoRoutes.value.splice(index, 1, updated)
    successMessage.value = t(updated.enabled ? 'settings.feishu.autoRouteEnabledMessage' : 'settings.feishu.autoRoutePausedMessage')
  } catch (error) {
    actionError.value = errorMessage(error)
  } finally {
    updatingAutoRouteId.value = ''
  }
}

async function updateAutoRouteScenarioPackage(route: FeishuAutoRoute, scenarioPackageId: string): Promise<void> {
  if (updatingAutoRouteId.value) return
  updatingAutoRouteId.value = route.id
  actionError.value = ''
  successMessage.value = ''
  try {
    const updated = await setFeishuAutoRouteScenarioPackage(route.id, scenarioPackageId)
    const index = autoRoutes.value.findIndex((item) => item.id === route.id)
    if (index >= 0) autoRoutes.value.splice(index, 1, updated)
    successMessage.value = scenarioPackageId
      ? t('settings.feishu.autoRouteScenarioPackageUpdated')
      : t('settings.feishu.autoRouteScenarioPackageCleared')
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : t('settings.feishu.autoRouteUpdateFailed')
  } finally { updatingAutoRouteId.value = '' }
}

async function removeAutoRoute(route: FeishuAutoRoute): Promise<void> {
  if (!window.confirm(t('settings.feishu.autoRouteRemoveConfirm', { name: route.name }))) return
  actionError.value = ''
  successMessage.value = ''
  removingAutoRouteId.value = route.id
  try {
    await removeFeishuAutoRoute(route.id)
    autoRoutes.value = autoRoutes.value.filter((item) => item.id !== route.id)
    successMessage.value = t('settings.feishu.autoRouteRemovedMessage')
  } catch (error) {
    actionError.value = errorMessage(error)
  } finally {
    removingAutoRouteId.value = ''
  }
}

function statusLabel(status: FeishuBotStatus): string {
  return t(`settings.feishu.status.${status}` as const)
}

function bindingScopeLabel(binding: FeishuBinding): string {
  if (binding.scopeType === 'private' && binding.threadId) return t('settings.feishu.scope.privateTopic')
  return t(`settings.feishu.scope.${binding.scopeType}` as const)
}

function diagnosticStatusLabel(status: FeishuDiagnostics['recentTurns'][number]['status'] | FeishuDiagnostics['recentCards'][number]['status']): string {
  return t(`settings.feishu.diagnostics.status.${status}` as const)
}

function connectivityCheckLabel(id: FeishuConnectivityReport['checks'][number]['id']): string {
  return t(`settings.feishu.connectivity.check.${id}` as const)
}

function qrStatusLabel(status: FeishuQrSetupJob['status']): string {
  return t(`settings.feishu.qr.status.${status}` as const)
}

function qrExpiryLabel(expiresAtIso: string | null): string {
  const expiresAt = expiresAtIso ? Date.parse(expiresAtIso) : Number.NaN
  if (!Number.isFinite(expiresAt)) return t('settings.feishu.qr.expiry')
  const remainingMs = expiresAt - Date.now()
  if (remainingMs <= 0) return t('settings.feishu.qr.expiredHint')
  return t('settings.feishu.qr.expiryRemaining', {
    minutes: String(Math.max(1, Math.ceil(remainingMs / 60_000))),
  })
}

function formatTime(value: string | null): string {
  if (!value) return t('settings.feishu.never')
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return value
  return new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(timestamp))
}

function onVisibilityChange(): void {
  if (!document.hidden) void refreshBotState()
}

onMounted(() => {
  void loadData()
  void loadPlatformSession()
  pollingTimer = setInterval(() => void refreshBotState(), 30_000)
  document.addEventListener('visibilitychange', onVisibilityChange)
})

onBeforeUnmount(() => {
  if (pollingTimer) clearInterval(pollingTimer)
  if (reconnectPollTimer) clearTimeout(reconnectPollTimer)
  stopQrSetupPolling()
  document.removeEventListener('visibilitychange', onVisibilityChange)
})
</script>

<style scoped>
@reference "../../style.css";

.feishu-panel { min-width: 0; }
.feishu-toolbar, .feishu-detail-header, .feishu-auto-routes > header, .feishu-bindings > header, .feishu-diagnostics > header { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; }
.feishu-toolbar { margin-bottom: 0.75rem; border-top: 1px solid var(--color-border); padding-top: 0.75rem; }
.feishu-toolbar > div { display: grid; gap: 0.15rem; }
.feishu-toolbar-actions { display: flex !important; flex-shrink: 0; flex-direction: row !important; gap: 0.5rem !important; }
.feishu-toolbar strong, .feishu-empty strong { color: var(--color-text); font-size: 0.82rem; }
.feishu-toolbar span, .feishu-empty p { color: var(--color-text-muted); font-size: 0.75rem; line-height: 1.5; }
.feishu-platform-session { display: flex; min-width: 0; align-items: center; justify-content: space-between; gap: 0.75rem; margin-bottom: 0.75rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface); padding: 0.65rem 0.75rem; }
.feishu-platform-session > div { display: grid; min-width: 0; gap: 0.15rem; }
.feishu-platform-session strong { color: var(--color-text); font-size: 0.74rem; }
.feishu-platform-session span, .feishu-platform-session small { overflow-wrap: anywhere; color: var(--color-text-muted); font-size: 0.68rem; line-height: 1.45; }
.feishu-platform-session small { color: var(--color-danger); }
.feishu-layout { display: grid; min-width: 0; grid-template-columns: minmax(10rem, 0.32fr) minmax(0, 1fr); gap: 0.75rem; }
.feishu-bot-list { display: flex; min-width: 0; flex-direction: column; gap: 0.4rem; }
.feishu-bot-card { display: grid; width: 100%; min-height: 4.2rem; cursor: pointer; gap: 0.25rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface); padding: 0.65rem; color: var(--color-text); text-align: left; transition: border-color 180ms ease, background 180ms ease; }
.feishu-bot-card:hover { background: var(--color-elevated); }
.feishu-bot-card.is-active { border-color: var(--color-accent); background: color-mix(in srgb, var(--color-accent) 8%, var(--color-surface)); }
.feishu-bot-card-heading { display: flex; min-width: 0; align-items: center; justify-content: space-between; gap: 0.5rem; }
.feishu-bot-card-heading strong { overflow: hidden; font-size: 0.8rem; text-overflow: ellipsis; white-space: nowrap; }
.feishu-bot-app-id { overflow: hidden; color: var(--color-text-muted); font-family: var(--font-mono); font-size: 0.68rem; text-overflow: ellipsis; white-space: nowrap; }
.feishu-bot-tenant, .feishu-bot-platform { overflow: hidden; color: var(--color-text-muted); font-size: 0.65rem; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.feishu-bot-disabled { color: var(--color-warning); font-size: 0.68rem; }
.feishu-status { display: inline-flex; flex-shrink: 0; align-items: center; gap: 0.28rem; color: var(--color-text-muted); font-size: 0.65rem; font-weight: 600; }
.feishu-status-dot { width: 0.45rem; height: 0.45rem; border-radius: 999px; background: var(--color-text-muted); }
.feishu-status[data-status='connected'] .feishu-status-dot { background: var(--color-success); }
.feishu-status[data-status='connecting'] .feishu-status-dot { background: var(--color-warning); }
.feishu-status[data-status='error'] .feishu-status-dot { background: var(--color-danger); }
.feishu-detail { display: grid; min-width: 0; gap: 0.75rem; }
.feishu-form, .feishu-health, .feishu-auto-routes, .feishu-bindings, .feishu-diagnostics { min-width: 0; border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-surface); padding: 0.85rem; }
.feishu-detail-header { margin-bottom: 0.8rem; }
.feishu-detail h3 { margin: 0; color: var(--color-text); font-size: 0.88rem; }
.feishu-detail-header p, .feishu-auto-routes header p, .feishu-bindings header p { margin: 0.18rem 0 0; color: var(--color-text-muted); font-size: 0.72rem; line-height: 1.45; }
.feishu-enabled-switch { display: inline-flex; min-height: 2.75rem; cursor: pointer; align-items: center; gap: 0.5rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: 0 0.7rem; color: var(--color-text); font-size: 0.75rem; font-weight: 600; }
.feishu-enabled-switch input { width: 1rem; height: 1rem; accent-color: var(--color-accent); }
.feishu-manual-enabled-switch { width: fit-content; margin: 0 0 0.75rem auto; }
.feishu-create-modes { display: inline-flex; flex-shrink: 0; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-panel); padding: 0.2rem; }
.feishu-create-modes button { min-height: 2.35rem; cursor: pointer; border: 0; border-radius: calc(var(--radius-md) - 0.15rem); background: transparent; padding: 0 0.7rem; color: var(--color-text-muted); font-size: 0.7rem; font-weight: 650; }
.feishu-create-modes button.is-active { background: var(--color-surface); color: var(--color-text); box-shadow: 0 1px 3px color-mix(in srgb, #000 16%, transparent); }
.feishu-qr-intro { display: grid; gap: 0.65rem; margin-bottom: 0.8rem; border: 1px solid color-mix(in srgb, var(--color-accent) 28%, var(--color-border)); border-radius: var(--radius-md); background: color-mix(in srgb, var(--color-accent) 5%, var(--color-surface)); padding: 0.75rem; }
.feishu-qr-intro ol { display: grid; list-style: none; margin: 0; padding: 0; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.5rem; }
.feishu-qr-intro li { display: flex; min-width: 0; align-items: center; gap: 0.45rem; color: var(--color-text); font-size: 0.7rem; font-weight: 650; }
.feishu-qr-intro li strong { display: inline-grid; flex: 0 0 1.55rem; height: 1.55rem; place-items: center; border-radius: 999px; background: var(--color-accent); color: var(--color-on-accent, #fff); font-size: 0.68rem; }
.feishu-qr-intro p { margin: 0; color: var(--color-text-muted); font-size: 0.68rem; line-height: 1.5; }
.feishu-existing-apps { display: grid; grid-column: 1 / -1; justify-items: start; gap: 0.45rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-panel); padding: 0.65rem 0.75rem; }
.feishu-existing-apps summary { width: 100%; min-height: 2.75rem; cursor: pointer; align-content: center; color: var(--color-text); font-size: 0.72rem; font-weight: 700; }
.feishu-existing-apps[open] summary { margin-bottom: 0.15rem; }
.feishu-existing-apps > p { margin: 0; color: var(--color-text-muted); font-size: 0.67rem; line-height: 1.5; }
.feishu-existing-app-id { display: grid; width: 100%; grid-template-columns: minmax(0, 1fr) auto; align-items: end; gap: 0.5rem; }
.feishu-existing-app-id label { display: grid; min-width: 0; gap: 0.3rem; color: var(--color-text-muted); font-size: 0.68rem; font-weight: 650; }
.feishu-existing-apps small, .feishu-existing-apps > span { color: var(--color-text-muted); font-size: 0.66rem; line-height: 1.45; }
.feishu-existing-apps ul { display: grid; width: 100%; list-style: none; margin: 0; padding: 0; gap: 0.4rem; }
.feishu-existing-apps li { display: flex; min-width: 0; align-items: center; justify-content: space-between; gap: 0.6rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface); padding: 0.5rem; }
.feishu-existing-apps li > span { display: grid; min-width: 0; gap: 0.1rem; }
.feishu-existing-apps li strong { overflow: hidden; color: var(--color-text); font-size: 0.7rem; text-overflow: ellipsis; white-space: nowrap; }
.feishu-existing-apps li code { overflow-wrap: anywhere; color: var(--color-text-muted); font-size: 0.62rem; }
.feishu-qr-name-field { grid-column: 1 / -1; }
.feishu-qr-progress { display: grid; justify-items: center; gap: 0.65rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-elevated); padding: 1rem; }
.feishu-qr-progress-heading { display: flex; width: 100%; align-items: center; justify-content: center; gap: 0.65rem; text-align: left; }
.feishu-qr-progress-heading > div { display: grid; gap: 0.12rem; }
.feishu-qr-progress-heading strong { color: var(--color-text); font-size: 0.78rem; }
.feishu-qr-progress-heading small, .feishu-qr-expiry { margin: 0; color: var(--color-text-muted); font-size: 0.67rem; line-height: 1.45; }
.feishu-qr-spinner { width: 1.2rem; height: 1.2rem; flex: 0 0 auto; border: 2px solid color-mix(in srgb, var(--color-accent) 24%, var(--color-border)); border-top-color: var(--color-accent); border-radius: 999px; animation: feishu-spin 800ms linear infinite; }
.feishu-qr-spinner[data-done='true'] { border-color: var(--color-success); animation: none; }
.feishu-qr-code { display: block; width: min(20rem, 100%); height: auto; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: #fff; padding: 0.5rem; }
.feishu-qr-account { display: grid; width: min(28rem, 100%); margin: 0; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.6rem; }
.feishu-qr-account div { min-width: 0; border-top: 1px solid var(--color-border); padding-top: 0.5rem; }
.feishu-qr-account dt { color: var(--color-text-muted); font-size: 0.65rem; }
.feishu-qr-account dd { display: grid; overflow-wrap: anywhere; gap: 0.1rem; margin: 0.18rem 0 0; color: var(--color-text); font-size: 0.72rem; font-weight: 650; }
.feishu-qr-account dd small { color: var(--color-text-muted); font-size: 0.63rem; font-weight: 400; }
.feishu-setup-proofs { display: grid; width: min(36rem, 100%); gap: 0.5rem; border-top: 1px solid var(--color-border); padding-top: 0.7rem; }
.feishu-setup-proofs > header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
.feishu-setup-proofs > header strong { color: var(--color-text); font-size: 0.72rem; }
.feishu-setup-proofs > header small { color: var(--color-text-muted); font-size: 0.65rem; font-variant-numeric: tabular-nums; }
.feishu-setup-proofs ul { display: grid; margin: 0; padding: 0; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.4rem; list-style: none; }
.feishu-setup-proofs li { display: grid; min-width: 0; min-height: 2.75rem; grid-template-columns: 1.25rem minmax(0, 1fr) auto; align-items: center; gap: 0.35rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: 0.45rem 0.55rem; }
.feishu-setup-proofs li > span { display: grid; width: 1.15rem; height: 1.15rem; place-items: center; border-radius: 999px; background: var(--color-panel); color: var(--color-text-muted); font-size: 0.7rem; font-weight: 800; }
.feishu-setup-proofs li > strong { overflow: hidden; color: var(--color-text); font-size: 0.66rem; text-overflow: ellipsis; white-space: nowrap; }
.feishu-setup-proofs li > small { color: var(--color-text-muted); font-size: 0.61rem; }
.feishu-setup-proofs li[data-passed='true'] { border-color: color-mix(in srgb, var(--color-success) 38%, var(--color-border)); background: color-mix(in srgb, var(--color-success) 5%, var(--color-surface)); }
.feishu-setup-proofs li[data-passed='true'] > span { background: var(--color-success); color: #fff; }
.feishu-form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.75rem; }
.feishu-form-grid > label { display: grid; min-width: 0; gap: 0.3rem; }
.feishu-form-grid > label > span { color: var(--color-text-muted); font-size: 0.7rem; font-weight: 650; }
.feishu-form-grid input, .feishu-form-grid textarea { width: 100%; min-width: 0; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-elevated); padding: 0.65rem 0.7rem; color: var(--color-text); font: inherit; font-size: 0.8rem; line-height: 1.4; outline: none; transition: border-color 180ms ease, box-shadow 180ms ease; }
.feishu-form-grid input { min-height: 2.75rem; }
.feishu-form-grid textarea { resize: vertical; }
.feishu-form-grid input:focus, .feishu-form-grid textarea:focus { border-color: var(--color-accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-accent) 20%, transparent); }
.feishu-form-grid small { color: var(--color-text-muted); font-size: 0.67rem; line-height: 1.45; }
.feishu-secret-field, .feishu-allowlist-field, .feishu-open-access-field, .feishu-availability-field, .feishu-mention-mode-field { grid-column: 1 / -1; }
.feishu-open-access-field { display: flex !important; align-items: flex-start; gap: 0.65rem; padding: 0.75rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); }
.feishu-open-access-field input { width: auto !important; margin-top: 0.2rem; }
.feishu-open-access-field > span { display: grid; gap: 0.2rem; }
.feishu-mention-mode-field { min-width: 0; margin: 0; border: 0; padding: 0; }
.feishu-mention-mode-field legend { padding: 0; color: var(--color-text-muted); font-size: 0.7rem; font-weight: 650; }
.feishu-mention-mode-field > p { margin: 0.25rem 0 0.5rem; color: var(--color-text-muted); font-size: 0.67rem; line-height: 1.45; }
.feishu-mention-mode-options { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.5rem; }
.feishu-mention-mode-options label { display: grid; min-width: 0; min-height: 4.5rem; cursor: pointer; grid-template-columns: auto minmax(0, 1fr); align-items: start; gap: 0.5rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-elevated); padding: 0.65rem; transition: border-color 180ms ease, background 180ms ease; }
.feishu-mention-mode-options label:hover { background: var(--color-panel); }
.feishu-mention-mode-options label:has(input:focus-visible) { outline: 2px solid var(--color-accent); outline-offset: 2px; }
.feishu-mention-mode-options label:has(input:checked) { border-color: var(--color-accent); background: color-mix(in srgb, var(--color-accent) 8%, var(--color-surface)); }
.feishu-mention-mode-options label[data-risk='high']:has(input:checked) { border-color: var(--color-warning); background: color-mix(in srgb, var(--color-warning) 8%, var(--color-surface)); }
.feishu-mention-mode-options input { width: 1rem; height: 1rem; margin: 0.1rem 0 0; accent-color: var(--color-accent); }
.feishu-mention-mode-options span { display: grid; min-width: 0; gap: 0.2rem; }
.feishu-mention-mode-options strong { color: var(--color-text); font-size: 0.72rem; }
.feishu-mention-mode-options small { color: var(--color-text-muted); font-size: 0.65rem; line-height: 1.45; }
.feishu-platform-field .feishu-mention-mode-options { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.feishu-availability-field { display: grid; min-width: 0; gap: 0.55rem; margin: 0; border: 0; padding: 0; }
.feishu-availability-field legend { padding: 0; color: var(--color-text-muted); font-size: 0.7rem; font-weight: 650; }
.feishu-availability-field > p { margin: 0; color: var(--color-text-muted); font-size: 0.67rem; line-height: 1.45; }
.feishu-availability-options { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 0.5rem; }
.feishu-availability-options label { display: grid; min-width: 0; cursor: pointer; grid-template-columns: auto minmax(0, 1fr); align-items: start; gap: 0.5rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-elevated); padding: 0.65rem; }
.feishu-availability-options label:has(input:checked) { border-color: var(--color-accent); background: color-mix(in srgb, var(--color-accent) 8%, var(--color-surface)); }
.feishu-availability-options input { width: 1rem; height: 1rem; margin: 0.1rem 0 0; accent-color: var(--color-accent); }
.feishu-availability-options span { display: grid; gap: 0.2rem; }
.feishu-availability-options strong { color: var(--color-text); font-size: 0.72rem; }
.feishu-availability-options small { color: var(--color-text-muted); font-size: 0.65rem; line-height: 1.45; }
.feishu-delete-options { display: grid; gap: 0.5rem; margin: 0.8rem 0 0; border: 1px solid color-mix(in srgb, var(--color-danger) 30%, var(--color-border)); border-radius: var(--radius-md); background: color-mix(in srgb, var(--color-danger) 4%, var(--color-surface)); padding: 0.75rem; }
.feishu-delete-options legend { padding: 0 0.3rem; color: var(--color-danger); font-size: 0.72rem; font-weight: 700; }
.feishu-delete-options > p { margin: 0; color: var(--color-text-muted); font-size: 0.67rem; line-height: 1.45; }
.feishu-delete-options > label { display: grid; min-height: 2.75rem; cursor: pointer; grid-template-columns: auto minmax(0, 1fr); align-items: start; gap: 0.55rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-elevated); padding: 0.65rem; }
.feishu-delete-options > label:has(input:checked) { border-color: var(--color-accent); background: color-mix(in srgb, var(--color-accent) 7%, var(--color-surface)); }
.feishu-delete-options > label[data-risk='high']:has(input:checked) { border-color: var(--color-danger); background: color-mix(in srgb, var(--color-danger) 8%, var(--color-surface)); }
.feishu-delete-options input { width: 1rem; height: 1rem; margin: 0.1rem 0 0; accent-color: var(--color-danger); }
.feishu-delete-options span { display: grid; gap: 0.18rem; }
.feishu-delete-options strong { color: var(--color-text); font-size: 0.72rem; }
.feishu-delete-options small { color: var(--color-text-muted); font-size: 0.65rem; line-height: 1.45; }
.feishu-secret-input { display: grid; grid-template-columns: minmax(0, 1fr) auto; }
.feishu-secret-input input { border-radius: var(--radius-md) 0 0 var(--radius-md); }
.feishu-secret-input button { min-width: 4rem; cursor: pointer; border: 1px solid var(--color-border); border-left: 0; border-radius: 0 var(--radius-md) var(--radius-md) 0; background: var(--color-panel); color: var(--color-text); font-size: 0.72rem; }
.feishu-form-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 0.5rem; margin-top: 0.8rem; border-top: 1px solid var(--color-border); padding-top: 0.8rem; }
.feishu-delete-bot-button { margin-right: auto; }
.feishu-primary-button, .feishu-secondary-button, .feishu-danger-button, .feishu-alert button { display: inline-flex; min-height: 2.75rem; cursor: pointer; align-items: center; justify-content: center; border-radius: var(--radius-md); padding: 0 0.85rem; font-size: 0.75rem; font-weight: 650; transition: opacity 180ms ease, background 180ms ease, border-color 180ms ease; }
.feishu-primary-button { border: 1px solid var(--color-accent); background: var(--color-accent); color: var(--color-on-accent, #fff); }
.feishu-secondary-button, .feishu-alert button { border: 1px solid var(--color-border); background: var(--color-panel); color: var(--color-text); }
.feishu-danger-button { border: 1px solid color-mix(in srgb, var(--color-danger) 48%, var(--color-border)); background: color-mix(in srgb, var(--color-danger) 8%, var(--color-surface)); color: var(--color-danger); }
button:disabled { cursor: wait; opacity: 0.5; }
button:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
.feishu-health dl { display: grid; margin: 0; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.65rem; }
.feishu-health dl div { min-width: 0; }
.feishu-health dt { color: var(--color-text-muted); font-size: 0.68rem; font-weight: 650; }
.feishu-health dd { overflow-wrap: anywhere; margin: 0.2rem 0 0; color: var(--color-text); font-size: 0.76rem; }
.feishu-last-error { display: grid; gap: 0.2rem; margin: 0.75rem 0 0; border-top: 1px solid var(--color-border); padding-top: 0.75rem; color: var(--color-danger); font-size: 0.72rem; line-height: 1.5; }
.feishu-diagnostics > header { align-items: center; margin-bottom: 0.65rem; }
.feishu-diagnostics > header p { margin: 0.18rem 0 0; color: var(--color-text-muted); font-size: 0.72rem; line-height: 1.45; }
.feishu-diagnostics-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 0.5rem; }
.feishu-connectivity-report { margin-bottom: 0.75rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-panel); padding: 0.7rem; }
.feishu-connectivity-report[data-status='pass'] { border-color: color-mix(in srgb, var(--color-success) 42%, var(--color-border)); }
.feishu-connectivity-report[data-status='fail'] { border-color: color-mix(in srgb, var(--color-danger) 42%, var(--color-border)); }
.feishu-connectivity-report > header > div { display: grid; gap: 0.15rem; }
.feishu-connectivity-report > header strong { color: var(--color-text); font-size: 0.76rem; }
.feishu-connectivity-report > header small { color: var(--color-text-muted); font-size: 0.64rem; }
.feishu-connectivity-report ul { display: grid; gap: 0.35rem; margin: 0.6rem 0 0; padding: 0; list-style: none; }
.feishu-connectivity-report li { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: start; gap: 0.5rem; border-top: 1px solid var(--color-border); padding-top: 0.45rem; }
.feishu-connectivity-report li > span:nth-child(2) { display: grid; gap: 0.12rem; }
.feishu-connectivity-report li strong, .feishu-connectivity-report li b { color: var(--color-text); font-size: 0.68rem; }
.feishu-connectivity-report li small { overflow-wrap: anywhere; color: var(--color-text-muted); font-size: 0.63rem; line-height: 1.4; }
.feishu-connectivity-report li[data-status='pass'] b { color: var(--color-success); }
.feishu-connectivity-report li[data-status='fail'] b { color: var(--color-danger); }
.feishu-connectivity-dot { width: 0.55rem; height: 0.55rem; margin-top: 0.18rem; border-radius: 999px; background: var(--color-danger); }
.feishu-connectivity-report li[data-status='pass'] .feishu-connectivity-dot { background: var(--color-success); }
.feishu-diagnostics-generated, .feishu-diagnostics-loading { margin: 0 0 0.65rem; color: var(--color-text-muted); font-size: 0.67rem; }
.feishu-diagnostic-counts { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 0.5rem; }
.feishu-diagnostic-counts article { min-width: 0; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-panel); padding: 0.6rem; }
.feishu-diagnostics h4 { margin: 0 0 0.45rem; color: var(--color-text); font-size: 0.72rem; }
.feishu-diagnostic-counts dl { display: grid; margin: 0; gap: 0.28rem; }
.feishu-diagnostic-counts dl div { display: flex; min-width: 0; align-items: baseline; justify-content: space-between; gap: 0.4rem; }
.feishu-diagnostic-counts dt { overflow: hidden; color: var(--color-text-muted); font-size: 0.65rem; text-overflow: ellipsis; white-space: nowrap; }
.feishu-diagnostic-counts dd { margin: 0; color: var(--color-text); font-family: var(--font-mono); font-size: 0.72rem; font-weight: 700; }
.feishu-diagnostic-counts dd[data-tone='danger'] { color: var(--color-danger); }
.feishu-diagnostic-recents { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.5rem; margin-top: 0.5rem; }
.feishu-diagnostic-recents article { min-width: 0; border-top: 1px solid var(--color-border); padding-top: 0.6rem; }
.feishu-diagnostic-recents ul { display: grid; max-height: 15rem; overflow-y: auto; list-style: none; margin: 0; padding: 0; gap: 0.35rem; }
.feishu-diagnostic-recents li { display: grid; min-width: 0; gap: 0.15rem; border-radius: var(--radius-sm); background: var(--color-panel); padding: 0.45rem 0.5rem; color: var(--color-text-muted); font-size: 0.64rem; line-height: 1.4; }
.feishu-diagnostic-recents li > span:first-child { display: flex; min-width: 0; align-items: baseline; justify-content: space-between; gap: 0.4rem; }
.feishu-diagnostic-recents strong { overflow: hidden; color: var(--color-text); font-size: 0.67rem; text-overflow: ellipsis; white-space: nowrap; }
.feishu-diagnostic-recents time { flex-shrink: 0; color: var(--color-text-muted); font-size: 0.6rem; }
.feishu-diagnostic-recents code { overflow-wrap: anywhere; color: var(--color-danger); font-size: 0.62rem; white-space: normal; }
.feishu-diagnostic-recents li > button { justify-self: start; margin-top: 0.2rem; }
.feishu-diagnostic-recents [data-tone='success'] { color: var(--color-success); }
.feishu-diagnostic-recents [data-tone='danger'] { color: var(--color-danger); }
.feishu-diagnostics-empty { margin: 0; color: var(--color-text-muted); font-size: 0.67rem; line-height: 1.45; }
.feishu-diagnostics-privacy { margin: 0.65rem 0 0; border-top: 1px solid var(--color-border); padding-top: 0.55rem; color: var(--color-text-muted); font-size: 0.64rem; line-height: 1.45; }
.feishu-auto-routes > header { align-items: center; margin-bottom: 0.7rem; }
.feishu-auto-routes > header > span, .feishu-bindings > header > span { display: inline-grid; min-width: 1.65rem; height: 1.65rem; place-items: center; border-radius: 999px; background: var(--color-elevated); color: var(--color-text); font-size: 0.7rem; font-weight: 700; }
.feishu-auto-routes ul { display: grid; list-style: none; margin: 0; padding: 0; gap: 0.6rem; }
.feishu-auto-routes li { display: grid; min-width: 0; grid-template-columns: minmax(12rem, 0.8fr) minmax(16rem, 1.4fr) auto; align-items: start; gap: 0.8rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-panel); padding: 0.7rem; }
.feishu-auto-routes li[data-enabled='false'] { opacity: 0.72; }
.feishu-auto-route-heading { display: grid; min-width: 0; gap: 0.22rem; }
.feishu-auto-route-heading > strong { overflow: hidden; color: var(--color-text); font-size: 0.78rem; text-overflow: ellipsis; white-space: nowrap; }
.feishu-auto-route-heading > span:last-child { overflow-wrap: anywhere; color: var(--color-text-muted); font-size: 0.67rem; line-height: 1.4; }
.feishu-auto-routes dl { display: grid; min-width: 0; margin: 0; gap: 0.3rem; }
.feishu-auto-routes dl > div { display: grid; min-width: 0; grid-template-columns: 4.5rem minmax(0, 1fr); gap: 0.45rem; }
.feishu-auto-routes dt { color: var(--color-text-muted); font-size: 0.64rem; font-weight: 650; }
.feishu-auto-routes dd { overflow-wrap: anywhere; margin: 0; color: var(--color-text); font-size: 0.66rem; line-height: 1.45; }
.feishu-auto-route-package dd { display:grid; gap:.25rem; }
.feishu-auto-route-package select { min-height:2.35rem; min-width:0; width:100%; border:1px solid var(--color-border); border-radius:var(--radius-sm); background:var(--color-control); color:var(--color-text); padding:0 .55rem; font-size:.68rem; }
.feishu-auto-route-package small { color:var(--color-text-muted); font-size:.61rem; line-height:1.4; }
.feishu-auto-route-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 0.4rem; }
.feishu-auto-route-actions button { min-width: 5.5rem; }
.feishu-bindings > header { align-items: center; margin-bottom: 0.7rem; }
.feishu-bindings ul { display: grid; list-style: none; margin: 0; padding: 0; gap: 0.5rem; }
.feishu-bindings li { display: flex; min-width: 0; align-items: center; justify-content: space-between; gap: 0.75rem; border-top: 1px solid var(--color-border); padding-top: 0.65rem; }
.feishu-binding-main { display: grid; min-width: 0; gap: 0.18rem; }
.feishu-binding-main strong { color: var(--color-text); font-size: 0.78rem; }
.feishu-binding-main span { color: var(--color-text-muted); font-size: 0.72rem; }
.feishu-binding-main code { overflow-wrap: anywhere; color: var(--color-text-muted); font-size: 0.65rem; }
.feishu-binding-meta { display: flex; flex-shrink: 0; align-items: center; gap: 0.65rem; }
.feishu-binding-meta time { color: var(--color-text-muted); font-size: 0.65rem; }
.feishu-empty { border: 1px dashed var(--color-border); border-radius: var(--radius-lg); padding: 1.25rem; text-align: center; }
.feishu-empty p { margin: 0.3rem auto 0.8rem; max-width: 36rem; }
.feishu-empty-compact { padding: 1rem; }
.feishu-empty-compact p { margin-bottom: 0; }
.feishu-alert { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; margin: 0 0 0.75rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: 0.65rem 0.75rem; font-size: 0.72rem; line-height: 1.45; }
.feishu-alert strong, .feishu-alert p { margin: 0; }
.feishu-alert[data-tone='danger'] { border-color: color-mix(in srgb, var(--color-danger) 42%, var(--color-border)); background: color-mix(in srgb, var(--color-danger) 8%, var(--color-surface)); color: var(--color-danger); }
.feishu-alert[data-tone='success'] { border-color: color-mix(in srgb, var(--color-success) 42%, var(--color-border)); background: color-mix(in srgb, var(--color-success) 8%, var(--color-surface)); color: color-mix(in srgb, var(--color-success) 52%, var(--color-text)); }
.feishu-alert[data-tone='warning'] { border-color: color-mix(in srgb, var(--color-warning) 48%, var(--color-border)); background: color-mix(in srgb, var(--color-warning) 10%, var(--color-surface)); color: color-mix(in srgb, var(--color-warning) 58%, var(--color-text)); }
.feishu-transport-warning { align-items: flex-start; }
.feishu-transport-warning > div { display: grid; gap: 0.18rem; }
.feishu-transport-warning p { color: var(--color-text-muted); }
.feishu-loading { display: grid; min-height: 8rem; place-content: center; gap: 0.5rem; color: var(--color-text-muted); font-size: 0.75rem; text-align: center; }
.feishu-loading-bar { width: min(15rem, 70vw); height: 0.7rem; border-radius: 999px; background: var(--color-elevated); animation: feishu-pulse 1.4s ease-in-out infinite alternate; }
.feishu-loading-bar:nth-child(2) { width: min(10rem, 50vw); }
@keyframes feishu-pulse { to { opacity: 0.42; } }
@keyframes feishu-spin { to { transform: rotate(360deg); } }

@media (prefers-reduced-motion: reduce) {
  .feishu-qr-spinner, .feishu-loading-bar { animation-duration: 1ms; animation-iteration-count: 1; }
}

@media (max-width: 760px) {
  .feishu-layout { grid-template-columns: minmax(0, 1fr); }
  .feishu-bot-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .feishu-form-grid { grid-template-columns: minmax(0, 1fr); }
  .feishu-secret-field, .feishu-allowlist-field, .feishu-open-access-field, .feishu-availability-field, .feishu-mention-mode-field { grid-column: auto; }
  .feishu-availability-options { grid-template-columns: minmax(0, 1fr); }
  .feishu-mention-mode-options { grid-template-columns: minmax(0, 1fr); }
  .feishu-platform-field .feishu-mention-mode-options { grid-template-columns: minmax(0, 1fr); }
  .feishu-qr-intro ol { grid-template-columns: minmax(0, 1fr); }
  .feishu-diagnostic-counts { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .feishu-diagnostic-recents { grid-template-columns: minmax(0, 1fr); }
  .feishu-auto-routes li { grid-template-columns: minmax(0, 1fr); }
  .feishu-auto-route-actions { justify-content: stretch; }
  .feishu-auto-route-actions button { flex: 1; }
}
@media (max-width: 520px) {
  .feishu-setup-proofs ul { grid-template-columns: 1fr; }
  .feishu-toolbar, .feishu-platform-session, .feishu-detail-header, .feishu-auto-routes > header, .feishu-bindings li, .feishu-diagnostics > header { align-items: stretch; flex-direction: column; }
  .feishu-create-modes { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .feishu-toolbar-actions { width: 100%; }
  .feishu-toolbar-actions > button { flex: 1; }
  .feishu-bot-list { grid-template-columns: minmax(0, 1fr); }
  .feishu-health dl { grid-template-columns: minmax(0, 1fr); }
  .feishu-binding-meta { justify-content: space-between; }
  .feishu-binding-meta .feishu-danger-button { flex: 1; }
  .feishu-form-actions > button { flex: 1 1 8rem; }
  .feishu-qr-account { grid-template-columns: minmax(0, 1fr); }
  .feishu-delete-bot-button { margin-right: 0; }
  .feishu-diagnostic-counts { grid-template-columns: minmax(0, 1fr); }
  .feishu-diagnostics-actions { width: 100%; }
  .feishu-diagnostics-actions button { flex: 1 1 10rem; }
  .feishu-existing-app-id { grid-template-columns: minmax(0, 1fr); }
  .feishu-existing-app-id > button { width: 100%; }
}
@media (prefers-reduced-motion: reduce) {
  .feishu-loading-bar { animation: none; }
  .feishu-bot-card, .feishu-form-grid input, .feishu-form-grid textarea, .feishu-primary-button, .feishu-secondary-button, .feishu-danger-button { transition: none; }
}
</style>
