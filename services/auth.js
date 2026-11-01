// services/auth.js - 账号认证
const config = require('../utils/config.js')
const storage = require('./storage.js')

// 校验账号密码（预设账号）
// remember=true 时只把账号名写入本地缓存，下次打开回填账号（密码不落盘）
const login = (username, password, remember = true) => {
  const account = config.PRESET_ACCOUNTS.find(a => a.username === username && a.password === password)
  if (!account) {
    return { success: false, message: '用户名或密码错误' }
  }
  const user = {
    username: account.username,
    grade: account.grade,
    loginAt: Date.now()
  }
  storage.setUser(user)
  if (remember) {
    storage.setSavedCredentials({ username })
  } else {
    storage.clearSavedCredentials()
  }
  return { success: true, user }
}

// 获取本地缓存的用户（自动登录用）
const getCachedUser = () => storage.getUser()

// 获取记住的账号密码（用于登录页回填）
const getSavedCredentials = () => storage.getSavedCredentials()

// 退出登录（保留记住的账号密码，方便下次直接登录）
const logout = () => {
  storage.clearUser()
}

// 是否已登录
const isLoggedIn = () => !!storage.getUser()

module.exports = { login, getCachedUser, getSavedCredentials, logout, isLoggedIn }
