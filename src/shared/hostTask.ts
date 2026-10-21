import { ATTACHMENT_LIMITS, bytesToBase64, isImageMimeType } from './attachments'

/**
 * Owner tasks: how the desktop and the web app hand one agent turn to the
 * douchat-host that runs the agent, through the service's host-task-* actions
 * (douchat-tanstack ownerTasks.ts). Both clients and the host import this, so
 * the session key, the inputs and the task state stay one format.
 */

export interface WireImage { name: string; mimeType: string; base64: string }
export interface WireFile { name: string; base64: string }
/** What the human sent with the message. */
export interface HostTaskInputs { images?: WireImage[]; files?: WireFile[] }

/** An image or file a finished task delivered; host-task-attachment returns its bytes. */
export interface HostTaskAttachment { id: string; index: number; kind: 'image' | 'file'; name: string; mimeType?: string; size: number }

/** host-task-wait: the task as the service reports it. */
export interface HostTaskState {
  cursor: string
  taskId: string
  status: 'pending' | 'running' | 'succeeded' | 'failed' | string
  reply?: string
  attachments?: HostTaskAttachment[]
  progress: { phase?: string; detail?: string; text?: string; at?: number } | null
  approvals: ({ id: string } & Record<string, unknown>)[]
  hostId?: string
  bindingRevision?: number
  claimHash?: string
  cancelRequested?: boolean
}

/** A direct chat's agent session on any device. */
export const directSessionKey = (conversationId: string, topicId: string) => `direct:${conversationId}:${topicId}`
/**
 * The native session (Codex thread, Claude session) a host keeps for a
 * conversation. A context reset changes it, so the host starts over. The
 * desktop and the web app build the same key, so either continues the other's.
 */
export const hostSessionKey = (sessionKey: string, contextResetId?: string) => `${sessionKey}:${contextResetId ?? ''}`

/** Told to every agent its host runs: it works on the server, not the human's computer. */
export function hostAgentNote(host: string): string {
  return `You are running on the server ${host}, not on the human's computer. You cannot access the human's local files, desktop, browser or applications, and paths you see refer to the server. Do not create douchat-file: or file: links. Deliver files through the outbox folder named at the end of this request.`
}

/**
 * The images and files that fit one task, in order, within the message
 * limits; the rest are left out. Images in an unsupported format are skipped.
 */
export function packTaskInputs(
  images: readonly { name: string; mimeType: string; data: Uint8Array }[] = [],
  files: readonly { name: string; data: Uint8Array }[] = []
): HostTaskInputs {
  const outImages: WireImage[] = []
  const outFiles: WireFile[] = []
  let total = 0
  const fits = (size: number, limit: number) => outImages.length + outFiles.length < ATTACHMENT_LIMITS.count && size > 0 && size <= limit && total + size <= ATTACHMENT_LIMITS.totalBytes
  for (const image of images) {
    if (!isImageMimeType(image.mimeType) || !fits(image.data.byteLength, ATTACHMENT_LIMITS.imageBytes)) continue
    total += image.data.byteLength
    outImages.push({ name: image.name, mimeType: image.mimeType, base64: bytesToBase64(image.data) })
  }
  for (const file of files) {
    if (!fits(file.data.byteLength, ATTACHMENT_LIMITS.totalBytes)) continue
    total += file.data.byteLength
    outFiles.push({ name: file.name, base64: bytesToBase64(file.data) })
  }
  return { ...(outImages.length ? { images: outImages } : {}), ...(outFiles.length ? { files: outFiles } : {}) }
}
