import { statSync } from 'node:fs'
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path'

const windows = process.platform === 'win32'
const toolName = (name) => windows ? name + '.exe' : name
function fileExists(file) {
  try { return Boolean(file && isAbsolute(file) && statSync(file, { throwIfNoEntry: false })?.isFile()) } catch { return false }
}

export function mediaToolEnvironment(config = {}, inherited = process.env) {
  const pathKey = Object.keys(inherited).find((key) => key.toLowerCase() === 'path') || 'PATH'
  const original = String(inherited[pathKey] || '')
  const root = config.song?.root
  const configured = config.song?.seedVc?.ffmpeg
  const locations = [
    fileExists(configured) ? dirname(configured) : '',
    root && isAbsolute(root) ? join(root, 'bin') : '',
  ].filter(Boolean)
  if (windows) {
    for (const bin of [...locations]) {
      const tools = dirname(dirname(bin))
      locations.push(join(tools, 'apps', 'remotion-video-kit', 'node_modules', '@remotion', 'compositor-win32-' + process.arch + '-msvc'))
    }
  }
  const candidates = [...new Set([...locations, ...original.split(delimiter).map((dir) => dir.replace(/^"|"$/g, ''))])].filter(Boolean)
  const find = (name) => {
    const executable = toolName(name)
    return candidates.map((dir) => join(dir, executable)).find(fileExists) || ''
  }
  const ffmpeg = fileExists(configured) && basename(configured).toLowerCase() === toolName('ffmpeg') ? configured : find('ffmpeg')
  const ffprobe = find('ffprobe')
  const preferred = [...new Set([ffmpeg, ffprobe].filter(Boolean).map(dirname))]
  const env = Object.fromEntries(Object.entries(inherited).filter(([key]) => !/^AGENT_WECHAT_/i.test(key) && key.toLowerCase() !== 'path'))
  env[pathKey] = [...preferred, original].filter(Boolean).join(delimiter)
  return { env, ffmpeg, ffprobe }
}
