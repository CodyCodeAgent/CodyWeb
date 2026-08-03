import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const files = {
  app: new URL('../App.vue', import.meta.url),
  layout: new URL('../components/layout/DesktopLayout.vue', import.meta.url),
  header: new URL('../components/content/ContentHeader.vue', import.meta.url),
  composer: new URL('../components/content/ThreadComposer.vue', import.meta.url),
  conversation: new URL('../components/content/ThreadConversation.vue', import.meta.url),
  style: new URL('../style.css', import.meta.url),
}

describe('Skin API v2 public contract', () => {
  it('publishes stable semantic regions and component hooks', async () => {
    const [app, layout, header, composer, conversation] = await Promise.all([
      readFile(files.app, 'utf8'),
      readFile(files.layout, 'utf8'),
      readFile(files.header, 'utf8'),
      readFile(files.composer, 'utf8'),
      readFile(files.conversation, 'utf8'),
    ])
    expect(layout).toContain('data-cody-region="app-shell"')
    expect(layout).toContain('data-cody-region="sidebar"')
    expect(layout).toContain('data-cody-region="workspace"')
    expect(app).toContain('data-cody-region="content"')
    expect(app).toContain('data-cody-region="workspace-chrome"')
    expect(app).toContain('data-cody-region="contextbar"')
    expect(header).toContain('data-cody-region="titlebar"')
    expect(composer).toContain('data-cody-component="composer-surface"')
    expect(conversation).toContain('data-cody-component="message"')
  })

  it('implements QQ 2007 through recipes without a skin-id CSS branch', async () => {
    const style = await readFile(files.style, 'utf8')
    expect(style).not.toContain("data-theme-skin='qq-2007'")
    for (const recipe of ['chrome', 'navigation', 'panel', 'control', 'message', 'identity', 'composer', 'backdrop']) {
      expect(style).toContain(`data-skin-recipe-${recipe}`)
    }
  })

  it('keeps chrome controls legible and prevents panel recipes from overriding the titlebar', async () => {
    const style = await readFile(files.style, 'utf8')
    expect(style).toContain("[data-cody-component='panel']:not([data-cody-region='titlebar']):not([data-cody-region='contextbar'])")
    expect(style).toContain("[data-skin-recipe-chrome='glossy'] .content-header :is(")
    expect(style).toContain('.browser-notifications-trigger')
    expect(style).toContain('.sidebar-thread-controls-button')
  })

  it('only renders a glossy chrome separator when the skin supplies a label', async () => {
    const style = await readFile(files.style, 'utf8')
    expect(style).toContain("span[data-skin-label]:not([data-skin-label=''])::after")
    expect(style).not.toContain(".sidebar-brand span::after")
  })

  it('uses one geometry contract for sidebar and workspace chrome across skins', async () => {
    const style = await readFile(files.style, 'utf8')
    expect(style).toContain('--ui-shell-titlebar-height')
    expect(style).toContain('--ui-shell-commandbar-height')
    expect(style).toContain('--ui-shell-titlebar-background')
    expect(style).toContain('--ui-shell-commandbar-background')
    expect(style).toContain("[data-skin-recipe-chrome='glossy']")
    expect(style).toContain("[data-skin-recipe-chrome='terminal']")
  })
})
