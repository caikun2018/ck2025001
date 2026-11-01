// services/lexiang.js - 乐享知识库 API 服务
// 官方文档: https://lexiang.tencent.com/wiki/api/
// 认证：appKey + appSecret 换取 access_token（有效期 2 小时，自动缓存刷新）
// 业务接口：https://lxapi.lexiangla.com/cgi-bin/v1

const config = require('../utils/config.js')
const storage = require('./storage.js')
const util = require('../utils/util.js')

const BASE_URL = 'https://lxapi.lexiangla.com/cgi-bin/v1'
const TOKEN_URL = 'https://lxapi.lexiangla.com/cgi-bin/token'
const TOKEN_KEY = 'ct_lexiang_token'

// 内存 token 缓存
let cachedToken = null
let cachedExpireAt = 0

// 传输方式：'' 未探测 | 'direct' 直连 | 'cloud' 微信云开发云函数 | 'http' 公网代理
// 乐享 WAF 会拦截微信/移动端 UA（返回 404 页面）：
// - 开发者工具可用桌面 UA 直连；
// - 真机 UA 由微信控制，必须走云函数（推荐）或公网代理。
const TRANSPORT_KEY = 'ct_lexiang_transport'
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
let transport = storage.get(TRANSPORT_KEY, '') || ''
if (transport === 'proxy') transport = 'http' // 兼容旧版本存储值

const setTransport = (t) => {
  transport = t
  storage.set(TRANSPORT_KEY, t)
  console.log('[lexiang] 传输方式切换为:', t)
}

const hasProxy = () => !!(config.LEXIANG_PROXY_URL && config.LEXIANG_PROXY_URL !== 'your-workers-url')

// 公网代理的共享密钥请求头：SCF / Worker 侧会校验 x-proxy-key，
// 避免函数 URL 被扫描器拿到后白嫖 token。密钥放在本地 utils/config.js（不入库）。
const proxyHeaders = () => {
  const header = { 'Content-Type': 'application/json' }
  if (config.LEXIANG_PROXY_KEY) header['x-proxy-key'] = config.LEXIANG_PROXY_KEY
  return header
}

const hasCloud = () => {
  const env = config.CLOUD_ENV_ID
  return !!(env && env !== 'your-cloud-env-id' && wx.cloud && wx.cloud.callFunction)
}

// 调用云函数（lexiang-proxy）
const cloudCall = (data) => {
  return new Promise((resolve, reject) => {
    wx.cloud.callFunction({
      name: 'lexiang-proxy',
      data,
      success: res => {
        const r = res.result || {}
        if (r.success) resolve(r)
        else reject(new Error(r.error || '云函数调用失败'))
      },
      fail: err => reject(new Error((err && err.errMsg) || '云函数调用失败'))
    })
  })
}

const isConfigured = () => !!(config.LEXIANG.appKey && config.LEXIANG.appSecret)

// 直连获取 token（带桌面 UA，绕过 WAF 的移动端拦截）
const directToken = () => {
  const secret = config.LEXIANG.appSecret
  // appKey 是公开标识可以放包里；appSecret 属于服务端凭证，正式包不该带（放云函数环境变量 LX_APP_SECRET），
  // 否则整个小程序包被解包就等于泄漏一份永久有效的知识库读写凭证
  if (!secret) {
    const e = new Error('客户端未内置 appSecret，改用云函数通道')
    e.waf = true
    return Promise.reject(e)
  }
  return new Promise((resolve, reject) => {
    wx.request({
      url: TOKEN_URL,
      method: 'POST',
      header: {
        'Content-Type': 'application/json; charset=utf-8',
        'User-Agent': DESKTOP_UA
      },
      data: {
        grant_type: 'client_credentials',
        app_key: config.LEXIANG.appKey,
        app_secret: secret
      },
      success: res => {
        const d = res.data
        if (res.statusCode === 200 && d && d.access_token) {
          resolve({ token: d.access_token, expiresIn: d.expires_in || 7200 })
          return
        }
        const e = new Error('token 接口返回 ' + res.statusCode)
        // 404 或 HTML 响应 = WAF 拦截（UA 未被覆盖）
        e.waf = res.statusCode === 404 || typeof d === 'string'
        reject(e)
      },
      fail: err => {
        const e = new Error(err.errMsg || '直连网络请求失败')
        e.network = true
        reject(e)
      }
    })
  })
}

// 通过代理获取 token
const proxyToken = () => {
  return new Promise((resolve, reject) => {
    if (!hasProxy()) {
      reject(new Error('未配置可用代理（请填写 CLOUD_ENV_ID 部署云函数，或配置 LEXIANG_PROXY_URL）'))
      return
    }
    console.log('[lexiang] 通过代理获取 token')
    wx.request({
      url: config.LEXIANG_PROXY_URL,
      method: 'POST',
      header: proxyHeaders(),
      data: { action: 'token' },
      success: res => {
        const result = res.data || {}
        if (result.success && result.token) {
          resolve({ token: result.token, expiresIn: 7200 })
        } else {
          reject(new Error(result.error || '代理获取 token 失败'))
        }
      },
      fail: err => {
        console.error('[lexiang] 代理请求失败:', JSON.stringify(err))
        reject(new Error(err.errMsg || '代理网络请求失败'))
      }
    })
  })
}

// 通过云函数获取 token
const cloudToken = () => {
  return cloudCall({ action: 'token' }).then(r => {
    if (!r.token) throw new Error('云函数未返回 token')
    return { token: r.token, expiresIn: 7200 }
  })
}

// 获取 access_token：直连（开发者工具）→ 云函数 → 公网代理
const getAccessToken = async () => {
  const now = Date.now()
  if (cachedToken && now < cachedExpireAt - 5 * 60 * 1000) return cachedToken
  const local = storage.get(TOKEN_KEY)
  if (local && local.token && now < local.expireAt - 5 * 60 * 1000) {
    cachedToken = local.token
    cachedExpireAt = local.expireAt
    return cachedToken
  }

  let result = null
  let lastErr = null
  if (transport !== 'cloud' && transport !== 'http') {
    try {
      result = await directToken()
      setTransport('direct')
    } catch (e) {
      console.warn('[lexiang] 直连获取 token 失败:', e.message, e.waf ? '(WAF 拦截)' : '')
    }
  }
  if (!result && hasCloud()) {
    try {
      console.log('[lexiang] 通过云函数获取 token')
      result = await cloudToken()
      setTransport('cloud')
    } catch (e) {
      console.warn('[lexiang] 云函数获取 token 失败:', e.message)
      lastErr = e
    }
  }
  if (!result) {
    try {
      result = await proxyToken()
      setTransport('http')
    } catch (e) {
      lastErr = e
    }
  }
  if (!result || !result.token) {
    throw new Error((lastErr && lastErr.message) || '未能获取乐享 access_token（请部署云函数并填写 CLOUD_ENV_ID）')
  }

  cachedToken = result.token
  cachedExpireAt = now + (result.expiresIn || 7200) * 1000
  storage.set(TOKEN_KEY, { token: cachedToken, expireAt: cachedExpireAt })
  console.log('[lexiang] token 获取成功')
  return cachedToken
}

// 清空本地 token 缓存（凭证失效时使用）
const clearToken = () => {
  cachedToken = null
  cachedExpireAt = 0
  storage.remove(TOKEN_KEY)
}

// 拼接完整 URL
const buildUrl = (path, query) => {
  let url = BASE_URL + path
  if (typeof query === 'string') {
    return url + (query ? (url.indexOf('?') >= 0 ? '&' : '?') + query : '')
  }
  if (query) {
    const qs = Object.keys(query)
      .filter(k => query[k] !== undefined && query[k] !== null)
      .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(query[k]))
      .join('&')
    if (qs) url += (url.indexOf('?') >= 0 ? '&' : '?') + qs
  }
  return url
}

// 直连业务请求（带桌面 UA + access_token）
const directApiRequest = (method, path, data, query, token) => {
  return new Promise((resolve, reject) => {
    wx.request({
      url: buildUrl(path, query),
      method,
      header: {
        'Content-Type': 'application/json; charset=utf-8',
        'User-Agent': DESKTOP_UA,
        'Authorization': 'Bearer ' + token,
        'x-staff-id': config.LEXIANG.staffId || ''
      },
      data: method === 'GET' ? undefined : data,
      success: res => {
        const d = res.data
        if (res.statusCode === 404 || typeof d === 'string') {
          const e = new Error('直连被拦截（' + res.statusCode + '）')
          e.waf = true
          reject(e)
          return
        }
        resolve({ statusCode: res.statusCode, data: d })
      },
      fail: err => {
        const e = new Error(err.errMsg || '直连网络请求失败')
        e.network = true
        reject(e)
      }
    })
  })
}

// 通过代理业务请求
const proxyApiRequest = (method, path, data, query) => {
  return new Promise((resolve, reject) => {
    if (!hasProxy()) {
      reject(new Error('未配置可用代理（请填写 CLOUD_ENV_ID 部署云函数，或配置 LEXIANG_PROXY_URL）'))
      return
    }
    // query 既可能是对象，也可能是已拼好的字符串（如 ids=xx&ids=yy）
    const payload = { action: 'request', method, path, data, query }
    if (typeof query === 'string') payload.queryString = query
    wx.request({
      url: config.LEXIANG_PROXY_URL,
      method: 'POST',
      header: proxyHeaders(),
      data: payload,
      success: res => {
        const result = res.data || {}
        if (result.success) {
          resolve({ statusCode: result.statusCode, data: result.data })
        } else {
          reject(new Error(result.error || '代理请求失败'))
        }
      },
      fail: err => {
        console.error('[lexiang] 代理请求失败:', JSON.stringify(err))
        reject(new Error(err.errMsg || '代理网络请求失败'))
      }
    })
  })
}

// 通过云函数业务请求
const cloudApiRequest = (method, path, data, query) => {
  const payload = { action: 'request', method, path, data, query }
  if (typeof query === 'string') payload.queryString = query
  return cloudCall(payload).then(r => ({ statusCode: r.statusCode, data: r.data }))
}

// 统一业务请求封装：先取 token（失败直接抛错），再按传输方式发请求
// 注意：必须先拿到有效 token，否则乐享会返回 403「接口凭证无效」
const apiRequest = async (method, path, data, query) => {
  const send = async (token) => {
    if (transport === 'cloud') return cloudApiRequest(method, path, data, query)
    if (transport === 'http') return proxyApiRequest(method, path, data, query)
    try {
      return await directApiRequest(method, path, data, query, token)
    } catch (e) {
      console.warn('[lexiang] 直连失败:', e.message)
      // 只有确实存在备用通道时才切换并持久化：
      // 以前无条件 setTransport('http')，没配代理时会把自己永久钉死在无效通道上（清缓存才能恢复）
      if (hasCloud()) {
        const r = await cloudApiRequest(method, path, data, query)
        setTransport('cloud')
        return r
      }
      if (hasProxy()) {
        const r = await proxyApiRequest(method, path, data, query)
        setTransport('http')
        return r
      }
      throw e
    }
  }

  let token = await getAccessToken()
  let r = await send(token)

  // 403 = 凭证失效（本地缓存了过期/无效 token），清缓存重取一次
  if (r && r.statusCode === 403) {
    console.warn('[lexiang] 凭证失效，清缓存后重试:', path)
    clearToken()
    token = await getAccessToken()
    r = await send(token)
  }
  return r
}

// 构造一个文本块（段落 p）
const textBlock = (content) => ({
  block_type: 'p',
  text: { elements: [{ text_run: { content: String(content) } }] }
})

// 构造标题块（乐享字段名为 heading1~heading5，不是 h2）
const headingBlock = (level, content) => {
  const key = 'heading' + level
  const obj = { block_type: 'h' + level }
  obj[key] = { elements: [{ text_run: { content: String(content) } }] }
  return obj
}

// 解析 wx.request 响应，兼容字符串 body
const parseRes = (res) => {
  if (typeof res.data === 'string') {
    try { return JSON.parse(res.data || '{}') } catch (e) { return { _raw: res.data } }
  }
  return res.data || {}
}

// ==================== 知识节点操作 ====================

// 创建知识节点（folder / page）
const createEntry = (name, entryType, parentId) => {
  const body = {
    data: {
      attributes: { name, entry_type: entryType },
      relationships: parentId ? {
        parent_entry: { data: { type: 'kb_entry', id: parentId } }
      } : undefined
    }
  }
  return apiRequest('POST', '/kb/entries', body, { space_id: config.LEXIANG.spaceId })
    .then(res => {
      const data = parseRes(res)
      console.log('[lexiang] createEntry 响应:', res.statusCode, JSON.stringify(data).slice(0, 300))
      if (res.statusCode >= 200 && res.statusCode < 300 && data.data && data.data.id) {
        return { ok: true, entryId: data.data.id, data }
      }
      // 失败也要留痕，否则归档里少了一条时无从查起
      console.warn('[lexiang] createEntry 失败:', name, 'parent=', parentId, 'status=', res.statusCode, JSON.stringify(data).slice(0, 200))
      return { ok: false, error: data.errors || data.message || ('创建节点失败 status=' + res.statusCode), data }
    })
}

// 获取子节点列表（extraQuery 用于分页等可选参数）
const listChildren = (parentId, extraQuery) => {
  const query = Object.assign({}, extraQuery || {})
  query.space_id = config.LEXIANG.spaceId
  if (parentId) query.parent_id = parentId
  return apiRequest('GET', '/kb/entries', undefined, query)
    .then(res => {
      const data = parseRes(res)
      return { ok: res.statusCode === 200, data: data.data || [], meta: data.meta }
    })
}

// 判断条目是否真实存在（用于识别历史“假同步”标记）
// 返回 true / false；网络异常等无法判断时按 true 处理，避免重复创建
const entryExists = (entryId) => {
  if (!entryId) return Promise.resolve(false)
  return apiRequest('GET', '/kb/entries/' + entryId, undefined, { space_id: config.LEXIANG.spaceId })
    .then(res => {
      if (res.statusCode === 404) return false
      return true
    })
    .catch(() => true)
}

// 获取文档内容（markdown 格式）
const getEntryContent = (entryId) => {
  return apiRequest('GET', '/kb/entries/' + entryId + '/content', undefined, { content_type: 'markdown' })
    .then(res => {
      const data = parseRes(res)
      return { ok: res.statusCode === 200, content: (data.data && data.data.attributes && (data.data.attributes.markdown_content || data.data.attributes.content)) || '' }
    })
}

// ==================== 在线文档块操作 ====================

// 获取页面子块列表
const getBlocks = (entryId, parentBlockId) => {
  const query = {}
  if (parentBlockId) query.parent_block_id = parentBlockId
  return apiRequest('GET', '/kb/page/entries/' + entryId + '/blocks/children', undefined, query)
    .then(res => {
      const data = parseRes(res)
      return { ok: res.statusCode === 200, blocks: (data.data && data.data.blocks) || [] }
    })
}

// 创建块（支持多个，追加到末尾）
const createBlocks = (entryId, blocks) => {
  return apiRequest('POST', '/kb/page/entries/' + entryId + '/blocks/descendant', {
    index: -1,
    descendant: blocks
  }).then(res => {
    const data = parseRes(res)
    console.log('[lexiang] createBlocks 响应:', res.statusCode, JSON.stringify(data).slice(0, 200))
    return { ok: res.statusCode >= 200 && res.statusCode < 300 && data.code === 0, data }
  })
}

// 更新块的文本内容
const updateBlockText = (entryId, blockId, content) => {
  return apiRequest('PUT', '/kb/page/entries/' + entryId + '/blocks/' + blockId, {
    update_text_elements: { elements: [{ text_run: { content: String(content) } }] }
  }).then(res => {
    const data = parseRes(res)
    return { ok: res.statusCode === 200 && data.code === 0, data }
  })
}

// 删除页面所有子块
const deleteAllBlocks = async (entryId) => {
  const r = await getBlocks(entryId)
  if (!r.ok) return { ok: false, error: '获取块列表失败' }
  if (!r.blocks || r.blocks.length === 0) return { ok: true }
  const ids = r.blocks.map(b => b.block_id).filter(Boolean)
  if (ids.length === 0) return { ok: true }
  const query = ids.map(id => 'ids=' + encodeURIComponent(id)).join('&')
  return apiRequest('DELETE', '/kb/page/entries/' + entryId + '/blocks/children', undefined, query)
    .then(res => {
      const data = parseRes(res)
      return { ok: res.statusCode === 200 && data.code === 0, data }
    })
}

// ==================== 科目目录（自动创建） ====================

// 对话可能涉及任意学科，这里尽量把常见科目都准备好，归档时不会无处可去
const ARCHIVE_SUBJECTS = [
  '语文', '数学', '英语', '物理', '化学', '生物',
  '历史', '地理', '政治', '科学', '道德与法治',
  '古筝', '练字', '其他'
]
// 出题/筛题用的学科选项：全科 + 知识库全部科目（闯关页与练习页共用）
const ALL_SUBJECT = '全科'
const SUBJECT_OPTIONS = [ALL_SUBJECT].concat(ARCHIVE_SUBJECTS)
const CATALOG_KEY = 'ct_lx_catalog'
// 目录结构修正（科目改到年级目录下、加「题库」页面）后递增，旧缓存自动作废重建
const CATALOG_VERSION = 3
// 每科目录下的题库页面名（每道待用题一个块，出掉就删块）
const BANK_PAGE_NAME = '题库'
// 题库页面建失败时的重试间隔（网络抖动不要每次都重新查目录）
const BANK_RETRY_GAP = 8 * 60 * 1000

const describeError = (e) => {
  if (!e) return '未知错误'
  if (typeof e === 'string') return e
  try { return JSON.stringify(e).slice(0, 120) } catch (x) { return '未知错误' }
}

const getCatalogCache = () => {
  const c = storage.get(CATALOG_KEY, {}) || {}
  return c.__v === CATALOG_VERSION ? c : { __v: CATALOG_VERSION }
}
const saveCatalogCache = (c) => {
  c.__v = CATALOG_VERSION
  storage.set(CATALOG_KEY, c)
}

// ==================== 科目清单（每次打开小程序与乐享同步） ====================

const SUBJECTS_KEY = 'ct_lx_subjects' // { list: [...], at: 同步时间戳 }
const SUBJECTS_TTL = 10 * 60 * 1000   // 10 分钟内不重复拉取，避免频繁请求
// 年级目录下这些文件夹不是科目，同步时要跳过
const NOT_SUBJECT_NAMES = ['错题', '学习记忆', '题库']
let subjectsSyncing = null

// 同步到的科目清单（不含全科）；还没同步成功过时用预置清单兜底
const getSyncedSubjects = () => {
  const cached = storage.get(SUBJECTS_KEY, null)
  if (cached && Array.isArray(cached.list) && cached.list.length) return cached.list.slice()
  return ARCHIVE_SUBJECTS.slice()
}

// 所有页面统一使用的下拉选项：全科 + 同步到的科目
const getSubjectOptions = () => [ALL_SUBJECT].concat(getSyncedSubjects())

// 从乐享知识库拉取「当前年级」下的科目文件夹，作为全局科目清单
// 页面/业务只读本地缓存（getSyncedSubjects），这里负责把缓存刷新成知识库的最新状态
const refreshSubjects = (options = {}) => {
  if (!isConfigured()) return Promise.resolve({ ok: false, skipped: true, message: '乐享未配置' })
  if (subjectsSyncing) return subjectsSyncing
  const cached = storage.get(SUBJECTS_KEY, null)
  const gap = options.minGap !== undefined ? options.minGap : SUBJECTS_TTL
  if (!options.force && cached && cached.at && Date.now() - cached.at < gap) {
    return Promise.resolve({ ok: true, cached: true, list: getSyncedSubjects() })
  }

  const gradeName = (storage.getUser() || {}).grade || '四年级'
  subjectsSyncing = getGradeEntryId()
    // 先请求大页容量（科目可能较多），不支持该参数时退回默认分页
    .then(gradeId => listChildren(gradeId, { page_size: 100 })
      .then(r => (r.ok ? r : listChildren(gradeId))))
    .then(r => {
      if (!r.ok) throw new Error('读取知识库科目目录失败')
      const remote = []
      ;(r.data || []).forEach(it => {
        const a = it.attributes || {}
        const name = String(a.name || it.name || '').trim()
        const type = a.entry_type || it.entry_type || ''
        if (!name || name === gradeName) return
        // 只认文件夹；错题/学习记忆是科目内部目录
        if (type && String(type).toLowerCase().indexOf('folder') < 0) return
        if (NOT_SUBJECT_NAMES.indexOf(name) >= 0) return
        if (remote.indexOf(name) < 0) remote.push(name)
      })
      if (!remote.length) throw new Error('知识库里没有读到科目文件夹')
      // 预置科目保持原有顺序，知识库里新增的科目追加在后面
      const ordered = ARCHIVE_SUBJECTS.filter(n => remote.indexOf(n) >= 0)
        .concat(remote.filter(n => ARCHIVE_SUBJECTS.indexOf(n) < 0).sort())
      if (ordered.indexOf('其他') < 0) ordered.push('其他')
      storage.set(SUBJECTS_KEY, { list: ordered, at: Date.now() })
      console.log('[lexiang] 科目同步完成:', ordered.join('/'))
      return { ok: true, list: ordered }
    })
    .catch(e => {
      console.warn('[lexiang] 科目同步失败，沿用本地清单:', (e && e.message) || e)
      return { ok: false, message: (e && e.message) || '科目同步失败', list: getSyncedSubjects() }
    })
  subjectsSyncing.then(() => { subjectsSyncing = null })
  return subjectsSyncing
}

// 知识点名归一化：比对各处写法差异（空格、标点、Markdown 引用后缀）
const stripBlockRef = (s) => String(s || '').replace(/\[[^\]]*\]\(@[^)]*\)/g, '')
const normPoint = (s) => stripBlockRef(s)
  .replace(/[\s，。、；：:！？!?（）()【】\[\]"'“”‘’]/g, '')
  .slice(0, 60)

// 从学习记忆的 Markdown / 块文本里抽知识点名称
// 兼容两种写法：`### 知识点标题`（appendMemory 追加）与整段 JSON（旧版 updateMemory 写的）
const MEM_POINT_NOISE = /^(记录时间|更新时间|待补充|掌握薄弱点|已掌握点|常犯错误|出题偏好|最近更新|weakPoints|masteredPoints|commonErrors|preference)/
const parseMemoryPoints = (text) => {
  const out = []
  const push = (raw) => {
    const name = stripBlockRef(raw)
      .replace(/^[#>*\s\-·]+/, '')
      .replace(/[。，、；：:]+$/, '')
      .trim()
    if (!name || name.length > 40 || MEM_POINT_NOISE.test(name)) return
    if (out.indexOf(name) < 0) out.push(name)
  }
  String(text || '').split(/\r?\n/).forEach(line => {
    const t = String(line).trim()
    if (t.charAt(0) === '{') {
      try {
        const obj = JSON.parse(stripBlockRef(t))
        if (obj && Array.isArray(obj.weakPoints)) obj.weakPoints.forEach(push)
      } catch (e) {}
      return
    }
    const m = /^#{2,4}\s+(.+)$/.exec(t)
    if (m) push(m[1])
  })
  return out
}

// 把任意科目名收敛到已知清单，未知的一律进"其他"
const normalizeSubject = (subject) => {
  const s = String(subject || '').trim()
  if (ARCHIVE_SUBJECTS.indexOf(s) >= 0) return s
  return getSyncedSubjects().indexOf(s) >= 0 ? s : '其他'
}

// 在指定目录下按名字查找子节点
const findChildByName = (parentId, name) => {
  return listChildren(parentId).then(r => {
    if (!r.ok) return null
    const list = r.data || []
    const hit = list.find(it => {
      const n = (it.attributes && it.attributes.name) || it.name || ''
      return n === name
    })
    return hit ? hit.id : null
  }).catch(() => null)
}

// 当前年级目录：科目必须建在「知识库根 → 年级 → 科目」下
// 早期版本误用知识库根节点做父级，导致「历史」这类非预置科目与「四年级」平级，用户在年级里看不到
const getGradeEntryId = async () => {
  const grade = (storage.getUser() || {}).grade || '四年级'
  if (grade === '四年级' && config.LEXIANG.grade4EntryId) return config.LEXIANG.grade4EntryId
  const found = await findChildByName(config.LEXIANG.rootEntryId, grade)
  if (found) return found
  console.warn('[lexiang] 未找到年级目录「' + grade + '」，暂时写入根级')
  return config.LEXIANG.rootEntryId
}

// 题库页面（每科一个「题库」页）：建不出来只提示，不影响错题归档
const ensureBankPage = async (subjectId, name) => {
  try {
    const found = await findChildByName(subjectId, BANK_PAGE_NAME)
    if (found) return found
    const r = await createEntry(BANK_PAGE_NAME, 'page', subjectId)
    if (!r.ok) throw new Error(describeError(r.error))
    console.log('[lexiang] 新建题库页面:', name, r.entryId)
    return r.entryId
  } catch (e) {
    console.warn('[lexiang] 题库页面就绪失败:', name, (e && e.message) || e)
    return null
  }
}

// 确保科目在乐享里有：科目文件夹 -> 错题文件夹 / 学习记忆页面 / 题库页面
// 结果缓存在本地，之后归档直接用 id，不再重复查询
const ensureSubject = async (subject) => {
  const name = normalizeSubject(subject)
  const cache = getCatalogCache()
  const hit = cache[name]
  if (hit && hit.wrongId && hit.memoryId) {
    // 题库页可能还没建（旧缓存），建不出来时 8 分钟内不再重试
    if (hit.bankId) return hit
    if (hit.bankTryAt && Date.now() - hit.bankTryAt < BANK_RETRY_GAP) return hit
  }

  // 1) 代码里预置的科目直接用现成 id
  const preset = config.LEXIANG.subjects[name]
  if (preset && preset.wrongId && preset.memoryId) {
    const cat = {
      subjectId: preset.entryId,
      wrongId: preset.wrongId,
      memoryId: preset.memoryId,
      bankId: await ensureBankPage(preset.entryId, name),
      bankTryAt: Date.now()
    }
    cache[name] = cat
    saveCatalogCache(cache)
    return cat
  }

  // 2) 科目文件夹（建在当前年级下）
  const gradeId = await getGradeEntryId()
  let subjectId = (preset && preset.entryId) || await findChildByName(gradeId, name)
  if (!subjectId) {
    // 旧版本把科目建在了根级，这里只提示不复用，否则用户在自己的年级里仍然看不到
    const legacyId = gradeId !== config.LEXIANG.rootEntryId
      ? await findChildByName(config.LEXIANG.rootEntryId, name)
      : null
    if (legacyId) {
      console.warn('[lexiang] 科目「' + name + '」在知识库根级有旧目录 ' + legacyId + '，本次改为在年级下创建，旧目录可在乐享中手动整理')
    }
    const r = await createEntry(name, 'folder', gradeId)
    if (!r.ok) throw new Error('创建科目「' + name + '」失败：' + describeError(r.error))
    subjectId = r.entryId
    console.log('[lexiang] 新建科目文件夹:', name, '父目录:', gradeId, '新目录:', subjectId)
  }

  // 3) 错题文件夹
  let wrongId = await findChildByName(subjectId, '错题')
  if (!wrongId) {
    const r = await createEntry('错题', 'folder', subjectId)
    if (!r.ok) throw new Error('在「' + name + '」下创建错题目录失败：' + describeError(r.error))
    wrongId = r.entryId
  }

  // 4) 学习记忆页面
  let memoryId = await findChildByName(subjectId, '学习记忆')
  if (!memoryId) {
    const r = await createEntry('学习记忆', 'page', subjectId)
    if (!r.ok) throw new Error('在「' + name + '」下创建学习记忆失败：' + describeError(r.error))
    memoryId = r.entryId
  }

  // 5) 题库页面（待用题都放这里，出掉一题删一个块）
  const bankId = await ensureBankPage(subjectId, name)

  const cat = { subjectId, wrongId, memoryId, bankId, bankTryAt: Date.now() }
  cache[name] = cat
  saveCatalogCache(cache)
  console.log('[lexiang] 科目目录就绪:', name, JSON.stringify(cat))
  return cat
}

// 一次性把全部科目目录建好（后台静默执行，失败不影响主流程）
const ensureAllSubjects = async () => {
  if (!isConfigured()) return { ok: false, message: '乐享未配置' }
  const ready = []
  const failed = []
  for (const name of ARCHIVE_SUBJECTS) {
    try {
      await ensureSubject(name)
      ready.push(name)
    } catch (e) {
      console.warn('[lexiang] 科目目录创建失败:', name, e.message)
      failed.push(name + '：' + e.message)
    }
  }
  console.log('[lexiang] 科目目录初始化完成，成功', ready.length, '失败', failed.length)
  return { ok: failed.length === 0, ready, failed }
}

// 归档一条知识点：只增量追加，绝不删除页面已有内容
// - 页面里没有同名知识点 → 追加「### 标题 + 正文 + 记录时间」
// - 已有同名知识点 → 讲解相同就跳过（去重）；讲解不同则用新内容覆盖那一条的正文（矛盾取新）
const appendMemory = async (subject, title, content) => {
  const name = String(title || '').trim() || '知识点'
  const body = String(content || '').trim()
  const cat = await ensureSubject(subject)
  if (!cat || !cat.memoryId) return { ok: false, error: '未找到学习记忆页面' }
  const memoryId = cat.memoryId
  const target = normPoint(name)
  const isHeading = (b) => /^h[1-6]$/.test(String((b && b.block_type) || ''))

  const listed = await getBlocks(memoryId)
  const blocks = (listed && listed.ok && listed.blocks) || []
  const idx = blocks.findIndex(b => isHeading(b) && normPoint(extractBlockText(b)) === target)

  if (idx >= 0 && body) {
    const next = blocks[idx + 1]
    // 标题存在但下面没有正文（历史数据 / 被手动清过）：只补正文，不能再追一个同名标题
    const hasBody = !!(next && !isHeading(next) && next.block_id)
    if (hasBody && String(extractBlockText(next)).trim() === body) {
      console.log('[lexiang] 学习记忆已有相同知识点，跳过:', name)
      return { ok: true, deduped: true, entryId: memoryId }
    }
    if (hasBody) {
      const up = await updateBlockText(memoryId, next.block_id, body)
      console.log('[lexiang] 学习记忆同名知识点，按新内容更新:', name, up.ok ? '成功' : '失败')
      return { ok: up.ok, updated: true, error: up.ok ? '' : describeError(up.data), entryId: memoryId }
    }
    const fix = await createBlocks(memoryId, [
      textBlock(body),
      textBlock('记录时间：' + util.formatTime(new Date()))
    ])
    console.log('[lexiang] 学习记忆同名知识点缺正文，补写正文:', name, fix.ok ? '成功' : '失败')
    return { ok: fix.ok, updated: true, appended: fix.ok, error: fix.ok ? '' : describeError(fix.data), entryId: memoryId }
  }

  console.log('[lexiang] 知识点归档（追加）:', normalizeSubject(subject), '-> 学习记忆', memoryId, name)
  const add = [headingBlock(3, name), textBlock(body), textBlock('记录时间：' + util.formatTime(new Date()))]
  return createBlocks(memoryId, add).then(r => {
    if (!r.ok) console.warn('[lexiang] 知识点写入失败:', name, JSON.stringify(r.data).slice(0, 200))
    return { ok: r.ok, error: r.ok ? '' : describeError(r.data), entryId: memoryId, appended: r.ok }
  })
}

// 知识点消退：从学习记忆页面删掉这一条知识点（标题块 + 其下正文块），
// 页面文件与其它知识点保留 —— 乐享没有删节点的 API，所以只删块、不删页面
// 兼容两种写法：### 标题 + 正文段落（appendMemory），以及整页一段 JSON（旧 updateMemory）
const removeMemoryPoint = async (subject, name) => {
  const target = normPoint(name)
  if (!target) return { ok: false, error: '缺少知识点名称' }
  let cat = null
  try {
    cat = await ensureSubject(subject)
  } catch (e) {
    return { ok: false, error: (e && e.message) || '准备科目目录失败' }
  }
  const memoryId = cat && cat.memoryId
  if (!memoryId) return { ok: false, error: '未找到学习记忆页面' }

  const r = await getBlocks(memoryId)
  if (!r.ok) return { ok: false, error: '获取学习记忆块失败' }
  const blocks = r.blocks || []
  const isHeading = (b) => /^h[1-6]$/.test(String((b && b.block_type) || ''))
  const textOf = (b) => extractBlockText(b)

  // 1) 历史遗留的 JSON 段（老版本 updateMemory 写的）：只改这一段，其它块不动
  const jsonBlock = blocks.find(b => /^\s*\{/.test(textOf(b)))
  if (jsonBlock && jsonBlock.block_id) {
    let obj = null
    try { obj = JSON.parse(textOf(jsonBlock)) } catch (e) {}
    if (obj && Array.isArray(obj.weakPoints) && obj.weakPoints.some(p => normPoint(p) === target)) {
      obj.weakPoints = obj.weakPoints.filter(p => normPoint(p) !== target)
      obj.updatedAt = util.formatTime(new Date())
      const upJson = await updateBlockText(memoryId, jsonBlock.block_id, JSON.stringify(obj))
      console.log('[lexiang] 学习记忆（JSON 段）移除知识点:', target, upJson.ok ? '成功' : '失败')
    }
  }

  // 2) 「### 标题」格式：连同标题下面的正文块一起删（遇到下一个标题就停）
  const ids = []
  for (let i = 0; i < blocks.length; i++) {
    if (!isHeading(blocks[i]) || normPoint(textOf(blocks[i])) !== target) continue
    // 一直删到下一个标题为止：以前写死 j < i + 6，正文超过 5 段时后半截会残留成孤立段落
    for (let j = i; j < blocks.length; j++) {
      if (j > i && isHeading(blocks[j])) break
      const id = blocks[j] && blocks[j].block_id
      if (id && ids.indexOf(id) < 0) ids.push(id)
    }
  }
  if (!ids.length) return { ok: true, skipped: '页面里没有这条知识点段落' }
  const query = ids.map(id => 'ids=' + encodeURIComponent(id)).join('&')
  const del = await apiRequest('DELETE', '/kb/page/entries/' + memoryId + '/blocks/children', undefined, query)
  const data = parseRes(del)
  const ok = del.statusCode === 200 && data.code === 0
  console.log('[lexiang] 学习记忆删除知识点:', normalizeSubject(subject), target, '块数', ids.length, ok ? '成功' : '失败')
  return { ok, error: ok ? '' : describeError(data) }
}

// ==================== 业务方法 ====================

// 机器可读块的前缀：错题状态、题库题目、设置参数都用它开头，
// 人读的文字块负责「看得懂」，带前缀的块负责「换手机后能还原成本地数据」
const MACHINE_TAG = '【机器】'

// 错题入库：创建 page + 写入文本块（科目目录不存在时自动创建）
const createWrongQuestion = async (item) => {
  const subject = normalizeSubject(item.subject)
  let cat = null
  try {
    cat = await ensureSubject(subject)
  } catch (e) {
    console.error('[lexiang] 准备科目目录失败:', e.message)
    return { ok: false, error: e.message }
  }
  const parentId = cat && cat.wrongId
  if (!parentId) {
    console.warn('[lexiang] 学科', subject, '无错题目录，跳过入库')
    return Promise.resolve({ ok: false, skipped: true })
  }
  // 名称过长会被乐享拒绝，知识点和题干都截断
  const title = '[' + String(item.knowledge || '未分类').slice(0, 20) + ']' + String(item.title || '错题').slice(0, 40)
  console.log('[lexiang] 错题入库:', title, '学科:', subject, '父目录:', parentId)
  return createEntry(title, 'page', parentId).then(r => {
    if (!r.ok) {
      console.warn('[lexiang] 错题创建页面失败:', title, describeError(r.error))
      return r
    }
    const entryId = r.entryId
    // 状态块的时间戳：回填时按它判断「云端这份」和「本地这份」谁更新，必须和写入时的值一致
    const stateAt = item.stateAt || util.formatTime(new Date())
    // 构造内容块
    const blocks = [
      headingBlock(2, title),
      textBlock(`学科：${item.subject}`),
      textBlock(`知识点：${item.knowledge || ''}`),
      textBlock(`题干：${item.question || ''}`),
      textBlock(`我的错误答案：${item.myAnswer || ''}`),
      textBlock(`正确答案：${item.correctAnswer || ''}`),
      textBlock(`错因分析：${item.analysis || ''}`),
      textBlock(`难度：${item.difficulty || ''}`),
      textBlock(`录入时间：${util.formatTime(new Date())}`),
      textBlock(`来源：${item.source || '拍照'}`),
      // 进度不再单独写人读行（那会变成永不更新的旧值），统一看页尾的机器行
      textBlock('进度与答题记录：见页尾【机器】行（程序同步用，数字以它为准）')
    ]
    // 建页前已经生成了 AI 思路的，一起写进去，后面不用再补
    if (item.aiSolution) {
      blocks.push(headingBlock(2, 'AI 解题思路'))
      blocks.push(textBlock(item.aiSolution))
    }
    // 状态块：连续正确次数、答题记录、状态都存这一行，换手机时靠它还原本地参数
    blocks.push(textBlock(MACHINE_TAG + JSON.stringify(wrongStatePayload(item, stateAt))))
    return createBlocks(entryId, blocks).then(br => ({ ok: br.ok, entryId, stateAt }))
  })
}

// 更新错题练习记录（追加一条记录块）
const updateWrongRecord = (entryId, records, correctCount, status) => {
  const blocks = [
    textBlock(`--- 练习记录 ${util.formatTime(new Date())} ---`),
    textBlock(`状态：${status}，连续正确次数：${correctCount}`)
  ]
  if (records && records.length) {
    records.forEach(rec => {
      blocks.push(textBlock(`${rec.time || ''}：${rec.result || ''}`))
    })
  }
  return createBlocks(entryId, blocks)
}

// 把 AI 解题思路追加到已建好的错题页面（后台补齐用，不重建页面）
const appendSolution = (entryId, solution, updatedAt) => {
  if (!entryId) return Promise.resolve({ ok: false, error: '缺少 entryId' })
  if (!solution) return Promise.resolve({ ok: false, error: '解题思路为空' })
  const blocks = [
    headingBlock(2, 'AI 解题思路'),
    textBlock(`思路时间：${updatedAt || util.formatTime(new Date())}`),
    textBlock(solution)
  ]
  return createBlocks(entryId, blocks).then(r => {
    if (!r.ok) console.warn('[lexiang] 解题思路写入失败:', entryId, describeError(r.data || r.error))
    return { ok: r.ok, data: r.data }
  })
}

// 错题消退：清空云端错题页面的内容块，页面文件本身保留（乐享无删除节点 API）
const clearWrongContent = (entryId) => {
  if (!entryId) return Promise.resolve({ ok: false, error: '缺少 entryId' })
  return deleteAllBlocks(entryId).then(r => {
    if (!r.ok) console.warn('[lexiang] 清空错题内容失败:', entryId, describeError(r.data || r.error))
    else console.log('[lexiang] 错题内容已清空（文件保留）:', entryId)
    return r
  })
}

// ==================== 题库（每科一个「题库」页，每题一个块） ====================
// 出题服务在本地缓存题池，这里负责把它镜像到乐享：补题追加块、用掉的题按块 id 删除。
// 为什么不是「每题一个页面」：乐享没有删除节点的 API，页面删不掉会在题库文件夹里留一堆空壳。

const BANK_TAG = MACHINE_TAG

// 从块结构里取纯文本（不同接口版本字段略有差异，都兼容一下）
const extractBlockText = (b) => {
  if (!b) return ''
  // 段落是 text，标题块的字段名是 heading1~heading6（不是 text），两种都要认，
  // 否则标题文字会读成空串（学习记忆按标题去重会失效，错题页的「AI 解题思路」也识别不到）
  const t = b.text || b.heading1 || b.heading2 || b.heading3 || b.heading4 || b.heading5 || b.heading6
  if (!t) return ''
  const els = t.elements || []
  const joined = els.map(e => (e && e.text_run && e.text_run.content) || (e && e.content) || '').join('')
  if (joined) return joined
  return typeof t.content === 'string' ? t.content : ''
}

// 块内容 = 人能看懂的一段 + 一行机器可读 JSON（取题时只读 JSON）
const bankBlockText = (item) => {
  const lines = [
    '【知识点】' + (item.knowledge || ''),
    '【题目】' + (item.question || ''),
    '【答案】' + (item.answer || '')
  ]
  if (item.options && item.options.length) lines.push('【选项】' + item.options.join(' / '))
  if (item.explanation) lines.push('【解析】' + item.explanation)
  const payload = {
    qid: item.qid,
    subject: item.subject,
    knowledge: item.knowledge || '',
    question: item.question || '',
    answer: item.answer || '',
    explanation: item.explanation || '',
    options: item.options || [],
    figure: item.figure || null,
    type: item.type || 'short',
    difficulty: item.difficulty || '',
    wrongId: item.wrongId || '',
    createdAt: item.createdAt || ''
  }
  return lines.join('\n') + '\n' + BANK_TAG + JSON.stringify(payload)
}

const parseBankBlock = (text) => {
  const s = String(text || '')
  const idx = s.lastIndexOf(BANK_TAG)
  if (idx < 0) return null
  try {
    const obj = JSON.parse(s.slice(idx + BANK_TAG.length).trim())
    return obj && obj.qid ? obj : null
  } catch (e) {
    return null
  }
}

// 按 block_id 删除指定块（题库踢题用；整页清空是 deleteAllBlocks）
const deleteBlocksByIds = (entryId, ids) => {
  const list = (ids || []).filter(Boolean)
  if (!entryId || !list.length) return Promise.resolve({ ok: true })
  const query = list.map(id => 'ids=' + encodeURIComponent(id)).join('&')
  return apiRequest('DELETE', '/kb/page/entries/' + entryId + '/blocks/children', undefined, query)
    .then(res => {
      const data = parseRes(res)
      return { ok: res.statusCode === 200 && data.code === 0, data }
    })
}

const getBankEntryId = async (subject) => {
  const cat = await ensureSubject(subject)
  return (cat && cat.bankId) || ''
}

// 读取题库页面里的全部待用题（返回的每项带 blockId）
const listBankQuestions = async (subject) => {
  if (!isConfigured()) return { ok: false, items: [], error: '乐享未配置' }
  let bankId = ''
  try {
    bankId = await getBankEntryId(subject)
  } catch (e) {
    return { ok: false, items: [], error: (e && e.message) || '题库不可用' }
  }
  if (!bankId) return { ok: false, items: [], error: '未找到题库页面' }
  const r = await getBlocks(bankId)
  if (!r.ok) return { ok: false, items: [], error: '读取题库失败', entryId: bankId }
  const items = []
  ;(r.blocks || []).forEach(b => {
    const obj = parseBankBlock(extractBlockText(b))
    if (obj) items.push(Object.assign({}, obj, { blockId: b.block_id }))
  })
  return { ok: true, items, entryId: bankId }
}

// 补题：把新题追加进题库页面，并回填每道题的 blockId（后续踢出要用）
const appendBankQuestions = async (subject, items) => {
  const list = (items || []).filter(it => it && it.qid)
  if (!list.length) return { ok: true, added: [] }
  if (!isConfigured()) return { ok: false, error: '乐享未配置', added: [] }
  let bankId = ''
  try {
    bankId = await getBankEntryId(subject)
  } catch (e) {
    return { ok: false, error: (e && e.message) || '题库不可用', added: [] }
  }
  if (!bankId) return { ok: false, error: '未找到题库页面', added: [] }
  const w = await createBlocks(bankId, list.map(it => textBlock(bankBlockText(it))))
  if (!w.ok) return { ok: false, error: describeError(w.data), added: [] }
  // 创建接口不保证回传块 id，统一读一次块列表按 qid 对齐
  const listed = await listBankQuestions(subject)
  const map = {}
  ;(listed.items || []).forEach(it => { if (it.qid) map[it.qid] = it.blockId })
  const added = list.map(it => ({ qid: it.qid, blockId: map[it.qid] || '' }))
  console.log('[lexiang] 题库补题:', normalizeSubject(subject), '新增', added.length, '道')
  return { ok: true, added, entryId: bankId }
}

// 踢题：把已经出掉的题从题库页面删掉
const deleteBankQuestions = async (subject, blockIds) => {
  const ids = (blockIds || []).filter(Boolean)
  if (!ids.length) return { ok: true }
  if (!isConfigured()) return { ok: false, error: '乐享未配置' }
  let bankId = ''
  try {
    bankId = await getBankEntryId(subject)
  } catch (e) {
    return { ok: false, error: (e && e.message) || '题库不可用' }
  }
  if (!bankId) return { ok: false, error: '未找到题库页面' }
  const r = await deleteBlocksByIds(bankId, ids)
  if (!r.ok) console.warn('[lexiang] 踢出题库失败:', normalizeSubject(subject), describeError(r.data))
  return r
}

// 搜索（乐享无关键词搜索 API，返回空）
const search = (keyword) => {
  return Promise.resolve({ ok: true, data: [] })
}

// 读取学习记忆（markdown 内容）
// memoryId 优先取目录缓存：动态新建的科目（科学、历史…）不在 config 里，也能读到页面
const getMemory = (subject) => {
  const name = normalizeSubject(subject)
  const cached = getCatalogCache()[name]
  const memoryId = (cached && cached.memoryId) || (config.LEXIANG.subjects[name] || {}).memoryId
  if (!memoryId) return Promise.resolve(null)
  return getEntryContent(memoryId).then(r => r.ok ? r.content : null)
}

// 学习记忆写入：只做增量追加，绝不删除页面已有内容
// （2026-10-26 事故复盘：旧实现是 deleteAllBlocks + 写一条 JSON，每次自动同步都会把归档进去的知识点全冲掉）
// content 支持 JSON（{weakPoints:[...]}）或 Markdown（### 标题）；已存在的知识点直接跳过（去重）
const updateMemory = async (subject, content) => {
  const name = normalizeSubject(subject)
  const cached = getCatalogCache()[name]
  const memoryId = (cached && cached.memoryId) || (config.LEXIANG.subjects[name] || {}).memoryId
  if (!memoryId) return { ok: false, error: '无 memoryId' }
  const points = parseMemoryPoints(content)
  if (!points.length) return { ok: true, appended: 0 }
  const r = await getBlocks(memoryId)
  if (!r.ok) return { ok: false, error: '读取学习记忆块失败' }
  const existing = (r.blocks || [])
    .filter(b => /^h[1-6]$/.test(String((b && b.block_type) || '')))
    .map(b => normPoint(extractBlockText(b)))
  const fresh = points.filter(p => existing.indexOf(normPoint(p)) < 0)
  if (!fresh.length) {
    console.log('[lexiang] 学习记忆知识点都已存在，跳过写入:', name)
    return { ok: true, appended: 0 }
  }
  const add = []
  fresh.forEach(p => {
    add.push(headingBlock(3, p), textBlock('（由本地学习记忆补录，讲解待补充）'), textBlock('记录时间：' + util.formatTime(new Date())))
  })
  const w = await createBlocks(memoryId, add)
  console.log('[lexiang] 学习记忆增量补录知识点:', name, w.ok ? fresh.length + ' 条' : '失败')
  return { ok: w.ok, appended: w.ok ? fresh.length : 0, error: w.ok ? '' : describeError(w.data) }
}

// 读取身份和习惯
const getIdentity = () => {
  return getEntryContent(config.LEXIANG.identityEntryId).then(r => r.ok ? r.content : null)
}

// 去掉空白与标点，便于比对「同一件事换个说法」
const normalizeIdentityText = (s) => String(s || '').replace(/[\s，。、；：！？,.!?;:()（）\[\]【】\-—_*#]/g, '')

// 判断某条记忆是否已被页面覆盖：先整句包含，再用中文 2-gram 覆盖率兜底
const identityTextCovered = (line, existing) => {
  const a = normalizeIdentityText(line)
  if (!a) return true
  if (existing.indexOf(a) !== -1) return true
  let hit = 0
  let total = 0
  for (let i = 0; i < a.length - 1; i++) {
    total++
    if (existing.indexOf(a.substring(i, i + 2)) !== -1) hit++
  }
  return total > 0 && hit / total >= 0.7
}

// 更新身份和习惯：只追加新条目，绝不删除页面已有内容
// 注意：早期实现是「清空所有块再写一条 JSON」，会把用户在乐享手写的预设内容整页覆盖掉（2026-10-25 出过事故）
const updateIdentity = async (content) => {
  const text = String(content || '').trim()
  if (!text) return { ok: true, appended: 0 }
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  if (!lines.length) return { ok: true, appended: 0 }
  const r = await getBlocks(config.LEXIANG.identityEntryId)
  if (!r.ok) return { ok: false, appended: 0, error: '读取身份和习惯页面失败' }
  const existing = normalizeIdentityText((r.blocks || []).map(extractBlockText).join('\n'))
  // 已写过的条目跳过，避免每次同步都堆重复段落
  const fresh = lines.filter(line => !identityTextCovered(line, existing))
  if (!fresh.length) {
    console.log('[lexiang] 身份和习惯无新增条目，跳过写入')
    return { ok: true, appended: 0 }
  }
  const res = await createBlocks(config.LEXIANG.identityEntryId, fresh.map(textBlock))
  if (!res.ok) console.warn('[lexiang] 身份和习惯追加失败:', describeError(res.data))
  return { ok: res.ok, appended: res.ok ? fresh.length : 0, error: res.ok ? '' : describeError(res.data) }
}

// 保存会话记录（创建 page）
const saveSession = (sessionName, content) => {
  return createEntry(sessionName, 'page', config.LEXIANG.sessionEntryId).then(r => {
    if (!r.ok) return r
    return createBlocks(r.entryId, [textBlock(content)])
  })
}

// 归档错题（乐享无移动节点 API，仅打标记，本地处理）
const archiveWrong = (entryId, archiveFolderId) => {
  // 官方 API 暂未提供节点移动接口，此处仅标记成功（归档逻辑在本地存储处理）
  return Promise.resolve({ ok: true, archived: true })
}

// 升年级：创建新年级目录
const createGradeFolder = (gradeName) => {
  return createEntry(gradeName, 'folder', config.LEXIANG.rootEntryId)
}

// 移动错题到新年级（官方无移动 API，返回成功由本地处理）
const moveEntry = (entryId, targetParentId) => {
  return Promise.resolve({ ok: true, moved: true })
}

// ==================== 错题「参数」上云与回填 ====================
// 错题页里的文字块是给人看的；连续正确次数、答题记录这类「参数」另外写一行
// 「【机器】{JSON}」块，换手机时按它恢复本地数据（乐享页面是权威副本，本地只是缓存）。

const WRONG_RECORD_LIMIT = 30           // 云端只留最近 30 条答题记录，避免块文本无限变长
const WRONG_PULL_TTL = 30 * 60 * 1000   // 同一科两次回填的最小间隔（持久化，冷启动也算）
const WRONG_PULL_MAX_PAGES = 80         // 单科一次最多读这么多错题页，别一次打满接口
const WRONG_PULL_KEY = 'ct_lx_wrongpull' // { 科目: 上次回填时间戳 }
const wrongPulling = {}

const getWrongPullStamps = () => storage.get(WRONG_PULL_KEY, {}) || {}
const markWrongPulled = (name) => {
  const map = getWrongPullStamps()
  map[name] = Date.now()
  storage.set(WRONG_PULL_KEY, map)
}

// 写进状态块的内容（云端唯一的一份「参数」）
// stateAt / updatedAt 是同一个值：两台设备靠它比谁新（不能只比次数，
// 答错会把次数清零，只看大小会把「清零」判成旧数据）
const wrongStatePayload = (item = {}, stateAt) => {
  const at = stateAt || item.stateAt || util.formatTime(new Date())
  return {
    correctCount: item.correctCount || 0,
    status: item.status || '在册',
    fadedAt: item.fadedAt || '',
    fadeReason: item.fadeReason || '',
    records: Array.isArray(item.records) ? item.records.slice(-WRONG_RECORD_LIMIT) : [],
    stateAt: at,
    updatedAt: at
  }
}

// 题干归一化（回填时按它判断「云端这页是不是本地已有那道题」）
const wrongQuestionKey = (q) => String(q || '')
  .replace(/\s/g, '')
  .replace(/[，。！？、,.!?；;：:'"“”‘’（）()【】\[\]]/g, '')
  .toLowerCase()
  .slice(0, 60)

// 页面里找「【机器】」开头的块（题库题、错题状态、设置参数共用）
const findMachineBlock = (blocks) => (blocks || []).find(b => {
  return String(extractBlockText(b) || '').trim().indexOf(MACHINE_TAG) === 0
}) || null

const parseMachineBlock = (block) => {
  const text = String(extractBlockText(block) || '').trim()
  if (text.indexOf(MACHINE_TAG) !== 0) return null
  try {
    return JSON.parse(text.slice(MACHINE_TAG.length).trim())
  } catch (e) {
    return null
  }
}

// 答题后更新错题页的状态块：有就改那一行，旧题页没有就追加一行（绝不删原文）
// 返回 stateAt：调用方据此判断「这次写入之后本地是否还有更新的答题」
const updateWrongState = async (entryId, item, stateAt) => {
  if (!entryId) return { ok: false, error: '缺少 entryId' }
  if (!item) return { ok: false, error: '缺少错题数据' }
  const at = stateAt || item.stateAt || util.formatTime(new Date())
  const payload = MACHINE_TAG + JSON.stringify(wrongStatePayload(item, at))
  const r = await getBlocks(entryId)
  if (!r.ok) return { ok: false, error: '读取错题页失败', stateAt: at }
  const hit = findMachineBlock(r.blocks || [])
  // 每题只写一次：状态块是唯一权威（人读的「状态 / 连续正确次数」只在建页时写快照，不再刷新）
  if (hit && hit.block_id) {
    const u = await updateBlockText(entryId, hit.block_id, payload)
    return { ok: u.ok, action: 'updated', stateAt: at, error: u.ok ? '' : describeError(u.data) }
  }
  // 老题页没有状态块：只追加，不删原文
  const c = await createBlocks(entryId, [textBlock(payload)])
  return { ok: c.ok, action: 'appended', stateAt: at, error: c.ok ? '' : describeError(c.data) }
}

// 从云端错题页还原一条本地错题；页面已被清空（已消退）时返回 null
const parseWrongPage = (entryId, pageName, blocks) => {
  const list = blocks || []
  const hasText = list.some(b => !!String(extractBlockText(b) || '').trim())
  if (!hasText) return null
  const item = {
    id: 'lx_' + entryId,
    entryId,
    synced: true,
    verifiedAt: util.formatTime(new Date()),
    status: '在册',
    correctCount: 0,
    records: [],
    title: '错题',
    createdAt: '',
    aiSolution: '',
    solutionSynced: false
  }
  const pageTitle = String(pageName || '').trim()
  const headingMatch = /^\[([^\]]*)\]\s*(.*)$/.exec(pageTitle)
  if (headingMatch) {
    item.knowledge = headingMatch[1].trim() || '未分类知识点'
    item.title = item.knowledge
  } else if (pageTitle) {
    // 老页面没有 [知识点] 前缀：标题就是页面名，知识点另有文字块
    item.title = pageTitle
  }
  const solution = []
  let inSolution = false
  list.forEach(b => {
    const type = String((b && b.block_type) || '')
    const raw = String(extractBlockText(b) || '').trim()
    if (!raw) return
    const machine = parseMachineBlock(b)
    if (machine) {
      // 有机器块 = 云端已经存了参数，不用再迁移
      item.stateSynced = true
      if (typeof machine.correctCount === 'number') item.correctCount = machine.correctCount
      if (machine.status) item.status = machine.status
      if (machine.fadedAt) item.fadedAt = machine.fadedAt
      if (machine.fadeReason) item.fadeReason = machine.fadeReason
      if (Array.isArray(machine.records)) item.records = machine.records
      // 云端这份参数的时间戳：回填时和本地 stateAt 比谁新
      const at = String(machine.stateAt || machine.updatedAt || '')
      if (at) item.stateAt = at
      return
    }
    if (/^h[1-6]$/.test(type) && raw === 'AI 解题思路') {
      inSolution = true
      return
    }
    if (inSolution) {
      if (!/^思路时间[：:]/.test(raw)) solution.push(raw)
      return
    }
    const m = /^(学科|知识点|题干|我的错误答案|正确答案|错因分析|难度|录入时间|来源)[：:]\s*([\s\S]*)$/.exec(raw)
    if (!m) return
    const v = m[2].trim()
    if (m[1] === '学科') item.subject = v
    else if (m[1] === '知识点') item.knowledge = item.knowledge || v
    else if (m[1] === '题干') item.question = v
    else if (m[1] === '我的错误答案') item.myAnswer = v
    else if (m[1] === '正确答案') item.correctAnswer = v
    else if (m[1] === '错因分析') item.analysis = v
    else if (m[1] === '难度') item.difficulty = v
    else if (m[1] === '录入时间') item.createdAt = v
    else if (m[1] === '来源') item.source = v
  })
  if (!item.question) return null
  if (solution.length) {
    item.aiSolution = solution.join('\n')
    item.solutionSynced = true
  }
  return item
}

const getWrongFolderId = (name) => {
  const cached = getCatalogCache()[name]
  return (cached && cached.wrongId) || (config.LEXIANG.subjects[name] || {}).wrongId || ''
}

// 云端「错题」目录 → 本地：本地没有的题补进来（带 entryId，不会再重复建页）；
// 本地已有的题按 stateAt 比新旧（云端新就跟随云端，本地新就标脏待重推）。
// 换设备后消退次数不一致的根因就在这里：以前只在本地次数为 0 时才采纳云端值，
// 本地显示 1/5 而云端还是 0/5 时两边永远对不上。
const syncWrongFromCloud = async (subject, opts = {}) => {
  if (!isConfigured()) return { ok: false, skipped: '乐享未配置', added: 0 }
  const name = normalizeSubject(subject)
  if (!name || name === ALL_SUBJECT) return { ok: false, skipped: '无学科', added: 0 }
  const maxAge = Number(opts.maxAge) > 0 ? Number(opts.maxAge) : WRONG_PULL_TTL
  if (!opts.force) {
    const last = getWrongPullStamps()[name]
    if (last && Date.now() - last < maxAge) {
      return { ok: true, skipped: '刚回填过', added: 0 }
    }
  }
  if (wrongPulling[name]) return wrongPulling[name]
  const folderId = getWrongFolderId(name)
  if (!folderId) return Promise.resolve({ ok: true, skipped: '云端没有该科错题目录', added: 0 })

  wrongPulling[name] = (async () => {
    try {
      markWrongPulled(name)
      const r = await listChildren(folderId, { page_size: 100 })
      if (!r.ok) return { ok: false, error: '读取错题目录失败', added: 0 }
      const pages = (r.data || []).filter(it => {
        const a = it.attributes || {}
        const type = String(a.entry_type || it.entry_type || '').toLowerCase()
        return !type || type.indexOf('page') >= 0
      }).slice(0, WRONG_PULL_MAX_PAGES)
      if (!pages.length) return { ok: true, added: 0, total: 0 }

      const local = storage.getWrongbook() || []
      const byEntry = {}
      const byQuestion = {}
      local.forEach(w => {
        if (!w) return
        if (w.entryId) byEntry[w.entryId] = w
        const q = wrongQuestionKey(w.question)
        if (q) byQuestion[q] = w
      })

      const fresh = []
      const pending = []   // 本地次数比云端新的题：回填完立刻补写云端
      const touchedItems = [] // 这次回填改过的本地老题（落盘时按字段并到最新那条）
      let merged = 0
      let empty = 0
      let failed = 0
      for (const it of pages) {
        const entryId = it.id || (it.attributes && it.attributes.id)
        if (!entryId) continue
        const pageName = (it.attributes && it.attributes.name) || it.name || ''
        const br = await getBlocks(entryId)
        if (!br.ok) {
          failed++
          continue
        }
        const parsed = parseWrongPage(entryId, pageName, br.blocks)
        // 页面内容被清空 / 已经消退的题不拉回来（消退是终态，拉回来会复活）
        if (!parsed || parsed.status === '已消退' || parsed.status === '已归档') {
          empty++
          continue
        }
        parsed.subject = normalizeSubject(parsed.subject || name)
        if (!parsed.knowledge) parsed.knowledge = '未分类知识点'
        if (!parsed.title) parsed.title = parsed.knowledge
        const q = wrongQuestionKey(parsed.question)
        const exist = byEntry[entryId] || (q ? byQuestion[q] : null)
        if (exist) {
          let changed = false
          if (!exist.entryId) { exist.entryId = entryId; changed = true }
          if (!exist.synced) { exist.synced = true; changed = true }
          // 「次数 / 状态 / 记录」看时间戳：谁更新听谁的
          const localAt = String(exist.stateAt || '')
          const cloudAt = String(parsed.stateAt || '')
          const localCount = exist.correctCount || 0
          const cloudCount = parsed.correctCount || 0
          let takeCloud
          if (localAt && cloudAt) takeCloud = cloudAt > localAt
          // 本地没有时间戳（老数据）：云端不落后就跟随云端，云端落后说明本地次数更可信
          else if (cloudAt) takeCloud = cloudCount >= localCount
          else takeCloud = false
          if (takeCloud) {
            if (localCount !== cloudCount) { exist.correctCount = cloudCount; changed = true }
            if (parsed.status && exist.status !== parsed.status) { exist.status = parsed.status; changed = true }
            if (parsed.fadedAt && exist.fadedAt !== parsed.fadedAt) { exist.fadedAt = parsed.fadedAt; changed = true }
            if (parsed.fadeReason && exist.fadeReason !== parsed.fadeReason) { exist.fadeReason = parsed.fadeReason; changed = true }
            if (parsed.records && parsed.records.length) { exist.records = parsed.records; changed = true }
            if (cloudAt && exist.stateAt !== cloudAt) { exist.stateAt = cloudAt; changed = true }
            exist.stateSynced = true
          } else if (cloudCount !== localCount || (!exist.stateSynced && (localCount || (exist.records || []).length))) {
            // 本地更新（或上次云端写入失败还留着脏标记）：重推云端
            if (!exist.stateAt) exist.stateAt = util.formatTime(new Date())
            exist.stateSynced = false
            changed = true
            pending.push(exist)
          }
          if (!exist.aiSolution && parsed.aiSolution) {
            exist.aiSolution = parsed.aiSolution
            exist.solutionSynced = true
            changed = true
          }
          if (changed) { merged++; touchedItems.push(exist) }
          continue
        }
        fresh.push(parsed)
        byEntry[entryId] = parsed
        if (q) byQuestion[q] = parsed
      }

      // 本地更新但云端落后的：立刻补写云端（回填已经读到状态块，这里只多一次 PUT），
      // 免得另一台设备下一次拉到的还是旧次数
      let pushed = 0
      for (const it of pending.slice(0, 10)) {
        const newest = (storage.getWrongbook() || []).find(w => w && w.id === it.id)
        // 回填期间本地又答了题（时间戳更新）：那次自己会写云端，别用旧快照盖上去
        if (newest && newest.stateAt && it.stateAt && String(newest.stateAt) > String(it.stateAt)) continue
        const target = newest || it
        const ur = await updateWrongState(target.entryId || it.entryId, target, target.stateAt)
        if (ur && ur.ok) {
          it.stateSynced = true
          if (ur.stateAt) it.stateAt = ur.stateAt
          pushed++
        } else {
          failed++
        }
      }

      // 落盘：回填期间本地可能又答了题，只把「回填改动的字段」并到最新那条上，
      // 整页用旧快照覆盖会把刚答出来的次数冲掉
      if (fresh.length || merged) {
        const latest = storage.getWrongbook() || []
        const byId = {}
        latest.forEach(w => { if (w && w.id) byId[w.id] = w })
        touchedItems.forEach(w => {
          const cur = byId[w.id]
          if (!cur) return
          if (cur.stateAt && w.stateAt && String(cur.stateAt) > String(w.stateAt)) return
          if (!cur.entryId && w.entryId) cur.entryId = w.entryId
          if (!cur.synced && w.synced) cur.synced = true
          cur.correctCount = w.correctCount || 0
          if (w.status) cur.status = w.status
          if (w.fadedAt !== undefined && w.fadedAt) cur.fadedAt = w.fadedAt
          if (w.fadeReason !== undefined && w.fadeReason) cur.fadeReason = w.fadeReason
          if (Array.isArray(w.records) && w.records.length) cur.records = w.records
          if (w.stateAt) cur.stateAt = w.stateAt
          if (w.stateSynced !== undefined) cur.stateSynced = w.stateSynced
          if (w.aiSolution && !cur.aiSolution) { cur.aiSolution = w.aiSolution; cur.solutionSynced = true }
        })
        storage.setWrongbook(latest.concat(fresh))
      }
      console.log('[lexiang] 错题回填:', name, '新增', fresh.length, '补参数', merged, '重推', pushed, '空页/已消退', empty, '失败', failed)
      return { ok: true, added: fresh.length, merged, pushed, total: pages.length, failed }
    } catch (e) {
      console.warn('[lexiang] 错题回填失败:', name, (e && e.message) || e)
      return { ok: false, error: (e && e.message) || '错题回填失败', added: 0 }
    }
  })()
  wrongPulling[name].then(() => { delete wrongPulling[name] }).catch(() => { delete wrongPulling[name] })
  return wrongPulling[name]
}

// ==================== 显示设置同步 ====================
// 只同步「用户可调」的显示项：字号、夜间模式。
// 消退阈值（5）、闯关题量（5）、教材（英语沪教版 / 其余人教版）写在 utils/config.js，
// 写死不参与同步；模型连接里的 API Key 同样不写云端（密钥不进知识库）。

const SETTINGS_PAGE_NAME = '设置'
const SETTINGS_CACHE_KEY = 'ct_lx_settings_entry'
// 只同步「用户可调」的显示项。消退阈值 / 闯关题量 / 教材已写死在 utils/config.js，
// 不再上传也不读取（云端旧块里残留的这几个字段会被忽略）
const SETTINGS_FIELDS = ['fontSize', 'darkMode']

// 乐享根级单页（设置 / 学习进度）：没有就建一个，只需一块机器文本，不占知识库目录。
// 只认 page：同名文件夹不能当目标（往文件夹上读块会失败）
const getRootPageId = async (name, cacheKey, opts = {}) => {
  if (!opts.force) {
    const cached = storage.get(cacheKey, '')
    if (cached) return cached
  }
  const r = await listChildren(config.LEXIANG.rootEntryId, { page_size: 100 })
  if (r.ok) {
    const hit = (r.data || []).find(it => {
      const a = it.attributes || {}
      const type = String(a.entry_type || it.entry_type || '').toLowerCase()
      return String(a.name || '').trim() === name && type.indexOf('folder') < 0
    })
    if (hit) {
      const id = hit.id || (hit.attributes && hit.attributes.id)
      if (id) {
        storage.set(cacheKey, id)
        return id
      }
    }
  }
  const created = await createEntry(name, 'page', config.LEXIANG.rootEntryId)
  if (!created.ok) throw new Error('创建「' + name + '」页面失败：' + describeError(created.error))
  console.log('[lexiang] 新建根级页面:', name, created.entryId)
  storage.set(cacheKey, created.entryId)
  return created.entryId
}

const getSettingsEntryId = (opts = {}) => getRootPageId(SETTINGS_PAGE_NAME, SETTINGS_CACHE_KEY, opts)

const pickSettings = (cfg = {}, rev) => {
  const out = {}
  SETTINGS_FIELDS.forEach(k => { if (cfg[k] !== undefined) out[k] = cfg[k] })
  // rev 是「第几次修改」的序号：跨设备判新旧只看它，不看手机时钟（两台设备时间不一致也不会判错）
  out.rev = Number(rev || (Number(cfg.settingsCloudRev || 0) + 1))
  out.updatedAt = cfg.settingsUpdatedAt || util.formatTime(new Date())
  return out
}

const readSettings = async () => {
  if (!isConfigured()) return { ok: false, error: '乐享未配置' }
  try {
    const entryId = await getSettingsEntryId()
    const r = await getBlocks(entryId)
    if (!r.ok) {
      // 缓存的 entryId 可能已在乐享里被删：清掉缓存，下次自动重建页面
      storage.set(SETTINGS_CACHE_KEY, '')
      return { ok: false, error: '读取设置页面失败' }
    }
    const block = findMachineBlock(r.blocks)
    return { ok: true, entryId, data: block ? parseMachineBlock(block) : null }
  } catch (e) {
    return { ok: false, error: (e && e.message) || '读取设置失败' }
  }
}

const writeSettings = async (cfg, rev) => {
  if (!isConfigured()) return { ok: false, error: '乐享未配置' }
  const payload = MACHINE_TAG + JSON.stringify(pickSettings(cfg, rev))
  try {
    const entryId = await getSettingsEntryId()
    const r = await getBlocks(entryId)
    if (!r.ok) {
      storage.set(SETTINGS_CACHE_KEY, '')
      return { ok: false, error: '读取设置页面失败' }
    }
    const block = findMachineBlock(r.blocks)
    if (block && block.block_id) {
      const u = await updateBlockText(entryId, block.block_id, payload)
      return { ok: u.ok, entryId, action: 'updated', error: u.ok ? '' : describeError(u.data) }
    }
    const c = await createBlocks(entryId, [textBlock(payload)])
    return { ok: c.ok, entryId, action: 'created', error: c.ok ? '' : describeError(c.data) }
  } catch (e) {
    return { ok: false, error: (e && e.message) || '写入设置失败' }
  }
}

// 云端参数落到 globalData，页面立刻按新字号 / 夜间模式重绘；
// 设置页自己实现 onSettingsUpdated() 时会收到回调，界面数值跟着刷新（不同设备显示一致）
const applySettingsToApp = (patch = {}) => {
  try {
    const app = getApp()
    if (app && app.globalData) {
      SETTINGS_FIELDS.forEach(k => {
        if (patch[k] !== undefined) app.globalData[k] = patch[k]
      })
      if (typeof app.applyDisplaySettings === 'function') app.applyDisplaySettings()
    }
  } catch (e) {}
  try {
    getCurrentPages().forEach(p => {
      if (p && typeof p.onSettingsUpdated === 'function') {
        try { p.onSettingsUpdated(patch) } catch (e) {}
      }
    })
  } catch (e) {}
}

// 本机参数上传：rev 在云端版本号上 +1，成功后把 rev 记成基线并清脏。
// 判新旧只看 rev（修改次数），完全不依赖手机时钟，两台设备时间差几小时也不会判错。
const doUploadSettings = async (opts = {}) => {
  if (!isConfigured()) return { ok: false, skipped: '乐享未配置' }
  const cfg = storage.getConfig()
  const prevRev = Number(cfg.settingsCloudRev || 0)
  const prevDirty = cfg.settingsDirty

  let cloudRev = 0
  if (opts.cloud) {
    cloudRev = Number(opts.cloud.rev || 0)
  } else {
    const remote = await readSettings()
    if (remote.ok && remote.data) cloudRev = Number(remote.data.rev || 0)
  }
  const rev = cloudRev + 1

  cfg.settingsUpdatedAt = util.formatTime(new Date())
  cfg.settingsCloudRev = rev
  cfg.settingsDirty = false
  storage.setConfig(cfg)

  const w = await writeSettings(cfg, rev)
  if (w.ok) {
    console.log('[lexiang] 设置参数已上传: rev', rev, w.action)
  } else {
    // 上传失败：版本基线回滚、保持「本机已改」，等下次同步重试（不要假装修好了）
    const cur = storage.getConfig()
    cur.settingsCloudRev = prevRev
    cur.settingsDirty = prevDirty === undefined ? true : prevDirty
    storage.setConfig(cur)
    console.warn('[lexiang] 设置参数上传失败:', w.error || '未知错误')
  }
  return w
}

// 排队执行：连拖两次滑块时两次上传会串起来，第二次读到的 rev 已包含第一次，不会撞号
let settingsUploadChain = Promise.resolve()
const uploadSettings = (opts = {}) => {
  const run = () => doUploadSettings(opts).catch(e => {
    console.warn('[lexiang] 设置参数上传异常:', (e && e.message) || e)
    return { ok: false, error: (e && e.message) || '上传异常' }
  })
  settingsUploadChain = settingsUploadChain.then(run, run)
  return settingsUploadChain
}

// 云端参数覆盖本机（「取回云端参数」也走这里）
const applyCloudSettings = (cloud) => {
  const patch = {}
  SETTINGS_FIELDS.forEach(k => { if (cloud && cloud[k] !== undefined) patch[k] = cloud[k] })
  if (!Object.keys(patch).length) return { ok: true, skipped: '云端没有可用参数' }
  const cfg = storage.getConfig()
  Object.assign(cfg, patch, {
    settingsUpdatedAt: String(cloud.updatedAt || ''),
    settingsCloudRev: Number(cloud.rev || 0),
    settingsDirty: false
  })
  storage.setConfig(cfg)
  applySettingsToApp(patch)
  console.log('[lexiang] 设置参数已从云端拉回: rev', cfg.settingsCloudRev, JSON.stringify(patch))
  return { ok: true, applied: 'cloud', patch }
}

// 双向同步规则：
//   baseRev = 上次同步时云端的 rev（本机认识的最新版本）
//   dirty   = 本机自那之后改过（saveDisplayConfig 里置 true）
// 1) 云端没有参数                → 上传本机
// 2) 云端 rev === baseRev（没别人改）→ 本机脏就上传，否则一致
// 3) 云端 rev ≠ baseRev（别人改过）→ 跟随云端；本机改动被覆盖时会打日志提示，
//    确实想以本机为准就用设置页「上传本机参数」强制覆盖
const syncSettings = async (opts = {}) => {
  if (!isConfigured()) return { ok: false, skipped: '乐享未配置' }
  const remote = await readSettings()
  if (!remote.ok) return { ok: false, error: remote.error }
  const cloud = remote.data
  if (!cloud) return uploadSettings()

  const cfg = storage.getConfig()
  const baseRev = Number(cfg.settingsCloudRev || 0)
  // 老格式的云端块（升级前写的，没有 rev）不能当成 rev=0 与本机基线相等，
  // 否则两台设备都停在 rev 0 会一直「判定一致」而互相看不到对方的字号设置
  const hasRev = cloud.rev !== undefined && cloud.rev !== null && cloud.rev !== ''
  const cloudRev = hasRev ? (Number(cloud.rev) || 0) : -1
  // 老数据没有 settingsDirty：以前每次保存都写 settingsUpdatedAt，有值就当本机改过
  const dirty = cfg.settingsDirty === undefined ? !!cfg.settingsUpdatedAt : !!cfg.settingsDirty

  if (opts.prefer === 'cloud') return applyCloudSettings(cloud)
  if (!hasRev) {
    // 云端没有版本号：本机已有基线（说明之前正常同步过）就以本机为准补齐版本号；
    // 否则以云端老数据为准拉一次，并顺手升级成带 rev 的新格式（下次起按版本号比较）
    if (baseRev > 0) return uploadSettings({ cloud: { rev: baseRev } })
    const applied = applyCloudSettings(cloud)
    await uploadSettings({ cloud: { rev: 0 } })
    return applied
  }
  if (cloudRev === baseRev) {
    if (dirty) return uploadSettings({ cloud })
    return { ok: true, skipped: '本地与云端一致' }
  }
  if (dirty) console.warn('[lexiang] 云端参数已被其他设备修改，本机改动以云端为准（可用「上传本机参数」反向覆盖）')
  return applyCloudSettings(cloud)
}

// ==================== 学习进度页（知识点次数 / 成就统计） ====================
// 根级「学习进度」页面只存一行机器文本，内容由 services/progress.js 组织：
// { knowledge: { '学科::知识点': {c,s,u} }, achievements: {badges,stats} }
// 这里只负责读写那一行块，合并规则全在 progress.js（按条目取新，别在云端做整页覆盖）。

const PROGRESS_PAGE_NAME = '学习进度'
const PROGRESS_CACHE_KEY = 'ct_lx_progress_entry'

const getProgressEntryId = (opts = {}) => getRootPageId(PROGRESS_PAGE_NAME, PROGRESS_CACHE_KEY, opts)

const readProgress = async () => {
  if (!isConfigured()) return { ok: false, error: '乐享未配置' }
  try {
    const entryId = await getProgressEntryId()
    const r = await getBlocks(entryId)
    if (!r.ok) {
      // 页面可能已在乐享里被删：清缓存，下次重建
      storage.set(PROGRESS_CACHE_KEY, '')
      return { ok: false, error: '读取学习进度页面失败' }
    }
    const block = findMachineBlock(r.blocks)
    return { ok: true, entryId, data: block ? parseMachineBlock(block) : null }
  } catch (e) {
    return { ok: false, error: (e && e.message) || '读取学习进度失败' }
  }
}

const writeProgress = async (data) => {
  if (!isConfigured()) return { ok: false, error: '乐享未配置' }
  const payload = MACHINE_TAG + JSON.stringify(data || {})
  try {
    const entryId = await getProgressEntryId()
    const r = await getBlocks(entryId)
    if (!r.ok) {
      storage.set(PROGRESS_CACHE_KEY, '')
      return { ok: false, error: '读取学习进度页面失败' }
    }
    const block = findMachineBlock(r.blocks)
    if (block && block.block_id) {
      const u = await updateBlockText(entryId, block.block_id, payload)
      return { ok: u.ok, entryId, action: 'updated', error: u.ok ? '' : describeError(u.data) }
    }
    const c = await createBlocks(entryId, [textBlock(payload)])
    return { ok: c.ok, entryId, action: 'created', error: c.ok ? '' : describeError(c.data) }
  } catch (e) {
    return { ok: false, error: (e && e.message) || '写入学习进度失败' }
  }
}

// ==================== 全量同步 ====================

// 自动同步：进入小程序、完成闯关/练习、AI 记住内容时静默调用
// - 同一时间只跑一个同步任务
// - 默认 60 秒内不重复同步，避免多个页面同时触发
let autoSyncPromise = null
const AUTO_SYNC_KEY = 'ct_autosync_at'
const autoSync = (options = {}) => {
  if (autoSyncPromise) return autoSyncPromise
  if (!isConfigured()) return Promise.resolve({ ok: false, skipped: true, message: '乐享未配置' })
  const minGap = options.minGap !== undefined ? options.minGap : 60 * 1000
  const last = storage.get(AUTO_SYNC_KEY, 0) || 0
  if (!options.force && Date.now() - last < minGap) {
    return Promise.resolve({ ok: true, skipped: true, message: '刚刚已同步' })
  }
  storage.set(AUTO_SYNC_KEY, Date.now())
  console.log('[lexiang] 自动同步开始')
  autoSyncPromise = syncAll()
    .then(r => {
      console.log('[lexiang] 自动同步结果:', r.message)
      return r
    })
    .catch(e => {
      console.warn('[lexiang] 自动同步异常:', e && e.message)
      return { ok: false, skipped: true, message: '自动同步失败：' + ((e && e.message) || '未知错误') }
    })
  autoSyncPromise.then(() => { autoSyncPromise = null })
  return autoSyncPromise
}

const syncAll = async (options = {}) => {
  if (!isConfigured()) {
    return { ok: false, synced: 0, failed: 0, message: '乐享未配置，无法同步' }
  }
  let synced = 0
  let failed = 0
  let skipped = 0
  let touched = false
  let firstError = ''

  // 0. 先验证连接（拿不到 token 直接返回明确原因，不再逐条失败）
  try {
    await getAccessToken()
  } catch (e) {
    console.warn('[lexiang] 连接失败:', e.message)
    return { ok: false, synced: 0, failed: 0, message: '乐享连接失败：' + (e.message || '未知错误') }
  }
  console.log('[lexiang] 连接正常，开始同步，错题本共', (storage.getWrongbook() || []).length, '条')

  // 0.5 先刷新科目清单，后面的错题归档与记忆同步都用最新科目
  const subjRes = await refreshSubjects()
  if (!subjRes || !subjRes.ok) console.warn('[lexiang] 科目清单刷新失败:', subjRes && subjRes.message)

  // 1. 同步错题本
  const wrongbook = storage.getWrongbook() || []
  for (const item of wrongbook) {
    // 已消退 / 已归档的题不再上传，避免消退后又被重新建回云端
    if (item.status === '已消退' || item.status === '已归档') continue
    // 只有「标记已同步 + 有 entryId + 云端确实存在」才跳过；
    // 历史版本存在假同步标记，这里做一次校验，缺失的自动重传
    if (item.synced) {
      // verifiedAt：今天刚在回填里读到的云端页面，当天免验存在性（省一轮请求）
      const today = util.formatDate(new Date())
      const verifiedToday = !!item.verifiedAt && String(item.verifiedAt).indexOf(today) === 0
      const exists = verifiedToday ? true : (item.entryId ? await entryExists(item.entryId) : false)
      if (exists) {
        // 页面已在云端：只补后来生成的 AI 解题思路，其余不重复写
        if (item.aiSolution && !item.solutionSynced) {
          const sr = await appendSolution(item.entryId, item.aiSolution, item.aiSolutionAt)
          if (sr && sr.ok) {
            item.solutionSynced = true
            touched = true
            console.log('[lexiang] 解题思路已补写:', item.title || item.question)
          }
        }
        // 老题页还没有状态块（参数只在本机）/ 上次写入失败还留着脏标记：补写一次，
        // 换手机才不会丢次数与记录
        if (!item.stateSynced && (item.correctCount || (item.records && item.records.length))) {
          const ur = await updateWrongState(item.entryId, item, item.stateAt)
          if (ur && ur.ok) {
            item.stateSynced = true
            if (ur.stateAt) item.stateAt = ur.stateAt
            touched = true
            console.log('[lexiang] 错题参数已补写云端:', item.title || item.question)
          }
        }
        console.log('[lexiang] 跳过已同步错题:', item.title || item.question)
        continue
      }
      console.log('[lexiang] 检测到云端缺失，重新同步:', item.title || item.question)
      item.synced = false
    }
    try {
      console.log('[lexiang] 同步错题:', item.subject, '-', item.title || item.question)
      const res = await createWrongQuestion(item)
      if (res && res.ok) {
        console.log('[lexiang] 错题同步成功, entryId:', res.entryId)
        item.synced = true
        item.entryId = res.entryId
        // 建页时思路和状态块已经一起写进块里了
        if (item.aiSolution) item.solutionSynced = true
        item.stateSynced = true
        if (res.stateAt) item.stateAt = res.stateAt
        synced++
      } else if (res && res.skipped) {
        console.log('[lexiang] 错题跳过（学科无错题目录）:', item.subject)
        skipped++
      } else {
        console.error('[lexiang] 错题同步失败:', JSON.stringify(res && res.error ? res.error : res))
        if (!firstError) firstError = '错题「' + (item.title || '') + '」' + (res && res.error ? '：' + JSON.stringify(res.error) : '写入失败')
        failed++
      }
    } catch (e) {
      console.error('[lexiang] 错题同步异常:', e.message)
      if (!firstError) firstError = '错题「' + (item.title || '') + '」：' + e.message
      failed++
    }
  }
  if (synced > 0 || touched) {
    // 同步是异步慢慢跑的，期间本地可能有新内容（比如后台生成的 AI 思路），
    // 这里把同步标记合并到最新数据上再写回，避免旧快照覆盖新字段
    const latest = storage.getWrongbook() || []
    latest.forEach(w => {
      const cur = wrongbook.find(x => x && x.id === w.id)
      if (!cur) return
      w.synced = cur.synced
      if (cur.entryId) w.entryId = cur.entryId
      if (cur.solutionSynced) w.solutionSynced = true
      if (cur.stateSynced) w.stateSynced = true
      if (cur.stateAt) w.stateAt = cur.stateAt
    })
    storage.setWrongbook(latest)
  }

  // 2. 学习记忆：云端页面是权威副本，只做「云端 → 本地回填」，绝不反向覆盖云端
  // （反向上传曾把 appendMemory 追加进去的知识点整页冲掉，2026-10-26 事故）
  const subjects = getSyncedSubjects()

  // 1.5 错题「云端 → 本地」回填：换手机 / 清过缓存时，把云端错题页里的题和参数拉回来
  // （只读云端 + 写本地，云端一个字都不改；每科 30 分钟最多一次，手动同步强制）
  let pulledWrong = 0
  if (options.pullWrong !== false) {
    for (const subj of subjects) {
      try {
        const pr = await syncWrongFromCloud(subj, { force: !!options.force })
        if (pr && pr.added) {
          pulledWrong += pr.added
          synced += pr.added
        }
      } catch (e) {
        failed++
        if (!firstError) firstError = subj + '错题回填：' + ((e && e.message) || '未知错误')
      }
    }
    if (pulledWrong) console.log('[lexiang] 错题回填完成，新增', pulledWrong, '条')
  }

  for (const subj of subjects) {
    try {
      const md = await getMemory(subj)
      if (!md) {
        skipped++
        continue
      }
      // 统一走 memory.addPoints：同名去重 + 跳过已消退知识点
      // （旧实现在这里写了第二套合并逻辑，没过滤已消退的，会把消退掉的又塞回本地 weakPoints）
      const memory = require('./memory.js') // 延迟 require：memory 反向依赖本模块
      const added = memory.addPoints(subj, parseMemoryPoints(md))
      if (added) {
        synced++
        console.log('[lexiang] 学习记忆回填本地:', subj, added, '个知识点')
      } else {
        skipped++
      }
    } catch (e) {
      failed++
      if (!firstError) firstError = subj + '记忆读取：' + e.message
    }
  }

  // 3. 同步身份习惯（只把 content 里的条目追加到云端，不再塞 JSON、不再清空页面）
  const identity = storage.getIdentity()
  if (identity && (identity.content || identity.name)) {
    try {
      const res = await updateIdentity(identity.content)
      if (res && res.ok) {
        // 没有新条目就不算「同步项」，避免每次都报成功
        if (res.appended > 0) synced++
        else skipped++
      } else {
        failed++
        if (!firstError) firstError = '身份习惯写入失败'
      }
    } catch (e) {
      failed++
      if (!firstError) firstError = '身份习惯：' + e.message
    }
  }

  // 4. 显示设置（字号 / 夜间）：按 rev 版本号合并，阈值题量教材写死不参与
  try {
    const st = await syncSettings()
    if (st && st.applied) synced++
    else if (st && st.ok) skipped++
    else if (st && st.error) {
      failed++
      if (!firstError) firstError = '设置同步：' + st.error
    }
  } catch (e) {
    failed++
    if (!firstError) firstError = '设置同步：' + ((e && e.message) || '未知错误')
  }

  // 5. 学习进度（知识点累计次数 / 成就统计）：根级「学习进度」页双向合并
  // 延迟 require：progress.js 依赖本模块，写在顶部会形成循环引用
  try {
    const progress = require('./progress.js')
    const pg = await progress.syncFromCloud({ force: !!options.force })
    if (pg && pg.applied) synced++
    else if (pg && pg.ok) skipped++
    else if (pg && pg.error) {
      failed++
      if (!firstError) firstError = '学习进度：' + pg.error
    }
  } catch (e) {
    failed++
    if (!firstError) firstError = '学习进度：' + ((e && e.message) || '未知错误')
  }

  let message
  let ok
  if (failed > 0) {
    ok = false
    message = `同步完成：成功 ${synced} 项，失败 ${failed} 项（${firstError}）`
  } else if (synced === 0 && skipped > 0) {
    ok = true
    message = `同步完成：跳过 ${skipped} 项（该学科未配置错题目录）`
  } else if (synced === 0) {
    ok = true
    message = '没有需要同步的新内容'
  } else {
    ok = true
    message = skipped > 0 ? `已同步完成（成功 ${synced} 项，跳过 ${skipped} 项）` : `已同步完成（${synced} 项）`
  }
  console.log('[lexiang] 同步结果:', message)
  return { ok, synced, failed, message }
}

module.exports = {
  isConfigured,
  getAccessToken,
  createWrongQuestion,
  updateWrongRecord,
  appendSolution,
  clearWrongContent,
  updateWrongState,
  syncWrongFromCloud,
  listChildren,
  search,
  ARCHIVE_SUBJECTS,
  ALL_SUBJECT,
  SUBJECT_OPTIONS,
  getSyncedSubjects,
  getSubjectOptions,
  refreshSubjects,
  normalizeSubject,
  ensureSubject,
  ensureAllSubjects,
  BANK_PAGE_NAME,
  getBankEntryId,
  listBankQuestions,
  appendBankQuestions,
  deleteBankQuestions,
  appendMemory,
  removeMemoryPoint,
  parseMemoryPoints,
  getMemory,
  updateMemory,
  getIdentity,
  updateIdentity,
  saveSession,
  archiveWrong,
  createGradeFolder,
  moveEntry,
  getSettingsEntryId,
  readSettings,
  writeSettings,
  uploadSettings,
  syncSettings,
  getProgressEntryId,
  readProgress,
  writeProgress,
  syncAll,
  autoSync
}

