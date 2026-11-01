// services/storage.js - 本地缓存管理
const crypto = require('../utils/crypto.js')

const KEYS = {
  USER: 'ct_user',           // 登录用户（明文 JSON）
  CREDENTIALS: 'ct_cred',    // 记住的账号密码
  CONFIG: 'ct_config',       // 用户配置
  LEXIANG_KEY: 'ct_lexiang', // 乐享 API Key（加密，不回显）
  LLM_KEY: 'ct_llm_key',     // LLM API Key（加密）
  WRONGBOOK: 'ct_wrongbook', // 错题本地缓存
  SESSIONS: 'ct_sessions',   // 会话记录
  MEMORY: 'ct_memory',       // 学习记忆缓存
  IDENTITY: 'ct_identity',   // 身份和习惯
  ACHIEVEMENTS: 'ct_ach',    // 成就数据
  LEVEL_PROGRESS: 'ct_level', // 闯关进度（本地激励）
  KNOWLEDGE: 'ct_knowledge', // 知识点消退进度（跨题目累计）
  QUESTION_BANK: 'ct_question_bank' // 预生成题库（按科目分组，镜像到乐享「题库」页）
}

const get = (key, defaultValue = null) => {
  try {
    const v = wx.getStorageSync(key)
    return v === '' || v === undefined ? defaultValue : v
  } catch (e) {
    return defaultValue
  }
}

const set = (key, value) => {
  try { wx.setStorageSync(key, value) } catch (e) {}
}

const remove = (key) => {
  try { wx.removeStorageSync(key) } catch (e) {}
}

// 用户信息（明文 JSON 存储，含 username/grade/loginAt）
const getUser = () => {
  try {
    return get(KEYS.USER, null)
  } catch (e) { return null }
}

const setUser = (user) => {
  set(KEYS.USER, user)
}

const clearUser = () => remove(KEYS.USER)

// 记住的账号（仅本地）：只存账号名，不落盘密码，登录时再输一次
// （密码明文 / 固定密钥异或都挡不住本地读取，宁可不存）
const getSavedCredentials = () => get(KEYS.CREDENTIALS, null)
const setSavedCredentials = (cred) => set(KEYS.CREDENTIALS, cred ? { username: cred.username || '' } : null)
const clearSavedCredentials = () => remove(KEYS.CREDENTIALS)

// 配置
const getConfig = () => get(KEYS.CONFIG, {})
const setConfig = (cfg) => set(KEYS.CONFIG, cfg)

// 乐享 Key（加密，不回显）
const getLexiangKey = () => {
  const enc = get(KEYS.LEXIANG_KEY)
  return enc ? crypto.decrypt(enc) : ''
}
const setLexiangKey = (k) => set(KEYS.LEXIANG_KEY, crypto.encrypt(k))
const clearLexiangKey = () => remove(KEYS.LEXIANG_KEY)
const hasLexiangKey = () => !!get(KEYS.LEXIANG_KEY)

// LLM Key
const getLLMKey = (provider) => {
  const all = get(KEYS.LLM_KEY, {})
  return all[provider] ? crypto.decrypt(all[provider]) : ''
}
const setLLMKey = (provider, k) => {
  const all = get(KEYS.LLM_KEY, {})
  all[provider] = crypto.encrypt(k)
  set(KEYS.LLM_KEY, all)
}

// 连接用途类型：text 文本 / voice 语音 / image 图片
const ROLE_LABELS = { text: '文本', voice: '语音', image: '图片' }
const ROLE_ID_KEYS = { text: 'activeModelId', voice: 'asrModelId', image: 'visionModelId' }

// 供应商简称：历史连接可能存了旧的完整名称，读取时统一为简称
const PROVIDER_SHORT_NAMES = {
  '商汤日日新 SenseNova': '商汤日日新',
  'Kimi 月之暗面': 'Kimi',
  '豆包 火山方舟': '豆包',
  '智谱 GLM': '智谱',
  '小米 MiMo': '小米',
  '阶跃星辰 StepFun': '阶跃星辰',
  '硅基流动 SiliconFlow': '硅基流动'
}
const normalizeConnName = (name) => PROVIDER_SHORT_NAMES[name] || name

// 旧数据没有 type 字段时，按模型/供应商名称推断用途
const inferRoleType = (conn) => {
  if (conn.type === 'text' || conn.type === 'voice' || conn.type === 'image') return conn.type
  const s = ((conn.model || '') + ' ' + (conn.name || '')).toLowerCase()
  if (/sensevoice|whisper|asr|audio|speech/.test(s)) return 'voice'
  if (/qwen.*vl|glm-4v|vision|gpt-4o|gpt-4[.-]|gemini|claude|deepseek-flash|step-1v|mimo-vl|internvl|llava|sensenova/.test(s)) return 'image'
  return 'text'
}

// 模型连接列表（每个连接包含 name/baseUrl/model/key/type）
// 读取时顺便补齐 type，并保证每种类型各有一个选中项
const getModelConnections = () => {
  const cfg = get(KEYS.CONFIG, {})
  const raw = Array.isArray(cfg.modelConnections) ? cfg.modelConnections : []
  let dirty = false
  const list = raw.map(c => {
    const type = inferRoleType(c)
    const name = normalizeConnName(c.name)
    if (c.type === type && c.name === name) return c
    dirty = true
    return Object.assign({}, c, { type, name })
  })
  const roleUpdates = {}
  Object.keys(ROLE_ID_KEYS).forEach(type => {
    const key = ROLE_ID_KEYS[type]
    const selected = cfg[key] || ''
    const group = list.filter(c => c.type === type)
    if (!group.length) {
      if (selected) roleUpdates[key] = ''
      return
    }
    if (!group.some(c => c.id === selected)) roleUpdates[key] = group[0].id
  })
  if (dirty || Object.keys(roleUpdates).length) {
    cfg.modelConnections = list
    Object.assign(cfg, roleUpdates)
    set(KEYS.CONFIG, cfg)
  }
  return list
}
const setModelConnections = (list) => {
  const cfg = get(KEYS.CONFIG, {})
  cfg.modelConnections = list
  set(KEYS.CONFIG, cfg)
}
const getActiveModelId = () => {
  const cfg = get(KEYS.CONFIG, {})
  return cfg.activeModelId || ''
}
const setActiveModelId = (id) => {
  const cfg = get(KEYS.CONFIG, {})
  cfg.activeModelId = id
  set(KEYS.CONFIG, cfg)
}
const getActiveConnection = () => {
  const list = getModelConnections()
  const id = getActiveModelId()
  return list.find(c => c.id === id) || list.find(c => c.type === 'text') || list[0] || null
}

// 按用途获取选中的连接（text / voice / image）
const getRoleConnection = (type) => {
  const list = getModelConnections()
  const id = type === 'text' ? getActiveModelId() : type === 'voice' ? getAsrModelId() : getVisionModelId()
  const picked = list.find(c => c.id === id)
  if (picked && picked.type === type) return picked
  return list.find(c => c.type === type) || null
}

// 语音模型 / 图片识别模型：单独指定连接，未指定时由 llm.js 自动挑选
const getAsrModelId = () => {
  const cfg = get(KEYS.CONFIG, {})
  return cfg.asrModelId || ''
}
const setAsrModelId = (id) => {
  const cfg = get(KEYS.CONFIG, {})
  cfg.asrModelId = id || ''
  set(KEYS.CONFIG, cfg)
}
const getVisionModelId = () => {
  const cfg = get(KEYS.CONFIG, {})
  return cfg.visionModelId || ''
}
const setVisionModelId = (id) => {
  const cfg = get(KEYS.CONFIG, {})
  cfg.visionModelId = id || ''
  set(KEYS.CONFIG, cfg)
}
const findConnectionById = (id) => {
  if (!id) return null
  return getModelConnections().find(c => c.id === id) || null
}

// 错题本
const getWrongbook = () => get(KEYS.WRONGBOOK, [])
const setWrongbook = (list) => set(KEYS.WRONGBOOK, list)

// 会话
const getSessions = () => get(KEYS.SESSIONS, [])
const setSessions = (s) => set(KEYS.SESSIONS, s)

// 学习记忆
const getMemory = (subject) => {
  const all = get(KEYS.MEMORY, {})
  return all[subject] || null
}
const setMemory = (subject, mem) => {
  const all = get(KEYS.MEMORY, {})
  all[subject] = mem
  set(KEYS.MEMORY, all)
}

// 身份习惯
const getIdentity = () => get(KEYS.IDENTITY, {})
const setIdentity = (i) => set(KEYS.IDENTITY, i)

// 成就
const getAchievements = () => get(KEYS.ACHIEVEMENTS, { badges: [], stats: { faded: 0, challengeCount: 0, streak: 0 } })
const setAchievements = (a) => set(KEYS.ACHIEVEMENTS, a)

// 闯关进度
const getLevelProgress = () => get(KEYS.LEVEL_PROGRESS, { current: 1, stars: 0 })
const setLevelProgress = (p) => set(KEYS.LEVEL_PROGRESS, p)

// 知识点消退进度：{ '学科::知识点': { subject, name, count, status, updatedAt, fadedAt } }
const getKnowledge = () => get(KEYS.KNOWLEDGE, {})
const setKnowledge = (map) => set(KEYS.KNOWLEDGE, map)

// 预生成题库：{ '数学': { items: [...], updatedAt, lastFillAt } }
const getQuestionBank = () => get(KEYS.QUESTION_BANK, {})
const setQuestionBank = (bank) => set(KEYS.QUESTION_BANK, bank)

module.exports = {
  KEYS,
  get, set, remove,
  getUser, setUser, clearUser,
  getSavedCredentials, setSavedCredentials, clearSavedCredentials,
  getConfig, setConfig,
  getLexiangKey, setLexiangKey, clearLexiangKey, hasLexiangKey,
  getLLMKey, setLLMKey,
  getModelConnections, setModelConnections, getActiveModelId, setActiveModelId, getActiveConnection,
  getAsrModelId, setAsrModelId, getVisionModelId, setVisionModelId, findConnectionById,
  ROLE_LABELS, ROLE_ID_KEYS, getRoleConnection,
  getWrongbook, setWrongbook,
  getSessions, setSessions,
  getMemory, setMemory,
  getIdentity, setIdentity,
  getAchievements, setAchievements,
  getLevelProgress, setLevelProgress,
  getKnowledge, setKnowledge,
  getQuestionBank, setQuestionBank
}
