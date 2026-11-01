// 腾讯云 SCF 云函数 - 乐享知识库 API 代理
// 作用：小程序真机无法自定义 User-Agent（乐享 WAF 会拦截移动端 UA 返回 404 页面），
//       因此改由国内云函数做服务端转发（服务端 UA 直连乐享正常）。
//
// 部署步骤（腾讯云函数 SCF，有免费额度，国内可直接访问）：
// 1. 登录 https://console.cloud.tencent.com/scf → 新建云函数 → 选择「从头开始」
// 2. 运行环境选 Node.js 16 或 18，函数代码直接粘贴本文件，超时时间建议 20 秒
// 3. 在「函数管理 → 函数配置 → 环境变量」添加：
//      LX_APP_KEY / LX_APP_SECRET / LX_STAFF_ID  —— 乐享凭证
//      LX_PROXY_KEY                              —— 调用方校验密钥（必填，见下）
// 4. 进入「函数管理 → 函数URL」，开启函数 URL。
//    认证类型必须选「无认证」：小程序 wx.request 无法对函数 URL 做签名认证，
//    开着认证反而调不通。所以安全性由 LX_PROXY_KEY 承担 —— 不配这个变量，本函数会拒绝所有请求。
// 5. 复制函数 URL（形如 https://xxx-xxxx.gz.tencentcs.com/release/）
// 6. 填入小程序 utils/config.js 的 LEXIANG_PROXY_URL，并把同一个 LX_PROXY_KEY 值填进 LEXIANG_PROXY_KEY
// 7. 在微信公众平台「开发管理 → 服务器域名 → request 合法域名」加入该域名
//
// 请求约定（与 lexiang.js 保持一致）：
//   { action: 'token' }                         -> { success, token }
//   { action: 'request', method, path, data, query | queryString }
//                                              -> { success, statusCode, data }
//
// 凭证可用环境变量覆盖：LX_APP_KEY / LX_APP_SECRET / LX_STAFF_ID

const https = require('https')
const crypto = require('crypto')

// 凭证只在环境变量里提供，代码中不保存任何明文
const APP_KEY = process.env.LX_APP_KEY || ''
const APP_SECRET = process.env.LX_APP_SECRET || ''
const STAFF_ID = process.env.LX_STAFF_ID || ''

// 调用方校验密钥：函数 URL 一旦公开，任何人都能换 token 读写知识库。
// 必须在云函数环境变量里配置 LX_PROXY_KEY，小程序端用同值放请求头 x-proxy-key。
const PROXY_KEY = process.env.LX_PROXY_KEY || ''

// 定长比较，避免按字节提前返回带来的时序差异
function keyMatches(got) {
  if (!PROXY_KEY || !got) return false
  const a = Buffer.from(String(got))
  const b = Buffer.from(PROXY_KEY)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

// 返回空字符串表示通过，否则返回拒绝原因
function authFailure(event) {
  if (!PROXY_KEY) return '服务端未配置 LX_PROXY_KEY，出于安全已拒绝所有请求'
  const h = event.headers || {}
  const got = h['x-proxy-key'] || h['X-Proxy-Key'] || h['X-PROXY-KEY'] || ''
  return keyMatches(got) ? '' : '未授权：缺少或错误的 x-proxy-key'
}

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

function buildQuery(query, queryString) {
  if (queryString) return queryString
  if (!query) return ''
  return Object.keys(query)
    .filter(k => query[k] !== undefined && query[k] !== null)
    .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(query[k]))
    .join('&')
}

function parseBody(event) {
  let raw = event.body
  if (event.isBase64Encoded && typeof raw === 'string') {
    raw = Buffer.from(raw, 'base64').toString('utf8')
  }
  if (!raw) return {}
  if (typeof raw === 'object') return raw
  try { return JSON.parse(raw) } catch (e) { return {} }
}

exports.main_handler = async (event) => {
  const cors = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-proxy-key'
  }
  const reply = (statusCode, obj) => ({
    statusCode,
    headers: cors,
    body: JSON.stringify(obj),
    isBase64Encoded: false
  })

  const httpMethod = (event.requestContext && event.requestContext.http && event.requestContext.http.method) || event.httpMethod || 'POST'
  if (httpMethod === 'OPTIONS') return reply(200, { success: true })

  // 预检放行之后、碰任何业务逻辑之前，先校验调用方
  const denied = authFailure(event)
  if (denied) return reply(401, { success: false, error: denied })

  const payload = parseBody(event)
  const action = payload.action

  try {
    if (action === 'token') {
      const token = await getAccessToken()
      return reply(200, { success: true, token })
    }

    if (action === 'request') {
      const token = await getAccessToken()
      const qs = buildQuery(payload.query, payload.queryString)
      let url = BASE_URL + payload.path
      if (qs) url += (url.indexOf('?') >= 0 ? '&' : '?') + qs
      const headers = {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': 'Bearer ' + token,
        'x-staff-id': STAFF_ID
      }
      const method = (payload.method || 'GET').toUpperCase()
      const body = (method === 'GET' || payload.data === undefined || payload.data === null)
        ? null
        : JSON.stringify(payload.data)
      const res = await request(method, url, headers, body)
      let data = {}
      try { data = JSON.parse(res.text) } catch (e) { data = { _raw: res.text } }
      return reply(200, { success: true, statusCode: res.status, data })
    }

    return reply(400, { success: false, error: '未知 action: ' + action })
  } catch (err) {
    return reply(500, { success: false, error: err.message || '代理请求失败' })
  }
}
