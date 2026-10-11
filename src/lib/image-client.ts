'use client'

/**
 * Preparación de imágenes en el cliente antes de subirlas (visión del chat):
 * redimensiona a un máximo de 1280 px por lado y exporta JPEG 0.9 con fondo
 * blanco (sin canal alfa) para un data URL compacto y compatible.
 */
export async function fileToDownscaledDataUrl(file: File, maxDim = 1280, quality = 0.9): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('No se pudo leer el archivo de imagen.'))
    reader.readAsDataURL(file)
  })

  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('Formato de imagen no soportado por el navegador.'))
    image.src = dataUrl
  })

  const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight))
  const w = Math.max(1, Math.round(img.naturalWidth * scale))
  const h = Math.max(1, Math.round(img.naturalHeight * scale))

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return dataUrl // sin canvas disponible: se envía la original
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, w, h)
  ctx.drawImage(img, 0, 0, w, h)
  return canvas.toDataURL('image/jpeg', quality)
}
