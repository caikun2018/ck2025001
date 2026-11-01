// Cloudflare Workers 代理脚本 - 乐享知识库 API
// 部署到 Cloudflare Workers 后，小程序请求此 Worker，由 Worker 转发到乐享 API
// 解决微信小程序移动端 UA 被乐享 WAF 拦截的问题
//
// 部署方式：
// 1. 注册 Cloudflare 账号（免费）
// 2. 在 Workers & Pages 中创建新 Worker
// 3. 粘贴此代码并部署
// 4. 把 Worker 的 URL（如 https://lexiang-proxy.xxx.workers.dev）填入小程序 config.js

// 乐享凭证：统一从 Workers Secrets 读取，代码中不保存任何明文凭据
// 部署后在控制台「Settings → Variables and Secrets」添加 LX_APP_KEY / LX_APP_SECRET / LX_STAFF_ID
const credentialError = (env) => ((!env || !env.LX_APP_KEY || !env.LX_APP_SECRET)
  ? '缺少乐享凭证：请在 Workers 的 Variables and Secrets 中配置 LX_APP_KEY / LX_APP_SECRET / LX_STAFF_ID'
  : '')

const BASE_URL = 'https://lxapi.lexiangla.com/cgi-bin/v1'
const TOKEN_URL = 'https://lxapi.lexiangla.com/cgi-bin/token'

// Token 缓存（Workers 内存，实例复用期间有效）
let cachedToken = null
let cachedExpireAt = 0

async function getAccessToken(env) {
  const miss = credentialError(env)
  if (miss) throw new Error(miss)
  const now = Date.now()
  if (cachedToken && now < cachedExpireAt - 5 * 60 * 1000) {
    return cachedToken
  }
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      app_key: env.LX_APP_KEY,
      app_secret: env.LX_APP_SECRET
    })
  })
  const data = await res.json()
  if (data.access_token) {
    cachedToken = data.access_token
    cachedExpireAt = now + (data.expires_in || 7200) * 1000
    return cachedToken
  }
  throw new Error(JSON.stringify(data))
}

export default {
  async fetch(request, env) {
    // CORS 头，允许小程序跨域请求
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-proxy-key'
    }

    // 处理 OPTIONS 预检请求
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders })
    }

    // 预检放行后先校验调用方：Worker 地址公开后任何人都能换 token
    const proxyKey = env.LX_PROXY_KEY || ''
    if (!proxyKey) {
      return new Response(JSON.stringify({ success: false, error: '缺少 LX_PROXY_KEY：请为该 Worker 配置调用方校验密钥' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 401
      })
    }
    if ((request.headers.get('x-proxy-key') || '') !== proxyKey) {
      return new Response(JSON.stringify({ success: false, error: '未授权：缺少或错误的 x-proxy-key' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 401
      })
    }

    try {
      const body = await request.json().catch(() => ({}))
      const { action, method, path, data, query, queryString } = body

      // token 接口
      if (action === 'token') {
        const token = await getAccessToken(env)
        return new Response(JSON.stringify({ success: true, token }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      // 业务请求
      if (action === 'request') {
        const token = await getAccessToken(env)
        let url = BASE_URL + path
        if (queryString) {
          url += (url.indexOf('?') >= 0 ? '&' : '?') + queryString
        } else if (query) {
          const qs = Object.keys(query).map(k => encodeURIComponent(k) + '=' + encodeURIComponent(query[k])).join('&')
          url += (url.indexOf('?') >= 0 ? '&' : '?') + qs
        }
        const headers = {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token,
          'x-staff-id': env.LX_STAFF_ID || ''
        }
        const init = { method: method || 'GET', headers }
        if (data !== undefined && data !== null) {
          init.body = JSON.stringify(data)
        }
        const res = await fetch(url, init)
        const respData = await res.json().catch(() => ({}))
        return new Response(JSON.stringify({ success: true, statusCode: res.status, data: respData }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      return new Response(JSON.stringify({ success: false, error: '未知 action' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400
      })
    } catch (err) {
      let msg = err.message || '请求失败'
      if (err.message && err.message.indexOf('fetch') >= 0) {
        msg = '网络请求失败: ' + err.message
      }
      return new Response(JSON.stringify({ success: false, error: msg }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500
      })
    }
  }
}
