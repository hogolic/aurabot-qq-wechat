import { statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { CHANNELS, legacyDir, readJson } from './settings.js'

export function isSharedSeedVc(seed) {
  if (!seed?.enabled) return false
  try {
    return ['python', 'converter', 'reference'].every((key) =>
      isAbsolute(seed[key] || '') && statSync(seed[key], { throwIfNoEntry: false })?.isFile())
  } catch { return false }
}

export function usesOriginalSongRoot(root) {
  if (typeof root !== 'string' || !isAbsolute(root)) return false
  const location = (value) => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value)
  return CHANNELS.some((channel) => {
    try {
      const original = readJson(legacyDir(channel, 'config.json'), {})?.song?.root
      return typeof original === 'string' && isAbsolute(original) && location(original) === location(root)
    } catch { return false }
  })
}

export const ORIGINAL_SONG_ROOT_MESSAGE = '当前在复用旧插件的翻唱目录。需要安装或导入音色时，请先选择合并版自己的翻唱目录。'
