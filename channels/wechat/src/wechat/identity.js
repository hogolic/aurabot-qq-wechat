const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

export function wechatId(value) {
  const id = String(value ?? '').trim()
  return /^[\w][\w@.-]{0,127}$/.test(id) && !RESERVED_KEYS.has(id) ? id : ''
}

export function wechatPrivateId(value) {
  const id = wechatId(value)
  return id === 'filehelper' || id.endsWith('@chatroom') ? '' : id
}

export function gatewayOrigin(value) {
  try {
    const url = new URL(String(value ?? '').trim())
    const local = url.hostname === '127.0.0.1' || url.hostname === '[::1]'
    const root = url.pathname === '/' || url.pathname === '/v1' || url.pathname === '/v1/'
    return local && root && url.protocol === 'http:' && !url.username && !url.password && !url.search && !url.hash ? url.origin : ''
  } catch {
    return ''
  }
}
