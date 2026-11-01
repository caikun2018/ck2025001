// components/answer-bar/answer-bar.js
// 答题输入栏：和 AI 助手底部一致 —— 默认语音（按住说话），左侧按钮切键盘输入
// 与 AI 助手不同：语音识别结果只填进输入框，由孩子确认后自己点提交，绝不自动发送
const llm = require('../../services/llm.js')
const util = require('../../utils/util.js')

// 短于这个时长（毫秒）就当没说话：按住就松手、或只擦了一下按钮
const MIN_VOICE_MS = 500

Component({
  properties: {
    value: { type: String, value: '' },          // 当前答案（父页面持有）
    placeholder: { type: String, value: '输入答案' },
    submitText: { type: String, value: '' },     // 为空则不显示右侧提交按钮
    disabled: { type: Boolean, value: false },   // 判题中禁用提交
    resetKey: { type: Number, value: 0 },        // 页面换题/重试时递增，输入栏回到语音
    hideEcho: { type: Boolean, value: false }    // 为 true 时不显示语音状态的「🎤 我听到」回显行
  },

  data: {
    inputMode: 'voice', // voice 默认语音，text 为键盘输入（识别完也切到 text，答案落在输入框里）
    recording: false,
    transcribing: false,
    voiceSeconds: 0
  },

  observers: {
    // 换题、重试时页面把 resetKey +1，输入栏回到「按住说话」，保持语音优先
    resetKey(val, oldVal) {
      if (oldVal !== undefined && val !== oldVal) this.setData({ inputMode: 'voice' })
    }
  },

  methods: {
    // 语音 / 键盘切换（录音或识别中不允许切）
    switchInput() {
      if (this.data.recording || this.data.transcribing) return
      this.triggerEvent('modechange', { mode: this.data.inputMode === 'voice' ? 'text' : 'voice' })
      this.setData({ inputMode: this.data.inputMode === 'voice' ? 'text' : 'voice' })
    },

    onInput(e) {
      this.triggerEvent('change', { value: e.detail.value, from: 'text' })
    },

    onSubmit() {
      if (this.data.disabled || this.data.recording || this.data.transcribing) return
      this.triggerEvent('submit')
    },

    // ===== 录音：wx.getRecorderManager + 语音识别模型（与 AI 助手同一套） =====
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

    startRecord() {
      if (this.data.recording || this.data.transcribing) return
      // 记住手指是否还按着：查权限是异步的，松手后才拿到结果的不能再开录（否则会录到 60 秒空音）
      this._touchActive = true
      const recorder = this.getRecorder()
      const doStart = () => {
        if (!this._touchActive) return
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
          if (granted === true) {
            this._recordGranted = true
            doStart()
            return
          }
          if (granted === false) {
            wx.showModal({
              title: '需要麦克风权限',
              content: '请在设置中开启麦克风权限后再使用语音输入。',
              confirmText: '去设置',
              success: r => {
                if (r.confirm) {
                  wx.openSetting({
                    success: s => {
                      if (s.authSetting && s.authSetting['scope.record']) this._recordGranted = true
                    }
                  })
                }
              }
            })
            return
          }
          // 还没问过：先申请权限，拿到后提示再按一次（按住时弹窗会让这次按压失效）
          this.askRecordPermission()
        },
        fail: doStart
      })
    },

    askRecordPermission() {
      if (this._authing) return
      this._authing = true
      wx.authorize({
        scope: 'scope.record',
        success: () => {
          this._authing = false
          this._recordGranted = true
          util.toast('麦克风已授权，请再按住说话')
        },
        fail: () => {
          this._authing = false
          this._recordGranted = false
          util.toast('未获得麦克风权限，无法语音输入')
        }
      })
    },

    stopRecord() {
      this._touchActive = false
      if (!this.data.recording) return
      this.stopVoiceTimer()
      this.setData({ recording: false, transcribing: true })
      // 兜底：识别异常时不一直停在「识别中...」
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
        // 口算容易说成「三十五」，这里统一转成阿拉伯数字再交给页面
        const answer = util.speechToAnswer(text)
        // 只填充不发送：把识别结果交给页面写进答案，再切到输入框摆出来给孩子改
        this.triggerEvent('change', { value: answer, raw: text, from: 'voice' })
        this.setData({ inputMode: 'text' })
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

  },

  // 页面卸载时放弃正在进行的录音，避免录音器一直占着麦克风
  lifetimes: {
    detached() {
      if (this._voiceTimer) clearTimeout(this._voiceTimer)
      if (this._voiceTick) clearInterval(this._voiceTick)
      if (this.data.recording) {
        try { this.getRecorder().stop() } catch (e) {}
      }
    }
  }
})
