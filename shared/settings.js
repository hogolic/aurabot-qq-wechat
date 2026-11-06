import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

export const CHANNELS = ['qq', 'wechat']
const LEGACY = { qq: 'aurabot', wechat: 'aurabot-wechat' }
const COMMON = new Set([
  'ownerName', 'ownerLevel', 'longTasks', 'approvalNotify', 'approvalViaQQ',
  'model', 'persona', 'memory', 'mood', 'voice', 'song', 'imageGen', 'stickers',
  'chat', 'merge', 'titleFilter', 'security', 'logging', 'files', 'profilePerms',
  'cost', 'tabs', 'safeMode', 'subagentBackground',
  'workspaceDir',
])
const listeners = new Map()

export const dshHome = () => process.env.DSH_HOME || join(homedir(), '.dsh')
export const unifiedDir = (...parts) => join(process.env.AURABOT_UNIFIED_DATA_DIR || join(dshHome(), 'plugins-data', 'aurabot-unified'), ...parts)
export const legacyDir = (channel, ...parts) => join(dshHome(), 'plugins-data', LEGACY[channel], ...parts)
const settingsFile = () => unifiedDir('settings.json')

export function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) } catch (error) {
    if (error.code === 'ENOENT') return fallback
    throw error
  }
}

export function writeJson(file, data) {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = file + '.tmp-' + process.pid
  writeFileSync(temporary, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, file)
}

function split(config, common) {
  const result = Object.fromEntries(Object.entries(config).filter(([key]) => key !== 'group' && COMMON.has(key) === common))
  if (config.group) {
    const { overrides, ...policy } = config.group
    result.group = common ? policy : { overrides }
  }
  return result
}

function legacyConfig(channel) {
  try { return readJson(legacyDir(channel, 'config.json'), {}) || {} } catch { return {} }
}

function initialSettings() {
  const qq = legacyConfig('qq')
  const wechat = legacyConfig('wechat')
  const shared = { ...split(qq, true), ...split(wechat, true) }
  shared.workspaceDir = ''
  if (qq.song || wechat.song) shared.song = { ...qq.song, ...wechat.song, root: wechat.song?.root || qq.song?.root || '' }
  const channel = (config) => ({
    ...split(config, false),
    enabled: false, dryRun: true,
    bridge: { ...config.bridge, dshTools: false, http: false, token: '' },
    // Channels keep separate allowlists and schedules.
    speakUp: { ...config.speakUp, enabled: false },
  })
  return { revision: 0, shared, channels: { qq: channel(qq), wechat: channel(wechat) }, ownerLink: null }
}

export function settings() {
  const file = settingsFile()
  const current = readJson(file, null)
  if (current) return current
  const initial = initialSettings()
  writeJson(file, initial)
  return initial
}

export function channelConfig(channel) {
  const state = settings()
  const channelState = state.channels[channel]
  return {
    ...channelState,
    ...state.shared,
    workspaceDir: state.shared.workspaceDir ?? (state.channels.qq.workspaceDir || state.channels.wechat.workspaceDir || ''),
    group: { ...state.shared.group, overrides: channelState.group?.overrides || {} },
  }
}

export function mirrorChannelConfig(channel, config) {
  // Keep a channel-local snapshot for its existing backup and diagnostics tools.
  try { writeJson(unifiedDir('channels', channel, 'config.json'), config) } catch {}
  return config
}

export function saveChannelConfig(channel, config) {
  const state = settings()
  const nextShared = split(config, true)
  const changed = !isDeepStrictEqual(state.shared, nextShared)
  state.shared = nextShared
  state.channels[channel] = split(config, false)
  if (changed) state.revision += 1
  writeJson(settingsFile(), state)
  if (changed) {
    for (const callback of listeners.get(settingsFile()) || []) callback(channel)
  }
  return mirrorChannelConfig(channel, config)
}

export function onSharedSettings(listener) {
  const file = settingsFile()
  let group = listeners.get(file)
  if (!group) listeners.set(file, group = new Set())
  group.add(listener)
  return () => {
    group.delete(listener)
    if (!group.size) listeners.delete(file)
  }
}

export function ownerAccounts(state = settings()) {
  const qq = String(state.channels.qq?.ownerQQ || '').trim()
  const wechat = String(state.channels.wechat?.ownerQQ || '').trim()
  const bot = (channel) => String(state.channels[channel]?.botQQ || '').trim()
  const validWechat = (id) => /^[\w][\w@.-]{0,127}$/.test(id) && !id.endsWith('@chatroom') &&
    !['filehelper', '__proto__', 'constructor', 'prototype'].includes(id)
  if (!/^\d{5,11}$/.test(qq) || !/^\d{5,11}$/.test(bot('qq')) || !validWechat(wechat) || !validWechat(bot('wechat')) ||
    qq === bot('qq') || wechat === bot('wechat') ||
    !state.channels.qq?.setupDone || !state.channels.wechat?.setupDone) return null
  return { qq, wechat }
}

export function ownerLink(state = settings()) {
  const accounts = ownerAccounts(state)
  return accounts && state.ownerLink?.qq === accounts.qq && state.ownerLink?.wechat === accounts.wechat ? accounts : null
}

export function saveOwnerLink(accounts) {
  const state = settings()
  if (!isDeepStrictEqual(accounts, ownerAccounts(state))) throw new Error('两个平台的主人账号已变更，请重新核对')
  state.ownerLink = accounts
  writeJson(settingsFile(), state)
}
