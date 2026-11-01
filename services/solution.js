// services/solution.js - AI 解题思路缓存与后台补齐
// 目标：思路只生成一次，存本地 + 乐享；闯关/练习过程中无感补齐，没补完的下次进来自动重试
const storage = require('./storage.js')
const llm = require('./llm.js')
const lexiang = require('./lexiang.js')
const util = require('../utils/util.js')

const RUN_AT_KEY = 'ct_solution_at' // 上次后台任务时间
const RUN_GAP = 20 * 1000           // 两次后台任务最小间隔，避免切页反复触发
const MAX_PER_RUN = 3               // 每次最多补几道，不长时间占用模型
const MAX_TRIES = 8                 // 单题最多重试次数，防止坏题无限请求
let running = null

// 是否配了可用模型（没配就不生成，避免把本地兜底文案当成 AI 思路存下来）
const hasModel = () => {
  const conn = llm.getActiveConnection()
  return !!(conn && conn.key)
}

const isActive = (w) => w && w.status !== '已消退' && w.status !== '已归档'

// 还差解题思路的错题
const pendingItems = () => (storage.getWrongbook() || [])
  // 和 syncPending 的队列口径保持一致：到重试上限的坏题不再算「待补」，否则计数永不归零
  .filter(w => isActive(w) && !w.aiSolution && (w.solutionTries || 0) < MAX_TRIES)

// 写本地错题
const saveLocal = (id, text) => {
  const list = storage.getWrongbook() || []
  const item = list.find(w => w.id === id)
  if (!item) return null
  item.aiSolution = text
  item.aiSolutionAt = util.formatTime(new Date())
  item.solutionSynced = false
  item.solutionTries = 0
  storage.setWrongbook(list)
  return item
}

// 写乐享：错题页面已建好才写；还没建（或还没同步）的留给下次 syncAll 补
const pushCloud = async (id) => {
  if (!lexiang.isConfigured()) return { ok: false, error: '乐享未配置' }
  const list = storage.getWrongbook() || []
  const item = list.find(w => w.id === id)
  if (!item || !item.aiSolution) return { ok: false, error: '没有可写的解题思路' }
  if (!item.entryId) return { ok: false, error: '错题页面还没建好' }
  const r = await lexiang.appendSolution(item.entryId, item.aiSolution, item.aiSolutionAt)
  if (r && r.ok) {
    const after = storage.getWrongbook() || []
    const target = after.find(w => w.id === id)
    if (target) {
      target.solutionSynced = true
      storage.setWrongbook(after)
    }
    return { ok: true }
  }
  return { ok: false, error: (r && r.error) || '写入失败' }
}

// 生成一条并落库（详情页等待用）；已有缓存直接返回，force 时重新生成
const generateFor = async (id, options = {}) => {
  const item = (storage.getWrongbook() || []).find(w => w.id === id)
  if (!item) throw new Error('这道错题已不存在')
  if (item.aiSolution && !options.force) return item.aiSolution
  const text = await llm.explainQuestion(item, { strict: true })
  saveLocal(id, text)
  // 云端失败不影响看，之后 syncAll / 下次后台任务会补
  pushCloud(id).catch(() => {})
  return text
}

// 后台补齐：串行生成，生成一条存一条，最后把「有思路但没写进乐享」的补上
const syncPending = (options = {}) => {
  if (running) return running
  if (!hasModel()) return Promise.resolve({ ok: false, skipped: true, reason: 'no-model' })
  const now = Date.now()
  const last = storage.get(RUN_AT_KEY, 0) || 0
  if (!options.force && now - last < RUN_GAP) return Promise.resolve({ ok: true, skipped: true })

  const all = storage.getWrongbook() || []
  const queue = all
    .filter(w => isActive(w) && !w.aiSolution && (w.solutionTries || 0) < MAX_TRIES)
    .slice(0, options.limit || MAX_PER_RUN)
    .map(w => w.id)
  const cloudTodo = all
    .filter(w => isActive(w) && w.aiSolution && !w.solutionSynced && w.entryId)
    .map(w => w.id)
  if (!queue.length && !cloudTodo.length) return Promise.resolve({ ok: true, done: 0 })

  storage.set(RUN_AT_KEY, now)

  const runQueue = async () => {
    let done = 0
    for (const id of queue) {
      const item = (storage.getWrongbook() || []).find(w => w.id === id)
      if (!item || !isActive(item)) continue
      try {
        const text = await llm.explainQuestion(item, { strict: true })
        saveLocal(id, text)
        done++
        await pushCloud(id).catch(() => {})
        console.log('[solution] 思路已补齐:', item.title || item.question)
      } catch (e) {
        // 记一次失败，下次进闯关再试
        const list = storage.getWrongbook() || []
        const target = list.find(w => w.id === id)
        if (target) {
          target.solutionTries = (target.solutionTries || 0) + 1
          storage.setWrongbook(list)
        }
        console.warn('[solution] 思路生成失败，下次再试:', item.title || item.question, (e && e.message) || e)
      }
    }
    for (const id of cloudTodo) {
      try { await pushCloud(id) } catch (e) {}
    }
    console.log('[solution] 本次补齐:', done, '条，待补:', pendingItems().length, '条')
    return { ok: true, done, pending: pendingItems().length }
  }

  const task = runQueue()
  running = task
  const clear = () => { if (running === task) running = null }
  task.then(clear, clear)
  return task
}

// 还有多少道题缺思路（页面想展示进度时用）
const pendingCount = () => pendingItems().length

module.exports = {
  hasModel,
  pendingItems,
  pendingCount,
  generateFor,
  syncPending,
  pushCloud
}
