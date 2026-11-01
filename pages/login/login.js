// pages/login/login.js
const auth = require('../../services/auth.js')
const util = require('../../utils/util.js')

Page({
  data: {
    username: '',
    password: '',
    rememberMe: true,
    loading: false
  },

  onLoad() {
    // 已登录则直接跳转
    if (auth.isLoggedIn()) {
      this.goHome()
      return
    }
    // 回填记住的账号名（密码不存本地，需要重新输入）
    const cred = auth.getSavedCredentials()
    if (cred) {
      this.setData({
        username: cred.username || '',
        password: '',
        rememberMe: true
      })
    }
  },

  onUsernameInput(e) {
    this.setData({ username: e.detail.value })
  },
  onPasswordInput(e) {
    this.setData({ password: e.detail.value })
  },
  onRememberChange(e) {
    this.setData({ rememberMe: e.detail.value })
  },

  onLogin() {
    const { username, password, rememberMe } = this.data
    if (!username || !password) {
      util.toast('请输入用户名和密码')
      return
    }
    this.setData({ loading: true })
    const res = auth.login(username, password, rememberMe)
    this.setData({ loading: false })
    if (res.success) {
      const app = getApp()
      app.globalData.userInfo = res.user
      app.globalData.currentGrade = res.user.grade
      // 登录后立刻和乐享同步科目清单，各页面下拉框用知识库里的科目
      if (typeof app.syncSubjects === 'function') app.syncSubjects({ force: true })
      util.toast('登录成功', 'success')
      setTimeout(() => this.goHome(), 800)
    } else {
      util.toast(res.message)
    }
  },

  goHome() {
    wx.switchTab({ url: '/pages/assistant/assistant' })
  }
})
