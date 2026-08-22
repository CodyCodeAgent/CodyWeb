export type DataAuthorityPolicy = {
  resource: 'rate-limits' | 'plan' | 'messages' | 'token-usage' | 'catalog'
  authority: string
  realtimeMode: 'invalidate' | 'replace-snapshot' | 'apply-overlay' | 'apply-delta-then-reconcile'
}

export const DATA_AUTHORITY_POLICIES: Record<string, DataAuthorityPolicy> = {
  'account/rateLimits/updated': {
    resource: 'rate-limits',
    authority: 'account/rateLimits/read',
    realtimeMode: 'invalidate',
  },
  'turn/plan/updated': {
    resource: 'plan',
    authority: 'turn/plan/updated revisioned snapshot',
    realtimeMode: 'replace-snapshot',
  },
  'item/agentMessage/delta': {
    resource: 'messages',
    authority: 'thread/read completed item',
    realtimeMode: 'apply-overlay',
  },
  'thread/tokenUsage/updated': {
    resource: 'token-usage',
    authority: 'local rollout reconciliation',
    realtimeMode: 'apply-delta-then-reconcile',
  },
  'thread/started': {
    resource: 'catalog',
    authority: 'thread/list synchronized catalog',
    realtimeMode: 'invalidate',
  },
}

export function dataAuthorityPolicy(method: string): DataAuthorityPolicy | null {
  if (dataAuthorityFor(method) === 'ignore') return null
  return DATA_AUTHORITY_POLICIES[method] ?? null
}
import { dataAuthorityFor } from '@codycodeagent/cody-web-core/conversation'
