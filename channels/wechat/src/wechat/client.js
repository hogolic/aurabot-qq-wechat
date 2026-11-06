import { randomUUID } from 'node:crypto'
import { setTimeout as pause } from 'node:timers/promises'
import { dataDir, readJson, writeJson } from '../core/store.js'
import { checkAllowed } from '../chat/access.js'
import { gatewayError, openGateway } from './api.js'
import { wechatId, wechatPrivateId } from './identity.js'

const messageIdOf = (value) => /^[A-Za-z0-9_-]{1,256}$/.test(String(value || '')) ? String(value) : ''
const part = encodeURIComponent
const groupIdOf = (value) => wechatId(value).endsWith('@chatroom') ? wechatId(value) : ''
const asItems = (page) => (page?.items || []).filter((item) => !item.deleted)

function identity(status) {
  return { id: wechatId(status.ownUsername), online: status.authenticated === true && status.connection === 'online' }
}

// Convert the wire event to the shared Aurabot message segment model. All WeChat IDs remain strings.
export function toChatEvent(message, self, nickname, quotedId = '') {
  const thread = wechatId(message.threadId)
  const group = groupIdOf(thread)
  const user = wechatId(message.senderId || (message.direction === 'outgoing' ? self : ''))
  const messageId = messageIdOf(message.id)
  if (!thread || !user || !messageId || message.recall) return null
  const segments = []
  if (quotedId) segments.push({ type: 'reply', data: { id: quotedId } })
  else if (message.quote?.embeddedText) segments.push({ type: 'text', data: { text: `【引用】${String(message.quote.embeddedText).slice(0, 500)}\n` } })
  if (group) {
    const mentioned = new Set((message.mentions?.userIds || []).map(wechatId).filter(Boolean))
    if (message.mentions?.self === true && self) mentioned.add(self)
    if (message.mentions?.all === true) mentioned.add('all')
    for (const id of mentioned) segments.push({ type: 'at', data: { qq: id } })
  }
  const media = { wechatMedia: messageId }
  const mediaType = { 3: 'image', 34: 'record', 43: 'video', 47: 'image' }[message.type]
  if (mediaType) {
    const sticker = message.type === 47
    segments.push({ type: mediaType, data: { ...media, file: messageId, ...(sticker ? { sub_type: 1, summary: '[表情包]' } : {}) } })
  } else if (message.appMessageType === 6) {
    const name = message.media?.find((item) => item.kind === 'file')?.filename || '附件'
    segments.push({ type: 'file', data: { id: messageId, name } })
  } else {
    const text = message.link ? [message.link.title, message.link.url].filter(Boolean).join('\n') : String(message.body || '')
    if (text.trim()) segments.push({ type: 'text', data: { text } })
  }
  if (!segments.length) return null
  return {
    post_type: 'message', message_type: group ? 'group' : 'private', sub_type: 'friend',
    message_id: messageId, self_id: self, user_id: user, ...(group ? { group_id: group } : {}),
    sender: { user_id: user, nickname: nickname || user }, message: segments,
    time: Math.floor((Date.parse(message.createdAt) || Date.now()) / 1000),
  }
}

async function* readEvents(response) {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true })
    let split
    while ((split = /\r?\n\r?\n/.exec(buffer))) {
      const frame = buffer.slice(0, split.index)
      buffer = buffer.slice(split.index + split[0].length)
      const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')
      if (data) yield JSON.parse(data)
    }
    if (buffer.length > 512 * 1024) throw gatewayError('网关事件超出大小限制')
  }
}

async function incomingMessage(api, id, thread) {
  const message = await api.at('/messages/' + part(id)).catch((error) => {
    if (error.statusCode === 404 || error.statusCode === 410) return null
    throw error
  })
  return message?.accountId === api.account && message.threadId === thread && message.direction === 'incoming' ? message : null
}

export function createWechatClient({ getConfig, onEvent, onState, log }) {
  let controller = null
  let current = null
  let state = 'stopped'
  let problem = ''
  let status = null
  const names = new Map()
  const references = new Map()
  const cursorFile = () => dataDir('wechat-events.json')

  function stateTo(next, detail = '') {
    if (state === next && problem === detail) return
    state = next
    problem = detail
    onState?.(next, detail)
  }

  async function inspect(signal, settings = getConfig().wechat) {
    const api = await openGateway(settings, signal)
    const info = identity(await api.at())
    const capabilities = await api.at('/capabilities')
    const result = { ...info, account: api.account, nativeVoice: capabilities.mediaKinds?.includes('voice') === true }
    if (getConfig().wechat === settings) status = result
    return result
  }

  async function verify(api, expected) {
    const info = identity(await api.at('', { timeoutMs: 5_000 }))
    if (!info.online || !info.id) throw gatewayError('微信档案还未上线，请先扫码登录')
    if (!expected || info.id !== expected) throw gatewayError('网关登录身份与配置的机器人微信 ID 不一致')
    return info.id
  }

  function allowed(thread, sender = thread) {
    const group = groupIdOf(thread)
    return checkAllowed(getConfig(), { kind: group ? 'group' : 'private', groupId: group, userId: sender }).allowed
  }

  function rememberMessage(message) {
    if (message.serverId) {
      references.set(`${message.threadId}|${message.serverId}`, message.id)
      if (references.size > 512) references.delete(references.keys().next().value)
    }
  }

  async function senderName(api, thread, sender) {
    const group = groupIdOf(thread)
    const key = `${group}|${sender}`
    const cached = names.get(key)
    if (cached) return cached
    const route = group ? `/groups/${part(group)}/members/${part(sender)}` : `/contacts/${part(sender)}`
    const item = await api.at(route, { timeoutMs: 2_500 }).catch(() => null)
    const member = item?.member || item
    const name = String(member?.roomDisplayName || member?.displayName || member?.nickname || sender)
    names.set(key, name)
    if (names.size > 500) names.delete(names.keys().next().value)
    return name
  }

  async function receive(api, self, event, signal) {
    if (event.kind !== 'message.committed' || event.data?.direction !== 'incoming') return
    const mid = messageIdOf(event.data.messageId)
    const thread = wechatId(event.data.threadId)
    if (!mid || !thread || !allowed(thread)) return
    const message = await incomingMessage(api, mid, thread)
    if (!message) return
    const sender = wechatId(message.senderId)
    if (!sender || sender === self || (!groupIdOf(thread) && sender !== thread) || !allowed(thread, sender)) return
    await verify(api, self)
    rememberMessage(message)
    const nickname = await senderName(api, thread, sender)
    const parsed = toChatEvent(message, self, nickname, references.get(`${thread}|${message.quote?.serverId}`))
    if (parsed && !signal.aborted) await onEvent(parsed)
  }

  async function identifyOwner({ settings, botId, code, signal, onReady }) {
    const api = await openGateway(settings, signal)
    const account = identity(await api.at('', { timeoutMs: 5_000 }))
    if (!account.online || !account.id) throw gatewayError('请先用机器人微信扫码登录网关')
    if (botId && account.id !== botId) throw gatewayError('机器人微信 ID 与网关登录账号不一致')
    // 只看本次识别开始后的事件，不改聊天监听的游标或读取状态。
    const head = await api.at('/threads?limit=1', { timeoutMs: 5_000 })
    const cursor = String(head.asOfEventCursor ?? '0')
    const stream = await api.stream(cursor)
    onReady()
    for await (const event of readEvents(stream)) {
      if (event.kind !== 'message.committed' || event.data?.direction !== 'incoming' || !event.cursor || String(event.cursor) === cursor) continue
      const id = messageIdOf(event.data.messageId)
      const thread = wechatPrivateId(event.data.threadId)
      if (!id || !thread || thread === account.id) continue
      const message = await incomingMessage(api, id, thread)
      if (!message || message.senderId !== thread || message.type !== 1 || message.recall || message.quote) continue
      if (String(message.body ?? '').trim() !== code) continue
      await verify(api, account.id)
      const name = await senderName(api, thread, thread)
      signal.throwIfAborted()
      return { ownerId: thread, botId: account.id, name }
    }
    throw gatewayError('微信网关的监听已断开，请重新识别主人 ID')
  }

  async function follow(run) {
    let backoff = 1_000
    while (!run.signal.aborted) {
      try {
        stateTo('connecting')
        const cfg = getConfig()
        const api = await openGateway(cfg.wechat, run.signal)
        const self = await verify(api, cfg.botQQ)
        const key = `${api.origin}|${api.account}|${self}`
        const saved = readJson(cursorFile(), {})
        let cursor = saved.key === key ? String(saved.cursor || '') : ''
        if (!cursor) {
          // On a new installation, begin at the current head instead of replying to retained history.
          const head = await api.at('/threads?limit=1')
          cursor = String(head.asOfEventCursor ?? '0')
          writeJson(cursorFile(), { key, cursor })
        }
        let stream
        try { stream = await api.stream(cursor) } catch (error) {
          if (error.statusCode === 409 || error.statusCode === 410) writeJson(cursorFile(), {})
          throw error
        }
        if (run.signal.aborted) return
        current = { api, self, run }
        status = { ...status, id: self, account: api.account, online: true }
        stateTo('connected')
        backoff = 1_000
        for await (const event of readEvents(stream)) {
          if (run.signal.aborted) return
          const next = String(event.cursor ?? '')
          if (!next || next === cursor) continue
          await receive(api, self, event, run.signal)
          if (run.signal.aborted) return
          writeJson(cursorFile(), { key, cursor: next })
          cursor = next
        }
      } catch (error) {
        if (!run.signal.aborted) stateTo('waiting', error.message)
      } finally {
        if (current?.run === run) current = null
      }
      if (run.signal.aborted) return
      if (state === 'connected') stateTo('waiting', '网关事件流断开，正在续连')
      await pause(backoff, undefined, { signal: run.signal, ref: false }).catch(() => {})
      backoff = Math.min(30_000, backoff * 2)
    }
  }

  function start() {
    if (controller) return
    controller = new AbortController()
    follow(controller).catch((error) => log.warn('微信事件监听异常：', error.message))
  }

  function stop() {
    controller?.abort()
    controller = null
    current = null
    status = null
    names.clear()
    references.clear()
    stateTo('stopped')
  }

  async function sendSegments(api, threadId, segments, options) {
    const mentions = new Set()
    const media = []
    const texts = []
    let quote
    for (const segment of segments || []) {
      const data = segment.data || {}
      if (segment.type === 'text') texts.push(String(data.text || ''))
      if (segment.type === 'face') texts.push(data.text || '🙂')
      if (segment.type === 'at' && groupIdOf(threadId)) {
        const id = wechatId(data.qq)
        if (id && id !== 'all') mentions.add(id)
      }
      if (segment.type === 'reply' && messageIdOf(data.id)) {
        const original = await api.at(`/messages/${part(data.id)}`).catch(() => null)
        if (original?.threadId === threadId && original.serverId) quote = { messageId: original.id, serverId: original.serverId }
      }
      const kind = { image: 'image', record: 'voice', video: 'video', file: 'file', mface: 'image' }[segment.type]
      if (kind && (data.file || data.url)) media.push({ kind, source: data.file || data.url, name: data.name })
    }
    let sent
    try {
      const text = texts.join('').trim()
      if (text) sent = await api.send({ threadId, text, ...(quote ? { quote } : {}), ...(mentions.size ? { mentions: { userIds: [...mentions] } } : {}) }, options)
      for (const item of media) sent = await api.sendMedia(threadId, item.kind, item.source, item.name, options)
    } catch (error) {
      if (sent) throw gatewayError(`部分微信消息已发送：${error.message}`, { uncertain: true })
      throw error
    }
    if (!sent) throw gatewayError('没有可发送到微信的消息内容')
    return sent
  }

  async function call(action, params = {}, options = {}) {
    if (action === 'get_login_info') {
      const info = await inspect()
      if (!info.online) throw gatewayError('微信尚未登录')
      return { user_id: info.id, nickname: '大肥鱼' }
    }
    const connection = current
    if (!connection) throw gatewayError('微信网关尚未连接')
    const { api, self, run } = connection
    const uid = wechatId(params.user_id)
    const gid = groupIdOf(params.group_id)
    const destination = action.includes('group') ? gid : uid
    if (/^(send_(?:private|group)_msg|upload_(?:private|group)_file)$/.test(action)) {
      const canSend = () => current === connection && !run.signal.aborted && getConfig().enabled && !getConfig().dryRun && allowed(destination)
      if (!destination || (!gid && groupIdOf(uid)) || !canSend()) throw gatewayError('微信投递未启用或目标不在白名单')
      await verify(api, self)
      const opts = { ...options, stillAllowed: canSend }
      return action.startsWith('upload')
        ? api.sendMedia(destination, 'file', params.file, params.name, opts)
        : sendSegments(api, destination, params.message, opts)
    }
    switch (action) {
      case 'set_input_status': return null
      case 'get_msg': {
        const message = await api.at(`/messages/${part(messageIdOf(params.message_id))}`)
        if (!allowed(message.threadId)) throw gatewayError('消息不在允许的会话内')
        return toChatEvent(message, self, await senderName(api, message.threadId, message.senderId))
      }
      case 'get_record': return { base64: (await download(params.file, 'voice')).toString('base64') }
      case 'get_stranger_info': return { user_id: uid, nickname: await senderName(api, uid, uid) }
      case 'get_friend_list': {
        const items = asItems(await api.at('/contacts?limit=200'))
        return items.map((item) => ({ user_id: item.username, nickname: item.nickname || item.displayName, remark: item.remark }))
      }
      case 'get_group_list': {
        const items = asItems(await api.at('/groups?limit=200'))
        return items.map((item) => ({ group_id: item.roomId || item.id, group_name: item.displayName || item.name }))
      }
      case 'get_group_info': {
        const item = await api.at(`/groups/${part(gid)}`)
        return { group_id: gid, group_name: item.displayName || item.name || gid }
      }
      case 'get_group_member_info': {
        const item = await api.at(`/groups/${part(gid)}/members/${part(uid)}`)
        if (!item.member) return null
        return memberInfo(item.member)
      }
      case 'get_group_member_list': return asItems(await api.at(`/groups/${part(gid)}/members?limit=200`)).map(memberInfo)
      case 'get_friend_msg_history':
      case 'get_group_msg_history': {
        if (!destination || !allowed(destination)) throw gatewayError('目标会话不在白名单')
        const count = Math.min(100, Math.max(1, Number(params.count) || 20))
        const base = `/threads/${part(destination)}/messages`
        const anchor = messageIdOf(params.message_id)
        let cursor = ''
        let matches = []
        let found = !anchor
        // Native pagination uses opaque page cursors. Find the message anchor before returning older rows.
        for (let page = 0; page < (anchor ? 10 : 1) && matches.length < count; page++) {
          const result = await api.at(`${base}?limit=${anchor ? 100 : count}${cursor ? `&cursor=${part(cursor)}` : ''}`)
          for (const item of asItems(result)) {
            if (found) matches.push(item)
            else if (item.id === anchor) found = true
          }
          cursor = result.nextCursor
          if (!cursor) break
        }
        const messages = matches.slice(0, count).reverse().map((message) => toChatEvent(message, self, names.get(`${gid}|${message.senderId}`))).filter(Boolean)
        return { messages }
      }
      default: throw gatewayError(`微信网关不提供 ${action}`)
    }
  }

  async function login(signal) {
    const api = await openGateway(getConfig().wechat, signal)
    if (identity(await api.at()).online) throw gatewayError('该档案已经登录，请先在 Agent WeChat 中退出再换号')
    return api.at('/login-attempts', {
      method: 'POST', key: randomUUID(),
      body: { strategy: 'qr', qrRefresh: { mode: 'manual', maxRefreshes: 0 }, allowQr: true, forceQr: true, timeoutSeconds: 300, computerName: 'Aurabot WeChat' },
    })
  }

  const download = async (id, kind, limit) => {
    const active = current
    if (!active || !messageIdOf(id)) throw gatewayError('微信媒体不可用')
    const message = await active.api.at(`/messages/${part(id)}`)
    if (!allowed(message.threadId)) throw gatewayError('媒体不在允许的会话内')
    return active.api.download(id, kind, limit)
  }
  return {
    start, stop, restart() { stop(); start() }, call, inspect, login, download, identifyOwner,
    async threads() {
      const api = await openGateway(getConfig().wechat)
      return asItems(await api.at('/threads?limit=50')).map(({ id, displayName }) => ({ id, name: displayName || id, kind: groupIdOf(id) ? 'group' : 'private' }))
    },
    async loginStatus(id) { return (await openGateway(getConfig().wechat)).at(`/login-attempts/${part(id)}`) },
    async loginQr(id) { return (await openGateway(getConfig().wechat)).qr(id) },
    get state() { return state }, get problem() { return problem }, get status() { return status },
  }
}

function memberInfo(member) {
  return { user_id: member.username || member.id, nickname: member.displayName, card: member.roomDisplayName || member.mentionName, role: 'member', join_time: 1 }
}
