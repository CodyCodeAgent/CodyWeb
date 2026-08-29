import type { ConversationPlanState } from '@codycodeagent/cody-web-core/conversation'

export type DesktopPlanState = {
  threadId: string
  turnId: string
  explanation: string
  steps: NonNullable<ConversationPlanState['steps']>
  updatedAtIso: string
  revision: number
  lifecycle: ConversationPlanState['lifecycle']
  possiblyStale: boolean
}
