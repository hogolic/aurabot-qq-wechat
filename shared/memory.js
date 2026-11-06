import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { CHANNELS, legacyDir, ownerAccounts, ownerLink, readJson, saveOwnerLink, settings, unifiedDir, writeJson } from './settings.js'

let Database
try { ({ DatabaseSync: Database } = await import('node:sqlite')) } catch {}

const COLLECTIONS = ['items', 'gists']
const BASE = '_aurabotUnifiedMemory'
const pairKey = (pair) => createHash('sha256').update(JSON.stringify([pair.qq, pair.wechat])).digest('hex').slice(0, 32)
const bankFile = (pair) => unifiedDir('shared-memory', pairKey(pair) + '.json')
const readBank = (pair) => readJson(bankFile(pair), { revision: 0, items: [], gists: [], imported: {}, moved: [] })
const writeBank = (pair, bank) => {
  bank.revision += 1
  writeJson(bankFile(pair), bank)
}
const portable = (row, owner) => typeof row?.id === 'string' && row.id && typeof row.text === 'string' && row.text.trim() &&
  row.chatId === 'private:' + owner && row.scope !== 'group' && row.kind !== 'seen' &&
  (!row.about || String(row.about) === owner) && (!row.speaker || String(row.speaker) === owner)

function canonical(row, channel) {
  const { chatId, about, speaker, related, ...body } = row
  return { ...body, origin: row.origin || channel, about: about ? 'owner' : '', ...(speaker ? { speaker: 'owner' } : {}) }
}

function project(row, owner) {
  return { ...row, chatId: 'private:' + owner, about: row.about ? owner : '', ...(row.speaker ? { speaker: owner } : {}) }
}

function readChannelMemory(dir) {
  const json = join(dir, 'memories.json')
  const sqlite = join(dir, 'memory.sqlite')
  if (existsSync(join(dir, 'memory-json-fallback.json')) || !existsSync(sqlite)) return readJson(json, { items: [], gists: [] })
  if (!Database) throw new Error('SQLite unavailable')
  const db = new Database(sqlite, { readOnly: true })
  try {
    db.exec('BEGIN')
    const rows = Object.fromEntries(COLLECTIONS.map((name) => [
      name, db.prepare('SELECT json FROM ' + name).all().map((row) => JSON.parse(row.json)),
    ]))
    db.exec('COMMIT')
    return rows
  } finally {
    db.close()
  }
}

// Mark records before clearing their channel-local copies, so deletion or a retry cannot resurrect them.
function collectLocalOwnerMemory(bank, channel, owner, state) {
  if (!state) return false
  const movedIds = new Set(bank.moved)
  let found = false
  for (const key of COLLECTIONS) {
    const rows = Array.isArray(state[key]) ? state[key] : []
    const eligible = rows.filter((row) => portable(row, owner))
    if (!eligible.length) continue
    const ids = new Set(bank[key].map((row) => row.id))
    for (const row of eligible) {
      const marker = channel + ':' + key + ':' + row.id
      if (!movedIds.has(marker) && !ids.has(row.id)) {
        bank[key].push(canonical(row, channel))
        ids.add(row.id)
      }
      movedIds.add(marker)
    }
    state[key] = rows.filter((row) => !portable(row, owner))
    found = true
  }
  if (found) bank.moved = [...movedIds]
  return found
}

export function linkOwnerMemory(accounts) {
  if (!accounts || !isDeepStrictEqual(accounts, ownerAccounts())) throw new Error('请先在 QQ 和微信连接页核对主人账号')
  const bank = readBank(accounts)
  const unavailable = []
  for (const channel of CHANNELS) {
    let source
    try {
      // The two channels can accumulate new memories before the owner chooses to link them.
      const current = readChannelMemory(unifiedDir('channels', channel))
      collectLocalOwnerMemory(bank, channel, accounts[channel], current)
      if (Object.hasOwn(bank.imported, channel)) continue
      source = readChannelMemory(legacyDir(channel))
    } catch {
      unavailable.push(channel)
      continue
    }
    let count = 0
    for (const key of COLLECTIONS) {
      const distinct = (row) => JSON.stringify([row.text.trim(), row.kind || '', row.validFrom || row.saidAt || 0, row.invalidAt || row.validUntil || 0])
      const seen = new Set(bank[key].map(distinct))
      for (const row of Array.isArray(source?.[key]) ? source[key] : []) {
        if (!portable(row, accounts[channel]) || seen.has(distinct(row))) continue
        const entry = canonical(row, channel)
        entry.id = createHash('sha256').update(channel + ':' + key + ':' + row.id).digest('hex').slice(0, 16)
        bank[key].push(entry)
        seen.add(distinct(row))
        count++
      }
    }
    bank.imported[channel] = count
  }
  writeBank(accounts, bank)
  saveOwnerLink(accounts)
  return { imported: bank.imported, unavailable }
}

export function sharedMemoryStatus() {
  const state = settings()
  const pair = ownerLink(state)
  const bank = pair ? readBank(pair) : null
  return {
    accounts: ownerAccounts(state), linked: Boolean(pair), items: bank?.items.length || 0, gists: bank?.gists.length || 0,
    importsPending: bank ? CHANNELS.filter((channel) => !Object.hasOwn(bank.imported, channel)) : [],
  }
}

export function shareOwnerMemory(channel, getOwner, local) {
  const currentPair = () => {
    const pair = ownerLink()
    return pair && pair[channel] === String(getOwner()) ? pair : null
  }
  return {
    ...local,
    load() {
      const state = local.load()
      const pair = currentPair()
      if (!pair) return state
      const owner = pair[channel]
      const bank = readBank(pair)
      if (collectLocalOwnerMemory(bank, channel, owner, state)) {
        writeBank(pair, bank)
        local.save(state)
      }
      for (const key of COLLECTIONS) state[key] = [...(state[key] || []), ...bank[key].map((row) => project(row, owner))]
      state[BASE] = { pair: pairKey(pair), revision: bank.revision, items: bank.items, gists: bank.gists }
      state.rev = (state.rev || 0) + bank.revision
      return state
    },
    save(state) {
      const { [BASE]: base, ...channelState } = state
      if (!base) return local.save(channelState)
      const pair = currentPair()
      if (!pair || pairKey(pair) !== base.pair) throw new Error('共享主人账号已变更，请刷新后重试')
      const bank = readBank(pair)
      const owner = pair[channel]
      let changed = false
      for (const key of COLLECTIONS) {
        const before = new Map(base[key].map((row) => [row.id, row]))
        const after = new Map()
        const rows = state[key] || []
        for (const row of rows) {
          if (portable(row, owner)) after.set(row.id, canonical(row, channel))
        }
        const latest = new Map(bank[key].map((row) => [row.id, row]))
        for (const [id, row] of before) {
          // A stale view may only delete the version it saw.
          if (!after.has(id) && isDeepStrictEqual(latest.get(id), row)) {
            latest.delete(id)
            changed = true
          }
        }
        for (const [id, row] of after) {
          const prior = before.get(id)
          if (isDeepStrictEqual(prior, row)) continue
          if (!prior && latest.has(id)) throw new Error('共享记忆 ID 冲突，请重试')
          if (prior && !isDeepStrictEqual(latest.get(id), prior)) {
            // Recall bookkeeping can race with another channel. Keep the newer record.
            const { hits: oldHits, ...oldFact } = prior
            const { hits: newHits, ...newFact } = row
            if (isDeepStrictEqual(oldFact, newFact)) continue
            throw new Error('这条共享记忆已在另一平台更新，请重试')
          }
          latest.set(id, row)
          changed = true
        }
        bank[key] = [...latest.values()]
        channelState[key] = rows.filter((row) => !after.has(row.id) && !before.has(row.id))
      }
      if (changed) writeBank(pair, bank)
      channelState.rev = Math.max(0, (channelState.rev || 0) - base.revision)
      return local.save(channelState)
    },
  }
}
