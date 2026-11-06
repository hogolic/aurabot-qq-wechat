import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { channelConfig, legacyDir, onSharedSettings, readJson, saveChannelConfig, settings, unifiedDir, writeJson } from '../shared/settings.js'
import { linkOwnerMemory, shareOwnerMemory, sharedMemoryStatus } from '../shared/memory.js'
import * as qqConfig from '../channels/qq/src/core/config.js'
import * as wxConfig from '../channels/wechat/src/core/config.js'
import { createMemoryStore as createQQMemory } from '../channels/qq/src/features/memory.js'
import { createMemoryStore as createWechatMemory } from '../channels/wechat/src/features/memory.js'
import { createHub } from '../channels/wechat/src/chat/hub.js'
import { memoryPromptRanges } from '../channels/wechat/src/security/leak-guard.js'
import wechatMemoryModule from '../channels/wechat/src/modules/memory/index.js'

const pair = { qq: '123450001', wechat: 'wxid_owner_fixture' }
const group = '110000000'
const guest = '123450100'
const log = { info() {}, warn() {}, debug() {} }
const ownerChat = (channel) => 'private:' + pair[channel]

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'aurabot-unified-test-'))
  const prior = { DSH_HOME: process.env.DSH_HOME, AURABOT_UNIFIED_DATA_DIR: process.env.AURABOT_UNIFIED_DATA_DIR }
  process.env.DSH_HOME = join(home, 'dsh')
  process.env.AURABOT_UNIFIED_DATA_DIR = join(home, 'data')
  t.after(() => {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  writeJson(legacyDir('qq', 'config.json'), {
    ownerQQ: pair.qq, botQQ: '123450002', setupDone: true, enabled: true,
    allow: { groups: [group] }, model: { provider: 'qq-provider', model: 'qq-model' },
  })
  writeJson(legacyDir('wechat', 'config.json'), {
    ownerQQ: pair.wechat, botQQ: 'wxid_bot_fixture', setupDone: true, enabled: true,
    allow: { groups: ['fixture@chatroom'] }, model: { provider: 'wx-provider', model: 'wx-model' },
  })
}

const fact = (channel, id, text) => ({
  id, text, about: pair[channel], speaker: pair[channel], chatId: ownerChat(channel), source: 'tool', at: Date.now(),
})

test('common settings start from the existing profiles and preserve transport-specific permissions', (t) => {
  fixture(t)
  assert.equal(channelConfig('qq').model.model, 'wx-model')
  assert.equal(channelConfig('qq').enabled, false)
  assert.equal(channelConfig('wechat').dryRun, true)
  let notification = null
  const off = onSharedSettings((channel) => { notification = channel })
  t.after(off)
  saveChannelConfig('qq', { ...channelConfig('qq'), model: { provider: 'next-provider', model: 'next-model' } })
  assert.equal(settings().revision, 1)
  assert.equal(notification, 'qq')
  assert.equal(channelConfig('wechat').model.model, 'next-model')
  assert.deepEqual(channelConfig('qq').allow.groups, [group])
  assert.deepEqual(channelConfig('wechat').allow.groups, ['fixture@chatroom'])
})

test('owner facts import, recall and delete across adapters while group and guest scopes stay separate', (t) => {
  fixture(t)
  writeJson(legacyDir('qq', 'memories.json'), { items: [
    fact('qq', 'old', '茶叶偏好是桂花'),
    { ...fact('qq', 'group', '群资料独立'), chatId: 'group:' + group, scope: 'group' },
    { ...fact('qq', 'other', '关于另一位联系人'), about: guest },
  ] })
  assert.throws(() => linkOwnerMemory({ ...pair, wechat: 'wxid_other' }), /主人/)
  assert.equal(sharedMemoryStatus().linked, false)
  assert.equal(linkOwnerMemory(pair).imported.qq, 1)
  const hub = { chatLogOf: () => [], chatLogDays: () => [], speakersOf: () => [] }
  const qq = createQQMemory({ getConfig: qqConfig.loadConfig, hub, log })
  const wechat = createWechatMemory({ getConfig: wxConfig.loadConfig, hub, log })
  const recalled = wechat.list('桂花')
  assert.equal(recalled.length, 1)
  assert.equal(recalled[0].about, pair.wechat)
  assert.equal(recalled[0].chatId, ownerChat('wechat'))
  assert.equal(wechat.list('群资料').length, 0)
  assert.equal(wechat.list('另一位').length, 0)
  wechat.add({ text: '喜欢蓝莓蛋糕', about: pair.wechat, speaker: pair.wechat, chatId: ownerChat('wechat'), importance: 0.9 })
  assert.equal(qq.list('蓝莓')[0].about, pair.qq)
  assert.match(qq.recallHint({ kind: 'private', userId: pair.qq, chatId: ownerChat('qq') }, '喜欢什么蛋糕'), /蓝莓/)
  assert.doesNotMatch(qq.recallHint({ kind: 'group', groupId: group, chatId: 'group:' + group }, '蓝莓蛋糕', '', '', [guest]), /蓝莓/)
  assert.doesNotMatch(qq.recallHint({ kind: 'private', userId: guest, chatId: 'private:' + guest }, '蓝莓蛋糕'), /蓝莓/)
  qq.remove(qq.list('蓝莓')[0].id)
  assert.equal(wechat.list('蓝莓').filter((item) => !item.invalidAt).length, 0)
  saveChannelConfig('wechat', { ...channelConfig('wechat'), ownerQQ: 'wxid_other' })
  assert.equal(sharedMemoryStatus().linked, false)
  assert.equal(qq.list('桂花').length, 0)
})

test('independent channel writes from stale snapshots preserve new facts and do not resurrect deletions', (t) => {
  fixture(t)
  linkOwnerMemory(pair)
  const local = () => {
    let data = { items: [] }
    return { load: () => structuredClone(data), save: (next) => { data = structuredClone(next) } }
  }
  const qq = shareOwnerMemory('qq', () => pair.qq, local())
  const wx = shareOwnerMemory('wechat', () => pair.wechat, local())
  const qqBefore = qq.load()
  const wxBefore = wx.load()
  qqBefore.items.push(fact('qq', 'qq-new', 'QQ 写入的事实'))
  wxBefore.items.push(fact('wechat', 'wx-new', '微信写入的事实'))
  qq.save(qqBefore)
  wx.save(wxBefore)
  assert.deepEqual(qq.load().items.map((row) => row.id), ['qq-new', 'wx-new'])
  const stale = wx.load()
  const removed = qq.load()
  removed.items = removed.items.filter((row) => row.id !== 'qq-new')
  qq.save(removed)
  stale.items.push(fact('wechat', 'wx-next', '另一条新记忆'))
  wx.save(stale)
  assert.deepEqual(qq.load().items.map((row) => row.id), ['wx-new', 'wx-next'])
})

test('linking the owner immediately imports private facts already learned on both active channels', (t) => {
  fixture(t)
  const hub = { chatLogOf: () => [], chatLogDays: () => [] }
  const qq = createQQMemory({ getConfig: qqConfig.loadConfig, hub, log })
  const wechat = createWechatMemory({ getConfig: wxConfig.loadConfig, hub, log })
  const add = (memory, channel, text) => memory.add({ text, about: pair[channel], chatId: ownerChat(channel) })
  assert.ok(add(qq, 'qq', '发布测试的杯子是蓝色').ok)
  assert.ok(add(wechat, 'wechat', '发布测试的小碗是绿色').ok)
  assert.equal(wechat.list('蓝色').length, 0)
  assert.equal(qq.list('绿色').length, 0)
  linkOwnerMemory(pair)
  assert.equal(sharedMemoryStatus().items, 2)
  assert.equal(wechat.list('蓝色').length, 1)
  assert.equal(qq.list('绿色').length, 1)
  linkOwnerMemory(pair)
  assert.equal(sharedMemoryStatus().items, 2)
})

test('the WeChat prompt can continue the linked owner QQ private chat on a one-character message', async (t) => {
  fixture(t)
  const now = Date.now()
  const cfg = wxConfig.loadConfig()
  cfg.memory.recallMode = 'trigger'
  cfg.memory.recallTriggers = []
  const wechatOwner = { kind: 'private', chatId: ownerChat('wechat'), userId: pair.wechat }
  const incoming = [{ type: 'text', text: '1' }]
  const info = { chat: wechatOwner, senderId: pair.wechat, queryText: '1' }
  const own = { t: now, chatId: ownerChat('qq'), uid: pair.qq, who: '主人' }
  const rows = [
    { ...own, text: '约定暗号，说 1 时回 34' },
    { ...own, uid: undefined, who: 'bot', text: '收到，说 1 时回 34（测试）' },
    { ...own, chatId: 'group:' + group, text: '群聊信息' },
    { ...own, uid: guest, text: '访客信息' },
    { ...own, forgottenAt: now, text: 'QQ 已忘信息' },
    { ...own, text: '微信已忘信息' },
    { ...own, t: now - 3 * 3600_000, text: '超时信息' },
  ]
  const date = new Date(now)
  const day = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-')
  const dir = unifiedDir('channels', 'qq', 'chatlog')
  const file = join(dir, day + '.jsonl')
  const raw = rows.map((row) => JSON.stringify(row)).join('\n') + '\n'
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, raw)
  const forgotten = { t: now + 1, chatId: ownerChat('wechat'), uid: pair.wechat, forgottenAt: now + 1, text: '忘掉 微信已忘信息' }
  let prompt
  wechatMemoryModule.setup({
    config: () => cfg, log, core: { hub: { chatLogOf: (date) => date === day ? [forgotten] : [] } },
    on: (event, callback) => { if (event === 'prompt') prompt = callback },
    context() {}, every() {}, tool() {}, route() {},
  })
  assert.deepEqual(await prompt(incoming, info), incoming)
  linkOwnerMemory(pair)
  const content = await prompt(incoming, info)
  assert.match(content[0].text, /约定暗号，说 1 时回 34/)
  assert.match(content[0].text, /收到，说 1 时回 34/)
  assert.deepEqual(content.slice(1), incoming)
  assert.deepEqual(memoryPromptRanges(content[0].text), [{ start: 0, end: content[0].text.length }])
  assert.doesNotMatch(content[0].text, /群聊信息|访客信息|已忘信息|超时信息/)
  assert.deepEqual(await prompt(incoming, { ...info, chat: { kind: 'group', chatId: 'group:fixture@chatroom' } }), incoming)
  assert.deepEqual(await prompt(incoming, { ...info, senderId: 'wxid_guest' }), incoming)
  assert.deepEqual(await prompt(incoming, { ...info, extraSenders: ['wxid_guest'] }), incoming)
  cfg.memory.shortTerm = false
  assert.deepEqual(await prompt(incoming, info), incoming)
  assert.equal(readFileSync(file, 'utf8'), raw)
})

test('WeChat title repair preserves a custom title and skips sessions outside its workspace', async (t) => {
  fixture(t)
  const cfg = wxConfig.loadConfig()
  cfg.workspaceDir = unifiedDir('wechat-workspace')
  const file = unifiedDir('channels', 'wechat', 'sessions.json')
  const old = 'QQ · 主人私聊'
  const auto = 'wechat-owner-fixture'
  const manual = 'wechat-manual-fixture'
  const qq = 'qq-owner-fixture'
  const mapping = { chats: {
    [ownerChat('wechat')]: { sessionId: auto, title: old },
    'private:wxid_guest': { sessionId: manual, title: 'QQ 私聊 · 好友' },
    'private:qq': { sessionId: qq, title: old },
  } }
  writeJson(file, mapping)
  const seen = new Map([[auto, old], [manual, '手动设置的标题'], [qq, old]])
  const renamed = []
  const services = {
    workspaceRegistry: { list: () => [
      { path: cfg.workspaceDir, sessionIds: [auto, manual] },
      { path: unifiedDir('qq-workspace'), sessionIds: [qq] },
    ] },
    sessionQuery: { readTitle: async (id) => ({ title: seen.get(id) }) },
    sessionTitle: {
      get: ({ id }) => ({ title: seen.get(id) }),
      rename: ({ id }, title) => { renamed.push(id); seen.set(id, title) },
    },
  }
  const dsh = { get: (name) => services[name], agents: new Map([[auto, { session: { id: auto } }]]) }
  const hub = createHub({ dsh, getConfig: () => cfg, log, onebot: {} })
  t.after(() => hub.dispose())
  await hub.repairSessionTitles()
  await hub.repairSessionTitles()
  assert.deepEqual(renamed, [auto])
  assert.equal(seen.get(auto), '微信 · 主人私聊')
  assert.equal(seen.get(manual), '手动设置的标题')
  assert.equal(seen.get(qq), old)
  const result = readJson(file)
  assert.equal(result.chats[ownerChat('wechat')].title, '微信 · 主人私聊')
  assert.deepEqual(result.chats['private:qq'], mapping.chats['private:qq'])
})
