import {
  approvalDecisionForScope,
  approvalScopeForDecision,
  buildApprovalRiskSummary,
  type ApprovalDecision,
  type ApprovalDecisionScope,
  type ApprovalRiskSummary,
  type ApprovalRiskTranslator,
} from '@codycodeagent/cody-web-core/presentation'
import type { UiApprovalGrant, UiServerRequest, UiServerRequestReply } from '../types/codex'
import {
  TOOL_CALL_REQUEST_METHOD,
  TOOL_USER_INPUT_REQUEST_METHOD,
  isCommandApprovalRequestMethod,
  isFileChangeApprovalRequestMethod,
  isToolCallRequestMethod,
  isToolUserInputRequestMethod,
} from '@codycodeagent/cody-web-core/protocol'

export {
  TOOL_CALL_REQUEST_METHOD,
  TOOL_USER_INPUT_REQUEST_METHOD,
  isToolCallRequestMethod,
  isToolUserInputRequestMethod,
} from '@codycodeagent/cody-web-core/protocol'

export type UiServerRequestKind =
  | 'command_approval'
  | 'file_change_approval'
  | 'tool_user_input'
  | 'tool_call'
  | 'unknown'

export type UiServerRequestCard = {
  request: UiServerRequest
  summary: ApprovalRiskSummary
  kind: UiServerRequestKind
  isApprovalRequest: boolean
}

export type UiServerRequestRiskCounts = {
  high: number
  medium: number
}

export type UiServerRequestBadgeTone = 'high' | 'medium' | 'low'

export function serverRequestKind(method: string): UiServerRequestKind {
  if (isCommandApprovalRequestMethod(method)) return 'command_approval'
  if (isFileChangeApprovalRequestMethod(method)) return 'file_change_approval'
  if (isToolUserInputRequestMethod(method)) return 'tool_user_input'
  if (isToolCallRequestMethod(method)) return 'tool_call'
  return 'unknown'
}

export function isServerApprovalRequestKind(kind: UiServerRequestKind): boolean {
  return kind === 'command_approval' || kind === 'file_change_approval'
}

export function isServerApprovalRequest(request: Pick<UiServerRequest, 'method'>): boolean {
  return isServerApprovalRequestKind(serverRequestKind(request.method))
}

export function serverRequestActionKeyPrefix(kind: UiServerRequestKind): string {
  if (kind === 'command_approval') return 'command'
  if (kind === 'file_change_approval') return 'file'
  return 'request'
}

export function formatServerRequestTime(value: string, format: 'short' | 'long' = 'short'): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return format === 'long' ? date.toLocaleString() : date.toLocaleTimeString()
}

export function serverRequestMetaLabel(input: {
  request: Pick<UiServerRequest, 'id' | 'threadId' | 'receivedAtIso'>
  idPrefix?: string
  includeThread?: boolean
  timeFormat?: 'short' | 'long'
}): string {
  const parts = [
    `${input.idPrefix ?? '#'}${String(input.request.id)}`,
  ]
  if (input.includeThread) {
    parts.push(input.request.threadId || 'global')
  }
  parts.push(formatServerRequestTime(input.request.receivedAtIso, input.timeFormat ?? 'short'))
  return parts.join(' · ')
}

export function buildServerRequestCards(
  requests: UiServerRequest[],
  approvalRiskTranslator?: ApprovalRiskTranslator,
): UiServerRequestCard[] {
  return requests.map((request) => ({
    request,
    summary: buildApprovalRiskSummary(request, approvalRiskTranslator),
    kind: serverRequestKind(request.method),
    isApprovalRequest: isServerApprovalRequest(request),
  }))
}

export function serverRequestRiskCounts(cards: Pick<UiServerRequestCard, 'summary'>[]): UiServerRequestRiskCounts {
  return {
    high: cards.filter((card) => card.summary.level === 'high').length,
    medium: cards.filter((card) => card.summary.level === 'medium').length,
  }
}

export function serverRequestBadgeTone(cards: Pick<UiServerRequestCard, 'summary'>[]): UiServerRequestBadgeTone {
  const counts = serverRequestRiskCounts(cards)
  if (counts.high > 0) return 'high'
  return cards.length > 0 ? 'medium' : 'low'
}

export function serverRequestApprovalCenterSummary(cards: Pick<UiServerRequestCard, 'summary'>[]): string {
  if (cards.length === 0) {
    return 'No local command, file, or tool approvals are waiting.'
  }
  const counts = serverRequestRiskCounts(cards)
  return `${String(counts.high)} high risk · ${String(counts.medium)} medium · respond without leaving the workspace`
}

export function approvalGrantSummaryText(cwd: string, grants: Pick<UiApprovalGrant, 'scope'>[]): string {
  if (!cwd) return 'Choose a workspace to inspect reusable approvals.'
  if (grants.length === 0) return 'Exact-match workspace and permanent grants will appear here.'
  const permanentCount = grants.filter((grant) => grant.scope === 'permanent').length
  return `${String(grants.length)} active · ${String(permanentCount)} permanent`
}

export function buildApprovalDecisionReply(requestId: number, decision: ApprovalDecision): UiServerRequestReply {
  return {
    id: requestId,
    approvalScope: approvalScopeForDecision(decision),
    result: { decision },
  }
}

export function buildApprovalScopeReply(requestId: number, scope: ApprovalDecisionScope): UiServerRequestReply {
  return {
    id: requestId,
    approvalScope: scope,
    result: { decision: approvalDecisionForScope(scope) },
  }
}

export function buildEmptyServerRequestReply(requestId: number): UiServerRequestReply {
  return {
    id: requestId,
    result: {},
  }
}

export function buildRejectedServerRequestReply(requestId: number, message: string): UiServerRequestReply {
  return {
    id: requestId,
    error: {
      code: -32000,
      message,
    },
  }
}
