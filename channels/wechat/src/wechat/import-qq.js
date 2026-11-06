import { readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { dshHome, readJson } from '../core/store.js'
import { parsePersona, readPersona, savePersona } from '../persona/personas.js'

export function importQqProfile({ persona, memories, config, memory }) {
  if (!persona && !memories) return { ok: false, message: '请选择要复制的资料' }
  const source = join(dshHome(), 'plugins-data', 'aurabot')
  const qq = readJson(join(source, 'config.json'), null)
  if (!qq) return { ok: false, message: '找不到此 DSH 安装的 QQ 版配置' }

  const owner = String(qq.ownerQQ || '')
  const wx = config.ownerQQ
  if (memories && (!/^\d+$/.test(owner) || !wx || wx === config.botQQ || wx === 'filehelper' || !memory?.add)) {
    return { ok: false, message: '先设置主人微信 ID，并打开微信版记忆模块' }
  }
  let personaId = ''
  if (persona) {
    const active = String(qq.persona?.current || '')
    if (!/^[\w-]{1,40}$/.test(active)) return { ok: false, message: 'QQ 版没有有效的当前人格' }
    const file = join(source, 'personas', active + '.md')
    const info = statSync(file, { throwIfNoEntry: false })
    if (!info?.isFile() || info.size > 1024 * 1024) return { ok: false, message: '找不到 QQ 当前人格文件，或文件超过 1MB' }
    const raw = readFileSync(file, 'utf8')
    const parsed = parsePersona(active, raw)
    personaId = 'qq-import-' + createHash('sha256').update(raw).digest('hex').slice(0, 12)
    if (!readPersona(personaId)) savePersona(personaId, { ...parsed, name: parsed.name + '（QQ 导入）' })
  }

  let imported = 0
  if (memories) {
    const old = readJson(join(source, 'memories.json'), {})
    const chatId = `private:${wx}`
    const candidates = (Array.isArray(old.items) ? old.items : []).filter((item) =>
      item && item.chatId === `private:${owner}` && item.scope !== 'group' && !item.invalidAt &&
      (!item.about || String(item.about) === owner) && (!item.speaker || String(item.speaker) === owner) &&
      typeof item.text === 'string' && item.text.trim() && !(item.validUntil && Number(item.validUntil) <= Date.now()))
    for (const item of candidates) {
      const result = memory.add({
        text: item.text, about: wx, aboutName: config.ownerName, chatId,
        tags: ['QQ导入', ...(Array.isArray(item.tags) ? item.tags.filter((tag) => typeof tag === 'string').slice(0, 4) : [])],
        importance: item.importance, saidAt: item.saidAt || item.at, source: 'panel',
        guard: (previous) => previous.chatId === chatId && previous.tags?.includes('QQ导入'),
      })
      if (result?.id) imported++
    }
  }
  return { ok: true, personaId, imported, message: [personaId && '已复制当前人格', memories && `新增 ${imported} 条主人私聊记忆`].filter(Boolean).join('，') }
}
