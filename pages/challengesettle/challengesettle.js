// pages/challengesettle/challengesettle.js
const storage = require('../../services/storage.js')
const lexiang = require('../../services/lexiang.js')
const solution = require('../../services/solution.js')
const progress = require('../../services/progress.js')
const util = require('../../utils/util.js')

Page({
  data: {
    subject: '',
    score: 0,
    correct: 0,
    total: 0,
    wrongCount: 0,
    wrongQuestions: [],
    charImg: '',
    comment: '',
    stars: 0
  },

  onLoad(options) {
    const app = getApp()
    const score = parseInt(options.score)
    const correct = parseInt(options.correct)
    const total = parseInt(options.total)
    const rate = correct / total
    let stars = 1
    if (rate >= 0.6) stars = 2
    if (rate >= 0.9) stars = 3

    const wrongQuestions = wx.getStorageSync('ct_challenge_wrong') || []
    let charImg = app.globalData.charImages.star
    let comment = '继续加油！'
    if (rate >= 0.9) { comment = '太厉害啦！你是闯关小达人！'; charImg = app.globalData.charImages.happy }
    else if (rate >= 0.6) { comment = '不错哦，再接再厉！'; charImg = app.globalData.charImages.wink }
    else { comment = '没关系，错题就是进步的阶梯！'; charImg = app.globalData.charImages.cheer }

    this.setData({
      subject: options.subject,
      score, correct, total,
      wrongCount: parseInt(options.wrongCount),
      wrongQuestions,
      charImg, comment, stars
    })

    // 更新闯关成就统计
    const ach = storage.getAchievements()
    ach.stats.challengeCount = (ach.stats.challengeCount || 0) + 1
    storage.setAchievements(ach)
    // 成就统计同步到乐享「学习进度」页（内部防抖，换手机不丢）
    progress.push().catch(() => {})
  },

  // 确认新错题入库
  confirmWrongToBook() {
    if (!this.data.wrongQuestions.length) {
      this.goBack()
      return
    }
    const list = storage.getWrongbook()
    const newList = this.data.wrongQuestions.concat(list)
    storage.setWrongbook(newList)
    util.toast(`已存入 ${this.data.wrongQuestions.length} 道错题`, 'success')
    // 闯关完成：统一走自动同步（会自动标记已同步，避免重复创建）
    lexiang.autoSync({ force: true }).catch(() => {})
    // 无感补齐新错题的 AI 解题思路：生成后存本地并发乐享，下次点开直接看
    solution.syncPending({ force: true }).catch(() => {})
    this.goBack()
  },

  // 跳过入库
  skipWrong() {
    // 闯关完成：即使不入库也同步一次
    lexiang.autoSync().catch(() => {})
    this.goBack()
  },

  goBack() {
    wx.removeStorageSync('ct_challenge_wrong')
    wx.switchTab({ url: '/pages/challenge/challenge' })
  }
})
