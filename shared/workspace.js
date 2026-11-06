import { homedir } from 'node:os'
import { join } from 'node:path'

export const WORKSPACE_TITLE = 'dafeiyu'
export const WORKSPACE_DIR = process.env.AURABOT_UNIFIED_WORKSPACE || join(homedir(), 'Aurabot', WORKSPACE_TITLE)

export const workspaceDirOf = (config) => String(config?.workspaceDir || '').trim() || WORKSPACE_DIR
