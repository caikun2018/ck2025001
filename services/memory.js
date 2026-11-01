// services/memory.js - 学科「学习记忆」（知识点库）的本地缓存与云端回填
//
// 学习记忆有两份：
//   1) 乐享「年级 → 学科 → 学习记忆」页面，是权威副本（AI 助手归档的知识点、知识清单都写这里）；
//   2) 本地 ct_memory，是出题时同步读取的缓存（bank / llm 都直接读它）。
// 以前只往云端写、从不往回读，导致出题的知识点池里实际只剩错题里的 knowledge，
// 云端学习记忆里的知识点全部失效。这里补上「云端 → 本地」的回填。
const storage = require('./storage.js')
const lexiang = require('./lexiang.js')
const fade = require('./fade.js')
const util = require('../utils/util.js')

const TTL = 10 * 60 * 1000   // 同一科两次回填的最小间隔
const lastPull = {}          // 上次回填时间
const pulling = {}           // 正在回填的科目（并发去重）

const blank = (subject) => ({
  subject,
  weakPoints: [],
  masteredPoints: [],
  commonErrors: [],
  preference: '',
  updatedAt: ''
})

const getMemory = (subject) => storage.getMemory(subject) || null

// 从学习记忆页面的 Markdown 里抽知识点名称（解析规则统一放在 lexiang，避免两套实现走偏）
const parsePoints = (md) => lexiang.parseMemoryPoints(md)

// 把知识点并入本地学习记忆：去重、跳过已消退的
const addPoints = (subject, points) => {
  const name = String(subject || '').trim()
  if (!name || !Array.isArray(points) || !points.length) return 0
  const mem = getMemory(name) || blank(name)
  const list = Array.isArray(mem.weakPoints) ? mem.weakPoints.slice() : []
  let added = 0
  points.forEach(p => {
    const k = String(p || '').trim()
    if (!k || list.indexOf(k) >= 0) return
    if (fade.isKnowledgeFaded(name, k)) return
    list.push(k)
    added++
  })
  if (!added) return 0
  mem.subject = name
  mem.weakPoints = list
  mem.updatedAt = util.formatTime(new Date())
  storage.setMemory(name, mem)
  console.log('[memory] 学习记忆新增知识点:', name, added, '个，共', list.length, '个')
  return added
}

// 云端学习记忆 → 本地缓存（TTL 内不重复请求）
const syncFromCloud = (subject, opts = {}) => {
  const name = String(subject || '').trim()
  if (!name || name === lexiang.ALL_SUBJECT) return Promise.resolve({ ok: false, skipped: '无学科' })
  if (!opts.force && lastPull[name] && Date.now() - lastPull[name] < TTL) {
    return Promise.resolve({ ok: true, skipped: '刚回填过', added: 0 })
  }
  if (pulling[name]) return pulling[name]
  pulling[name] = lexiang.getMemory(name).then(content => {
    lastPull[name] = Date.now()
    if (!content) return { ok: false, skipped: '云端学习记忆为空', added: 0 }
    const points = parsePoints(content)
    const added = addPoints(name, points)
    return { ok: true, added, total: points.length }
  }).catch(e => {
    console.warn('[memory] 学习记忆回填失败:', name, (e && e.message) || e)
    return { ok: false, error: (e && e.message) || '读取学习记忆失败', added: 0 }
  })
  pulling[name].then(() => { delete pulling[name] })
  return pulling[name]
}

// 批量回填（启动预热时调用）：串行拉，别一次并发打满乐享接口
const syncAll = async (subjects, opts) => {
  const list = (subjects || []).filter(s => s && s !== lexiang.ALL_SUBJECT)
  const out = []
  for (const s of list) {
    out.push(await syncFromCloud(s, opts))
  }
  return out
}

module.exports = {
  parsePoints,
  addPoints,
  syncFromCloud,
  syncAll
}
