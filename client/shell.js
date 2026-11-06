function createUnifiedPanel(require, panels) {
  const React = require('react')
  const { createElement: h, useCallback, useEffect, useRef, useState } = React
  const panelId = 'aurabot-unified'
  const names = { qq: 'QQ', wechat: '微信' }
  const api = (channel) => '/aurabot-unified-' + channel + '/api/unified/memory'

  function UnifiedPage() {
    const [channel, setChannel] = useState(() => localStorage.getItem(panelId + '.channel') === 'qq' ? 'qq' : 'wechat')
    const [memory, setMemory] = useState(null)
    const [message, setMessage] = useState('')
    const [linking, setLinking] = useState(false)
    const content = useRef(null)
    const refresh = useCallback(async () => {
      try {
        const response = await fetch(api(channel), { cache: 'no-store' })
        const result = await response.json()
        if (result.ok) setMemory(result)
      } catch {}
    }, [channel])
    useEffect(() => {
      refresh()
      const timer = setInterval(refresh, 5000)
      return () => clearInterval(timer)
    }, [refresh])
    function switchChannel(next) {
      if (next === channel) return
      if (content.current?.querySelector('.ab-savebar') && !window.confirm('当前页有未保存的设置。切换平台会放弃这些改动，继续吗？')) return
      setChannel(next)
      setMessage('')
      localStorage.setItem(panelId + '.channel', next)
    }
    async function link() {
      if (linking || !memory?.accounts) return
      setLinking(true)
      try {
        const response = await fetch(api(channel) + '/link', {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-aurabot-unified': '1' },
          body: JSON.stringify({ accounts: memory.accounts }),
        })
        const result = await response.json()
        if (result.ok) setMemory(result)
        setMessage(result.ok ? (result.unavailable?.length ? '共享已开启。部分旧记忆读取失败，可再次尝试导入。' : '主人私聊记忆已共享。') : result.message)
      } catch (error) { setMessage(error.message) } finally { setLinking(false) }
    }
    const Panel = panels[channel].AurabotPage
    const style = { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 14 }
    return h('div', { className: 'ab-root' },
      h('style', null, '.ab-unified-content > .ab-root { height: auto; overflow: visible; padding: 0; }'),
      h('div', { className: 'ab-wrap', style, role: 'group', 'aria-label': 'Aurabot 平台' },
        ...Object.entries(names).map(([id, label]) =>
          h('button', { key: id, type: 'button', className: 'ab-btn' + (channel === id ? ' primary' : ''), 'aria-pressed': channel === id, onClick: () => switchChannel(id) }, label)),
        h('span', { className: 'ab-small ab-muted' }, '模型、人格与翻唱等设置共用'),
        memory?.linked
          ? h('span', { className: 'ab-pill', role: 'status' }, '共享主人记忆 · ' + memory.items + ' 条记忆 · ' + memory.gists + ' 条梗概')
          : memory?.accounts
            ? h('button', { type: 'button', className: 'ab-btn sm', disabled: linking, onClick: link }, '确认两个账号属于同一主人，开启共享')
            : h('span', { className: 'ab-small ab-muted' }, '绑定两个平台后可以关联主人记忆'),
        memory?.accounts && !memory.linked ? h('span', { className: 'ab-small ab-muted' }, 'QQ ' + memory.accounts.qq + ' · 微信 ' + memory.accounts.wechat) : null,
        memory?.importsPending?.length ? h('button', { type: 'button', className: 'ab-btn sm', disabled: linking, onClick: link }, '重试导入旧记忆') : null,
        message ? h('span', { className: 'ab-small', role: 'status' }, message) : null),
      h('div', { className: 'ab-unified-content', ref: content }, h(Panel, { key: channel })))
  }

  function apply(ctx) {
    const slots = ctx.get('slots')
    if (!slots) return
    slots.inject('main', () => slots.register({ name: 'main', key: panelId }, UnifiedPage))
    slots.inject('sidebar.panellist', () => slots.register({ name: 'sidebar.panellist', id: panelId, order: 20, label: () => 'Aurabot · QQ / 微信' }, panels.wechat.WhaleIcon))
  }
  return { apply, inject: ['slots'] }
}
