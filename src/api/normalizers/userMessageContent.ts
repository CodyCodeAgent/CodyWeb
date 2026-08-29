import type { ComposerSkill } from '@codycodeagent/cody-web-core/composer'
import type { UiMessage } from '../../types/codex'
import { asRecord, readString, toRawPayload } from '../protocolValueReaders'

export type ParsedUserMessageContent = {
  text: string
  images: string[]
  skills: ComposerSkill[]
  rawBlocks: UiMessage[]
}

export { toRawPayload } from '../protocolValueReaders'

export function toLocalImagePreviewUrl(path: string): string {
  return `/codex-api/local-image?path=${encodeURIComponent(path)}`
}

export function extractCodexUserRequestText(value: string): string {
  const markerRegex = /(?:^|\n)\s{0,3}#{0,6}\s*my request for codex\s*:?\s*/giu
  const matches = Array.from(value.matchAll(markerRegex))
  if (matches.length === 0) {
    return value.trim()
  }

  const lastMatch = matches.at(-1)
  if (!lastMatch || typeof lastMatch.index !== 'number') {
    return value.trim()
  }

  const markerOffset = lastMatch.index + lastMatch[0].length
  return value.slice(markerOffset).trim()
}

export function parseUserMessageContent(
  itemId: string,
  content: unknown,
  turnId?: string,
): ParsedUserMessageContent {
  if (!Array.isArray(content)) return { text: '', images: [], skills: [], rawBlocks: [] }

  const textChunks: string[] = []
  const images: string[] = []
  const skills: ComposerSkill[] = []
  const rawBlocks: UiMessage[] = []

  for (const [index, value] of content.entries()) {
    const block = asRecord(value)
    if (!block) continue

    const blockType = readString(block.type)
    if (blockType === 'text') {
      const text = readString(block.text)
      if (text) {
        textChunks.push(text)
      }
      continue
    }

    if (blockType === 'image') {
      const url = readString(block.url).trim()
      if (url) {
        images.push(url)
      }
      continue
    }

    if (blockType === 'localImage') {
      const path = readString(block.path).trim()
      if (path) {
        images.push(toLocalImagePreviewUrl(path))
      }
      continue
    }

    if (blockType === 'skill') {
      const name = readString(block.name).trim()
      const path = readString(block.path).trim()
      if (name && path) {
        skills.push({
          name,
          path,
          displayName: name,
          description: '',
        })
      }
      continue
    }

    rawBlocks.push({
      id: `${itemId}:user-content:${String(index)}`,
      turnId,
      role: 'user',
      text: '',
      messageType: `userContent.${blockType || 'unknown'}`,
      rawPayload: toRawPayload(value),
      isUnhandled: true,
    })
  }

  return {
    text: extractCodexUserRequestText(textChunks.join('\n')),
    images,
    skills,
    rawBlocks,
  }
}

export function buildUserMessageContentMessages(
  itemId: string,
  content: unknown,
  messageType = 'userMessage',
  turnId?: string,
): UiMessage[] {
  const parsed = parseUserMessageContent(itemId, content, turnId)
  const messages: UiMessage[] = []

  if (parsed.text.length > 0 || parsed.images.length > 0 || parsed.skills.length > 0) {
    messages.push({
      id: itemId,
      turnId,
      role: 'user',
      text: parsed.text,
      images: parsed.images,
      skills: parsed.skills,
      messageType,
    })
  }

  messages.push(...parsed.rawBlocks)
  return messages
}
