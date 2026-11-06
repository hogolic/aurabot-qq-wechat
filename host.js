import * as qq from './channels/qq/src/host.js'
import * as wechat from './channels/wechat/src/host.js'
import { copyLegacyPersonas } from './shared/personas.js'

export const name = 'aurabot-unified'
export const inject = [...new Set([...qq.inject, ...wechat.inject])]

export function apply(ctx) {
  copyLegacyPersonas()
  for (const adapter of [qq, wechat]) {
    ctx.plugin({ name: adapter.name, inject: adapter.inject, apply: adapter.apply })
  }
}
