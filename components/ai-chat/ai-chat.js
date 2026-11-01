// components/ai-chat/ai-chat.js
const llm = require('../../services/llm.js')
const storage = require('../../services/storage.js')
const lexiang = require('../../services/lexiang.js')
const memory = require('../../services/memory.js')
const util = require('../../utils/util.js')
const fileParser = require('../../utils/fileParser.js')
const { mdToHtml } = require('../../utils/markdown.js')

// 短于这个时长（毫秒）就当没说话：按住就松手、或只擦了一下按钮
const MIN_VOICE_MS = 500

// 学生明确要求"存起来"的说法：回复结束后自动弹归档确认层
const SAVE_INTENT = /存到知识库|存入知识库|保存到知识库|存到学习记忆|记到.*知识点|存到.*错题|帮我存|存起来|保存一下|归档/

// 带原生 tabBar 的页面（与 app.json 的 tabBar 列表保持一致）
// 这些页面里 fixed bottom:0 的元素会被原生 tabBar 盖住，需要整体上移
const TAB_PAGES = [
  'pages/assistant/assistant',
  'pages/challenge/challenge',
  'pages/practice/practice',
  'pages/achievement/achievement',
  'pages/settings/settings'
]

Component({
  properties: {
    // 当前页面学科上下文（可选）
    subject: {
      type: String,
      value: ''
    },
    // 整页嵌入（学习助手 Tab 页用）：始终铺满、不显示悬浮球与「收起」按钮
    embedded: {
      type: Boolean,
      value: false
    },
    // 嵌入时顶部让出的高度（px）：页面自定义标题栏占掉的部分
    topInset: {
      type: Number,
      value: 0
    }
  },

  data: {
    expanded: false,
    inputText: '',
    messages: [],
    // 聊天区滚动位置：每次要滚到底就换一个更大的值（值不变小程序不会重新滚动）
    scrollTop: 0,
    loading: false,
    inputMode: 'voice', // voice 默认语音输入，text 为键盘输入
    recording: false,
    transcribing: false,
    voiceSeconds: 0,
    hasTabBar: false,
    // 归档确认层
    archiveVisible: false,
    archiveLoading: false,
    archiveError: '',
    archiveSummary: '',
    archiveDegraded: false,
    archiveWrongs: [],
    archivePoints: []
  },

  lifetimes: {
    attached() {
      let route = ''
      try {
        const pages = getCurrentPages()
        const cur = pages[pages.length - 1] || {}
        route = cur.route || cur.__route__ || ''
      } catch (e) {}
      this.setData({ hasTabBar: TAB_PAGES.indexOf(route) >= 0 })
      // 整页嵌入时没有展开动作，进来就加载历史会话
      if (this.data.embedded) this.loadSessions()
    },
    ready() {
      // 首次渲染完成：把历史会话滚到最新一条（否则长对话会停在最上面）
      this._stickToBottom = true
      this.measureMsgView()
      this.scrollToLatest(true)
    },
    detached() {
      this.stopVoiceTimer()
      this.clearVoiceTimer()
      // 组件销毁时恢复 tabBar，避免退出时底栏一直隐藏
      if (wx.showTabBar) wx.showTabBar({ animation: false, fail: () => {} })
    }
  },

  methods: {
    // 面板内部点击不再收起（原来直接绑 toggleExpand 会把输入区一起收起）
    noop() {},

    // 量一下聊天区的可视高度，用来判断"现在是不是贴着最新消息"
    measureMsgView() {
      if (this._measuring) return
      this._measuring = true
      wx.createSelectorQuery().in(this).select('.chat-messages').boundingClientRect(rect => {
        this._measuring = false
        if (rect && rect.height) this._msgViewH = rect.height
      }).exec()
    },

    // 滚到最新一条。force = true 时无论用户翻到哪儿都拉到底（自己发消息、刚进页面）
    scrollToLatest(force) {
      if (!force && this._stickToBottom === false) return
      if (force) this._stickToBottom = true
      const seq = (this._scrollSeq = (this._scrollSeq || 0) + 1)
      wx.nextTick(() => {
        // 一帧内多次触发只滚最后一次，避免流式输出时排一长串 setData
        if (seq !== this._scrollSeq) return
        this.setData({ scrollTop: 1000000 + seq })
      })
    },

    // 孩子自己往上翻看旧内容时停止自动跟随，翻回底部附近再恢复
    onMsgScroll(e) {
      const d = (e && e.detail) || {}
      if (!d.scrollHeight) return
      if (!this._msgViewH) {
        this.measureMsgView()
        return
      }
      this._stickToBottom = d.scrollHeight - d.scrollTop - this._msgViewH < 80
    },

    onMsgBottom() {
      this._stickToBottom = true
    },

    // 加载本地历史会话（没有历史就给一条欢迎语）
    loadSessions() {
      if (this.data.messages.length) return
      const sessions = storage.getSessions()
      if (sessions.length) {
        this.setData({
          messages: sessions.map(m => Object.assign({}, m, {
            html: m.role === 'assistant' ? mdToHtml(m.content) : ''
          }))
        })
      } else {
        this.setData({
          messages: [{ role: 'assistant', content: '你好呀！我是你的学习小助手，有什么不会的题都可以问我哦~' }]
        })
      }
      // 历史会话很长时，打开就停在最新一条
      this.scrollToLatest(true)
    },

    // 展开时全屏铺满（隐藏原生 tabBar），收起时恢复；整页嵌入模式不再触发
    toggleExpand() {
      if (this.data.embedded) return
      const next = !this.data.expanded
      this.setData({ expanded: next })

      if (next) {
        if (wx.hideTabBar) wx.hideTabBar({ animation: false, fail: () => {} })
        this.loadSessions()
        wx.nextTick(() => this.measureMsgView())
      } else {
        if (wx.showTabBar) wx.showTabBar({ animation: false, fail: () => {} })
        this.abortRecording()
      }
    },

    // 语音/键盘输入切换（识别中不允许切）
    switchInput() {
      if (this.data.transcribing) return
      if (this.data.recording) return
      const next = this.data.inputMode === 'voice' ? 'text' : 'voice'
      this.setData({ inputMode: next })
    },

    onInput(e) {
      // AI 回复中不接受输入（输入框已 disabled，这里再兜一层）
      if (this.data.loading) return
      this.setData({ inputText: e.detail.value })
    },

    sendText() {
      // AI 还没回完就再发，会把上一轮的流式回复打断、消息列表错乱，这里一律拦住
      if (this.data.loading) {
        util.toast('AI 正在回复，等它说完再发哦')
        return
      }
      if (this.data.recording || this.data.transcribing) {
        util.toast('请先结束录音')
        return
      }
      const text = this.data.inputText.trim()
      if (!text) return
      if (this._parsingFile) {
        util.toast('文件还在解析，请稍候')
        return
      }
      this.sendMessage(text)
      this.setData({ inputText: '' })
    },

    sendMessage(content, type = 'text', extra) {
      // 所有发送路径的总闸（文本 / 图片 / 文件都从这里进），防守卫顺序漏判
      if (this.data.loading) return
      // 用户说"记住..."时，同步更新身份习惯
      if (type === 'text') this.checkRemember(content)
      // 用户明确要求保存到知识库：这轮回复结束后自动弹归档确认层
      if (type === 'text' && SAVE_INTENT.test(String(content))) this._saveIntent = true
      const messages = this.data.messages.concat([Object.assign({ role: 'user', content, type }, extra || {})])
      this.runChat(messages)
    },

    // 把消息列表交给模型，回复以流式写进最后一条 assistant 消息
    runChat(messages) {
      this.setData({ messages, loading: true })
      this.scrollToLatest(true)

      // 构造上下文：带 context 的消息（图片识别结果、文件正文）用 context 正文，
      // 这样后续追问时模型能“记得”图片/文件里的内容；整体长度设上限，避免长文档撑爆请求
      const MAX_CONTEXT_CHARS = 24000
      const history = []
      let used = 0
      for (let i = messages.length - 1; i >= 0 && history.length < 12; i--) {
        const m = messages[i]
        let text = ''
        if (m.type === 'image') text = '[我发了一张图片]'
        else if (m.type === 'file' && !m.context) text = '[我发了一个附件] ' + (m.content || '')
        else text = m.context || m.content
        if (!text) continue
        if (used + text.length > MAX_CONTEXT_CHARS && history.length) break
        used += text.length
        history.unshift({ role: m.role, content: text })
      }
      // Promise.resolve().then 包一层：llm.chat 里万一同步抛错，也能走到 catch 解锁输入
      Promise.resolve().then(() => llm.chat(history, {
        format: 'doc',
        onStream: (partial, done) => {
          if (done) {
            this.finalizeLastAssistant()
            this.setData({ loading: false })
            this.saveSessions()
            this.maybeAutoArchive()
          } else if (partial) {
            const msgs = this.data.messages
            if (msgs.length && msgs[msgs.length - 1].role === 'assistant') {
              msgs[msgs.length - 1].content = partial
              msgs[msgs.length - 1].html = ''
              this.setData({ messages: msgs })
            } else {
              this.setData({ messages: msgs.concat([{ role: 'assistant', content: partial, html: '' }]) })
            }
            // 回复还在往外冒字，视角跟着往下走
            this.scrollToLatest()
          }
        }
      })).then(res => {
        // 非流式返回时补一条
        if (!this.data.messages.length || this.data.messages[this.data.messages.length - 1].role !== 'assistant') {
          this.setData({
            messages: this.data.messages.concat([{ role: 'assistant', content: res.content }]),
            loading: false
          })
        }
        this.finalizeLastAssistant()
        this.setData({ loading: false })
        this.saveSessions()
        this.maybeAutoArchive()
      }).catch(err => {
        this._saveIntent = false
        // 失败也留一条可见的助手消息，否则用户只看到自己那句话、不知道发生了什么
        const why = String((err && err.message) || '').slice(0, 60)
        const text = (why ? '这次没回答上来（' + why + '）。' : '这次没回答上来。') +
          '可以再发一次，图片的话换一张更清楚的。'
        const msgs = this.data.messages.slice()
        if (!msgs.length || msgs[msgs.length - 1].role !== 'assistant') {
          msgs.push({ role: 'assistant', content: text, html: mdToHtml(text) })
        }
        this.setData({ messages: msgs, loading: false })
        this.saveSessions()
        util.toast('AI 回复失败，请稍后重试')
      })
    },

    // 学生在对话里说了"帮我存到知识库"：回复结束后自动弹出归档确认层
    maybeAutoArchive() {
      if (!this._saveIntent) return
      this._saveIntent = false
      setTimeout(() => {
        if (this.data.loading) return
        this.archiveSession()
      }, 400)
    },

    // 回复结束后把 Markdown 渲染成带标题的富文本
    finalizeLastAssistant() {
      const msgs = this.data.messages
      const last = msgs[msgs.length - 1]
      if (!last || last.role !== 'assistant' || last.html) return
      last.html = mdToHtml(last.content)
      this.setData({ messages: msgs })
      // 富文本比纯文本更高，渲染完再补一次滚动，保证最后一行露出来
      this.scrollToLatest()
    },

    saveSessions() {
      // 保存到本地（html 是渲染结果不存；文件正文很长，只留开头，避免撑爆本地存储）
      storage.setSessions(this.data.messages.map(m => {
        const o = Object.assign({}, m)
        delete o.html
        if (o.context && o.context.length > 4000) o.context = o.context.slice(0, 4000) + '\n……（已截断）'
        return o
      }))
    },

    // 归档：先让 AI 总结并抽取错题/知识点，再弹全屏确认层
    archiveSession() {
      if (this.data.archiveVisible) return
      if (this.data.loading) {
        util.toast('AI 还在回复，请稍候')
        return
      }
      if (this.data.recording || this.data.transcribing) {
        util.toast('请先结束录音')
        return
      }
      const msgs = (this.data.messages || []).filter(m => m && (m.content || m.context))
      if (!msgs.length || !msgs.some(m => m.role === 'user')) {
        util.toast('当前还没有对话内容')
        return
      }
      this._archiveMsgs = msgs
      this.setData({
        archiveVisible: true,
        archiveLoading: true,
        archiveError: '',
        archiveSummary: '',
        archiveDegraded: false,
        archiveWrongs: [],
        archivePoints: []
      })

      llm.extractSessionItems(msgs).then(r => {
        this.setData({
          archiveLoading: false,
          archiveSummary: r.summary || '（AI 没有给出总结）',
          archiveDegraded: !!r.degraded,
          archiveWrongs: r.wrongQuestions.map(q => Object.assign({ checked: true }, q)),
          archivePoints: r.knowledgePoints.map(k => Object.assign({ checked: true }, k))
        })
        // 兜底路径：AI 没给出可解析的 JSON，只能归档会话本身
        if (r.degraded) util.toast('AI 总结失败，已用原文摘要，可只归档会话')
      }).catch(err => {
        this.setData({
          archiveLoading: false,
          archiveError: (err && err.message) || '总结失败，请重试'
        })
      })
    },

    closeArchive() {
      this.setData({ archiveVisible: false, archiveLoading: false })
    },

    toggleWrong(e) {
      const i = e.currentTarget.dataset.index
      const list = this.data.archiveWrongs
      list[i].checked = !list[i].checked
      this.setData({ archiveWrongs: list })
    },

    togglePoint(e) {
      const i = e.currentTarget.dataset.index
      const list = this.data.archivePoints
      list[i].checked = !list[i].checked
      this.setData({ archivePoints: list })
    },

    // 按勾选项逐条写入乐享：会话 -> 会话记录，错题 -> 科目/错题，知识点 -> 科目/学习记忆
    confirmArchive() {
      if (this.data.archiveLoading) {
        util.toast('还在总结，请稍候')
        return
      }
      const wrongs = this.data.archiveWrongs.filter(w => w.checked)
      const points = this.data.archivePoints.filter(p => p.checked)

      const msgs = this._archiveMsgs || []
      const name = 'AI 会话 ' + util.formatTime(new Date())
      const dialogText = msgs.map(m => {
        const who = m.role === 'user' ? '我' : 'AI'
        const text = m.type === 'image' ? '[图片]' : (m.type === 'file' ? '[附件]' : (m.context || m.content))
        return '【' + who + '】' + text
      }).join('\n\n')

      console.log('[archive] 归档项：会话 1 条，错题', wrongs.length, '条，知识点', points.length, '条',
        wrongs.map(w => w.subject + '/' + (w.title || '')).join(' | '))

      const steps = []
      // 会话记录强制归档（AI 总结失败时只存对话正文，不写兜底摘要）
      const summary = this.data.archiveDegraded ? '' : this.data.archiveSummary
      const sessionContent = (summary ? '【AI 总结】\n' + summary + '\n\n' : '') + dialogText
      steps.push({ key: 'session', label: '会话归档', run: () => lexiang.saveSession(name, sessionContent) })
      wrongs.forEach(w => {
        steps.push({
          label: '错题「' + String(w.title || w.question).slice(0, 10) + '」',
          run: () => lexiang.createWrongQuestion(w).then(r => {
            if (r && r.ok) {
              // 同步进本地错题本，错题列表和练习里能直接看到
              const list = storage.getWrongbook() || []
              list.unshift(Object.assign({}, w, {
                id: util.uid(),
                createdAt: Date.now(),
                synced: true,
                entryId: r.entryId,
                correctCount: 0,
                records: [],
                status: '在册'
              }))
              storage.setWrongbook(list)
            }
            return r
          })
        })
      })
      points.forEach(p => {
        steps.push({
          label: '知识点「' + String(p.title).slice(0, 10) + '」',
          run: () => lexiang.appendMemory(p.subject, p.title, p.content).then(r => {
            // 同时写本地学习记忆：题库出题立刻能参考到，不用等下一轮云端回填
            if (r && r.ok) memory.addPoints(p.subject, [p.title])
            return r
          })
        })
      })

      let ok = 0
      let fail = 0
      let firstErr = ''
      let sessionOk = true   // 会话本身是否已存进乐享
      const total = steps.length
      wx.showLoading({ title: '归档中 1/' + total, mask: true })

      const runStep = (i) => {
        if (i >= total) return Promise.resolve()
        wx.showLoading({ title: '归档中 ' + (i + 1) + '/' + total, mask: true })
        return Promise.resolve()
          .then(steps[i].run)
          .then(r => {
            if (r && r.ok) {
              ok++
            } else {
              fail++
              if (steps[i].key === 'session') sessionOk = false
              const e = r && (r.error || r.message)
              if (!firstErr) {
                firstErr = steps[i].label + '：' + (typeof e === 'string' ? e : (e ? JSON.stringify(e).slice(0, 100) : '写入失败'))
              }
            }
          })
          .catch(err => {
            fail++
            if (steps[i].key === 'session') sessionOk = false
            if (!firstErr) firstErr = steps[i].label + '：' + ((err && err.message) || '写入失败')
          })
          .then(() => runStep(i + 1))
      }

      runStep(0).then(() => {
        wx.hideLoading()
        this.closeArchive()
        // 科目目录按需创建：归档哪个学科就建哪个，避免在年级下堆一堆空科目
        if (fail === 0) {
          this.startNewSession()
          util.toast('已归档 ' + ok + ' 项')
          return
        }
        // 会话没归档成功就不能开新对话，否则这段聊天会丢
        if (!sessionOk) {
          wx.showModal({
            title: '还没归档成功',
            content: firstErr + '\n\n聊天内容还在，请稍后再点一次「新建对话」',
            showCancel: false
          })
          return
        }
        wx.showModal({
          title: '归档完成（部分失败）',
          content: '成功 ' + ok + ' 项，失败 ' + fail + ' 项\n' + firstErr,
          showCancel: false
        })
        if (ok > 0) this.startNewSession()
      })
    },

    startNewSession() {
      const welcome = [{ role: 'assistant', content: '你好呀！我是你的学习小助手，有什么不会的题都可以问我哦~' }]
      this.setData({ messages: welcome, inputText: '', loading: false, inputMode: 'voice', recording: false, transcribing: false })
      storage.setSessions(welcome)
      this.scrollToLatest(true)
    },

    // 标题栏「新建对话」：会话一律先归档到乐享，只有「归档」「取消」两个选择
    onNewChat() {
      if (this.data.archiveVisible) return
      if (this.data.loading) {
        util.toast('AI 还在回复，请稍候')
        return
      }
      if (this.data.recording || this.data.transcribing) {
        util.toast('请先结束录音')
        return
      }
      const hasUser = (this.data.messages || []).some(m => m && m.role === 'user')
      // 还没有对话内容时没有东西要归档，直接开新的
      if (!hasUser) {
        this.startNewSession()
        return
      }
      wx.showModal({
        title: '新建对话',
        content: '当前对话会先归档到乐享，再开始新对话。',
        confirmText: '归档',
        cancelText: '取消',
        confirmColor: '#7B5EA7',
        success: res => {
          if (res.confirm) this.archiveSession()
        },
        fail: () => {}
      })
    },

    // 输入栏「＋」：图片 / 文件二选一，替掉原来并排的两个按钮
    openAttach() {
      if (this.data.loading) {
        util.toast('AI 正在处理，请稍候')
        return
      }
      wx.showActionSheet({
        itemList: ['图片', '文件'],
        success: res => {
          if (res.tapIndex === 0) this.chooseImage()
          else if (res.tapIndex === 1) this.chooseFile()
        },
        fail: () => {}
      })
    },

    // 图片输入：交给视觉模型读图，识别结果作为后续追问的上下文
    chooseImage() {
      if (this.data.loading) {
        util.toast('AI 正在处理，请稍候')
        return
      }
      wx.chooseMedia({
        count: 1,
        mediaType: ['image'],
        sourceType: ['album', 'camera'],
        success: res => {
          this.handleImage(res.tempFiles[0].tempFilePath)
        }
      })
    },

    handleImage(tempPath) {
      // 相册/相机停留期间 AI 可能已经开始上一轮回复，回来时再判一次
      if (this.data.loading) {
        util.toast('AI 正在回复，等它说完再发哦')
        return
      }
      const messages = this.data.messages.concat([{ role: 'user', content: tempPath, type: 'image' }])
      this.setData({ messages, loading: true })
      this.scrollToLatest(true)
      util.toast('正在看图片，思考型模型可能要等一会儿')

      llm.describeImage(tempPath).then(desc => {
        const text = '图片我看清楚啦～题目讲解、答案、知识点都可以直接问我。'
        const list = this.data.messages.concat([{
          role: 'assistant',
          content: text,
          html: mdToHtml(text),
          context: '【我刚才发的图片，内容如下】\n' + desc
        }])
        this.setData({ messages: list, loading: false })
        this.saveSessions()
        this.scrollToLatest(true)
      }).catch(err => {
        const msg = (err && err.message) || '识别失败'
        const text = '这张图片我没看清楚（' + msg + '）。可以换个角度重拍，或者直接把题目打出来告诉我。'
        const list = this.data.messages.concat([{
          role: 'assistant',
          content: text,
          html: mdToHtml(text)
        }])
        this.setData({ messages: list, loading: false })
        this.saveSessions()
        this.scrollToLatest(true)
      })
    },

    // 文件输入：端上解析出文字后交给 AI；解析不了的格式直接回一句说明
    chooseFile() {
      if (this.data.loading) {
        util.toast('AI 正在处理，请稍候')
        return
      }
      wx.chooseMessageFile({
        count: 1,
        type: 'file',
        success: res => {
          const f = (res.tempFiles && res.tempFiles[0]) || {}
          if (!f.path) {
            util.toast('没有拿到文件，请重试')
            return
          }
          this.handleFile(f.path, f.name || '未命名文件', f.size)
        },
        fail: () => {}
      })
    },

    handleFile(tempPath, name, size) {
      // 选文件期间 AI 可能已经开始上一轮回复，回来时再判一次
      if (this.data.loading) {
        util.toast('AI 正在回复，等它说完再发哦')
        return
      }
      // 不支持的格式：不打扰模型，直接回复解析不了
      if (!fileParser.isSupported(name)) {
        this.setData({
          messages: this.data.messages.concat([{ role: 'user', type: 'file', content: name, fileOk: false, fileState: '无法解析' }])
        })
        this.pushNotice(fileParser.unsupportedMessage(name))
        return
      }

      this._parsingFile = true
      this.setData({
        messages: this.data.messages.concat([{ role: 'user', type: 'file', content: name, fileOk: true, fileState: '解析中…' }]),
        loading: true
      })
      this.scrollToLatest(true)
      const stopLoading = util.loadingTick(s => '解析文件 ' + s + 's')

      fileParser.parseFile(tempPath, name, size).then(r => {
        stopLoading()
        this._parsingFile = false
        const list = this.data.messages.slice()
        const msg = list[list.length - 1]
        msg.context = '【我发了一个文件：' + name + '，内容如下】\n' + r.text
        msg.fileState = '已解析 ' + r.chars + ' 字' + (r.truncated ? '（只取了前 ' + fileParser.MAX_CHARS + ' 字）' : '')
        this.setData({ messages: list })
        // 正文交给模型，让它先看看文件里有什么
        this.runChat(list)
      }).catch(err => {
        stopLoading()
        this._parsingFile = false
        const list = this.data.messages.slice()
        const msg = list[list.length - 1]
        msg.fileOk = false
        msg.fileState = '无法解析'
        const text = (err && err.message) || '这个文件我没能读出内容，可以截图发给我。'
        list.push({ role: 'assistant', content: text, html: mdToHtml(text) })
        this.setData({ messages: list, loading: false })
        this.saveSessions()
        this.scrollToLatest(true)
      })
    },

    // 不经过模型，直接回一条说明
    pushNotice(text) {
      const list = this.data.messages.concat([{ role: 'assistant', content: text, html: mdToHtml(text) }])
      this.setData({ messages: list, loading: false })
      this.saveSessions()
      this.scrollToLatest(true)
    },

    // 语音输入（按住说话）：录音后上传到语音识别模型转文字
    // 个人主体小程序无法使用「微信同声传译」插件，因此改用 wx.getRecorderManager + ASR 接口
    getRecorder() {
      if (this._recorder) return this._recorder
      const recorder = wx.getRecorderManager()
      recorder.onStart(() => {})
      recorder.onStop(res => this.handleRecordStop(res))
      recorder.onError(err => {
        this.clearVoiceTimer()
        this.stopVoiceTimer()
        this.setData({ recording: false, transcribing: false })
        const msg = (err && err.errMsg) || ''
        // 权限被关掉时清掉缓存，下次按下去重新走授权/设置流程
        if (/auth|permission|deny|权限/i.test(msg)) {
          this._recordGranted = false
          util.toast('录音失败：请检查麦克风权限')
          return
        }
        // 按住没说话就松手（录音太短 / 没录到内容）是正常情况，别弹「录音失败」
        if (/short|太短|empty|no\s*audio|无声|静音/i.test(msg)) {
          util.toast('没有听清，请按住按钮说完再松手')
          return
        }
        util.toast('录音失败：' + (msg || '请检查麦克风权限'))
      })
      this._recorder = recorder
      return recorder
    },

    clearVoiceTimer() {
      if (this._voiceTimer) {
        clearTimeout(this._voiceTimer)
        this._voiceTimer = null
      }
    },

    // 录音秒表
    startVoiceTimer() {
      this.stopVoiceTimer()
      this.setData({ voiceSeconds: 0 })
      this._voiceTick = setInterval(() => {
        if (!this.data.recording) return
        this.setData({ voiceSeconds: this.data.voiceSeconds + 1 })
      }, 1000)
    },

    stopVoiceTimer() {
      if (this._voiceTick) {
        clearInterval(this._voiceTick)
        this._voiceTick = null
      }
    },

    // 收起面板时取消正在进行的录音（不发送）
    abortRecording() {
      this._touchActive = false
      if (!this.data.recording) return
      this._voiceCancel = true
      this.stopVoiceTimer()
      try { this.getRecorder().stop() } catch (e) {}
    },

    startRecord() {
      if (this.data.loading) {
        util.toast('AI 正在回复，等它说完再说哦')
        return
      }
      if (this.data.recording || this.data.transcribing) return
      if (this._parsingFile) {
        util.toast('文件还在解析，请稍候')
        return
      }
      // 记住手指是否还按着：查权限是异步的，松手后才拿到结果的不能再开录（否则会录到 60 秒空音）
      this._touchActive = true
      const recorder = this.getRecorder()
      const doStart = () => {
        if (!this._touchActive) return
        this._voiceCancel = false
        this.setData({ recording: true, voiceSeconds: 0 })
        this.startVoiceTimer()
        try {
          recorder.start({
            duration: 60000,
            format: 'mp3',
            sampleRate: 16000,
            encodeBitRate: 48000,
            numberOfChannels: 1
          })
        } catch (e) {
          this.stopVoiceTimer()
          this.setData({ recording: false })
          util.toast('麦克风启动失败，请检查权限')
        }
      }
      // 已授权过就直接开录，不要再走一遍授权（否则按下去永远是「请再按住说话」）
      if (this._recordGranted) {
        doStart()
        return
      }
      wx.getSetting({
        success: res => {
          const granted = res.authSetting && res.authSetting['scope.record']
          if (granted === false) {
            wx.showModal({
              title: '需要麦克风权限',
              content: '请在设置中开启麦克风权限后再使用语音输入。',
              confirmText: '去设置',
              success: r => {
                if (!r.confirm) return
                wx.openSetting({
                  success: s => {
                    if (s.authSetting && s.authSetting['scope.record']) this._recordGranted = true
                  }
                })
              }
            })
            return
          }
          if (granted === true) {
            this._recordGranted = true
            doStart()
            return
          }
          // 首次使用先申请权限，拿到权限后提示用户再按一次，避免按住过程中弹窗导致状态错乱
          wx.authorize({
            scope: 'scope.record',
            success: () => {
              this._recordGranted = true
              util.toast('麦克风已授权，请再按住说话')
            },
            fail: () => {
              this._recordGranted = false
              util.toast('未获得麦克风权限，无法语音输入')
            }
          })
        },
        fail: doStart
      })
    },

    stopRecord() {
      this._touchActive = false
      if (!this.data.recording) return
      this.stopVoiceTimer()
      this.setData({ recording: false, transcribing: true })
      // 兜底：录音或识别异常时不一直停在“识别中...”
      this.clearVoiceTimer()
      this._voiceTimer = setTimeout(() => {
        if (!this.data.transcribing) return
        this.setData({ transcribing: false })
        util.toast('语音识别超时，请重试')
      }, 45000)
      try {
        this.getRecorder().stop()
      } catch (e) {
        this.clearVoiceTimer()
        this.setData({ transcribing: false })
        util.toast('录音结束失败，请重试')
      }
    },

    handleRecordStop(res) {
      // 被取消（收起面板等）的这次录音直接丢弃
      if (this._voiceCancel) {
        this._voiceCancel = false
        this.clearVoiceTimer()
        this.stopVoiceTimer()
        this.setData({ recording: false, transcribing: false })
        return
      }
      const filePath = res && res.tempFilePath
      const duration = Number(res && res.duration) || 0
      const size = Number(res && res.fileSize) || 0
      if (!filePath) {
        this.clearVoiceTimer()
        this.stopVoiceTimer()
        this.setData({ recording: false, transcribing: false })
        util.toast('没有录到声音，请重试')
        return
      }
      // 按住没说话就松手：录音几乎是空的，不上传、不弹报错，直接提示重说
      if ((duration > 0 && duration < MIN_VOICE_MS) || (duration === 0 && size > 0 && size < 2048)) {
        this.clearVoiceTimer()
        this.stopVoiceTimer()
        this.setData({ recording: false, transcribing: false })
        util.toast('没有听清，请按住按钮说完再松手')
        return
      }
      llm.transcribeAudio(filePath).then(text => {
        this.clearVoiceTimer()
        this.stopVoiceTimer()
        this.setData({ recording: false, transcribing: false })
        if (!text) {
          util.toast('没有识别到内容，请再说一遍')
          return
        }
        // 语音转文字后直接发送，保持语音模式方便连续对话
        this.sendMessage(text)
      }).catch(err => {
        this.clearVoiceTimer()
        this.stopVoiceTimer()
        this.setData({ recording: false, transcribing: false })
        // 「没听到内容」是正常情况（没说或声音太小），用轻提示，不弹错误弹窗
        if (err && err.empty) {
          util.toast('没有识别到内容，请再说一遍')
          return
        }
        wx.showModal({
          title: '语音识别失败',
          content: (err && err.message) || '请稍后重试',
          showCancel: false
        })
      })
    },

    // 用户说"记住..."时更新身份习惯
    checkRemember(content) {
      if (!/^(请|帮我)?记住/.test(String(content).trim())) return
      const memo = String(content).replace(/^.*?记住[：:]?\s*/, '').trim()
      if (!memo) return
      const identity = storage.getIdentity() || {}
      const old = String(identity.content || '')
      // 去重：本地已有同一条就不再追加（云端 updateIdentity 也有去重，这里先拦住本地膨胀）
      const norm = (s) => String(s || '').replace(/[\s，。、；：:！？,.!?;:()（）\[\]【】\-—_*#]/g, '').toLowerCase()
      const key = norm(memo)
      if (key && old.split('\n').some(line => norm(line).indexOf(key) >= 0)) {
        util.toast('这条已经记住了')
        return
      }
      const newContent = old + '\n- ' + memo
      storage.setIdentity({ content: newContent, updatedAt: util.formatTime(new Date()) })
      util.toast('已记住啦~')
      // AI 对话要求记住内容时，立即同步到乐享
      lexiang.autoSync({ force: true }).catch(() => {})
    }
  }
})
