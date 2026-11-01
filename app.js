// app.js - 错题智练小程序入口
const auth = require('./services/auth.js')
const storage = require('./services/storage.js')
const lexiang = require('./services/lexiang.js')
const progress = require('./services/progress.js')
const appConfig = require('./utils/config.js')

App({
  globalData: {
    userInfo: null,        // 当前登录用户
    currentGrade: '四年级', // 当前年级
    textbook: appConfig.DEFAULT_TEXTBOOK, // 默认教材；实际按学科取（英语沪教版，其余人教版）
    subjects: ['语文', '数学', '英语', '古筝', '练字', '其他'],
    fadeThreshold: appConfig.FIXED.fadeThreshold,   // 消退阈值 N（写死，不参与同步）
    challengeCount: appConfig.FIXED.challengeCount, // 闯关题量（写死，不参与同步）
    llmProvider: 'deepseek',
    llmModel: 'deepseek-chat',
    lexiangConfigured: false,
    fontSize: 28,
    darkMode: false,
    // 等待界面素材（10 张本地预置图）
    waitImages: [
      '/assets/03_等待界面/01_魔法书发光.jpg',
      '/assets/03_等待界面/02_星星魔法棒.jpg',
      '/assets/03_等待界面/03_云朵上看书.jpg',
      '/assets/03_等待界面/04_捧发光书.jpg',
      '/assets/03_等待界面/05_撒星星魔法.jpg',
      '/assets/03_等待界面/06_书堆中读书.jpg',
      '/assets/03_等待界面/07_提灯笼夜行.jpg',
      '/assets/03_等待界面/08_吹泡泡.jpg',
      '/assets/03_等待界面/09_浇灌知识花.jpg',
      '/assets/03_等待界面/10_骑飞马飞翔.jpg'
    ],
    // 主角色表情
    charImages: {
      happy: '/assets/01_主角色/表情动作/01_开心跳跃庆祝.jpg',
      sad: '/assets/01_主角色/表情动作/02_失落疑惑挠头.jpg',
      think: '/assets/01_主角色/表情动作/03_思考灵感灯泡.jpg',
      cheer: '/assets/01_主角色/表情动作/04_加油鼓劲握拳.jpg',
      star: '/assets/01_主角色/表情动作/05_抱星星开心.jpg',
      read: '/assets/01_主角色/表情动作/06_认真读书.jpg',
      magic: '/assets/01_主角色/表情动作/07_举魔法棒施法.jpg',
      wink: '/assets/01_主角色/表情动作/08_比耶wink.jpg'
    },
    // 闯关场景
    levelImages: [
      '/assets/02_闯关场景/01_森林小径关卡.jpg',
      '/assets/02_闯关场景/02_糖果城堡关卡.jpg',
      '/assets/02_闯关场景/03_星空云朵关卡.jpg',
      '/assets/02_闯关场景/04_海底世界关卡.jpg',
      '/assets/02_闯关场景/05_魔法图书馆关卡.jpg',
      '/assets/02_闯关场景/06_彩虹山坡关卡.jpg',
      '/assets/02_闯关场景/07_云朵王国关卡.jpg',
      '/assets/02_闯关场景/08_玩具乐园关卡.jpg',
      '/assets/02_闯关场景/09_花园仙境关卡.jpg',
      '/assets/02_闯关场景/10_月亮城堡关卡.jpg'
    ],
    // 成就徽章
    badgeImages: [
      '/assets/04_成就徽章/01_知识点攻克.jpg',
      '/assets/04_成就徽章/02_连续打卡.jpg',
      '/assets/04_成就徽章/03_闯关达人.jpg',
      '/assets/04_成就徽章/04_消退大师.jpg',
      '/assets/04_成就徽章/05_数学小天才.jpg',
      '/assets/04_成就徽章/06_语文小博士.jpg',
      '/assets/04_成就徽章/07_英语小达人.jpg',
      '/assets/04_成就徽章/08_古筝小能手.jpg',
      '/assets/04_成就徽章/09_练字小书法家.jpg',
      '/assets/04_成就徽章/10_坚持之星.jpg'
    ]
  },

  onLaunch() {
    // 初始化云开发（用于乐享 API 代理云函数，真机直连会被乐享 WAF 拦截）
    const config = require('./utils/config.js')
    if (config.CLOUD_ENV_ID && config.CLOUD_ENV_ID !== 'your-cloud-env-id' && wx.cloud) {
      wx.cloud.init({ env: config.CLOUD_ENV_ID, traceUser: true })
    }

    // 消退阈值 / 闯关题量 / 教材是写死的（见 utils/config.js 的 FIXED），不从本地配置读，
    // 老配置里残留的数值也不会再生效
    this.globalData.fadeThreshold = appConfig.FIXED.fadeThreshold
    this.globalData.challengeCount = appConfig.FIXED.challengeCount
    this.globalData.textbook = appConfig.DEFAULT_TEXTBOOK

    // 读取本地缓存的用户配置（只有显示相关项是可调的）
    const cfg = storage.getConfig()
    if (cfg) {
      this.globalData.fontSize = cfg.fontSize || 28
      this.globalData.darkMode = cfg.darkMode || false
      // 从模型连接列表同步当前激活的模型
      const conn = storage.getActiveConnection()
      if (conn) {
        this.globalData.llmProvider = conn.name
        this.globalData.llmModel = conn.model
      } else {
        this.globalData.llmProvider = cfg.llmProvider || 'deepseek'
        this.globalData.llmModel = cfg.llmModel || 'deepseek-chat'
      }
    }
    // 检查登录态
    const user = auth.getCachedUser()
    if (user) {
      this.globalData.userInfo = user
      this.globalData.currentGrade = user.grade || '四年级'
    }
    // 科目清单：先用上次同步的缓存，页面渲染不会空
    this.globalData.subjects = lexiang.getSyncedSubjects()
    this.globalData.subjectOptions = lexiang.getSubjectOptions()
    // 应用显示设置（字体/夜间模式），并监听页面切换重新应用
    this.applyDisplaySettings()
    wx.onAppRoute(() => {
      setTimeout(() => this.applyDisplaySettings(), 80)
    })
    // 每次启动小程序自动同步一次（登录后、后台静默执行）
    if (user) {
      setTimeout(() => { this.silentSync() }, 1200)
      // 打开软件即与乐享同步科目清单（新增/改名的科目会更新到各页面下拉框）
      setTimeout(() => { this.syncSubjects({ force: true }) }, 600)
      // 学习进度（知识点累计次数 / 成就统计）：云端 → 本地
      setTimeout(() => { progress.syncFromCloud().catch(() => {}) }, 2000)
      // 预生成题库：按各科错题和知识点在后台出题并写进乐享「题库」页，答题时秒取
      this.warmQuestionBank(4000)
    }
  },

  onShow() {
    // 每次从后台回到小程序也自动同步（autoSync 内部有节流，不会重复请求）
    const user = this.globalData.userInfo || auth.getCachedUser()
    if (user) {
      setTimeout(() => { this.silentSync() }, 500)
      setTimeout(() => { this.syncSubjects() }, 800)
      setTimeout(() => { progress.syncFromCloud().catch(() => {}) }, 1500)
      // 回到小程序继续补题（bank 内部有单飞 + 3 分钟节流，不会重复烧请求）
      this.warmQuestionBank(6000)
    }
  },

  // 后台同步：带可见提示（导航栏转圈 + 当前页 onSyncState 回调），有变化时轻提示
  // 单飞：启动与回前台都调也不会叠出多条
  silentSync() {
    if (this._syncing) return this._syncing
    this.setSyncIndicator(true)
    this._syncing = lexiang.autoSync()
      .catch(() => ({ ok: false, synced: 0 }))
      .then(r => {
        this._syncing = null
        this.setSyncIndicator(false)
        // 只有真的同步了内容才提示，避免每次进小程序都弹
        if (r && r.ok && r.synced > 0) {
          try { wx.showToast({ title: '已同步 ' + r.synced + ' 项', icon: 'none', duration: 1500 }) } catch (e) {}
        }
        return r
      })
    return this._syncing
  },

  // 同步中提示：开始只通知当前页（避免旧页面残留），结束通知全部页面
  setSyncIndicator(on) {
    try {
      if (on) wx.showNavigationBarLoading()
      else wx.hideNavigationBarLoading()
    } catch (e) {}
    try {
      const pages = getCurrentPages() || []
      const targets = on ? pages.slice(-1) : pages
      targets.forEach(p => {
        if (p && typeof p.onSyncState === 'function') {
          try { p.onSyncState(!!on) } catch (e) {}
        }
      })
    } catch (e) {}
  },

  onHide() {
    // 退到后台：把还在防抖等待的学习进度立刻写一次，别让这次答题白练
    progress.push({ delay: 0 }).catch(() => {})
  },

  // 后台预热题库：等错题同步完成后再跑，避免和同步抢请求
  warmQuestionBank(delay) {
    setTimeout(() => {
      try {
        require('./services/bank.js').warmUp().catch(e => {
          console.warn('[app] 题库预热失败:', (e && e.message) || e)
        })
      } catch (e) {
        console.warn('[app] 题库预热异常:', (e && e.message) || e)
      }
    }, delay || 4000)
  },

  // 与乐享知识库同步科目清单；同步完成后刷新已打开页面的科目下拉框
  syncSubjects(options = {}) {
    return lexiang.refreshSubjects(options).then(r => {
      if (!r || !r.ok) return r
      this.globalData.subjects = lexiang.getSyncedSubjects()
      this.globalData.subjectOptions = lexiang.getSubjectOptions()
      getCurrentPages().forEach(p => {
        if (p && typeof p.onSubjectsUpdated === 'function') {
          try {
            p.onSubjectsUpdated(this.globalData.subjectOptions)
          } catch (e) {
            console.warn('[app] 页面刷新科目失败:', (e && e.message) || e)
          }
        }
      })
      return r
    }).catch(e => {
      console.warn('[app] 科目同步失败:', (e && e.message) || e)
      return { ok: false }
    })
  },

  // 应用全局显示设置：字体大小 + 夜间模式
  // 方案：把 CSS 变量 + 直接属性拼成 style 字符串，注入到当前页面根 view 的 style 属性
  applyDisplaySettings() {
    const fs = this.globalData.fontSize
    const dark = this.globalData.darkMode
    let bg, card, text, textLight, border, inputBg, shadow
    if (dark) {
      bg = '#1a1625'; card = '#2a2438'; text = '#e8e4f0'
      textLight = '#9a93a8'; border = '#3d3550'; inputBg = '#2a2438'
      shadow = '0 4rpx 16rpx rgba(0,0,0,0.4)'
    } else {
      bg = '#F5F0FF'; card = '#FFFFFF'; text = '#333333'
      textLight = '#888888'; border = '#E8E0F5'; inputBg = '#F8F5FF'
      shadow = '0 6rpx 24rpx rgba(123,94,167,0.08)'
    }
    // 最小字号兜底 26rpx：任何页面文字都不小于底部 tabBar 的视觉大小
    const fsSm = Math.max(26, Math.round(fs * 0.94))
    const style = `background:${bg};color:${text};font-size:${fs}rpx;min-height:100vh;` +
      `--fs:${fs}rpx;--fs-sm:${fsSm}rpx;--bg:${bg};--card:${card};--text:${text};` +
      `--text-light:${textLight};--border:${border};--input-bg:${inputBg};--shadow:${shadow};`
    this.globalData.pageStyle = style
    // 尝试 setPageStyle（部分版本不支持，失败则走 fallback）
    try {
      wx.setPageStyle({ style, fail: () => {} })
    } catch (e) {}
    // Fallback：给当前页 setData（仅在页面已就绪时）
    try {
      const pages = getCurrentPages()
      const current = pages[pages.length - 1]
      if (current && current.route && typeof current.setData === 'function') {
        current.setData({ pageStyle: style })
      }
    } catch (e) {
      console.warn('[app] applyDisplaySettings setData failed:', e.message)
    }
  },

  // 随机取一张等待图
  randomWaitImage() {
    const list = this.globalData.waitImages
    return list[Math.floor(Math.random() * list.length)]
  },

  // 随机取一张关卡图
  randomLevelImage() {
    const list = this.globalData.levelImages
    return list[Math.floor(Math.random() * list.length)]
  }
})
