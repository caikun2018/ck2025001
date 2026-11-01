// pages/settings/settings.js
const config = require('../../utils/config.js')
const storage = require('../../services/storage.js')
const llm = require('../../services/llm.js')
const lexiang = require('../../services/lexiang.js')
const auth = require('../../services/auth.js')
const util = require('../../utils/util.js')

Page({
  data: {
    userInfo: null,
    // 模型连接列表
    providers: config.LLM_PROVIDERS,
    connections: [],
    activeId: '',
    // 新增连接的用途类型
    typeOptions: ['文本模型', '语音模型', '图片模型'],
    typeValues: ['text', 'voice', 'image'],
    typeIndex: 0,
    // 新增连接弹窗
    showAddModal: false,
    providerIndex: 0,
    newName: '',
    newBaseUrl: '',
    newModel: '',
    newKey: '',
    newKeyHidden: true,
    fetchedModels: [],
    fetchedModelIndex: 0,
    // 年级
    grades: ['一年级', '二年级', '三年级', '四年级', '五年级', '六年级', '初一', '初二', '初三'],
    gradeIndex: 3,
    currentGrade: '四年级',
    // 显示（这是唯一可调、可同步的部分；阈值/题量/教材都写死了）
    fontSize: 28,
    darkMode: false,
    syncing: false
  },

  onLoad() {
    this.loadSettings()
    this.syncParams(true)
  },

  onShow() {
    this.setData({ userInfo: getApp().globalData.userInfo })
    // 从别的页面切回来也拉一次（30 秒节流）：两台设备看到的阈值 / 题量才能一致
    this.syncParams()
  },

  // 从乐享取参数：云端更新（或本机没改过）才覆盖本机，取回后刷新界面数值
  syncParams(force) {
    const now = Date.now()
    if (!force && this._paramSyncAt && now - this._paramSyncAt < 30 * 1000) return
    this._paramSyncAt = now
    lexiang.syncSettings().then(r => {
      if (r && r.applied === 'cloud') this.loadSettings()
    }).catch(e => {
      console.warn('[settings] 参数拉取失败:', (e && e.message) || e)
    })
  },

  // 后台（autoSync / 立即同步）把云端参数合并进来后，由 lexiang 回调这里刷新
  onSettingsUpdated() {
    this.loadSettings()
  },

  // 两台设备已经不一致时，手动以云端为准（本机改动会被覆盖）
  async restoreSettingsFromCloud() {
    const ok = await util.confirm('将用乐享「设置」页的显示设置覆盖本机（字号、夜间模式），确定吗？', '取回云端参数')
    if (!ok) return
    util.loading('取回中...')
    this._paramSyncAt = Date.now()
    const r = await lexiang.syncSettings({ prefer: 'cloud' }).catch(e => ({ ok: false, error: (e && e.message) || '取回失败' }))
    util.hideLoading()
    if (r && r.ok && r.applied === 'cloud') {
      this.loadSettings()
      util.toast('已取回云端参数', 'success')
    } else {
      util.toast((r && (r.error || r.skipped)) || '云端暂无参数', 'none')
    }
  },

  // 反向：以本机为准，覆盖乐享「设置」页（其他设备下次同步跟随本机）
  async pushSettingsToCloud() {
    const ok = await util.confirm('将用本机显示设置覆盖乐享「设置」页，其他设备下次同步会跟随本机，确定吗？', '上传本机显示设置')
    if (!ok) return
    util.loading('上传中...')
    this._paramSyncAt = Date.now()
    const r = await lexiang.uploadSettings().catch(e => ({ ok: false, error: (e && e.message) || '上传失败' }))
    util.hideLoading()
    if (r && r.ok) util.toast('已上传本机参数', 'success')
    else util.toast((r && r.error) || '上传失败', 'none')
  },

  loadSettings() {
    const cfg = storage.getConfig()
    const app = getApp()
    // getModelConnections 会补齐 type 并保证每种类型各有一个选中项
    const connections = storage.getModelConnections()
    const activeId = storage.getActiveModelId() || ''

    this.setData({
      connections: this.decorateConnections(connections),
      activeId,
      currentGrade: cfg.grade || app.globalData.currentGrade,
      gradeIndex: this.data.grades.indexOf(cfg.grade || app.globalData.currentGrade),
      fontSize: cfg.fontSize || 28,
      darkMode: cfg.darkMode || false
    })
    // 同步到 globalData
    if (activeId) {
      const conn = connections.find(c => c.id === activeId)
      if (conn) {
        app.globalData.llmProvider = conn.name
        app.globalData.llmModel = conn.model
      }
    }
  },

  // 给连接补充用途标签和选中状态（每种类型只有选中的那条打钩）
  decorateConnections(connections) {
    const cfg = storage.getConfig()
    const order = { text: 0, voice: 1, image: 2 }
    const selectedId = (type) => {
      if (type === 'voice') return cfg.asrModelId || ''
      if (type === 'image') return cfg.visionModelId || ''
      return cfg.activeModelId || ''
    }
    return (connections || []).map(c => Object.assign({}, c, {
      typeLabel: storage.ROLE_LABELS[c.type] || '文本',
      selected: c.id === selectedId(c.type)
    })).sort((a, b) => (order[a.type] || 0) - (order[b.type] || 0))
  },

  // 保存显示设置（字号 / 夜间）+ 年级；阈值、题量、教材已写死，不再保存也不再上传
  saveDisplayConfig() {
    const cfg = storage.getConfig()
    const before = JSON.stringify([cfg.fontSize, cfg.darkMode])
    Object.assign(cfg, {
      grade: this.data.currentGrade,
      fontSize: this.data.fontSize,
      darkMode: this.data.darkMode
    })
    const changed = JSON.stringify([cfg.fontSize, cfg.darkMode]) !== before
    if (changed) {
      // 只有真的改了才标脏并上传，避免进页面拖一下相同值就把云端覆盖掉
      cfg.settingsUpdatedAt = util.formatTime(new Date())
      cfg.settingsDirty = true
    }
    storage.setConfig(cfg)
    const app = getApp()
    app.globalData.currentGrade = this.data.currentGrade
    app.globalData.fontSize = this.data.fontSize
    app.globalData.darkMode = this.data.darkMode
    app.applyDisplaySettings()
    if (!changed) return
    // 显示设置同步到乐享「设置」页：上传成功后记基线，换手机能带回来（失败不影响本机使用）
    this._paramSyncAt = Date.now()
    lexiang.uploadSettings().catch(e => {
      console.warn('[settings] 参数上传失败:', (e && e.message) || e)
    })
  },

  // 选中某个连接为该用途的当前模型（文本/语音/图片各自独立）
  selectConnection(e) {
    const id = e.currentTarget.dataset.id
    const conn = this.data.connections.find(c => c.id === id)
    if (!conn) return
    if (conn.type === 'voice') {
      storage.setAsrModelId(id)
    } else if (conn.type === 'image') {
      storage.setVisionModelId(id)
    } else {
      storage.setActiveModelId(id)
      getApp().globalData.llmProvider = conn.name
      getApp().globalData.llmModel = conn.model
    }
    this.setData({
      connections: this.decorateConnections(storage.getModelConnections()),
      activeId: storage.getActiveModelId()
    })
    util.toast('已设为' + conn.typeLabel + '模型：' + conn.name, 'success')
  },

  // 删除连接
  async deleteConnection(e) {
    const id = e.currentTarget.dataset.id
    const ok = await util.confirm('确定删除该模型连接吗？', '删除连接')
    if (!ok) return
    const list = storage.getModelConnections().filter(c => c.id !== id)
    storage.setModelConnections(list)
    // 重新读取，自动补选同类型的第一个连接
    const fresh = storage.getModelConnections()
    const activeId = storage.getActiveModelId()
    const active = fresh.find(c => c.id === activeId)
    if (active) {
      getApp().globalData.llmProvider = active.name
      getApp().globalData.llmModel = active.model
    }
    this.setData({
      connections: this.decorateConnections(fresh),
      activeId
    })
    util.toast('已删除', 'success')
  },

  // 打开新增弹窗（默认填入第一个预设供应商的名称和 Base URL）
  openAddModal() {
    const defaultProvider = config.LLM_PROVIDERS[0] || { name: '', baseUrl: '' }
    this.setData({
      showAddModal: true,
      typeIndex: 0,
      providerIndex: 0,
      newName: defaultProvider.name,
      newBaseUrl: defaultProvider.baseUrl,
      newModel: '',
      newKey: '',
      newKeyHidden: true,
      fetchedModels: [],
      fetchedModelIndex: 0
    })
  },
  closeAddModal() {
    this.setData({ showAddModal: false })
  },
  onNewTypeChange(e) {
    const idx = parseInt(e.detail.value) || 0
    this.setData({ typeIndex: idx })
  },
  onNewBaseUrlInput(e) { this.setData({ newBaseUrl: e.detail.value }) },
  onNewModelInput(e) { this.setData({ newModel: e.detail.value }) },
  onNewKeyInput(e) { this.setData({ newKey: e.detail.value }) },
  toggleNewKeyVisible() { this.setData({ newKeyHidden: !this.data.newKeyHidden }) },

  // 密码输入框在隐藏/显示两种状态下系统长按菜单都可能不出现粘贴项，
  // 这里提供显式粘贴入口，保证两种状态都能粘贴 API Key
  pasteNewKey() {
    wx.getClipboardData({
      success: (res) => {
        const text = String(res.data || '').trim()
        if (!text) { util.toast('剪贴板为空'); return }
        this.setData({ newKey: text })
        util.toast('已粘贴')
      },
      fail: () => util.toast('读取剪贴板失败')
    })
  },

  // 点击供应商名称后弹出的滑动选择框：选中即填充名称与 Base URL
  onQuickProvider(e) {
    const idx = parseInt(e.detail.value) || 0
    const p = config.LLM_PROVIDERS[idx]
    if (p) {
      // Base URL 变了，之前拉到的模型列表已失效
      this.setData({ providerIndex: idx, newName: p.name, newBaseUrl: p.baseUrl, fetchedModels: [], fetchedModelIndex: 0 })
    }
  },

  // 拉取模型列表（在新增弹窗中使用）
  async fetchModelsForModal() {
    const { newBaseUrl, newKey } = this.data
    if (!newBaseUrl.trim()) { util.toast('请先填写 Base URL'); return }
    if (!newKey.trim()) { util.toast('请先填写 API Key'); return }
    util.loading('获取模型列表中...')
    const result = await llm.fetchModels(newBaseUrl.trim(), newKey.trim())
    util.hideLoading()
    if (result.ok && result.models.length) {
      this.setData({
        fetchedModels: result.models,
        fetchedModelIndex: 0,
        newModel: result.models[0]
      })
      util.toast('已获取 ' + result.models.length + ' 个模型，请选择', 'success')
    } else {
      util.toast(result.message)
    }
  },

  // 选择拉取到的模型
  onFetchedModelChange(e) {
    const idx = parseInt(e.detail.value)
    this.setData({
      fetchedModelIndex: idx,
      newModel: this.data.fetchedModels[idx]
    })
  },

  // 测试弹窗中的连接
  async testModalConnection() {
    if (this.data.typeValues[this.data.typeIndex] === 'voice') {
      util.toast('语音模型不支持对话测试，保存后可直接使用')
      return
    }
    const { newBaseUrl, newKey, newModel } = this.data
    if (!newBaseUrl.trim()) { util.toast('请填写 Base URL'); return }
    if (!newKey.trim()) { util.toast('请填写 API Key'); return }
    util.loading('测试连接中...')
    const result = await llm.testConnection(newBaseUrl.trim(), newKey.trim(), newModel.trim() || undefined)
    util.hideLoading()
    util.toast(result.message, result.ok ? 'success' : 'none')
  },

  // 保存新增连接
  saveNewConnection() {
    const { newName, newBaseUrl, newModel, newKey } = this.data
    if (!newName.trim()) { util.toast('请填写供应商名称'); return }
    if (!newBaseUrl.trim()) { util.toast('请填写 Base URL'); return }
    if (!newModel.trim()) { util.toast('请填写模型名称'); return }
    if (!newKey.trim()) { util.toast('请填写 API Key'); return }

    const type = this.data.typeValues[this.data.typeIndex] || 'text'
    const conn = {
      id: 'c_' + Date.now(),
      name: newName.trim(),
      baseUrl: newBaseUrl.trim().replace(/\/+$/, ''),
      model: newModel.trim(),
      key: newKey.trim(),
      type
    }
    const list = storage.getModelConnections().concat(conn)
    storage.setModelConnections(list)
    // 新增的连接直接设为该类型的当前模型
    if (type === 'voice') {
      storage.setAsrModelId(conn.id)
    } else if (type === 'image') {
      storage.setVisionModelId(conn.id)
    } else {
      storage.setActiveModelId(conn.id)
      getApp().globalData.llmProvider = conn.name
      getApp().globalData.llmModel = conn.model
    }
    const fresh = storage.getModelConnections()
    this.setData({
      connections: this.decorateConnections(fresh),
      activeId: storage.getActiveModelId(),
      showAddModal: false
    })
    util.toast('连接已保存', 'success')
  },

  // 年级（触发升年级流程）
  async onGradeChange(e) {
    const idx = parseInt(e.detail.value)
    const newGrade = this.data.grades[idx]
    const ok = await util.confirm(
      `确定将年级从「${this.data.currentGrade}」改为「${newGrade}」吗？\n\n升年级将：\n1. 在知识库创建新年级目录\n2. 迁移未消退错题到新年级\n3. 旧年级整体保留为成长档案`,
      '升年级确认'
    )
    if (!ok) return
    this.setData({ gradeIndex: idx, currentGrade: newGrade })
    this.saveDisplayConfig()
    this.handleGradeUpgrade(newGrade)
  },

  handleGradeUpgrade(newGrade) {
    util.loading('正在执行升年级...')
    setTimeout(() => {
      util.hideLoading()
      util.toast('升年级完成', 'success')
    }, 1500)
  },

  // 显示
  onFontSizeChange(e) {
    this.setData({ fontSize: parseInt(e.detail.value) })
    this.saveDisplayConfig()
  },
  onDarkModeChange(e) {
    this.setData({ darkMode: e.detail.value })
    this.saveDisplayConfig()
  },

  // 手动同步乐享知识库
  async syncLexiang() {
    if (this.data.syncing) return
    this._manualSyncing = true
    this.setData({ syncing: true })
    util.loading('同步中...')
    try {
      // 手动点「立即同步」：错题回填绕过 30 分钟节流，真去云端拉一遍
      const result = await lexiang.syncAll({ force: true })
      util.hideLoading()
      util.toast(result.message, result.ok ? 'success' : 'none')
      // 云端若带回更新的参数 / 错题，页面上的数值跟着刷新
      this.loadSettings()
    } catch (e) {
      util.hideLoading()
      util.toast('同步失败：' + (e.message || '未知错误'))
    }
    this._manualSyncing = false
    this.setData({ syncing: false })
  },

  // 后台自动同步（app.silentSync）的进度提示：按钮临时显示「同步中…」
  // 手动同步进行中时不让后台回调改按钮状态，避免闪回
  onSyncState(on) {
    if (this._manualSyncing) return
    if (!!this.data.syncing === !!on) return
    this.setData({ syncing: !!on })
  },

  // 退出登录
  async logout() {
    const ok = await util.confirm('确定退出登录吗？退出后需重新输入账号密码。', '退出登录')
    if (!ok) return
    auth.logout()
    getApp().globalData.userInfo = null
    wx.reLaunch({ url: '/pages/login/login' })
  },

  // 清除缓存
  async clearCache() {
    const ok = await util.confirm('确定清除本地缓存吗？所有本地数据将被清空（乐享云端数据不受影响）。', '清除缓存')
    if (!ok) return
    wx.clearStorageSync()
    util.toast('缓存已清除', 'success')
    setTimeout(() => wx.reLaunch({ url: '/pages/login/login' }), 1000)
  }
})
