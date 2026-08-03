import type { SkinAssets } from './tokens'

type SkinMaterialLoader = () => Promise<SkinAssets>

const BUILT_IN_SKIN_MATERIAL_LOADERS: Record<string, SkinMaterialLoader> = {
  'qq-2007': async () => {
    const materials = await import('./qqSkinAssets')
    return {
      assistantAvatar: materials.QQ_ASSISTANT_AVATAR,
      userAvatar: materials.QQ_USER_AVATAR,
    }
  },
}

export async function loadBuiltInSkinMaterials(skinId: string): Promise<SkinAssets | null> {
  const loader = BUILT_IN_SKIN_MATERIAL_LOADERS[skinId]
  return loader ? loader() : null
}
