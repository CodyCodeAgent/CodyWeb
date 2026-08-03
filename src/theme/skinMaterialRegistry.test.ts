import { describe, expect, it } from 'vitest'
import { loadBuiltInSkinMaterials } from './skinMaterialRegistry'

describe('built-in skin material registry', () => {
  it('loads QQ identity materials on demand without coupling them to the skin registry', async () => {
    const materials = await loadBuiltInSkinMaterials('qq-2007')
    expect(materials?.assistantAvatar).toMatch(/^data:image\/png;base64,/u)
    expect(materials?.userAvatar).toMatch(/^data:image\/png;base64,/u)
    expect(await loadBuiltInSkinMaterials('control-tower')).toBeNull()
  })
})
