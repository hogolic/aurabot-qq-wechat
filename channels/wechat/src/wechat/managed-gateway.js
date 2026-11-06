import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { setTimeout as pause } from 'node:timers/promises'
import { dataDir } from '../core/store.js'
import { openGateway } from './api.js'
import { legacyDir } from '../../../../shared/settings.js'
import { mediaToolEnvironment } from '../../../../shared/media-tools.js'

const VERSION = '1.5.1'
const BUILDS = {
  'win32-x64': ['win32-x64.exe', 36516352, '29bfc4e5e45fa90ddadaa54eaa3f9d33b5d5a2d83803011468f40dc15c245abe'],
  'win32-arm64': ['win32-arm64.exe', 29909504, '6cbe3318c03db44b95c69654ed0a1e30dd3b547eda20fb3a3197e254c66f11fc'],
  'darwin-arm64': ['darwin-arm64', 32877616, 'b10b5a1007a19f94a4b3cce60127db848bf79ffaae0742efd196d8c4de0dcf08'],
  'linux-x64': ['linux-x64-gnu', 40906856, 'b9a88034f4f6c2e128e0b83a45c602b3f4bbcc84e5a15dcf57d7cbda34502926'],
  'linux-arm64': ['linux-arm64-gnu', 37964576, 'ff9427259e25a684bf5769bdc4bcdbebd94a001e91e912e1219f89b44b7eed6e'],
}
const ACCOUNT = 'aurabot'
const rootDir = () => resolve(dataDir('agent-wechat'))
const tokenPath = () => join(rootDir(), 'data', 'api-token')
const build = BUILDS[process.platform + '-' + process.arch]
const name = build && ('wx-v' + VERSION + '-' + build[0])
export const agentWechatAsset = build ? {
  name,
  url: 'https://github.com/thisnick/agent-wechat/releases/download/v' + VERSION + '/' + name,
} : null

export function isManagedGateway(settings) {
  return settings.account === ACCOUNT && settings.tokenFile === tokenPath()
}

async function verifiedFile(path, signal) {
  const info = await stat(path).catch((error) => {
    if (error.code !== 'ENOENT') throw error
    return null
  })
  if (!info?.isFile() || info.size !== build[1]) return false
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk)
  return hash.digest('hex') === build[2]
}

async function installBinary(root, signal) {
  const executable = join(root, agentWechatAsset.name)
  if (await verifiedFile(executable, signal)) return executable
  const downloaded = join(homedir(), 'Downloads', agentWechatAsset.name)
  const temp = executable + '.' + randomUUID() + '.tmp'
  const hash = createHash('sha256')
  let bytes = 0
  const verify = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length
      if (bytes > build[1]) return callback(new Error('Agent WeChat 文件大小与发布版本不符'))
      hash.update(chunk)
      callback(null, chunk)
    },
  })
  try {
    let source
    if (await verifiedFile(downloaded, signal)) {
      source = createReadStream(downloaded, { signal })
    } else {
      const response = await fetch(agentWechatAsset.url, { signal })
      if (!response.ok || !response.body) {
        await response.body?.cancel()
        throw new Error('下载 Agent WeChat 失败（HTTP ' + response.status + '）')
      }
      source = response.body
    }
    await pipeline(source, verify, createWriteStream(temp, { flags: 'wx', mode: 0o700 }), { signal })
    if (bytes !== build[1] || hash.digest('hex') !== build[2]) throw new Error('Agent WeChat 文件校验失败，请重新下载')
    try {
      await rename(temp, executable)
    } catch (error) {
      if (!await verifiedFile(executable, signal)) throw error
    }
    return executable
  } finally {
    await rm(temp, { force: true }).catch(() => {})
  }
}

async function availablePort() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise((done) => server.close(done))
  return port
}

async function launch(root, executable, signal, toolsConfig) {
  const serverConfig = join(root, 'server.toml')
  let config = await readFile(serverConfig, 'utf8').catch((error) => {
    if (error.code !== 'ENOENT') throw error
    return ''
  })
  if (!config) {
    const port = await availablePort()
    await writeFile(serverConfig, 'schemaVersion = 1\nlisten = "127.0.0.1:' + port + '"\n', { flag: 'wx', mode: 0o600 })
      .catch((error) => { if (error.code !== 'EEXIST') throw error })
    config = await readFile(serverConfig, 'utf8')
  }
  const port = /^schemaVersion = 1\nlisten = "127\.0\.0\.1:(\d{1,5})"\n$/.exec(config)?.[1]
  if (!port || Number(port) < 1 || Number(port) > 65535) throw new Error('读取不到插件专用网关的本机端口')
  const logPath = join(root, 'startup.log')
  const log = await open(logPath, 'a', 0o600)
  const { env } = mediaToolEnvironment(toolsConfig)
  try {
    // wx 启动后台服务后可能继续持有输出句柄。等待启动进程退出，输出写入插件日志。
    const child = spawn(executable, ['daemon', 'start', '--server-config', serverConfig, '--data-dir', join(root, 'data'), '--json'], {
      cwd: root, env, windowsHide: true, stdio: ['ignore', log.fd, log.fd],
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    })
    const [code] = await once(child, 'exit')
    if (code !== 0) throw new Error('Agent WeChat 启动失败。日志在 ' + logPath)
  } finally {
    await log.close()
  }
  return 'http://127.0.0.1:' + port
}

export async function prepareManagedGateway({ signal, stage, toolsConfig }) {
  if (!agentWechatAsset) throw new Error('当前平台没有可自动启动的 Agent WeChat 版本，请手动连接网关')
  signal.throwIfAborted()
  const root = rootDir()
  await mkdir(root, { recursive: true, mode: 0o700 })
  stage('download')
  const executable = await installBinary(root, AbortSignal.any([signal, AbortSignal.timeout(180_000)]))
  signal.throwIfAborted()
  stage('start')
  const url = await launch(root, executable, signal, toolsConfig)
  stage('account')
  const settings = { url, account: ACCOUNT, tokenFile: tokenPath() }
  await (await openGateway(settings, signal)).ensureAccount()
  return settings
}

function ownedRoot(settings) {
  if (isManagedGateway(settings)) return rootDir()
  const previous = legacyDir('wechat', 'agent-wechat')
  return settings.account === ACCOUNT && resolve(settings.tokenFile || '.') === resolve(previous, 'data', 'api-token') ? previous : ''
}

export function managedVoiceStatus(config) {
  const { ffmpeg, ffprobe } = mediaToolEnvironment(config)
  return { managed: Boolean(ownedRoot(config.wechat)), ffmpeg, ffprobe }
}

export async function restartManagedVoiceGateway({ config, signal }) {
  const root = ownedRoot(config.wechat)
  if (!root || !agentWechatAsset) throw new Error('请在网关主机上给 Agent WeChat 配置 FFmpeg 和 FFprobe')
  const { ffmpeg, ffprobe, env } = mediaToolEnvironment(config)
  if (!ffmpeg || !ffprobe) throw new Error('找不到 FFmpeg 和 FFprobe，请先核对翻唱工具路径')
  const executable = join(root, agentWechatAsset.name)
  if (!await verifiedFile(executable, signal)) throw new Error('Agent WeChat 可执行文件校验失败')
  const serverConfig = join(root, 'server.toml')
  const listen = /^schemaVersion = 1\nlisten = "127\.0\.0\.1:(\d{1,5})"\n$/.exec(await readFile(serverConfig, 'utf8'))?.[1]
  if (!listen || config.wechat.url !== 'http://127.0.0.1:' + listen) throw new Error('托管网关地址和启动配置不一致')
  signal.throwIfAborted()
  const stop = spawn(executable, ['daemon', 'stop', '--server-config', serverConfig, '--data-dir', join(root, 'data'), '--json'], {
    cwd: root, env, windowsHide: true, stdio: 'ignore', signal: AbortSignal.timeout(20_000),
  })
  const [exit] = await once(stop, 'exit')
  if (exit !== 0) throw new Error('Agent WeChat 未能停止，请核对托管网关状态')
  // Once stopped, restore the gateway even if the requesting panel closes.
  await launch(root, executable, AbortSignal.timeout(45_000), config)
  const api = await openGateway(config.wechat)
  const until = Date.now() + 25_000
  do {
    const account = await api.at('', { timeoutMs: 4000 })
    if (account.authenticated && account.connection === 'online' && (!config.botQQ || account.ownUsername === config.botQQ)) {
      return { ffmpeg, ffprobe, online: true }
    }
    if (signal.aborted) break
    await pause(800)
  } while (Date.now() < until)
  return { ffmpeg, ffprobe, online: false }
}
