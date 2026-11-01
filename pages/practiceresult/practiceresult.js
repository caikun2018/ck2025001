// pages/practiceresult/practiceresult.js
const storage = require('../../services/storage.js')
const lexiang = require('../../services/lexiang.js')
const solution = require('../../services/solution.js')
const util = require('../../utils/util.js')

Page({
  data: {
    mode: 'original',
    correct: 0,
    total: 0,
    wrongQuestions: [],
    charImg: ''
  },

  onLoad(options) {
    const app = getApp()
    const correct = parseInt(options.correct)
    const total = parseInt(options.total)
    const rate = correct / total
    let charImg = app.globalData.charImages.star
    if (rate >= 0.9) charImg = app.globalData.charImages.happy
    else if (rate < 0.6) charImg = app.globalData.charImages.sad

    const wrongQuestions = options.mode === 'exam' ? (wx.getStorageSync('ct_exam_wrong') || []) : []

    this.setData({
      mode: options.mode,
      correct, total,
      wrongQuestions,
      charImg
    })
  },

  confirmWrong() {
    if (!this.data.wrongQuestions.length) { this.goBack(); return }
    const list = storage.getWrongbook()
    storage.setWrongbook(this.data.wrongQuestions.concat(list))
    // 练习完成：统一走自动同步（自动标记已同步，避免重复创建）
    lexiang.autoSync({ force: true }).catch(() => {})
    // 无感补齐新错题的 AI 解题思路
    solution.syncPending({ force: true }).catch(() => {})
    util.toast(`已存入 ${this.data.wrongQuestions.length} 道错题`, 'success')
    this.goBack()
  },

  goBack() {
    wx.removeStorageSync('ct_exam_wrong')
    // 练习结束离开页面时也静默同步一次
    lexiang.autoSync().catch(() => {})
    wx.switchTab({ url: '/pages/practice/practice' })
  }
})
