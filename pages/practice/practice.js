// pages/practice/practice.js
const storage = require('../../services/storage.js')
const lexiang = require('../../services/lexiang.js')
const mock = require('../../services/mock.js')
const solution = require('../../services/solution.js')
const util = require('../../utils/util.js')

// 学科选项与闯关页保持一致（全科 + 乐享知识库同步的科目）
const ALL_SUBJECT = lexiang.ALL_SUBJECT

// 消退次数以云端为准：进页面就从云端拉一遍，两次之间至少隔这么久（避免来回切页反复打接口）
const STATES_PULL_GAP = 10 * 1000

Page({
  data: {
    mode: 'original', // original | exam
    statusBarHeight: 20,   // 状态栏高度（px）
    navBarHeight: 44,      // 标题栏自身高度（px）
    navTotal: 64,          // 状态栏 + 标题栏，页面内容从这条线下面开始
    subjects: lexiang.getSubjectOptions(),
    activeSubject: ALL_SUBJECT,
    subjectIndex: 0,
    wrongbook: [],
    filtered: [], // 按当前学科过滤后的错题列表
    syncing: false, // 正在从云端取消退次数：列表先显示「同步中」，拉完再显示次数
    keyword: '',
    selected: {}, // 选中的错题 id
    selectedCount: 0,
    fadeThreshold: 5, // 写死的消退阈值（config.FIXED），onShow 里从 globalData 再同步
    // 考试设置
    examDuration: 30,
    examCount: 10,
    examSubjects: lexiang.getSubjectOptions(),
    examSubject: '数学',
    examSubjectIndex: 0
  },

  onLoad(options) {
    if (options.mode) this.setData({ mode: options.mode })
    this.measureNav()
    this.refreshSubjects()
  },

  // 量状态栏与胶囊按钮，算出标题栏高度（不同机型不一样，写死会错位）
  measureNav() {
    let statusBarHeight = 20
    let navBarHeight = 44
    try {
      const win = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
      statusBarHeight = win.statusBarHeight || 20
      const rect = wx.getMenuButtonBoundingClientRect ? wx.getMenuButtonBoundingClientRect() : null
      if (rect && rect.height) {
        // 胶囊上下留白对称：navBar = 上间隙 * 2 + 胶囊高度
        navBarHeight = (rect.top - statusBarHeight) * 2 + rect.height
      }
    } catch (e) {}
    this.setData({
      statusBarHeight,
      navBarHeight,
      navTotal: statusBarHeight + navBarHeight
    })
  },

  onShow() {
    this.refreshSubjects()
    this.loadWrongbook()
    this.syncWrongStates()
    this.setData({ fadeThreshold: getApp().globalData.fadeThreshold })
    // 无感补齐：把还没有 AI 解题思路的错题接着生成（内部有节流）
    solution.syncPending().catch(() => {})
  },

  onHide() {
    // 离开页面时复位：清掉兜底定时器，同步标记也复位（拉取可能还在飞，回来重新拉一次就行）
    clearTimeout(this._syncTimer)
    this._syncTimer = null
    this._pulling = false
    this._pullingStates = false
    if (this.data.syncing) this.setData({ syncing: false })
  },

  // 科目下拉框随乐享同步结果刷新，保留当前选中项
  refreshSubjects() {
    const subjects = lexiang.getSubjectOptions()
    const activeIdx = Math.max(subjects.indexOf(this.data.activeSubject), 0)
    const examIdx = Math.max(subjects.indexOf(this.data.examSubject), 0)
    this.setData({
      subjects,
      examSubjects: subjects,
      subjectIndex: activeIdx,
      activeSubject: subjects[activeIdx] || ALL_SUBJECT,
      examSubjectIndex: examIdx,
      examSubject: subjects[examIdx] || '数学'
    })
    if (this.data.wrongbook.length) this.applyFilter()
  },

  // app 与乐享同步完科目后会回调这里
  onSubjectsUpdated() {
    this.refreshSubjects()
  },

  // 错题清单（原错题本列表已并入本页）：已消退/已归档的不再出现
  loadWrongbook() {
    let all = storage.getWrongbook()
    if (!all.length) {
      // 本地为空 + 配了乐享：可能是换了手机，先从云端把错题拉回来。
      // 这时绝不铺示例错题（会被当成真错题上传进知识库）
      if (lexiang.isConfigured()) {
        this.pullWrongFromCloud()
        return
      }
      // 只有本机没配乐享才铺示例错题
      all = mock.mockWrongbook()
      storage.setWrongbook(all)
    }
    const list = all.filter(w => w.status !== '已归档' && w.status !== '已消退')
    this.setData({ wrongbook: list })
    this.applyFilter()
  },

  // 「同步中」提示的开 / 关：接口卡住时兜底复位，别让列表一直显示同步中
  beginSyncUI() {
    this.setData({ syncing: true })
    clearTimeout(this._syncTimer)
    this._syncTimer = setTimeout(() => {
      this._pulling = false
      this._pullingStates = false
      if (this.data.syncing) this.setData({ syncing: false })
    }, 20000)
  },

  endSyncUI() {
    clearTimeout(this._syncTimer)
    this._syncTimer = null
    if (this.data.syncing) this.setData({ syncing: false })
  },

  // 本地错题为空时从乐享各科「错题」目录回填（服务内部有节流与并发去重）
  pullWrongFromCloud() {
    if (this._pulling) return
    this._pulling = true
    this.beginSyncUI()
    const subjects = lexiang.getSyncedSubjects()
    let added = 0
    const step = (i) => {
      if (i >= subjects.length) {
        this._pulling = false
        this.endSyncUI()
        if (added) this.loadWrongbook()
        return
      }
      lexiang.syncWrongFromCloud(subjects[i], { maxAge: 60 * 1000 }).then(r => {
        if (r && r.added) added += r.added
        step(i + 1)
      }).catch(() => step(i + 1))
    }
    step(0)
  },

  // 消退次数以云端为准：每次进页面从云端把「次数 / 状态」拉一遍，
  // 拉之前列表显示「同步中…」，拉完再显示次数（另一台设备答对过，这台才不会一直显示 0/5）
  syncWrongStates() {
    if (!lexiang.isConfigured() || this._pulling) return
    if (this._pullingStates) return
    if (this._statesAt && Date.now() - this._statesAt < STATES_PULL_GAP) return
    const subjects = lexiang.getSyncedSubjects()
    if (!subjects.length) return
    this._statesAt = Date.now()
    this._pullingStates = true
    this.beginSyncUI()
    let changed = 0
    const step = (i) => {
      if (i >= subjects.length) {
        this._pullingStates = false
        this.endSyncUI()
        if (changed) this.loadWrongbook()
        return
      }
      lexiang.syncWrongFromCloud(subjects[i], { maxAge: STATES_PULL_GAP }).then(r => {
        if (r) changed += (r.added || 0) + (r.merged || 0)
        step(i + 1)
      }).catch(() => step(i + 1))
    }
    step(0)
  },

  switchMode(e) {
    this.setData({ mode: e.currentTarget.dataset.mode })
  },

  // 学科下拉框切换：列表与已选状态同步切换
  onSubjectChange(e) {
    const idx = Number(e.detail.value) || 0
    this.setData({
      subjectIndex: idx,
      activeSubject: this.data.subjects[idx] || ALL_SUBJECT,
      selected: {},
      selectedCount: 0
    })
    this.applyFilter()
  },

  // 按当前学科 + 关键词过滤错题，已选中的题若被过滤掉则同步取消
  applyFilter() {
    const { wrongbook, activeSubject, keyword } = this.data
    let filtered = activeSubject === ALL_SUBJECT
      ? wrongbook
      : wrongbook.filter(w => w.subject === activeSubject)
    if (keyword) {
      filtered = filtered.filter(w =>
        (w.title || '').includes(keyword) ||
        (w.knowledge || '').includes(keyword) ||
        (w.question || '').includes(keyword)
      )
    }
    const selected = {}
    filtered.forEach(w => {
      if (this.data.selected[w.id]) selected[w.id] = true
    })
    this.setData({ filtered, selected, selectedCount: Object.keys(selected).length })
  },

  onSearch(e) {
    this.setData({ keyword: e.detail.value })
    this.applyFilter()
  },

  toggleSelect(e) {
    const id = e.currentTarget.dataset.id
    const selected = this.data.selected
    if (selected[id]) delete selected[id]
    else selected[id] = true
    this.setData({ selected, selectedCount: Object.keys(selected).length })
  },

  selectAll() {
    const selected = {}
    this.data.filtered.forEach(w => { selected[w.id] = true })
    this.setData({ selected, selectedCount: Object.keys(selected).length })
  },

  // 点题干：看这道错题的详细信息（从详情页再点题干可回到本页）
  goDetail(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: '/pages/wrongdetail/wrongdetail?id=' + id + '&from=practice' })
  },


  // 开始原题练习
  startOriginal() {
    if (this.data.selectedCount === 0) {
      util.toast('请至少选择一道题')
      return
    }
    const ids = Object.keys(this.data.selected)
    const questions = this.data.filtered.filter(w => ids.includes(w.id))
    wx.setStorageSync('ct_practice_questions', questions)
    wx.navigateTo({ url: '/pages/practiceexam/practiceexam?mode=original' })
  },

  // 开始模拟考试
  startExam() {
    const { examSubject, examCount, examDuration } = this.data
    const grade = getApp().globalData.currentGrade
    wx.navigateTo({
      url: `/pages/waitloading/waitloading?subject=${examSubject}&count=${examCount}&grade=${grade}&mode=exam&duration=${examDuration}`
    })
  },

  onExamDurationChange(e) {
    this.setData({ examDuration: e.detail.value })
  },
  onExamCountChange(e) {
    this.setData({ examCount: e.detail.value })
  },
  onExamSubjectChange(e) {
    const idx = parseInt(e.detail.value) || 0
    this.setData({
      examSubjectIndex: idx,
      examSubject: this.data.examSubjects[idx] || '数学'
    })
  }
})
