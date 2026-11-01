// pages/wrongentry/wrongentry.js
const llm = require('../../services/llm.js')
const lexiang = require('../../services/lexiang.js')
const storage = require('../../services/storage.js')
const solution = require('../../services/solution.js')
const memorySvc = require('../../services/memory.js')
const util = require('../../utils/util.js')

Page({
  data: {
    mode: 'camera', // camera | voice | chat
    imagePath: '',
    loading: false,
    loadingText: 'AI 正在识别整理中...',
    loadingSub: '请稍候，马上就好',
    // AI 整理结果（确认门）
    result: null,
    // 学科清单与乐享知识库同步（不含全科，错题必须归到具体科目）
    subjects: lexiang.getSyncedSubjects(),
    difficulties: ['基础', '中档', '难']
  },

  onLoad(options) {
    const mode = options.mode || 'camera'
    this.setData({ mode, subjects: lexiang.getSyncedSubjects() })
    if (mode === 'camera') {
      this.takePhoto()
    } else if (mode === 'voice') {
      this.startVoice()
    } else if (mode === 'chat') {
      // 从对话提取，直接用 mock 结果
      this.runOCR('')
    }
  },

  // app 与乐享同步完科目后会回调这里
  onSubjectsUpdated() {
    this.setData({ subjects: lexiang.getSyncedSubjects() })
  },

  takePhoto() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['camera', 'album'],
      sizeType: ['compressed'],
      success: res => {
        this.setData({ imagePath: res.tempFiles[0].tempFilePath })
        this.runOCR(res.tempFiles[0].tempFilePath)
      },
      fail: () => wx.navigateBack()
    })
  },

  // 口述录入：先确认麦克风权限，拿到权限才开录（未授权直接 start 会静默失败）
  startVoice() {
    const begin = () => {
      const recorder = this.getRecorder()
      try {
        recorder.start({ duration: 60000, format: 'mp3', sampleRate: 16000, encodeBitRate: 48000, numberOfChannels: 1 })
      } catch (e) {
        util.toast('麦克风启动失败，请检查权限')
        return
      }
      wx.showModal({
        title: '口述错题',
        content: '请对着麦克风口述题目内容，说完后点击"完成"。',
        showCancel: false,
        success: () => {
          try { recorder.stop() } catch (e) {}
        }
      })
    }
    if (this._recordGranted) {
      begin()
      return
    }
    wx.getSetting({
      success: res => {
        const granted = res.authSetting && res.authSetting['scope.record']
        if (granted === true) {
          this._recordGranted = true
          begin()
          return
        }
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
        wx.authorize({
          scope: 'scope.record',
          success: () => {
            this._recordGranted = true
            util.toast('麦克风已授权，请再点一次口述')
          },
          fail: () => util.toast('未获得麦克风权限，无法语音输入')
        })
      },
      fail: begin
    })
  },

  // 录音器只建一次，回调只绑一次，避免重复点口述后 onStop 叠加
  getRecorder() {
    if (this._recorder) return this._recorder
    const recorder = wx.getRecorderManager()
    recorder.onStop(() => {
      util.toast('正在转写整理...')
      this.runOCR('')
    })
    recorder.onError(err => {
      const msg = (err && err.errMsg) || ''
      if (/auth|permission|deny/i.test(msg)) this._recordGranted = false
      util.toast('录音失败：' + (msg || '请检查麦克风权限'))
    })
    this._recorder = recorder
    return recorder
  },

  runOCR(imagePath) {
    this.setData({ loading: true, result: null })
    this.startOcrTimer()
    llm.ocrWrongQuestion(imagePath).then(result => {
      this.stopOcrTimer()
      this.applyResult(result)
    }).catch(err => {
      const msg = (err && err.message) || '识别失败，请重试'
      console.warn('[wrongentry] OCR 失败:', msg)
      this.stopOcrTimer()
      this.setData({ loading: false })
      const hint = (err && err.visionUnsupported)
        ? '\n\n当前模型可能不支持图片输入，可在设置中更换支持视觉的模型（如 qwen-vl-max、glm-4v），或先手动填写。'
        : '\n\n可以重试；若一直失败，请改为手动填写。'
      wx.showModal({
        title: '识别失败',
        content: msg + hint,
        confirmText: '手动填写',
        cancelText: '重试',
        success: res => {
          if (res.confirm) this.useManual()
          else if (this.data.imagePath) this.runOCR(this.data.imagePath)
          else this.takePhoto()
        }
      })
    })
  },

  // 识别进度：思考型模型（商汤）单张图要 30~60 秒，走秒提示避免用户以为卡死
  startOcrTimer() {
    this.stopOcrTimer()
    const slow = llm.isSlowVisionModel()
    const start = Date.now()
    const tick = () => {
      const s = Math.floor((Date.now() - start) / 1000)
      if (s < 6) {
        this.setData({ loadingText: 'AI 正在识别整理中...', loadingSub: '请稍候，马上就好' })
        return
      }
      this.setData({
        loadingText: '图片识别中，已等待 ' + s + ' 秒',
        loadingSub: slow
          ? '当前模型需要先思考再看图，通常 30~60 秒，请不要退出'
          : '题目较复杂时需要多一点时间，请不要退出'
      })
    }
    tick()
    this._ocrTimer = setInterval(tick, 1000)
  },

  stopOcrTimer() {
    if (this._ocrTimer) {
      clearInterval(this._ocrTimer)
      this._ocrTimer = null
    }
  },

  onUnload() {
    this.stopOcrTimer()
  },

  applyResult(result) {
    const r = Object.assign({
      id: util.uid(),
      source: this.data.mode === 'camera' ? '拍照' : (this.data.mode === 'voice' ? '口述' : '对话'),
      status: '在册',
      correctCount: 0,
      createdAt: util.formatTime(new Date()),
      records: []
    }, result)
    // 标题统一使用知识点
    r.knowledge = r.knowledge || '未分类知识点'
    r.title = r.knowledge
    this.setData({
      result: r,
      loading: false,
      subjectIndex: Math.max(0, this.data.subjects.indexOf(r.subject)),
      difficultyIndex: Math.max(0, this.data.difficulties.indexOf(r.difficulty))
    })
  },

  // OCR 失败/模型不支持图片时的兜底：手动填写
  useManual() {
    this.applyResult({
      subject: '其他',
      knowledge: '未分类知识点',
      title: '未分类知识点',
      question: '',
      myAnswer: '',
      correctAnswer: '',
      analysis: '',
      difficulty: '中档'
    })
    util.toast('请手动补充题目信息')
  },

  // 用户可修正字段
  onFieldChange(e) {
    const field = e.currentTarget.dataset.field
    const result = this.data.result
    result[field] = e.detail.value
    // 题目标题始终等于知识点
    if (field === 'knowledge') result.title = e.detail.value
    this.setData({ result })
  },

  onSubjectChange(e) {
    const result = this.data.result
    const index = Number(e.detail.value) || 0
    result.subject = this.data.subjects[index]
    this.setData({ result, subjectIndex: index })
  },

  onDifficultyChange(e) {
    const result = this.data.result
    const index = Number(e.detail.value) || 0
    result.difficulty = this.data.difficulties[index]
    this.setData({ result, difficultyIndex: index })
  },

  // 确认入库（WB-4 确认门）
  async onConfirm() {
    const item = this.data.result
    const list = storage.getWrongbook()
    list.unshift(item)
    storage.setWrongbook(list)

    // 触发学习记忆更新（MEM-2 触发点）：增量追加知识点，不覆盖已有内容
    this.updateMemory(item.subject, item)

    // 统一走自动同步，成功后自动标记 synced，避免重复写入
    lexiang.autoSync({ force: true }).catch(() => {
      console.warn('[lexiang] 错题同步失败，已存本地')
    })

    // 顺手把 AI 解题思路在后台生成好（存本地 + 乐享），之后点开直接看
    solution.syncPending({ force: true }).catch(() => {})

    util.toast('已存入错题本', 'success')
    setTimeout(() => wx.navigateBack(), 1000)
  },

  // 取消
  onCancel() {
    wx.navigateBack()
  },

  // 重新拍照
  onRetake() {
    this.setData({ result: null })
    if (this.data.mode === 'camera') this.takePhoto()
    else if (this.data.mode === 'voice') this.startVoice()
  },

  // 更新学科学习记忆：只把这道错题的知识点增量写进去
  // 云端同名知识点去重、不删页面原有内容（整页覆盖会冲掉 AI 归档的知识点）
  updateMemory(subject, item) {
    const memory = storage.getMemory(subject) || {
      subject, weakPoints: [], masteredPoints: [], commonErrors: [], preference: '', updatedAt: ''
    }
    memory.updatedAt = util.formatTime(new Date())
    storage.setMemory(subject, memory)
    const knowledge = String((item && item.knowledge) || '').trim()
    if (!knowledge) return
    memorySvc.addPoints(subject, [knowledge])
    const detail = '来自错题：' + String(item.question || '').slice(0, 60) +
      (item.analysis ? '；错因：' + String(item.analysis).slice(0, 80) : '')
    lexiang.appendMemory(subject, knowledge, detail).catch(() => {})
  }
})
