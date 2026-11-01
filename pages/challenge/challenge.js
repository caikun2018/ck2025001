// pages/challenge/challenge.js
const storage = require('../../services/storage.js')
const lexiang = require('../../services/lexiang.js')
const llm = require('../../services/llm.js')
const solution = require('../../services/solution.js')
const config = require('../../utils/config.js')

// 科目清单由乐享知识库同步得到（含全科），与练习页、错题本共用同一份
// 关卡全部开放，不做解锁限制；关卡之间按知识点范围递进
const LEVELS = [
  { id: 1, name: '森林小径', stars: 0 },
  { id: 2, name: '糖果城堡', stars: 0 },
  { id: 3, name: '星空云朵', stars: 0 },
  { id: 4, name: '海底世界', stars: 0 },
  { id: 5, name: '魔法图书馆', stars: 0 },
  { id: 6, name: '彩虹山坡', stars: 0 },
  { id: 7, name: '云朵王国', stars: 0 },
  { id: 8, name: '玩具乐园', stars: 0 },
  { id: 9, name: '花园仙境', stars: 0 },
  { id: 10, name: '月亮城堡', stars: 0 }
]

// 每关的知识点范围提示
const scopeTip = (pool, levelId) => {
  if (!pool.length) return '年级基础题'
  const scope = llm.levelScope(pool, levelId)
  // 知识点本身不够多时，各高关卡覆盖范围会重合
  if (!scope.length || scope.length >= pool.length) return '全部知识点'
  const names = scope.join('、')
  return '知识点：' + (names.length > 12 ? names.slice(0, 11) + '…' : names)
}

Page({
  data: {
    subjects: lexiang.getSubjectOptions(),
    activeSubject: '数学',
    subjectIndex: 0,
    levelProgress: { current: 1, stars: 0 },
    challengeCount: config.FIXED.challengeCount, // 写死的题量（5），onShow 里再与 globalData 对齐
    levels: [],
    charImg: ''
  },

  onLoad() {
    const subjects = lexiang.getSubjectOptions()
    const mathIdx = subjects.indexOf('数学')
    this.setData({
      charImg: getApp().globalData.charImages.cheer,
      subjects,
      activeSubject: mathIdx >= 0 ? '数学' : subjects[0],
      subjectIndex: mathIdx >= 0 ? mathIdx : 0
    })
    this.refreshLevels()
  },

  onShow() {
    const lp = storage.getLevelProgress()
    this.setData({ levelProgress: lp, challengeCount: getApp().globalData.challengeCount })
    this.refreshSubjects()
    this.refreshLevels()
    // 无感补齐：把上轮没生成完的 AI 解题思路接着生成（内部有节流与重试上限）
    solution.syncPending().catch(() => {})
  },

  // 科目下拉框随乐享同步结果刷新，保留当前选中项
  refreshSubjects() {
    const subjects = lexiang.getSubjectOptions()
    const current = this.data.activeSubject
    const idx = subjects.indexOf(current)
    const next = idx >= 0 ? current : subjects[0]
    this.setData({
      subjects,
      activeSubject: next,
      subjectIndex: idx >= 0 ? idx : 0
    })
    if (next !== current) this.refreshLevels()
  },

  // app 与乐享同步完科目后会回调这里
  onSubjectsUpdated() {
    this.refreshSubjects()
  },

  // 按当前学科的知识点池刷新各关的知识点范围
  refreshLevels() {
    const pool = llm.knowledgePool(this.data.activeSubject)
    const levels = LEVELS.map(l => Object.assign({}, l, { scopeTip: scopeTip(pool, l.id) }))
    this.setData({ levels })
  },

  // 学科下拉框切换
  onSubjectChange(e) {
    const idx = Number(e.detail.value) || 0
    const subject = this.data.subjects[idx] || '数学'
    this.setData({ subjectIndex: idx, activeSubject: subject })
    this.refreshLevels()
  },

  startChallenge(e) {
    const level = e.currentTarget.dataset.level
    const subject = this.data.activeSubject
    const count = getApp().globalData.challengeCount
    const grade = getApp().globalData.currentGrade
    wx.navigateTo({
      url: `/pages/waitloading/waitloading?subject=${subject}&count=${count}&grade=${grade}&mode=challenge&level=${level.id}`
    })
  },

  // 快速开始
  quickStart() {
    const subject = this.data.activeSubject
    const count = getApp().globalData.challengeCount
    const grade = getApp().globalData.currentGrade
    wx.navigateTo({
      url: `/pages/waitloading/waitloading?subject=${subject}&count=${count}&grade=${grade}&mode=challenge&level=1`
    })
  }
})
