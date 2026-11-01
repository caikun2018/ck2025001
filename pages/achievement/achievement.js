// pages/achievement/achievement.js
const storage = require('../../services/storage.js')
const fade = require('../../services/fade.js')
const progress = require('../../services/progress.js')

Page({
  data: {
    stats: { faded: 0, challengeCount: 0, streak: 0, total: 0 },
    fadeProgress: 0,
    fadeTarget: 0,
    badges: [
      { name: '知识点攻克', desc: '某知识点错题全部消退', unlocked: false, img: 0 },
      { name: '连续打卡', desc: '连续登录 7 天', unlocked: false, img: 1 },
      { name: '闯关达人', desc: '完成 10 次闯关', unlocked: false, img: 2 },
      { name: '消退大师', desc: '累计消退 20 道错题', unlocked: false, img: 3 },
      { name: '数学小天才', desc: '数学错题消退 10 道', unlocked: false, img: 4 },
      { name: '语文小博士', desc: '语文错题消退 10 道', unlocked: false, img: 5 },
      { name: '英语小达人', desc: '英语错题消退 10 道', unlocked: false, img: 6 },
      { name: '古筝小能手', desc: '完成 5 次古筝练习', unlocked: false, img: 7 },
      { name: '练字小书法家', desc: '完成 5 次练字练习', unlocked: false, img: 8 },
      { name: '坚持之星', desc: '累计练习 30 天', unlocked: false, img: 9 }
    ],
    badgeImages: []
  },

  onLoad() {
    this.setData({ badgeImages: getApp().globalData.badgeImages })
  },

  onShow() {
    this.loadStats()
    // 换手机后先把云端的学习进度（知识点次数 / 成就统计）拉回来，再重算徽章
    progress.syncFromCloud().then(r => {
      if (r && r.applied) this.loadStats()
    }).catch(() => {})
  },

  loadStats() {
    const ach = storage.getAchievements()
    const wrongbook = storage.getWrongbook()
    const fadedCount = wrongbook.filter(w => w.status === '已消退').length
    const totalCount = wrongbook.filter(w => w.status !== '已归档').length
    // 已消退的知识点数：知识点累计答对达标后才算攻克
    const knowledgeFaded = fade.getKnowledgeList().filter(k => k.status === '已消退').length
    const stats = {
      faded: fadedCount,
      challengeCount: ach.stats.challengeCount || 0,
      streak: ach.stats.streak || 0,
      total: totalCount,
      knowledgeFaded
    }
    // 消退进度
    const fadeTarget = totalCount > 0 ? totalCount : 1
    const badges = this.data.badges.map(b => {
      let unlocked = false
      if (b.name === '消退大师' && stats.faded >= 20) unlocked = true
      if (b.name === '闯关达人' && stats.challengeCount >= 10) unlocked = true
      if (b.name === '知识点攻克' && stats.knowledgeFaded > 0) unlocked = true
      return Object.assign({}, b, { unlocked })
    })
    this.setData({ stats, badges, fadeTarget, fadeProgress: fadedCount })
  }
})
