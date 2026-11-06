import { openAsBlob } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { basename, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { setTimeout as pause } from 'node:timers/promises'
import { OneBotError } from '../onebot/client.js'
import { fetchImage } from '../core/net.js'
import { registerSecret } from '../core/redact.js'
import { gatewayOrigin, wechatId } from './identity.js'

const MEDIA_LIMIT = 26_214_383
const FILE_LIMIT = 50 * 1024 * 1024
const SEND_OK = new Set(['accepted', 'sent', 'completed', 'succeeded'])
const JOB_FAILED = new Set(['failed', 'cancelled', 'canceled', 'rejected', 'blocked'])
const JOB_UNKNOWN = new Set(['needs_review', 'uncertain', 'partial'])

export function gatewayError(message, { statusCode = 0, code, uncertain = false } = {}) {
  const error = new OneBotError('Agent WeChat', { message, status: 'failed' }, { uncertain })
  error.statusCode = statusCode
  error.code = code
  return error
}

export async function openGateway(settings, signal) {
  const origin = gatewayOrigin(settings.url)
  const account = wechatId(settings.account)
  if (!origin || !account || !isAbsolute(settings.tokenFile || '')) throw gatewayError('请填写本机网关地址、档案 ID 和 API 密钥文件的绝对路径')
  const tokenStat = await stat(settings.tokenFile).catch(() => null)
  if (!tokenStat?.isFile() || tokenStat.size > 4096) throw gatewayError('读取不到 Agent WeChat API 密钥文件')
  const token = (await readFile(settings.tokenFile, 'utf8')).trim()
  if (!token || /[\r\n]/.test(token)) throw gatewayError('Agent WeChat API 密钥文件为空或格式无效')
  registerSecret(token)

  const accountPath = `/v1/accounts/${encodeURIComponent(account)}`
  const part = encodeURIComponent
  async function raw(path, { method = 'GET', body, key, timeoutMs = 15_000, submit = false, streaming = false } = {}) {
    const headers = { Authorization: `Bearer ${token}` }
    if (key) headers['Idempotency-Key'] = key
    if (body !== undefined && !(body instanceof FormData)) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(body)
    }
    const handshake = streaming ? new AbortController() : null
    const timer = handshake ? setTimeout(() => handshake.abort(), timeoutMs) : null
    const deadline = handshake?.signal || AbortSignal.timeout(timeoutMs)
    const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline
    let response
    try {
      response = await fetch(origin + path, { method, headers, body, redirect: 'error', signal: requestSignal })
    } catch (error) {
      throw gatewayError(`访问本机网关失败：${error.message}`, { uncertain: submit })
    } finally {
      if (timer) clearTimeout(timer)
    }
    if (!response.ok) {
      const data = await response.json().catch(() => null)
      const code = data?.error?.code
      const message = data?.error?.message || `HTTP ${response.status}`
      throw gatewayError(message, { code, statusCode: response.status, uncertain: submit && response.status >= 500 })
    }
    return response
  }

  async function json(path, options) {
    const response = await raw(path, options)
    try { return await response.json() } catch {
      throw gatewayError('网关返回了无效的 JSON', { uncertain: options?.submit })
    }
  }

  const at = (path = '', options) => json(accountPath + path, options)
  async function ensureAccount() {
    const { items } = await json('/v1/accounts')
    if (!Array.isArray(items)) throw gatewayError('网关返回了无效的档案列表')
    if (items.some((item) => item.id === account)) return
    try {
      await json('/v1/accounts', { method: 'POST', body: { id: account, alias: account }, key: randomUUID() })
    } catch (error) {
      if (error.statusCode !== 409) throw error
      await at()
    }
  }

  async function poll(job, path, timeoutMs, { sending = false } = {}) {
    const deadline = Date.now() + timeoutMs
    while (true) {
      if (SEND_OK.has(job.state)) return job
      const reason = job.reason || job.errorCode || job.state || '状态未知'
      if (JOB_UNKNOWN.has(job.state)) throw gatewayError(`投递结果待核对（${job.id}）：${reason}`, { uncertain: sending })
      if (JOB_FAILED.has(job.state)) throw gatewayError(`任务失败（${job.id}）：${reason}`, { uncertain: sending && Boolean(job.serverMessageId || job.result?.messageIds?.length) })
      if (!job.id || Date.now() >= deadline) throw gatewayError(`等待网关任务结束（${job.id || '无任务编号'}）`, { uncertain: sending })
      try {
        await pause(350, undefined, { signal })
        job = await at(`${path}/${part(job.id)}`)
      } catch (error) {
        throw gatewayError(`查询网关任务 ${job.id} 失败：${error.message}`, { uncertain: sending })
      }
    }
  }

  async function send(body, { timeoutMs = 120_000, stillAllowed } = {}) {
    if (stillAllowed && !stillAllowed()) throw gatewayError('微信投递已暂停或目标已从白名单移除')
    const result = await at('/sends', { method: 'POST', body, key: randomUUID(), submit: true })
    const sent = await poll(result, body.sourceId ? '/jobs' : '/sends', timeoutMs, { sending: true })
    return { message_id: sent.localMessageId || sent.result?.messageIds?.at(-1) || sent.serverId || sent.serverMessageId || '' }
  }

  async function sendMedia(threadId, kind, source, name, options) {
    const { blob, filename } = await outboundFile(source, name, kind)
    const form = new FormData()
    form.set('file', blob, filename)
    const uploaded = await at('/uploads', { method: 'POST', body: form, timeoutMs: 60_000 })
    if (!uploaded.id) throw gatewayError('网关未返回上传源编号')
    return send({ threadId, kind, sourceId: uploaded.id, standardSourceId: null, thumbnailSourceId: null, playSeconds: null, durationMs: null }, options)
  }

  async function download(messageId, kind, maxBytes = MEDIA_LIMIT) {
    const path = `/messages/${part(messageId)}`
    const pick = (assets) => {
      const matches = assets.filter((item) => item.kind === kind)
      return matches.find((item) => item.state === 'available' && (kind !== 'voice' || item.contentType === 'audio/wav')) || matches[0]
    }
    let assets = (await at(`${path}/media`)).items || []
    let asset = pick(assets)
    if (!asset) throw gatewayError('该消息没有可下载的媒体')
    if (Number(asset.byteLength || asset.advertisedByteLength) > maxBytes) throw gatewayError('收到的媒体超过大小限制')
    if (asset.state !== 'available' || (kind === 'voice' && asset.contentType !== 'audio/wav')) {
      const quality = kind === 'voice' ? 'normal' : 'best'
      const job = await at(`${path}/media-transfers`, { method: 'POST', body: { messageId, assetId: kind === 'voice' ? null : asset.id, quality }, key: randomUUID() })
      const completed = await poll(job, '/jobs', 45_000)
      assets = (await at(`${path}/media`)).items || []
      asset = assets.find((item) => item.id === completed.assetId && item.state === 'available') || pick(assets)
    }
    if (asset?.state !== 'available') throw gatewayError('微信媒体暂不可用')
    const response = await raw(`${accountPath}/media/${part(asset.id)}/content`, { timeoutMs: 30_000 })
    return readBytes(response, maxBytes)
  }

  async function qr(id) {
    const response = await raw(`${accountPath}/login-attempts/${part(id)}/qr`)
    return readBytes(response, 512 * 1024)
  }

  return {
    account, origin, at, ensureAccount, send, sendMedia, download, qr,
    stream: (cursor) => raw(`${accountPath}/events/stream${cursor ? `?after=${part(cursor)}` : ''}`, { streaming: true }),
  }
}

async function readBytes(response, maxBytes) {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel()
    throw gatewayError('收到的媒体超过大小限制')
  }
  const chunks = []
  let size = 0
  for await (const chunk of response.body || []) {
    size += chunk.byteLength
    if (size > maxBytes) throw gatewayError('收到的媒体超过大小限制')
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks, size)
}

async function outboundFile(source, name, kind) {
  const src = String(source || '')
  const maxBytes = kind === 'file' ? FILE_LIMIT : MEDIA_LIMIT
  if (src.startsWith('base64://') || /^https?:\/\//i.test(src)) {
    if (src.startsWith('base64://') && src.length > Math.ceil(maxBytes / 3) * 4 + 9) throw gatewayError('发送文件超过大小限制')
    const bytes = src.startsWith('base64://')
      ? Buffer.from(src.slice(9), 'base64')
      : await fetchImage(src, { maxBytes, allowLocal: false })
    if (!bytes.length || bytes.length > maxBytes) throw gatewayError('发送文件为空或超过大小限制')
    const ext = kind === 'voice' ? (bytes.toString('ascii', 0, 4) === 'RIFF' ? 'wav' : 'mp3') : kind === 'image' ? imageExt(bytes) : 'bin'
    return { blob: new Blob([bytes]), filename: basename(name || `aurabot.${ext}`) }
  }
  const path = src.startsWith('file:') ? fileURLToPath(src) : src
  if (!isAbsolute(path)) throw gatewayError('发送文件需要绝对路径')
  const info = await stat(path)
  if (!info.isFile() || !info.size || info.size > maxBytes) throw gatewayError('发送文件为空或超过大小限制')
  return { blob: await openAsBlob(path), filename: basename(name || path) }
}

function imageExt(bytes) {
  if (bytes.toString('ascii', 0, 3) === 'GIF') return 'gif'
  if (bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp'
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'png'
  return 'jpg'
}
