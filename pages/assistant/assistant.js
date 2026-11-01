// pages/assistant/assistant.js
// AI 学习助手（Tab 1）：对话组件整页嵌入，没有悬浮球，也没有「收起」按钮
// 标题栏用自定义样式（navigationStyle: custom），才能把「新建对话」放进标题栏左侧
Page({
  data: {
    pageStyle: '',
    statusBarHeight: 20,   // 状态栏高度（px）
    navBarHeight: 44,      // 标题栏自身高度（px）
    navTotal: 64           // 状态栏 + 标题栏，对话面板从这条线下面开始
  },

  onLoad() {
    this.applyStyle()
    this.measureNav()
  },

  onShow() {
    this.applyStyle()
  },

  // 显示设置（字号/夜间模式）由 app.applyDisplaySettings 拼好，这里兜底取一次
  applyStyle() {
    const style = getApp().globalData.pageStyle
    if (style && style !== this.data.pageStyle) this.setData({ pageStyle: style })
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

  // 标题栏「新建对话」交给对话组件处理（归档 / 重新开始都在组件里）
  onNewChat() {
    const chat = this.selectComponent('#ai-chat')
    if (chat && typeof chat.onNewChat === 'function') chat.onNewChat()
  }
})
