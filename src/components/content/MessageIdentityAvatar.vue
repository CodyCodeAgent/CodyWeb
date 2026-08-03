<template>
  <details v-if="role === 'assistant'" class="message-identity message-identity-assistant">
    <summary :aria-label="assistantLabel" :title="assistantLabel">
      <span class="message-identity-frame" aria-hidden="true">
        <img v-if="avatarUrl" :src="avatarUrl" alt="" width="44" height="44" />
        <span v-else class="message-identity-fallback">C</span>
        <i class="message-identity-presence" />
      </span>
    </summary>
    <section class="message-identity-card" :aria-label="t('growth.cardAria')">
      <header>
        <img v-if="avatarUrl" :src="avatarUrl" alt="" width="42" height="42" />
        <span v-else class="message-identity-card-fallback">C</span>
        <div>
          <strong>Cody</strong>
          <small>{{ t('growth.scope') }}</small>
        </div>
        <b>Lv.{{ growth.level }}</b>
      </header>
      <div class="message-identity-level-icons" :aria-label="t('growth.iconsAria')">
        <i v-for="(icon, index) in growth.icons" :key="`${icon.kind}:${String(index)}`" :data-kind="icon.kind">{{ icon.symbol }}</i>
      </div>
      <p>{{ t('growth.nextLevel', { level: String(growth.level + 1), value: formatGrowth(growth.remaining) }) }}</p>
      <div class="message-identity-progress" role="progressbar" :aria-valuenow="growth.percent" aria-valuemin="0" aria-valuemax="100">
        <i :style="{ width: `${String(growth.percent)}%` }" />
      </div>
      <dl>
        <div><dt>{{ t('growth.today') }}</dt><dd>{{ compactNumber(growth.todayTokens) }}</dd></div>
        <div><dt>{{ t('growth.active') }}</dt><dd>{{ t('growth.days', { count: String(growth.activeDays) }) }}</dd></div>
        <div><dt>{{ t('growth.streak') }}</dt><dd>{{ t('growth.days', { count: String(growth.streakDays) }) }}</dd></div>
      </dl>
      <p v-if="isLoading" class="message-identity-state">{{ t('growth.syncing') }}</p>
      <p v-else-if="error" class="message-identity-state message-identity-error">{{ t(error === 'save' ? 'growth.saveError' : 'growth.loadError') }}</p>
    </section>
  </details>
  <span v-else class="message-identity message-identity-user" :aria-label="userLabel" :title="userLabel">
    <span class="message-identity-frame" aria-hidden="true">
      <img v-if="avatarUrl" :src="avatarUrl" alt="" width="44" height="44" />
      <span v-else class="message-identity-fallback">YOU</span>
      <i class="message-identity-presence" />
    </span>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { CodyGrowthSnapshot } from '../../composables/codyGrowthRules'
import { useLocale } from '../../composables/useLocale'
import { useTheme } from '../../theme/useTheme'

const props = defineProps<{
  role: 'assistant' | 'user'
  growth: CodyGrowthSnapshot
  isLoading: boolean
  error: '' | 'load' | 'save'
}>()

const { activeSkin } = useTheme()
const { t } = useLocale()
const avatarUrl = computed(() => props.role === 'assistant'
  ? activeSkin.value.assets?.assistantAvatar ?? ''
  : activeSkin.value.assets?.userAvatar ?? '')
const assistantLabel = computed(() => t('growth.assistantLabel', { level: String(props.growth.level) }))
const userLabel = computed(() => t('growth.userLabel'))

function compactNumber(value: number): string {
  const normalized = Math.max(0, Number(value) || 0)
  if (normalized >= 1_000_000) return `${(normalized / 1_000_000).toFixed(normalized >= 10_000_000 ? 0 : 1)}M`
  if (normalized >= 1_000) return `${Math.round(normalized / 1_000)}K`
  return String(Math.round(normalized))
}

function formatGrowth(value: number): string {
  const normalized = Math.max(0, Number(value) || 0)
  return normalized.toFixed(normalized % 1 === 0 ? 0 : 2)
}
</script>

<style scoped>
.message-identity {
  position: relative;
  z-index: 4;
  flex: 0 0 44px;
  width: 44px;
  height: 44px;
}

.message-identity > summary {
  width: 44px;
  height: 44px;
  display: block;
  cursor: pointer;
  list-style: none;
  border-radius: 10px;
}

.message-identity > summary::-webkit-details-marker { display: none; }

.message-identity > summary:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 3px;
}

.message-identity-frame {
  position: relative;
  width: 44px;
  height: 44px;
  display: grid;
  place-items: center;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--color-accent) 58%, var(--color-border));
  border-radius: 10px;
  background: linear-gradient(180deg, color-mix(in srgb, var(--color-panel) 72%, white), var(--color-elevated));
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.88), 0 2px 8px rgb(25 75 119 / 0.2);
}

.message-identity-frame img {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: cover;
}

.message-identity-assistant .message-identity-frame img {
  object-fit: contain;
  object-position: center 18%;
  transform: scale(1.22);
}

.message-identity-fallback,
.message-identity-card-fallback {
  color: var(--color-accent);
  font: 800 13px/1 var(--font-mono);
}

.message-identity-presence {
  position: absolute;
  right: 2px;
  bottom: 2px;
  width: 9px;
  height: 9px;
  border: 2px solid var(--color-panel);
  border-radius: 50%;
  background: var(--color-success);
}

.message-identity-card {
  position: absolute;
  top: 52px;
  left: 0;
  z-index: 30;
  width: min(310px, calc(100vw - 40px));
  padding: 12px;
  border: 1px solid color-mix(in srgb, var(--color-accent) 54%, var(--color-border));
  border-radius: var(--radius-md);
  background: linear-gradient(180deg, color-mix(in srgb, var(--color-panel) 88%, white), var(--color-elevated));
  box-shadow: var(--shadow-floating);
  color: var(--color-text);
}

.message-identity-card header {
  display: grid;
  grid-template-columns: 42px minmax(0, 1fr) auto;
  gap: 9px;
  align-items: center;
}

.message-identity-card header > img,
.message-identity-card-fallback {
  width: 42px;
  height: 42px;
  display: grid;
  place-items: center;
  object-fit: contain;
  border: 1px solid var(--color-border);
  border-radius: 9px;
  background: var(--color-panel);
}

.message-identity-card header div { min-width: 0; display: grid; gap: 2px; }
.message-identity-card header strong { font-size: 14px; }
.message-identity-card header small { overflow: hidden; color: var(--color-text-muted); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.message-identity-card header b { color: var(--color-accent); font-size: 18px; }

.message-identity-level-icons { min-height: 22px; display: flex; align-items: center; gap: 2px; margin-top: 8px; }
.message-identity-level-icons i { font: normal 17px/1 Georgia, serif; }
.message-identity-level-icons i[data-kind='crown'] { color: #d98d00; }
.message-identity-level-icons i[data-kind='sun'] { color: #e57d00; }
.message-identity-level-icons i[data-kind='moon'] { color: #2387c8; }
.message-identity-level-icons i[data-kind='star'] { color: #dca800; }
.message-identity-level-icons i[data-kind='empty'] { color: var(--color-text-muted); }

.message-identity-card > p { margin: 4px 0; color: var(--color-text-muted); font-size: 11px; }
.message-identity-progress { height: 6px; overflow: hidden; border: 1px solid var(--color-border); border-radius: 999px; background: var(--color-panel); }
.message-identity-progress i { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, var(--color-info), var(--color-success) 72%, var(--color-warning)); transition: width var(--motion-slow) ease; }

.message-identity-card dl { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; margin: 10px 0 0; }
.message-identity-card dl div { padding: 7px 4px; border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: color-mix(in srgb, var(--color-panel) 76%, transparent); text-align: center; }
.message-identity-card dt { color: var(--color-text-muted); font-size: 9px; }
.message-identity-card dd { margin: 2px 0 0; color: var(--color-text); font-size: 12px; font-weight: 750; }
.message-identity-card .message-identity-state { margin-top: 8px; }
.message-identity-card .message-identity-error { color: var(--color-danger); }

@media (max-width: 700px) {
  .message-identity-frame {
    width: 32px;
    height: 32px;
    margin: 6px;
    border-radius: 8px;
  }

  .message-identity-card { top: 44px; }
}

@media (prefers-reduced-motion: reduce) {
  .message-identity-progress i { transition: none; }
}
</style>
