import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, constants } from 'node:fs'
import { join } from 'node:path'
import { legacyDir, unifiedDir } from './settings.js'

export function copyLegacyPersonas() {
  const target = unifiedDir('personas')
  if (existsSync(target)) return
  mkdirSync(target, { recursive: true })
  for (const channel of ['wechat', 'qq']) {
    const source = legacyDir(channel, 'personas')
    if (!existsSync(source)) continue
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      if (!entry.isFile() || !/^[\w-]{1,80}\.md$/.test(entry.name)) continue
      const file = join(source, entry.name)
      if (statSync(file).size > 1024 * 1024) continue
      try { copyFileSync(file, join(target, entry.name), constants.COPYFILE_EXCL) } catch (error) {
        if (error.code !== 'EEXIST') throw error
      }
    }
  }
}
