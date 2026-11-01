// utils/util.js - 通用工具函数

const formatTime = date => {
  const year = date.getFullYear()
  const month = date.getMonth() + 1
  const day = date.getDate()
  const hour = date.getHours()
  const minute = date.getMinutes()
  const second = date.getSeconds()
  return `${[year, month, day].map(n => n.toString().padStart(2, '0')).join('-')} ${[hour, minute, second].map(n => n.toString().padStart(2, '0')).join(':')}`
}

const formatDate = date => {
  const year = date.getFullYear()
  const month = date.getMonth() + 1
  const day = date.getDate()
  return `${year}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`
}

// 年月日时分秒（会话文件名用）
const timestamp = () => {
  const d = new Date()
  const pad = n => n.toString().padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

// 生成唯一 id
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8)

// 防抖
const debounce = (fn, wait = 300) => {
  let timer = null
  return function (...args) {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => fn.apply(this, args), wait)
  }
}

// 提示
const toast = (title, icon = 'none') => {
  wx.showToast({ title, icon, duration: 2000 })
}

// 确认弹窗
const confirm = (content, title = '提示') => {
  return new Promise(resolve => {
    wx.showModal({
      title, content,
      success: res => resolve(res.confirm),
      fail: () => resolve(false)
    })
  })
}

// ===== 语音答案规整 =====
// 孩子口算常把数字说成中文（「三十五」），这里统一转成阿拉伯数字再判题
const CN_DIGIT = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
const CN_UNIT = { 十: 10, 百: 100, 千: 1000, 万: 10000 }

// 纯中文数字（可带「点」小数）转阿拉伯数字；不是纯数字时原样返回
const cnNumberToArabic = str => {
  if (!/^[零〇一二两三四五六七八九十百千万点负]+$/.test(str)) return str
  const negative = str[0] === '负'
  const body = negative ? str.slice(1) : str
  const parts = body.split('点')
  const intPart = parts[0] || ''
  const decPart = parts[1] || ''

  let total = 0
  let section = 0
  let number = 0
  for (const ch of intPart) {
    if (CN_DIGIT[ch] !== undefined) {
      number = CN_DIGIT[ch]
      continue
    }
    const unit = CN_UNIT[ch]
    if (unit === 10000) {
      section = (section + number) * unit
      total += section
      section = 0
      number = 0
    } else {
      section += (number || 1) * unit
      number = 0
    }
  }
  let out = String(total + section + number)
  if (decPart) {
    const dec = decPart.split('').map(c => (CN_DIGIT[c] !== undefined ? CN_DIGIT[c] : '')).join('')
    if (dec) out += '.' + dec
  }
  return (negative ? '-' : '') + out
}

// 语音识别结果 → 可直接判题的答案：去口语、去标点、中文数字转阿拉伯
const speechToAnswer = text => {
  let s = String(text || '').trim()
  if (!s) return ''
  s = s.replace(/^(嗯|呃|啊|哦)+/, '')
  s = s.replace(/^[\s，,。、]+/, '')
  s = s.replace(/^(这道题|这题)?(的)?(答案)?(应该|就)?(是|等于|就是)/, '')
  s = s.replace(/[\s，,、]+/g, '')
  // 整串是中文数字（如「三十五」「三点五」）时直接换算
  const num = cnNumberToArabic(s)
  if (num !== s) return num
  // 不是数字就只去掉句末的疑问和句号，保留小数点
  return s.replace(/[。！!？?；;：:]+$/, '')
}

// 加载框
const loading = (title = '加载中...') => {
  wx.showLoading({ title, mask: true })
}
const hideLoading = () => wx.hideLoading()

// 会走秒的加载框：图片识别（尤其思考型模型）耗时较长，让用户知道还在跑
// textOf(秒数) 返回文案，注意小程序 loading 标题最多 7 个汉字
const loadingTick = (textOf) => {
  const start = Date.now()
  const update = () => {
    const s = Math.floor((Date.now() - start) / 1000)
    wx.showLoading({ title: textOf(s), mask: true })
  }
  update()
  const timer = setInterval(update, 1000)
  return () => {
    clearInterval(timer)
    wx.hideLoading()
  }
}

module.exports = {
  formatTime,
  formatDate,
  timestamp,
  uid,
  debounce,
  toast,
  confirm,
  loading,
  hideLoading,
  loadingTick,
  cnNumberToArabic,
  speechToAnswer
}
