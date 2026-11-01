// pages/wrongdetail/wrongdetail.js
const storage = require('../../services/storage.js')
const lexiang = require('../../services/lexiang.js')
const solution = require('../../services/solution.js')
const fade = require('../../services/fade.js')
const util = require('../../utils/util.js')

Page({
  data: {
    item: null,
    showAnswer: false,
    showRecords: false,
    fadeThreshold: 5, // 写死的消退阈值，onLoad 里用 fade.getThreshold() 覆盖
    knowledgeItem: null,
    knowledgeTip: '',
    aiSolution: '',
    solutionLoading: false,
    // 是否从「练习 → 原题练习」点题干进来（再点题干返回）
    fromPractice: false
  },

  onLoad(options) {
    const id = options.id
    const list = storage.getWrongbook()
    const item = list.find(w => w.id === id)
    const diffMap = { '基础': 'basic', '中档': 'mid', '难': 'hard' }
    if (item) item.diffClass = diffMap[item.difficulty] || 'basic'
    const knowledgeItem = item ? fade.getKnowledgeItem(item.subject, item.knowledge || item.title) : null
    const threshold = fade.getThreshold()
    this.setData({
      item,
      fromPractice: options.from === 'practice',
      fadeThreshold: threshold,
      knowledgeItem,
      knowledgeTip: knowledgeItem && knowledgeItem.status === '已消退'
        ? '这个知识点已消退，之后不再出题'
        : '同一知识点的不同题目累计答对 ' + threshold + ' 次即消退',
      aiSolution: (item && item.aiSolution) || ''
    })
    // 已生成过就直接展示，没有则让 AI 现场生成
    if (item && !item.aiSolution) this.generateSolution()
  },

  onShow() {
    // 后台补齐的思路（或云端回填的消退次数）可能已经写进本地，回到页面直接刷新
    const item = this.data.item
    if (!item) return
    const latest = (storage.getWrongbook() || []).find(w => w.id === item.id)
    if (!latest) return
    const patch = {}
    const next = Object.assign({}, item)
    if (typeof latest.correctCount === 'number' && latest.correctCount !== item.correctCount) {
      next.correctCount = latest.correctCount
      patch.item = next
    }
    if (latest.aiSolution && latest.aiSolution !== this.data.aiSolution && !this.data.solutionLoading) {
      next.aiSolution = latest.aiSolution
      patch.item = next
      patch.aiSolution = latest.aiSolution
    }
    if (Object.keys(patch).length) this.setData(patch)
  },

  // AI 解题思路：优先用本地缓存（闯关时已后台生成并发到乐享），没有才现场生成
  // force = true 时重新生成一份，并把新版写回本地与乐享
  generateSolution(force) {
    const item = this.data.item
    if (!item || this.data.solutionLoading) return
    if (item.aiSolution && !force) {
      this.setData({ aiSolution: item.aiSolution })
      return
    }
    this.setData({ solutionLoading: true })
    solution.generateFor(item.id, { force: !!force }).then(text => {
      this.setData({ aiSolution: text || '', solutionLoading: false })
    }).catch(err => {
      console.warn('[wrongdetail] 生成解题思路失败:', err && err.message)
      this.setData({
        aiSolution: item.analysis || '暂时没能生成解题思路，请稍后重试。',
        solutionLoading: false
      })
    })
  },

  regenerateSolution() {
    if (this.data.solutionLoading) return
    this.generateSolution(true)
  },

  // 题干卡片：从原题练习进来的，再点一下就回练习页
  onQuestionTap() {
    if (!this.data.fromPractice) return
    wx.navigateBack()
  },

  toggleAnswer() {
    this.setData({ showAnswer: !this.data.showAnswer })
  },

  toggleRecords() {
    this.setData({ showRecords: !this.data.showRecords })
  },

  // 编辑
  onEdit() {
    util.toast('编辑功能开发中')
  },

  // 归档（无物理删除，移入归档）
  async onDelete() {
    const ok = await util.confirm('确认移出错题本？该题将被归档，不再出现在默认视图。')
    if (!ok) return
    const list = storage.getWrongbook()
    const idx = list.findIndex(w => w.id === this.data.item.id)
    if (idx >= 0) {
      list[idx].status = '已归档'
      storage.setWrongbook(list)
      // 异步回写乐享
      lexiang.archiveWrong(this.data.item.id, 'archive-folder-id').catch(() => {})
    }
    util.toast('已归档', 'success')
    setTimeout(() => wx.navigateBack(), 800)
  },

  // 只练这一道：作为本次原题练习的唯一题目
  onPractice() {
    wx.setStorageSync('ct_practice_questions', [this.data.item])
    wx.navigateTo({ url: '/pages/practiceexam/practiceexam?mode=original' })
  }
})
