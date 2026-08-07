function safeFileName(value: string): string {
  const normalized = value.trim().replace(/[\\/:*?"<>|\u0000-\u001f]+/gu, '-').replace(/\s+/gu, ' ')
  return (normalized || 'codyweb-conversation').slice(0, 100)
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('Failed to render the share image'))
    image.src = url
  })
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('Failed to encode the share image'))
    }, 'image/png')
  })
}

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
}

export async function downloadConversationSharePng(publicPath: string, title: string): Promise<void> {
  const response = await fetch(`${publicPath}/image.svg`)
  if (!response.ok) throw new Error(`Failed to load the share image (${String(response.status)})`)
  const svgBlob = await response.blob()
  const svgUrl = URL.createObjectURL(svgBlob)
  try {
    const image = await loadImage(svgUrl)
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Image export is not supported by this browser')
    context.drawImage(image, 0, 0)
    downloadBlob(await canvasBlob(canvas), `${safeFileName(title)}.png`)
  } finally {
    URL.revokeObjectURL(svgUrl)
  }
}
