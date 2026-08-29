import type { UiComposerPermissionMode } from '../types/codex'

export type ComposerPermissionModeOption = {
  value: UiComposerPermissionMode
  label: string
}

export type TurnPermissionOverride = {
  approvalPolicy?: 'untrusted' | 'on-request' | 'never'
  sandboxPolicy?: { type: 'dangerFullAccess' }
}

export const DEFAULT_COMPOSER_PERMISSION_MODE: UiComposerPermissionMode = 'current'

export const COMPOSER_PERMISSION_MODE_OPTIONS: ComposerPermissionModeOption[] = [
  { value: 'current', label: 'Normal' },
  { value: 'yolo', label: 'YOLO' },
]

export function normalizeComposerPermissionMode(value: unknown): UiComposerPermissionMode {
  return value === 'yolo' ? 'yolo' : DEFAULT_COMPOSER_PERMISSION_MODE
}

export function buildTurnPermissionOverride(mode: UiComposerPermissionMode): TurnPermissionOverride | null {
  if (mode !== 'yolo') return null
  return {
    approvalPolicy: 'never',
    sandboxPolicy: { type: 'dangerFullAccess' },
  }
}
