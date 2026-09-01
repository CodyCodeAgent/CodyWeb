import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fetchDirectoryListing,
  respondServerRequest,
  uploadLocalImage,
} from './codexBridgeClient'

function mockFetch(response: Response): ReturnType<typeof vi.fn> {
  const fetchSpy = vi.fn(async () => response)
  vi.stubGlobal('fetch', fetchSpy)
  return fetchSpy
}

class FakeFileReader {
  result: string | null = null
  error: Error | null = null
  onload: (() => void) | null = null
  onerror: (() => void) | null = null

  readAsDataURL(): void {
    this.result = 'data:image/png;base64,abc'
    this.onload?.()
  }
}

describe('codex bridge client', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('responds to pending server requests through the bridge endpoint', async () => {
    const fetchSpy = mockFetch(new Response(JSON.stringify({ ok: true }), { status: 200 }))

    await expect(respondServerRequest({
      id: 42,
      approvalScope: 'session',
      result: { ok: true },
    })).resolves.toBeUndefined()

    expect(fetchSpy).toHaveBeenCalledWith('/codex-api/server-requests/respond', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        id: 42,
        approvalScope: 'session',
        result: { ok: true },
      }),
    }))
  })

  it('normalizes directory listings and drops malformed entries', async () => {
    mockFetch(new Response(JSON.stringify({
      result: {
        path: '/repo',
        parentPath: '/repo/..',
        directories: [
          { name: 'src', path: '/repo/src' },
          { name: '', path: '/repo/empty' },
          { name: 'missing-path' },
          null,
        ],
      },
    }), { status: 200 }))

    await expect(fetchDirectoryListing('/repo')).resolves.toEqual({
      path: '/repo',
      parentPath: '/repo/..',
      directories: [
        { name: 'src', path: '/repo/src' },
      ],
    })
  })

  it('uploads local images as data URLs', async () => {
    vi.stubGlobal('FileReader', FakeFileReader)
    const fetchSpy = mockFetch(new Response(JSON.stringify({
      result: {
        id: 'image-1',
        name: 'screen.png',
        path: '/tmp/screen.png',
        url: '/codex-api/local-image?path=%2Ftmp%2Fscreen.png',
        mimeType: 'image/png',
      },
    }), { status: 200 }))

    await expect(uploadLocalImage({
      name: 'screen.png',
      type: 'image/png',
    } as File)).resolves.toEqual({
      id: 'image-1',
      name: 'screen.png',
      path: '/tmp/screen.png',
      url: '/codex-api/local-image?path=%2Ftmp%2Fscreen.png',
      mimeType: 'image/png',
    })

    expect(fetchSpy).toHaveBeenCalledWith('/codex-api/uploads/images', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        name: 'screen.png',
        mimeType: 'image/png',
        dataUrl: 'data:image/png;base64,abc',
      }),
    }))
  })
})
