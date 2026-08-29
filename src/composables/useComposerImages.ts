import { ref } from 'vue'
import { uploadComposerImage } from '../api/codexComposerClient'
import {
  DEFAULT_COMPOSER_IMAGE_POLICY,
  validateComposerImage,
  type ComposerImage,
} from '@codycodeagent/cody-web-core/composer'

function getImageFiles(files: FileList | File[]): File[] {
  return Array.from(files).filter((file) => DEFAULT_COMPOSER_IMAGE_POLICY.supportedMimeTypes.includes(file.type))
}

export function hasImageFile(items: DataTransferItemList | null | undefined): boolean {
  if (!items) return false
  return Array.from(items).some((item) => item.kind === 'file' && item.type.startsWith('image/'))
}

export function useComposerImages() {
  const attachedImages = ref<ComposerImage[]>([])
  const isUploadingImage = ref(false)
  const uploadError = ref('')

  function removeImage(imageId: string): void {
    attachedImages.value = attachedImages.value.filter((image) => image.id !== imageId)
  }

  function resetImages(): void {
    attachedImages.value = []
    uploadError.value = ''
  }

  async function attachFiles(files: FileList | File[]): Promise<void> {
    const imageFiles = getImageFiles(files)
    const remainingSlots = DEFAULT_COMPOSER_IMAGE_POLICY.maxCount - attachedImages.value.length
    if (remainingSlots <= 0) {
      uploadError.value = `You can attach up to ${String(DEFAULT_COMPOSER_IMAGE_POLICY.maxCount)} images`
      return
    }

    const candidates = imageFiles.slice(0, remainingSlots)
    if (candidates.length === 0) return

    isUploadingImage.value = true
    uploadError.value = ''

    try {
      const uploadedImages: ComposerImage[] = []
      for (const file of candidates) {
        const validation = validateComposerImage(file)
        if (!validation.accepted) {
          uploadError.value = validation.reason === 'too_large'
            ? `${file.name || 'Image'} is larger than 20 MB`
            : `${file.name || 'Image'} is not a supported image type`
          continue
        }
        uploadedImages.push(await uploadComposerImage(file))
      }

      if (uploadedImages.length > 0) {
        attachedImages.value = [...attachedImages.value, ...uploadedImages]
      }
    } catch (error) {
      uploadError.value = error instanceof Error ? error.message : 'Image upload failed'
    } finally {
      isUploadingImage.value = false
    }
  }

  return {
    attachedImages,
    isUploadingImage,
    uploadError,
    attachFiles,
    removeImage,
    resetImages,
  }
}
