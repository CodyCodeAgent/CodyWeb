import { renderPlantUmlSvg } from '../diagramRenderService.js'
import { handleDirectoryList } from '../directoryBrowser.js'
import { handleImageUpload, handleLocalImage } from '../imageUploads.js'
import { handleDeletePromptTemplate, handleFavoritePromptTemplate, handleListPromptTemplates, handleReplacePromptTemplates, handleSavePromptTemplate, handleUsePromptTemplate } from '../promptLibraryStore.js'
import { handleListUserSettings, handleReadUserSetting, handleWriteUserSetting } from '../settingsStore.js'
import { handleThemeAssetRead, handleThemeAssetUpload } from '../themeAssetStore.js'
import { asRecord, readJsonBody, setJson, type DomainRoute } from './httpRoute.js'

export function createContentRoutes(dependencies: {
  draftScenarioPackage?: (input: { cwd: string; brief: string }) => Promise<unknown>
} = {}): DomainRoute {
  return async ({ req, res, url }) => {
    const key = `${req.method ?? ''} ${url.pathname}`
    if (key === 'POST /codex-api/uploads/images') await handleImageUpload(req, res)
    else if (key === 'POST /codex-api/theme-assets') await handleThemeAssetUpload(req, res)
    else if ((req.method === 'GET' || req.method === 'HEAD') && /^\/codex-api\/theme-assets\/[a-f0-9]{64}$/u.test(url.pathname)) {
      await handleThemeAssetRead(url.pathname.slice('/codex-api/theme-assets/'.length), res, req.method)
    }
    else if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/codex-api/local-image') await handleLocalImage(url, res, req.method)
    else if (key === 'GET /codex-api/settings') await handleReadUserSetting(url, res)
    else if (key === 'GET /codex-api/settings/list') await handleListUserSettings(url, res)
    else if (key === 'POST /codex-api/settings') await handleWriteUserSetting(req, res)
    else if (key === 'GET /codex-api/prompt-templates') await handleListPromptTemplates(url, res)
    else if (key === 'POST /codex-api/prompt-templates') await handleReplacePromptTemplates(req, res)
    else if (key === 'POST /codex-api/prompt-templates/item') await handleSavePromptTemplate(req, res)
    else if (key === 'DELETE /codex-api/prompt-templates/item') await handleDeletePromptTemplate(url, res)
    else if (key === 'POST /codex-api/prompt-templates/use') await handleUsePromptTemplate(req, res)
    else if (key === 'POST /codex-api/prompt-templates/favorite') await handleFavoritePromptTemplate(req, res)
    else if (key === 'POST /codex-api/scenario-packages/draft') {
      if (!dependencies.draftScenarioPackage) setJson(res, 503, { error: 'Scenario package drafting is unavailable' })
      else {
        const body = asRecord(await readJsonBody(req))
        const cwd = typeof body?.cwd === 'string' ? body.cwd.trim() : ''
        const brief = typeof body?.brief === 'string' ? body.brief.trim() : ''
        if (!cwd || !brief) setJson(res, 400, { error: 'A workspace and scenario description are required' })
        else setJson(res, 200, { result: { draft: await dependencies.draftScenarioPackage({ cwd, brief }) } })
      }
    }
    else if (key === 'GET /codex-api/fs/directories') await handleDirectoryList(url, res)
    else if (key === 'POST /codex-api/diagrams/plantuml') {
      const body = asRecord(await readJsonBody(req)); const source = typeof body?.source === 'string' ? body.source : ''
      try { setJson(res, 200, { result: { svg: await renderPlantUmlSvg(source) } }) }
      catch (error) { setJson(res, 422, { error: error instanceof Error ? error.message : 'PlantUML rendering failed' }) }
    } else return false
    return true
  }
}
