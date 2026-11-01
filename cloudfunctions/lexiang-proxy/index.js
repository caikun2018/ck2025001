// 云函数：lexiang-proxy
// 作用：小程序真机无法自定义 User-Agent（乐享 WAF 会拦截移动端 UA 返回 404 HTML），
//       改由云函数在服务端转发，服务端 UA 直连乐享正常。
// 调用方式：wx.cloud.callFunction({ name: 'lexiang-proxy', data: { action: 'token' | 'request', ... } })
//
// 依赖：仅使用 Node 内置 https，无需 npm install（wx-server-sdk 由云开发内置）

const cloud = require('wx-server-sdk')
const https = require('https')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

// 乐享凭证：只从云函数环境变量读取，代码中不保存任何明文凭据
// 在云开发控制台「云函数 → 配置 → 环境变量」添加 LX_APP_KEY / LX_APP_SECRET / LX_STAFF_ID
const APP_KEY = process.env.LX_APP_KEY || ''
const APP_SECRET = process.env.LX_APP_SECRET || ''
const STAFF_ID = process.env.LX_STAFF_ID || ''

const BASE_URL = 'https://lxapi.lexiangla.com/cgi-bin/v1'
const TOKEN_URL = 'https://lxapi.lexiangla.com/cgi-bin/token'

// 实例复用期间的内存 token 缓存
let cachedToken = null
let cachedExpireAt = 0

// 通用 HTTPS 请求，返回 { status, text }
function request(method, url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = https.request({
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      method,
      headers: Object.assign({}, headers, body ? { 'Content-Length': Buffer.byteLength(body) } : {})
    }, res => {
      let chunks = ''
      res.setEncoding('utf8')
      res.on('data', d => { chunks += d })
      res.on('end', () => resolve({ status: res.statusCode, text: chunks }))
    })
    req.on('error', reject)
    req.setTimeout(15000, () => req.destroy(new Error('请求乐享超时')))
    if (body) req.write(body)
    req.end()
  })
}

async function getAccessToken() {
  const now = Date.now()
  if (cachedToken && now < cachedExpireAt - 5 * 60 * 1000) return cachedToken
  const body = JSON.stringify({
    grant_type: 'client_credentials',
    app_key: APP_KEY,
    app_secret: APP_SECRET
  })
  const res = await request('POST', TOKEN_URL, { 'Content-Type': 'application/json; charset=utf-8' }, body)
  let data = {}
  try { data = JSON.parse(res.text) } catch (e) {}
  if (res.status === 200 && data.access_token) {
    cachedToken = data.access_token
    cachedExpireAt = now + (data.expires_in || 7200) * 1000
    return cachedToken
  }
  throw new Error('token 获取失败（HTTP ' + res.status + '）：' + res.text.slice(0, 120))
}

// query 支持对象，也支持已拼好的字符串（如 ids=xx&ids=yy）
function buildQuery(query, queryString) {
  if (queryString) return queryString
  if (!query || typeof query !== 'object') return ''
  return Object.keys(query)
    .filter(k => query[k] !== undefined && query[k] !== null)
    .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(query[k]))
    .join('&')
}

exports.main = async (event) => {
  try {
    if (event.action === 'token') {
      const token = await getAccessToken()
      return { success: true, token }
    }

    if (event.action === 'request') {
      const token = await getAccessToken()
      const qs = buildQuery(event.query, event.queryString)
      let url = BASE_URL + event.path
      if (qs) url += (url.indexOf('?') >= 0 ? '&' : '?') + qs
      const method = (event.method || 'GET').toUpperCase()
      const body = (method === 'GET' || event.data === undefined || event.data === null)
        ? null
        : JSON.stringify(event.data)
      const res = await request(method, url, {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': 'Bearer ' + token,
        'x-staff-id': STAFF_ID
      }, body)
      let data = {}
      try { data = JSON.parse(res.text) } catch (e) { data = { _raw: res.text } }
      return { success: true, statusCode: res.status, data }
    }

    return { success: false, error: '未知 action: ' + event.action }
  } catch (err) {
    return { success: false, error: err.message || '代理请求失败' }
  }
}
