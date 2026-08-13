import { describe, expect, it } from 'vitest'
import type { ConversationShareRecord } from './conversationShareStore'
import { renderConversationShareImage } from './conversationShareImage'

function shareWithImages(images: string[]): ConversationShareRecord {
  return {
    id: 'share-1',
    threadId: 'thread-1',
    title: 'Multiple screenshots',
    publicPath: '/share/token',
    createdAtIso: '2026-08-12T00:00:00.000Z',
    expiresAtIso: null,
    revokedAtIso: null,
    messageCount: 1,
    turnCount: 1,
    snapshot: {
      version: 2,
      locale: 'zh-CN',
      title: 'Multiple screenshots',
      threadTitle: 'Multiple screenshots',
      projectName: 'project',
      createdAtIso: '2026-08-12T00:00:00.000Z',
      selectedTurnIds: ['turn-1'],
      selectedMessageIds: ['message-1'],
      theme: null,
      options: { includeToolDetails: false, redactLocalPaths: true },
      messages: [{
        id: 'message-1', turnId: 'turn-1', role: 'user', text: 'Screenshots', messageType: 'userMessage',
        imageCount: images.length, images, tool: null,
      }],
    },
  }
}

describe('conversation share image', () => {
  it('renders every materialized image instead of limiting a message to four', () => {
    const images = ['AA==', 'AQ==', 'Ag==', 'Aw==', 'BA==', 'BQ=='].map((value) => `data:image/png;base64,${value}`)
    const svg = renderConversationShareImage(shareWithImages(images))

    for (const [index, source] of images.entries()) {
      expect(svg).toContain(`id="image-1-${String(index)}"`)
      expect(svg).toContain(`href="${source}"`)
    }
  })
})
