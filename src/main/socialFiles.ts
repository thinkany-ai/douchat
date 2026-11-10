import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { basename } from 'node:path'
import type { MessageFileInput } from '../shared/types'
import type { SocialFile, SocialMessageImage } from '../shared/social'
import type { DouchatStore } from './store'
import { ATTACHMENT_LIMITS } from '../shared/attachments'

const MAX_BYTES = ATTACHMENT_LIMITS.totalBytes
export function decodeSocialFiles(files: SocialFile[] = [], images: SocialMessageImage[] = []): MessageFileInput[] {
  if (!Array.isArray(files) || !Array.isArray(images) || files.length + images.length > ATTACHMENT_LIMITS.count) throw new Error('一次最多发送 4 个附件。')
  let total = images.reduce((sum, image) => sum + (image.base64 === undefined ? image.size : Buffer.from(image.base64, 'base64').length), 0)
  return files.map(file => {
    if (!file || typeof file.name !== 'string' || !file.name.trim() || file.name.length > 240 || typeof file.base64 !== 'string' || file.base64.length > Math.ceil(MAX_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(file.base64)) throw new Error('无效的文件附件。')
    const data = Buffer.from(file.base64, 'base64')
    if (!data.length || data.toString('base64') !== file.base64) throw new Error('无效的文件附件。')
    total += data.length
    if (total > MAX_BYTES) throw new Error('附件总大小不能超过 20 MB。')
    return { name: file.name, data }
  })
}

/** Convert app-owned file cards into portable payloads; never send local paths. */
export async function exportSocialFiles(store: DouchatStore, text: string, ownerId: string): Promise<{ text: string; files: SocialFile[] }> {
  const files: SocialFile[] = []
  const matches = [...text.matchAll(/\[(?:\\.|[^\]\\])*\]\(<(douchat-file:[^>]+)>\)/g)]
  for (const match of matches) {
    if (store.currentAccountId !== ownerId) throw new Error('Chat account mismatch')
    const path = await store.ownedDocumentPath(fileURLToPath(match[1].replace(/^douchat-file:/, 'file:')))
    if (!path) throw new Error('File not found')
    const data = await readFile(path)
    if (store.currentAccountId !== ownerId) throw new Error('Chat account mismatch')
    files.push({ name: basename(path).slice(37), base64: data.toString('base64') })
    decodeSocialFiles(files)
  }
  for (const match of matches) text = text.replace(match[0], '')
  return { text: text.trim(), files }
}
