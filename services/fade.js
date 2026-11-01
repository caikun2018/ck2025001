// services/fade.js - 消退服务（错题 + 知识点）
//
// 两个维度的消退，闯关 / 原题练习 / 模拟考试三条链路共用：
// 1) 错题消退：同一道错题「连续答对 N 次」-> 已消退（答错清零）
// 2) 知识点消退：同一知识点下的不同题目答对「累计 N 次」-> 该知识点消退，
//    名下仍在册的错题一并消退（不同题目的次数累加到同一个知识点上）
//
// 消退后：本地移出默认视图，云端清空错题页面内容 / 学习记忆里的知识点，
// 但云端「文件」（entry）保留 —— 乐享没有删除节点的 API。
const storage = require('./storage.js')
const lexiang = require('./lexiang.js')
const progress = require('./progress.js')
const util = require('../utils/util.js')
const config = require('../utils/config.js')

// 错题答错是否清零连续次数（知识点是「累计」，答错不扣分）
const RESET_WRONG_ON_MISS = true

// 本地每题最多保留的答题记录条数（云端块里截 30 条，本地不必留更多）
const RECORD_LIMIT = 100

// 消退阈值：写死在 config.FIXED（连对 5 次消退），不再读本地配置、也不参与云同步
const getThreshold = () => config.FIXED.fadeThreshold

// 题干归一化，用于闯关/考试里识别「这是不是错题本里的那道原题」
const normalizeText = (s) => String(s || '')
  .replace(/\s/g, '')
  .replace(/[，。！？、,.!?；;：:'"“”‘’（）()【】\[\]]/g, '')
  .toLowerCase()

const normalizeName = (s) => String(s || '').trim().slice(0, 40)

const keyOf = (subject, name) => String(subject || '其他').trim() + '::' + normalizeName(name)

const isWrongActive = (w) => !!w && w.status !== '已消退' && w.status !== '已归档'

// ==================== 知识点进度 ====================

const getKnowledgeItem = (subject, name) => {
  const map = storage.getKnowledge() || {}
  return map[keyOf(subject, name)] || null
}

const isKnowledgeFaded = (subject, name) => {
  const item = getKnowledgeItem(subject, name)
  return !!(item && item.status === '已消退')
}

// 学科下的知识点清单（不传学科 = 全部）
const getKnowledgeList = (subject) => {
  const map = storage.getKnowledge() || {}
  return Object.keys(map)
    .map(k => map[k])
    .filter(it => it && (!subject || it.subject === subject))
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
}

// 知识点消退后：本地缓存去掉，云端「学习记忆」页只删这一条知识点
// （以前是整页覆盖写 JSON，会把 appendMemory 追加的知识点全冲掉）
const removeFromMemory = (subject, name) => {
  const mem = storage.getMemory(subject)
  if (mem && Array.isArray(mem.weakPoints)) {
    const before = mem.weakPoints.length
    mem.weakPoints = mem.weakPoints.filter(p => normalizeName(p) !== name)
    if (mem.weakPoints.length !== before) {
      mem.updatedAt = util.formatTime(new Date())
      storage.setMemory(subject, mem)
    }
  }
  lexiang.removeMemoryPoint(subject, name).catch(e => {
    console.warn('[fade] 云端学习记忆删除知识点失败:', subject, name, (e && e.message) || e)
  })
}

// 题库里对应的待用题一起清掉（本地题池 + 乐享题库页的块）
// 延迟 require：bank 依赖 fade，写在函数里避免循环引用
const dropBankQuestions = (subject) => {
  try {
    require('./bank.js').dropFaded(subject)
  } catch (e) {
    console.warn('[fade] 题库清理失败:', subject, (e && e.message) || e)
  }
}

// 知识点消退：连带该知识点下仍「在册」的错题一起消退
const fadeKnowledge = (subject, name, fadedAt) => {
  const wrongbook = storage.getWrongbook() || []
  const hit = []
  wrongbook.forEach(w => {
    if (!isWrongActive(w)) return
    if (String(w.subject || '').trim() !== String(subject || '').trim()) return
    if (normalizeName(w.knowledge || w.title) !== name) return
    w.status = '已消退'
    w.fadedAt = fadedAt
    w.fadeReason = '知识点已掌握'
    hit.push(w)
  })
  if (hit.length) storage.setWrongbook(wrongbook)
  removeFromMemory(subject, name)
  // 知识点已掌握：题库里该知识点的待用题一并清掉，不再出题
  dropBankQuestions(subject)
  return hit
}

// 知识点计次：答对 +1，达到阈值即消退；答错不扣分（跨题目累计）
const bumpKnowledge = (subject, name, correct, threshold, out) => {
  const map = storage.getKnowledge() || {}
  const key = keyOf(subject, name)
  const now = util.formatTime(new Date())
  const item = map[key] || {
    subject: String(subject || '其他').trim(),
    name,
    count: 0,
    status: '在册',
    createdAt: now
  }
  if (item.status === '已消退') return item
  if (correct) {
    item.count = (item.count || 0) + 1
    item.updatedAt = now
    if (item.count >= threshold) {
      item.status = '已消退'
      item.fadedAt = now
      map[key] = item
      storage.setKnowledge(map)
      const hitWrong = fadeKnowledge(item.subject, name, now)
      if (hitWrong.length) out.wrongFaded = out.wrongFaded.concat(hitWrong)
      out.knowledgeFaded.push(item)
      return item
    }
  } else {
    item.updatedAt = now
  }
  map[key] = item
  storage.setKnowledge(map)
  return item
}

// ==================== 错题定位 ====================

const findWrong = (list, opts) => {
  if (opts.wrongId) {
    const hit = list.find(w => w.id === opts.wrongId)
    if (hit) return hit
  }
  const q = normalizeText(opts.question)
  if (!q) return null
  return list.find(w => isWrongActive(w) && normalizeText(w.question) === q) || null
}

// ==================== 云端清理 ====================

// 已消退的错题：清空云端页面内容，文件保留
const clearCloudWrong = (items) => {
  (items || []).forEach(w => {
    if (!w || !w.entryId) return
    lexiang.clearWrongContent(w.entryId).catch(e => {
      console.warn('[fade] 云端错题内容清空失败:', w.title || w.question, (e && e.message) || e)
    })
  })
}

// ==================== 参数落云端 ====================

// 写成功后把本地这条标成「已同步」（按 id / entryId 找到最新那条，别用旧快照覆盖）
const markStateSynced = (item, stateAt) => {
  const list = storage.getWrongbook() || []
  const hit = list.find(w => w && (w.id === item.id || (item.entryId && w.entryId === item.entryId)))
  if (!hit) return
  // 写入期间又答了一次题（本地时间戳更新了）就保持脏标记，交给下一轮同步
  if (hit.stateAt && stateAt && hit.stateAt > stateAt) return
  hit.stateSynced = true
  if (stateAt) hit.stateAt = stateAt
  storage.setWrongbook(list)
}

// 同一道题的参数写入排队执行：连答两题时先发的请求可能后到，
// 不排队会把旧次数盖在新次数上（云端和另一台设备就永久落后了）
const stateQueues = {}
const pushWrongState = (item) => {
  if (!item || !item.entryId) return Promise.resolve({ ok: false, error: '缺少 entryId' })
  const at = item.stateAt || util.formatTime(new Date())
  const key = item.id || item.entryId
  const prev = stateQueues[key] || Promise.resolve()
  const task = prev.catch(() => {}).then(() => lexiang.updateWrongState(item.entryId, item, at)).then(r => {
    if (!r || !r.ok) {
      console.warn('[fade] 云端错题参数写入失败:', item.title || item.question, (r && r.error) || '')
      return r
    }
    markStateSynced(item, r.stateAt || at)
    return r
  }).catch(e => {
    console.warn('[fade] 云端错题参数写入失败:', item.title || item.question, (e && e.message) || e)
    return { ok: false, error: (e && e.message) || '写入失败' }
  })
  stateQueues[key] = task
  task.then(() => { if (stateQueues[key] === task) delete stateQueues[key] })
  return task
}

// ==================== 对外入口 ====================

// 记录一次答题（闯关 / 原题练习 / 模拟考试都调用这里）
// opts: { wrongId, question, subject, knowledge, correct, source }
// 返回: { wrongFaded: [], knowledgeFaded: [], wrongTouched, knowledge }
const recordAnswer = (opts = {}) => {
  const correct = !!opts.correct
  const threshold = getThreshold()
  const out = { wrongFaded: [], knowledgeFaded: [], wrongTouched: null, knowledge: null }

  // 1) 错题维度：只有「答的就是这道错题本身」才推进连续正确次数
  const list = storage.getWrongbook() || []
  const item = findWrong(list, opts)
  if (item && isWrongActive(item)) {
    if (correct) {
      item.correctCount = (item.correctCount || 0) + 1
      if (item.correctCount >= threshold) {
        item.status = '已消退'
        item.fadedAt = util.formatTime(new Date())
        item.fadeReason = '连续答对 ' + threshold + ' 次'
        out.wrongFaded.push(item)
      }
    } else if (RESET_WRONG_ON_MISS) {
      item.correctCount = 0
    }
    item.records = item.records || []
    item.records.push({ date: util.formatDate(new Date()), correct, source: opts.source || '' })
    // 本地只留最近 100 条：云端已截到 30 条，本地无上限会让 ct_wrongbook 越存越大
    if (item.records.length > RECORD_LIMIT) item.records = item.records.slice(-RECORD_LIMIT)
    // 有云端页面的题：先记时间戳 + 标脏，写成功后才置 stateSynced（失败要留给 syncAll 重试）
    item.stateAt = util.formatTime(new Date())
    if (item.entryId) item.stateSynced = false
    storage.setWrongbook(list)
    out.wrongTouched = item
  }

  // 2) 知识点维度：同一知识点的不同题目累加到同一条进度上
  const knowledgeName = normalizeName(opts.knowledge || (item && item.knowledge))
  const subject = String(opts.subject || (item && item.subject) || '其他').trim()
  if (knowledgeName) {
    out.knowledge = bumpKnowledge(subject, knowledgeName, correct, threshold, out)
  }

  // 3) 消退结果落云端：错题清内容、学习记忆里对应的知识点段落删掉
  clearCloudWrong(out.wrongFaded)
  // 4) 题库里对应的待用题也要跟着消退（错题消退清该题来源的题，知识点消退清该知识点的题）
  //    按"真的消退了谁"的学科去清，避免全科答题时只清了「其他」科
  if (out.wrongFaded.length || out.knowledgeFaded.length) {
    const touched = {}
    out.wrongFaded.forEach(w => { if (w && w.subject) touched[w.subject] = true })
    out.knowledgeFaded.forEach(k => { if (k && k.subject) touched[k.subject] = true })
    touched[subject] = true
    Object.keys(touched).forEach(dropBankQuestions)
  }
  // 5) 错题「参数」落云端：连续正确次数 + 答题记录写进错题页的状态块，换手机能还原
  //    （已消退的题刚被整页清空，不能再写，否则云端又冒出内容）
  if (out.wrongTouched && out.wrongTouched.entryId && out.wrongTouched.status !== '已消退') {
    pushWrongState(out.wrongTouched)
  }
  // 6) 学习进度（知识点累计次数）落云端「学习进度」页，内部防抖，连答几题只写一次
  progress.push().catch(() => {})
  return out
}

// 手动把某个知识点标记为已消退（预留：AI 对话里「这个我会了」等场景）
const fadeKnowledgeNow = (subject, name) => {
  const map = storage.getKnowledge() || {}
  const key = keyOf(subject, name)
  const now = util.formatTime(new Date())
  const item = map[key] || {
    subject: String(subject || '其他').trim(),
    name: normalizeName(name),
    count: 0,
    status: '在册',
    createdAt: now
  }
  if (item.status === '已消退') return { knowledge: item, wrongFaded: [] }
  item.status = '已消退'
  item.fadedAt = now
  item.updatedAt = now
  map[key] = item
  storage.setKnowledge(map)
  const wrongFaded = fadeKnowledge(item.subject, item.name, now)
  clearCloudWrong(wrongFaded)
  progress.push().catch(() => {})
  return { knowledge: item, wrongFaded }
}

// 失效（答错/重新出错）时把已消退的知识点拉回在册，避免误消退后无法再复习
const reviveKnowledge = (subject, name) => {
  const map = storage.getKnowledge() || {}
  const key = keyOf(subject, name)
  const item = map[key]
  if (!item || item.status !== '已消退') return null
  item.status = '在册'
  item.count = 0
  item.fadedAt = ''
  item.updatedAt = util.formatTime(new Date())
  map[key] = item
  storage.setKnowledge(map)
  // 拉回在册也算进度变化（云端那条要跟着改回去，更新时间更晚所以本地说了算）
  progress.push().catch(() => {})
  return item
}

module.exports = {
  getThreshold,
  recordAnswer,
  getKnowledgeList,
  getKnowledgeItem,
  isKnowledgeFaded,
  fadeKnowledgeNow,
  reviveKnowledge,
  keyOf,
  normalizeName
}
