import { createQzone } from '../../features/qzone.js'

export default {
  id: 'diary',
  name: '本地日记',
  version: '1.0.0',
  description: '结合主人私聊生成日记，保存在微信版数据目录。',
  tab: 'diary',
  setup(api) {
    const { hub } = api.core
    const memory = api.lazy('memory')
    const diary = createQzone({ getConfig: api.config, hub, log: api.log, localOnly: true, onDiary(text) {
      const owner = api.config().ownerQQ
      if (owner) memory.add?.({ text, about: owner, chatId: `private:${owner}`, source: 'diary' })
    } })
    const write = (preview = false) => api.config().diary.enabled ? diary.writeDiary({ preview }) : { ok: false, message: '请先打开本地日记' }
    api.every(60_000, () => diary.tick(), '本地日记')
    api.route('/diary/run', async (req) => req.method === 'POST' ? write() : { ok: false, message: '请从面板发起' })
    api.route('/diary/preview', async (req) => req.method === 'POST' ? write(true) : { ok: false, message: '请从面板发起' })
    api.route('/diary/history', () => ({ ok: true, items: diary.history(), next: diary.nextTime() }))
    return { writeDiary: () => write(), history: diary.history, nextTime: diary.nextTime }
  },
}
