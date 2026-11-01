// pages/waitloading/waitloading.js
// 出题等待页：优先用启动时预生成好的题库（秒开），题库不够才现场补
const llm = require('../../services/llm.js')
const storage = require('../../services/storage.js')
const lexiang = require('../../services/lexiang.js')
const bank = require('../../services/bank.js')
const memory = require('../../services/memory.js')
const util = require('../../utils/util.js')

const ALL_SUBJECT = '全科'

Page({
  data: {
    subject: '',
    count: 10,
    grade: '',
    mode: 'challenge', // challenge | exam
    level: 1,
    bgImage: '',
    loadingText: 'AI 正在出题中...',
    progress: 0
  },

  onLoad(options) {
    const app = getApp()
    // 出题是异步的：记住页面是否还在，一旦返回就作废这次出题
    this._alive = true
    this._navigated = false
    this._seeded = []
    this.setData({
      subject: options.subject || '数学',
      count: parseInt(options.count) || 10,
      grade: options.grade || app.globalData.currentGrade,
      mode: options.mode || 'challenge',
      level: parseInt(options.level) || 1,
      bgImage: app.randomWaitImage()
    })
    this.start()
  },

  // 先看题库：打开小程序时已经按错题和知识点预生成好了
  start() {
    const pack = bank.take(this.data.subject, this.data.count, { level: this.data.level })
    const seeded = (pack && pack.questions) || []
    // 记下取走的题：中途返回时退回题库，别让预生成的题白白丢掉
    this._seeded = seeded
    if (seeded.length >= this.data.count) {
      console.log('[waitloading] 题库直接命中:', this.data.subject, seeded.length, '道')
      this.finish(seeded.slice(0, this.data.count), '题库已备好，马上开始...')
      return
    }
    // 题库不够：能用的先用上，剩下的现场出
    this.generateNow(seeded)
  },

  // 题库没货时现场生成（首次使用、刚换年级、知识点刚变化都会走到这里）
  generateNow(seeded) {
    const isAll = this.data.subject === ALL_SUBJECT
    const need = this.data.count - seeded.length
    const texts = seeded.length
      ? [
          '题库里已有 ' + seeded.length + ' 道，再补 ' + need + ' 道...',
          isAll ? '汇总各科错题知识点...' : '分析错题薄弱点...',
          '举一反三生成题目...',
          '匹配年级难度...',
          '马上就好啦...'
        ]
      : [
          'AI 正在出题中...',
          isAll ? '汇总各科错题知识点...' : '分析错题薄弱点...',
          '举一反三生成题目...',
          '匹配年级难度...',
          '马上就好啦...'
        ]
    let progress = seeded.length ? Math.min(seeded.length / this.data.count * 100, 60) : 0
    let textIdx = 0
    this.setData({ progress, loadingText: texts[0] })
    this._timer = setInterval(() => {
      progress += Math.random() * 15 + 5
      if (progress >= 95) progress = 95
      if (progress > (textIdx + 1) * 20 && textIdx < texts.length - 1) {
        textIdx++
        this.setData({ loadingText: texts[textIdx] })
      }
      this.setData({ progress })
    }, 300)

    // 调 LLM 出题：全科时汇总乐享知识库里所有科目（含同步到的科目）的错题
    const subjectPool = isAll ? lexiang.getSyncedSubjects() : [this.data.subject]
    const wrongbook = storage.getWrongbook().filter(w => subjectPool.indexOf(w.subject) >= 0)
    // 闯关按关卡限定知识点范围；模拟考试参考闯关中等难度（中间关卡的知识点范围 + 中档难度）
    const isExam = this.data.mode !== 'challenge'
    const level = isExam ? llm.EXAM_LEVEL : this.data.level
    const difficulty = isExam ? '中档' : ''
    // 出题前先把各科云端「学习记忆」的知识点回填到本地：知识点库是必考来源之一
    memory.syncAll(subjectPool)
      .catch(() => null)
      .then(() => {
        if (!this._alive) return null
        return llm.generateQuestions(this.data.subject, need, this.data.grade, wrongbook, level, difficulty, {
          // 孩子已经返回了：别再让模型补第二遍题，安静收工
          shouldStop: () => !this._alive
        })
      })
      .then(questions => {
        if (!this._alive) return
        clearInterval(this._timer)
        this._timer = null
        this.finish(seeded.concat(questions || []))
      })
      .catch(() => {
        if (!this._alive) return
        clearInterval(this._timer)
        this._timer = null
        // 现场出题失败但题库里还有货：先用题库的题，别让孩子白等
        if (seeded.length) {
          this.finish(seeded)
          return
        }
        util.toast('出题失败，请重试')
        setTimeout(() => this.back(), 1000)
      })
  },

  // 收尾：写缓存 → 稍后跳答题页（跳之前才补题库，返回了就不补）
  finish(questions, doneText) {
    if (!this._alive) return
    const list = (questions || []).map((q, i) => Object.assign({}, q, {
      id: 'q' + i,
      subject: q.subject || this.data.subject,
      knowledge: q.knowledge || this.data.subject
    }))
    if (list.length) {
      wx.setStorageSync('ct_generated_questions', {
        subject: this.data.subject,
        count: this.data.count,
        grade: this.data.grade,
        questions: list,
        ts: Date.now()
      })
    }
    this._used = list
    this.setData({ progress: 100, loadingText: doneText || '出题完成！' })
    // 这 600ms 里孩子点了返回，就不再跳答题页
    this._goTimer = setTimeout(() => this.goNext(), 600)
  },

  goNext() {
    if (!this._alive) return
    this._navigated = true
    // 题已经出掉、答题页马上接手，按同知识点补回来；知识点消退的题不再补
    bank.refillAfterUse(this.data.subject, this._used || []).catch(() => {})
    if (this.data.mode === 'challenge') {
      wx.redirectTo({
        url: `/pages/challengeplay/challengeplay?subject=${this.data.subject}&level=${this.data.level}`,
        fail: () => { this._navigated = false }
      })
    } else {
      wx.redirectTo({
        url: `/pages/practiceexam/practiceexam?subject=${this.data.subject}&count=${this.data.count}`,
        fail: () => { this._navigated = false }
      })
    }
  },

  // 出错退回上一页：页面已经走了就别再退（会多退一层）
  back() {
    if (!this._alive) return
    wx.navigateBack()
  },

  onUnload() {
    this._alive = false
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
    if (this._goTimer) {
      clearTimeout(this._goTimer)
      this._goTimer = null
    }
    // 正常跳到答题页：题目已被答题页取走，什么都不用清
    if (this._navigated) return
    // 中途返回：作废这次出题，取走的题退回题库，半成品题目缓存清掉
    if (this._seeded && this._seeded.length) {
      const n = bank.putBack(this.data.subject, this._seeded)
      console.log('[waitloading] 出题中途返回，退回题库', n, '道')
    }
    this._seeded = []
    try {
      wx.removeStorageSync('ct_generated_questions')
    } catch (e) {}
    console.log('[waitloading] 已取消本次出题')
  }
})
