// services/progress.js - 学习进度的云端同步（知识点累计次数 / 成就统计）
//
// 这两样以前只在本机（ct_knowledge / ct_ach），换手机就归零：
// 知识点次数丢了会导致「已经掌握的知识点」重新累计，成就统计也跟着白练。
// 现在统一存到乐享根级「学习进度」页面的一行机器块里：
//   { knowledge: { '数学::分数加减': { c, s, u, f } }, achievements: { badges, stats } }
// 合并规则（不在云端做整页覆盖）：
//   - 知识点：按条目 updatedAt 取新；本地没有更新时间的历史数据才按次数取大
//   - 成就：徽章取并集，统计数字取大的
// 闯关进度（ct_level）不做同步：它目前没有写入点，存了也永远是初始值。
const storage = require('./storage.js')
const lexiang = require('./lexiang.js')
const util = require('../utils/util.js')

const TTL = 10 * 60 * 1000   // 两次「云端 → 本地」的最小间隔
const PUSH_DELAY = 5000      // 本地改动后延迟上传，连答几题只写一次

let lastPull = 0
let pullPromise = null
let pushTimer = null
let pushResolve = null

// ==================== 本地 → 云端格式 ====================

// 知识点压成短字段：c=次数 s=是否已消退 u=更新时间 f=消退时间
// 从没答过（0 次、在册、也没有更新时间）的知识点不上云：没有进度意义，还能省块文本。
// 注意「拉回在册」的条目必须有 updatedAt 一起上云，否则云端仍是已消退，换手机就错了。
const packKnowledge = (map) => {
  const out = {}
  Object.keys(map || {}).forEach(key => {
    const it = map[key]
    if (!it) return
    const count = it.count || 0
    const faded = it.status === '已消退'
    const updatedAt = it.updatedAt || ''
    if (!count && !faded && !updatedAt) return
    out[key] = { c: count, s: faded ? 1 : 0, u: updatedAt, f: it.fadedAt || '' }
  })
  return out
}

const unpackKnowledge = (packed) => {
  const out = {}
  Object.keys(packed || {}).forEach(key => {
    const p = packed[key] || {}
    const idx = String(key).indexOf('::')
    out[key] = {
      subject: idx >= 0 ? key.slice(0, idx) : '其他',
      name: idx >= 0 ? key.slice(idx + 2) : key,
      count: p.c || 0,
      status: p.s ? '已消退' : '在册',
      updatedAt: p.u || '',
      fadedAt: p.f || ''
    }
  })
  return out
}

const snapshot = () => {
  const ach = storage.getAchievements() || {}
  const stats = ach.stats || {}
  return {
    knowledge: packKnowledge(storage.getKnowledge() || {}),
    achievements: {
      badges: Array.isArray(ach.badges) ? ach.badges.slice() : [],
      stats: {
        faded: stats.faded || 0,
        challengeCount: stats.challengeCount || 0,
        streak: stats.streak || 0
      }
    },
    updatedAt: util.formatTime(new Date())
  }
}

// ==================== 云端 → 本地合并 ====================

const mergeKnowledge = (packed) => {
  const local = storage.getKnowledge() || {}
  const remote = unpackKnowledge(packed)
  let changed = 0
  Object.keys(remote).forEach(key => {
    const r = remote[key]
    const l = local[key]
    if (!l) {
      local[key] = r
      changed++
      return
    }
    const lt = String(l.updatedAt || '')
    const rt = String(r.updatedAt || '')
    if (rt && rt > lt) {
      // 云端更新（另一台手机答过 / 消退过 / 拉回过）：整条以云端为准
      l.count = r.count
      l.status = r.status
      l.fadedAt = r.fadedAt
      l.updatedAt = r.updatedAt
      l.subject = l.subject || r.subject
      l.name = l.name || r.name
      changed++
    } else if (!lt && r.count > (l.count || 0)) {
      // 本地是没带更新时间的老数据，只能按次数取大
      l.count = r.count
      changed++
    }
  })
  if (changed) storage.setKnowledge(local)
  return changed
}

const mergeAchievements = (cloud) => {
  const ach = storage.getAchievements() || { badges: [], stats: {} }
  ach.badges = Array.isArray(ach.badges) ? ach.badges : []
  ach.stats = ach.stats || {}
  let changed = 0
  ;((cloud && cloud.badges) || []).forEach(b => {
    if (b && ach.badges.indexOf(b) < 0) {
      ach.badges.push(b)
      changed++
    }
  })
  const rs = (cloud && cloud.stats) || {}
  Object.keys(rs).forEach(k => {
    if (typeof rs[k] !== 'number') return
    if (rs[k] > (ach.stats[k] || 0)) {
      ach.stats[k] = rs[k]
      changed++
    }
  })
  if (changed) storage.setAchievements(ach)
  return changed
}

// ==================== 对外入口 ====================

// 云端 → 本地（TTL 节流 + 并发去重）；合并后本机更全时回写一次
const syncFromCloud = (opts = {}) => {
  if (!lexiang.isConfigured()) return Promise.resolve({ ok: false, skipped: '乐享未配置' })
  if (!opts.force && lastPull && Date.now() - lastPull < TTL) {
    return Promise.resolve({ ok: true, skipped: '刚拉过' })
  }
  if (pullPromise) return pullPromise
  pullPromise = (async () => {
    try {
      lastPull = Date.now()
      const r = await lexiang.readProgress()
      if (!r.ok) return { ok: false, error: r.error }
      if (!r.data) {
        // 云端还没有进度内容：把本机进度先写上去
        const up = await lexiang.writeProgress(snapshot())
        if (up.ok) console.log('[progress] 学习进度首次上传:', up.action)
        return { ok: up.ok, applied: 0, uploaded: up.ok, error: up.error }
      }
      const changed = mergeKnowledge(r.data.knowledge) +
        mergeAchievements(r.data.achievements)
      if (changed) {
        // 合并后本机比云端全：回写一次，两台手机口径一致
        const up = await lexiang.writeProgress(snapshot())
        if (!up.ok) console.warn('[progress] 合并结果回写失败:', up.error)
      }
      console.log('[progress] 学习进度回填:', changed, '项')
      return { ok: true, applied: changed }
    } catch (e) {
      console.warn('[progress] 学习进度回填异常:', (e && e.message) || e)
      return { ok: false, error: (e && e.message) || '学习进度回填失败' }
    }
  })()
  pullPromise.then(() => { pullPromise = null }).catch(() => { pullPromise = null })
  return pullPromise
}

// 本地 → 云端（防抖：连续答题只写最后一次）
const push = (opts = {}) => {
  if (!lexiang.isConfigured()) return Promise.resolve({ ok: false, skipped: '乐享未配置' })
  const delay = opts.delay !== undefined ? opts.delay : PUSH_DELAY
  if (pushTimer) {
    clearTimeout(pushTimer)
    pushTimer = null
    if (pushResolve) {
      pushResolve({ ok: true, skipped: '已并入下一次上传' })
      pushResolve = null
    }
  }
  return new Promise(resolve => {
    pushResolve = resolve
    pushTimer = setTimeout(async () => {
      pushTimer = null
      pushResolve = null
      try {
        // 写前先拉一次并合并：整块覆盖会把另一台设备刚写的次数冲掉
        const remote = await lexiang.readProgress()
        if (remote && remote.ok && remote.data) {
          mergeKnowledge(remote.data.knowledge)
          mergeAchievements(remote.data.achievements)
        }
        const r = await lexiang.writeProgress(snapshot())
        if (r && r.ok) console.log('[progress] 学习进度已上传:', r.action)
        else console.warn('[progress] 学习进度上传失败:', (r && r.error) || '未知错误')
        resolve(r || { ok: false })
      } catch (e) {
        console.warn('[progress] 学习进度上传异常:', (e && e.message) || e)
        resolve({ ok: false, error: (e && e.message) || '上传失败' })
      }
    }, delay)
  })
}

module.exports = {
  snapshot,
  syncFromCloud,
  push
}
