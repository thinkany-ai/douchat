/**
 * What one message may carry, wherever Douchat moves it: the composer, the
 * desktop runtime, IM channels, shared rooms, douchat-host tasks and what an
 * agent delivers back. The service checks the same numbers
 * (douchat-tanstack encodeDirectBody).
 */
export const ATTACHMENT_LIMITS = {
  /** Images and files together. */
  count: 4,
  imageBytes: 8 * 1024 * 1024,
  totalBytes: 20 * 1024 * 1024
} as const

export const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
export type ImageMimeType = typeof IMAGE_MIME_TYPES[number]
export const isImageMimeType = (value: unknown): value is ImageMimeType => IMAGE_MIME_TYPES.includes(value as ImageMimeType)

/** Base64 in the desktop, the host and the browser alike. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(binary)
}
export const base64ToBytes = (value: string): Uint8Array => Uint8Array.from(atob(value), (char) => char.charCodeAt(0))
