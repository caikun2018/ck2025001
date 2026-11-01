// services/bank.js - 预生成题库（打开小程序就在后台补题，答题时秒取）
//
// 设计要点：
// 1) 出题依据只有两个：该科目的错题（knowledge/title）+ 学习记忆里的薄弱知识点；
// 2) 题库按科目分组存本地（ct_question_bank），同时镜像到乐享「年级 → 学科 → 题库」页面；
// 3) 每道题在乐享是题库页面里的一个块，题被取走就删那个块（乐享没有删页面 API）；
// 4) 取走一题就按同一知识点补一题；知识点一旦消退，题库里该知识点的题一并清掉、不再补。
const storage = require('./storage.js')
const lexiang = require('./lexiang.js')
const llm = require('./llm.js')
const fade = require('./fade.js')
const memory = require('./memory.js')
const util = require('../utils/util.js')

const BANK_TARGET = 30          // 每科目标库存（够连打 3 关，每关 10 题）
const FILL_BATCH = 10           // 单次补题上限（一次请求最多出 10 道）
const FILL_GAP = 3 * 60 * 1000  // 同一科两次补题的最小间隔
const MAX_SUBJECTS = 3          // 一次预热最多处理几科（有错题的科目优先）
const MAX_FILL_ROUNDS = 2       // 一次预热里同一科最多补几轮（每轮一批，别让后台请求排太长）
const LOG = '[bank]'

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

const getGrade = () => {
  try {
    return getApp().globalData.currentGrade || '四年级'
  } catch (e) {
    return (storage.getUser() || {}).grade || '四年级'
  }
}

// ==================== 出题依据（错题 + 知识点） ====================

// 该科仍在册的错题
const wrongOf = (subject) => (storage.getWrongbook() || []).filter(w =>
  w && w.subject === subject && w.status !== '已消退' && w.status !== '已归档')

// 学习记忆里的薄弱知识点（已消退的不要）
const weakPointsOf = (subject) => {
  const mem = storage.getMemory(subject)
  const list = (mem && Array.isArray(mem.weakPoints)) ? mem.weakPoints : []
  return list
    .map(p => String(p || '').trim())
    .filter(p => p && !fade.isKnowledgeFaded(subject, p))
}

// 该科的出题知识点池：错题里的知识点在前（错得越多越靠前），薄弱知识点补后
const knowledgePoolOf = (subject) => {
  const out = []
  const weights = {}
  const push = (k) => {
    const name = String(k || '').trim()
    if (!name || fade.isKnowledgeFaded(subject, name)) return
    if (!(name in weights)) {
      weights[name] = 0
      out.push(name)
    }
  }
  wrongOf(subject).forEach(w => {
    const k = String(w.knowledge || w.title || '').trim()
    if (!k) return
    push(k)
    if (k in weights) weights[k] += 1
  })
  weakPointsOf(subject).forEach(push)
  return out
    .map((name, i) => ({ name, weight: weights[name], i }))
    .sort((a, b) => (b.weight - a.weight) || (a.i - b.i))
    .map(x => x.name)
}

// 有出题依据的科目（有错题或薄弱知识点），按依据多少排序
const getActiveSubjects = () => {
  return lexiang.getSyncedSubjects()
    .map(s => ({ subject: s, score: wrongOf(s).length + weakPointsOf(s).length }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(x => x.subject)
}

// ==================== 本地题库读写 ====================

const getBankMap = () => storage.getQuestionBank() || {}

const listOf = (subject) => {
  const entry = getBankMap()[subject]
  return (entry && Array.isArray(entry.items)) ? entry.items.slice() : []
}

const setList = (subject, items, extra) => {
  const bank = getBankMap()
  const cur = bank[subject] || {}
  bank[subject] = Object.assign({}, cur, extra || {}, {
    items,
    updatedAt: util.formatTime(new Date())
  })
  storage.setQuestionBank(bank)
  return bank[subject]
}

const countOf = (subject) => listOf(subject).length

// ==================== 已被淘汰的题：知识点消退 / 来源错题消退 ====================

const itemAlive = (subject, item) => {
  if (!item) return false
  if (item.knowledge && fade.isKnowledgeFaded(subject, item.knowledge)) return false
  if (item.wrongId) {
    const alive = wrongOf(subject).some(w => w.id === item.wrongId)
    if (!alive) return false
  }
  return true
}

// 清掉失效题（本地 + 乐享块），返回被清掉的题
const dropFaded = (subject) => {
  const items = listOf(subject)
  if (!items.length) return []
  const alive = []
  const dead = []
  items.forEach(it => (itemAlive(subject, it) ? alive.push(it) : dead.push(it)))
  if (!dead.length) return []
  setList(subject, alive)
  const ids = dead.map(it => it.blockId).filter(Boolean)
  if (ids.length) {
    lexiang.deleteBankQuestions(subject, ids).catch(e => {
      console.warn(LOG, '云端清理失效题失败:', subject, (e && e.message) || e)
    })
  }
  console.log(LOG, '清理失效题:', subject, dead.length, '道（知识点或错题已消退）')
  return dead
}

// ==================== 取题 ====================

// 洗牌：题库是一个页面里的多个块，按顺序取会永远先出最早的题，这里打乱顺序
const shuffle = (list) => {
  const arr = (list || []).slice()
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = arr[i]
    arr[i] = arr[j]
    arr[j] = tmp
  }
  return arr
}

// 关卡知识点范围：和 llm.levelScope 同一套规则（第 1~9 关逐步扩大，第 10 关全部）
const LEVEL_COUNT = [1, 2, 3, 4, 5, 6, 7, 8, 9, 0]
const levelRangeOf = (pool, level) => {
  const lv = parseInt(level) || 0
  if (lv < 1) return pool
  const n = LEVEL_COUNT[Math.min(lv, LEVEL_COUNT.length) - 1]
  return n > 0 ? pool.slice(0, n) : pool
}

// 踢云端：按科目分组删除已被取走的题的块
const kickCloud = (subject, picked) => {
  const bySubject = {}
  picked.forEach(it => {
    if (!it.blockId) return
    const s = it.subject || subject
    if (s === lexiang.ALL_SUBJECT) return
    bySubject[s] = bySubject[s] || []
    bySubject[s].push(it.blockId)
  })
  Object.keys(bySubject).forEach(s => {
    lexiang.deleteBankQuestions(s, bySubject[s]).catch(e => {
      console.warn(LOG, '云端踢题失败:', s, (e && e.message) || e)
    })
  })
}

// 从题库取题：返回 { questions, have, need }
// 取走的题立刻从本地题库移除并从乐享题库页删块，随后由调用方触发补题
const take = (subject, count, opts = {}) => {
  const want = Math.max(parseInt(count) || 10, 1)
  // 全科：从各科题库轮流取，保证学科混合
  if (subject === lexiang.ALL_SUBJECT) return takeAll(want, opts)

  dropFaded(subject)
  const items = listOf(subject)
  if (!items.length) return { questions: [], have: 0, need: want }

  const pool = knowledgePoolOf(subject)
  const range = levelRangeOf(pool, opts.level)
  const inRange = (it) => !range.length || range.indexOf(it.knowledge) >= 0
  // 关卡范围内的题优先，其次其它知识点的题（题库空时才放宽，保证能玩上）
  // 同一档内部随机取，避免每次都从题库最前面按顺序拿
  const picked = []
  const inList = shuffle(items.filter(inRange))
  const outList = shuffle(items.filter(it => !inRange(it)))
  inList.slice(0, want).forEach(it => picked.push(it))
  if (picked.length < want) {
    outList.slice(0, want - picked.length).forEach(it => picked.push(it))
  }
  const kept = items.filter(it => picked.indexOf(it) < 0)
  setList(subject, kept)
  kickCloud(subject, picked)

  console.log(LOG, '取题:', subject, picked.length, '/', want, '剩余', kept.length, '知识点:', picked.map(q => q.knowledge).join('、'))
  return { questions: picked, have: picked.length, need: want }
}

// 全科取题：各科题库各自打乱后轮流出一道，凑够为止
const takeAll = (want, opts = {}) => {
  const subjects = getActiveSubjects()
  const picked = []
  if (!subjects.length) return { questions: [], have: 0, need: want }
  const lists = subjects.map(s => {
    dropFaded(s)
    return { subject: s, items: shuffle(listOf(s)) }
  })
  let round = 0
  let progressed = true
  while (picked.length < want && progressed) {
    progressed = false
    lists.forEach(l => {
      if (picked.length >= want) return
      const it = l.items[round]
      if (!it) return
      picked.push(it)
      progressed = true
    })
    round++
  }
  // 各科只保留没被取走的部分
  lists.forEach(l => {
    const used = picked.filter(p => p.subject === l.subject).length
    if (used) setList(l.subject, l.items.slice(used))
  })
  kickCloud(lexiang.ALL_SUBJECT, picked)
  console.log(LOG, '取题:全科', picked.length, '/', want)
  return { questions: picked, have: picked.length, need: want }
}

// 中途退出（出题被取消）：把已取走但没答的题放回题库，别让预生成的题白丢
// 只回本地池：取题时乐享题库页的块已经删了，云端不再有这几道，不影响答题（restoreFromCloud 按 qid 去重）
const putBack = (subject, questions) => {
  const back = (questions || []).filter(it => it && it.qid)
  if (!back.length) return 0
  // 全科：按题目的学科拆开，各科各自放回
  if (subject === lexiang.ALL_SUBJECT) {
    const groups = {}
    back.forEach(it => {
      const s = it.subject
      if (!s || s === lexiang.ALL_SUBJECT) return
      groups[s] = groups[s] || []
      groups[s].push(it)
    })
    return Object.keys(groups).reduce((n, s) => n + putBack(s, groups[s]), 0)
  }
  const items = listOf(subject)
  const known = {}
  items.forEach(it => { known[it.qid] = true })
  const add = back.filter(it => !known[it.qid])
  if (!add.length) return 0
  setList(subject, items.concat(add))
  console.log(LOG, '退回题库:', subject, add.length, '道（本次没用到）')
  return add.length
}

// ==================== 补题 ====================

const filling = {}

// 补题：先把云端「学习记忆」里的知识点拉回本地（出题必考的第二个来源），再按知识点补足库存
// opts.focus 指定优先补哪些知识点（刚被出掉的那些）
const refill = (subject, opts = {}) => {
  if (filling[subject]) return filling[subject]
  filling[subject] = memory.syncFromCloud(subject)
    .catch(() => null)
    .then(() => doRefill(subject, opts))
    .then(r => { delete filling[subject]; return r })
    .catch(e => {
      delete filling[subject]
      return { ok: false, error: (e && e.message) || '补题失败' }
    })
  return filling[subject]
}

const doRefill = (subject, opts = {}) => {
  const conn = storage.getActiveConnection()
  if (!conn || !conn.key) return Promise.resolve({ ok: false, skipped: '未配置模型连接' })

  const bank = getBankMap()[subject] || {}
  if (!opts.force && bank.lastFillAt && Date.now() - bank.lastFillAt < FILL_GAP) {
    return Promise.resolve({ ok: true, skipped: '刚补过，先歇一下' })
  }
  const pool = knowledgePoolOf(subject)
  if (!pool.length) return Promise.resolve({ ok: false, skipped: '该科没有错题知识点' })

  const cur = listOf(subject)
  const target = opts.target || BANK_TARGET
  const need = Math.min(target - cur.length, opts.batch || FILL_BATCH, pool.length * 2)
  if (need <= 0) return Promise.resolve({ ok: true, skipped: '题库已满' })

  // 补哪些知识点：优先刚被出掉的那几个，其次按池子顺序轮转
  const focus = (opts.focus || []).filter(k => pool.indexOf(k) >= 0)
  const picks = []
  focus.forEach(k => { if (picks.length < need && picks.indexOf(k) < 0) picks.push(k) })
  for (let i = 0; picks.length < need && i < pool.length; i++) {
    if (picks.indexOf(pool[i]) < 0) picks.push(pool[i])
  }

  const grade = opts.grade || getGrade()
  const wrongbook = wrongOf(subject)
  const exclude = cur.map(q => q.question).filter(Boolean).slice(0, 10)
  console.log(LOG, '补题开始:', subject, '需要', need, '道，知识点:', picks.join('、'))

  return llm.generateQuestions(subject, picks.length, grade, wrongbook, 0, opts.difficulty || '', {
    knowledgeList: picks,
    exclude
  }).then(questions => {
    const now = util.formatTime(new Date())
    // 题库里已经有的题干不再重复入库（模型偶发重复出题）
    const norm = (s) => String(s || '').replace(/\s/g, '').slice(0, 60)
    const seen = {}
    cur.forEach(q => { seen[norm(q.question)] = true })
    const fresh = (questions || []).filter(q => {
      if (!q || !q.question || !q.answer) return false
      const key = norm(q.question)
      if (!key || seen[key]) return false
      seen[key] = true
      return true
    })
    const added = fresh.map(q => {
      const k = String(q.knowledge || '').trim()
      const src = wrongbook.find(w => String(w.knowledge || w.title || '').trim() === k)
      return {
        qid: util.uid(),
        subject,
        knowledge: k || subject,
        question: q.question,
        answer: q.answer,
        explanation: q.explanation || '',
        options: q.options || [],
        figure: q.figure || null,
        type: q.type || 'short',
        difficulty: opts.difficulty || '',
        wrongId: src ? src.id : '',
        createdAt: now,
        blockId: ''
      }
    })
    if (!added.length) return { ok: false, skipped: '模型没返回题目' }

    // 先落本地（立刻可用），再异步镜像到乐享
    const latest = listOf(subject)
    setList(subject, latest.concat(added), { lastFillAt: Date.now() })
    console.log(LOG, '补题完成:', subject, added.length, '道，库存', countOf(subject))

    lexiang.appendBankQuestions(subject, added).then(r => {
      if (!r || !r.ok) {
        console.warn(LOG, '题库镜像失败，仅保留本地:', subject, r && r.error)
        return
      }
      // 回填 blockId，之后踢题才能精准删块
      const map = {}
      ;(r.added || []).forEach(a => { if (a.qid) map[a.qid] = a.blockId })
      const items = listOf(subject).map(it => map[it.qid] ? Object.assign({}, it, { blockId: map[it.qid] }) : it)
      setList(subject, items)
    }).catch(e => {
      console.warn(LOG, '题库镜像异常:', subject, (e && e.message) || e)
    })

    return { ok: true, added: added.length, knowledge: picks }
  }).catch(e => {
    console.warn(LOG, '补题失败:', subject, (e && e.message) || e)
    // 失败也记一笔时间，避免每次回到小程序就立刻重试烧请求
    setList(subject, listOf(subject), { lastFillAt: Date.now() })
    return { ok: false, error: (e && e.message) || '补题失败' }
  })
}

// 取题后调用：按被出掉的题的知识点补回（一次闯关出掉几道就补几道，最多 10 道）
const refillAfterUse = (subject, usedQuestions) => {
  // 全科：按题目的学科拆开，各科各自补
  if (subject === lexiang.ALL_SUBJECT) {
    const groups = {}
    ;(usedQuestions || []).forEach(q => {
      const s = q && q.subject
      if (!s || s === lexiang.ALL_SUBJECT) return
      groups[s] = groups[s] || []
      groups[s].push(q)
    })
    const keys = Object.keys(groups)
    if (!keys.length) return Promise.resolve({ ok: false, skipped: '没有学科信息' })
    return Promise.all(keys.map(s => refillAfterUse(s, groups[s]))).then(() => ({ ok: true }))
  }
  const focus = []
  ;(usedQuestions || []).forEach(q => {
    const k = String((q && q.knowledge) || '').trim()
    if (k && focus.indexOf(k) < 0) focus.push(k)
  })
  const batch = Math.min(Math.max((usedQuestions || []).length, 1), FILL_BATCH)
  return refill(subject, { focus, force: true, batch })
    .catch(() => ({ ok: false }))
}

// ==================== 启动预热 ====================

let warming = null

// 打开小程序时调用：把各科题库补到目标库存（后台静默跑，失败不影响使用）
const warmUp = (opts = {}) => {
  if (warming) return warming
  if (!lexiang.isConfigured()) return Promise.resolve({ ok: false, skipped: '乐享未配置' })
  const conn = storage.getActiveConnection()
  if (!conn || !conn.key) return Promise.resolve({ ok: false, skipped: '未配置模型连接' })

  // 先把各科云端「学习记忆」的知识点拉回本地：
  // 少了这一步，只有知识点、没有错题的科目会被当成"没有出题依据"而整科跳过
  warming = memory.syncAll(lexiang.getSyncedSubjects())
    .catch(() => null)
    .then(() => runWarm(opts))
    .then(r => { warming = null; return r })
    .catch(e => {
      warming = null
      return { ok: false, error: (e && e.message) || '题库预热失败' }
    })
  return warming
}

const runWarm = (opts = {}) => {
  const subjects = getActiveSubjects()
  if (!subjects.length) return Promise.resolve({ ok: true, skipped: '还没有错题或知识点' })
  // 库存最少的科目优先补，这样每次启动都在「填最空的坑」，各科会自然轮转
  const todo = subjects
    .map(s => ({ s, count: countOf(s) }))
    .sort((a, b) => a.count - b.count)
    .slice(0, opts.maxSubjects || MAX_SUBJECTS)
    .map(x => x.s)
  console.log(LOG, '预热开始:', todo.join('、'), '目标', BANK_TARGET, '道/科')

  return (async () => {
    const result = []
    for (const subject of todo) {
      dropFaded(subject)
      // 本地题库空了（换手机 / 清过缓存）先从乐享「题库」页把已有题捞回来，别重复生成
      if (!countOf(subject)) {
        const rr = await restoreFromCloud(subject).catch(() => null)
        if (rr && rr.added) console.log(LOG, '预热前从云端恢复:', subject, rr.added, '道')
      }
      const before = countOf(subject)
      if (before >= BANK_TARGET) {
        result.push({ subject, skipped: '已满', count: before })
        continue
      }
      // 一轮补不满目标（单轮最多 FILL_BATCH 道），接着补下一轮；第一轮尊重 3 分钟节流，后面几轮强制补
      let added = 0
      let skipped = ''
      for (let round = 0; round < (opts.rounds || MAX_FILL_ROUNDS); round++) {
        if (countOf(subject) >= BANK_TARGET) break
        const r = await refill(subject, { target: BANK_TARGET, force: round > 0 })
        if (r && r.added) added += r.added
        if (!r || r.ok === false || r.skipped || !r.added) {
          skipped = (r && (r.skipped || r.error)) || '模型没返回题目'
          break
        }
        await sleep(400)
      }
      result.push({ subject, added, count: countOf(subject), skipped })
      await sleep(400)
    }
    console.log(LOG, '预热结束:', JSON.stringify(result))
    return { ok: true, result }
  })()
}

// ==================== 与乐享对账 ====================

// 本地题库丢了（换机/清缓存）时，从乐享题库页把题捞回来
const restoreFromCloud = async (subject) => {
  const cur = listOf(subject)
  if (cur.length >= BANK_TARGET) return { ok: true, skipped: '本地已够' }
  const r = await lexiang.listBankQuestions(subject)
  if (!r || !r.ok) return { ok: false, error: (r && r.error) || '读取题库失败' }
  const known = {}
  cur.forEach(it => { known[it.qid] = true })
  const add = (r.items || []).filter(it => !known[it.qid]).map(it => Object.assign({}, it, {
    subject: it.subject || subject
  }))
  if (!add.length) return { ok: true, added: 0 }
  setList(subject, cur.concat(add))
  console.log(LOG, '从乐享恢复题库:', subject, add.length, '道')
  return { ok: true, added: add.length }
}

// 概览（设置页/日志用）
const stats = () => {
  const subjects = lexiang.getSyncedSubjects()
  return subjects.map(s => ({
    subject: s,
    count: countOf(s),
    knowledge: knowledgePoolOf(s).length,
    wrong: wrongOf(s).length
  }))
}

module.exports = {
  BANK_TARGET,
  wrongOf,
  weakPointsOf,
  knowledgePoolOf,
  getActiveSubjects,
  countOf,
  listOf,
  take,
  putBack,
  refill,
  refillAfterUse,
  dropFaded,
  warmUp,
  restoreFromCloud,
  stats
}
