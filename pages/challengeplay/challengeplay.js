// pages/challengeplay/challengeplay.js
const llm = require('../../services/llm.js')
const fade = require('../../services/fade.js')
const util = require('../../utils/util.js')

Page({
  data: {
    subject: '',
    level: 1,
    questions: [],
    current: 0,
    userAnswer: '',
    showResult: false,
    isCorrect: false,
    score: 0,
    correctCount: 0,
    wrongQuestions: [], // 本次产生的错题
    charImg: '',
    levelBg: '',
    // 手写板
    showPad: false,
    padImage: '',
    answerReset: 0, // +1 让输入栏回到语音模式（换题时用）
    grading: false,
    resultRecognized: '',
    resultFeedback: '',
    resultExplanation: '',
    resultAnswer: ''
  },

  onLoad(options) {
    const app = getApp()
    const subject = options.subject || '数学'
    const count = app.globalData.challengeCount
    const grade = app.globalData.currentGrade
    // 优先使用 waitloading 中 AI 生成的题目，没有再降级到预设题库
    let questions = []
    try {
      const payload = wx.getStorageSync('ct_generated_questions')
      if (payload && payload.subject === subject && Array.isArray(payload.questions) && payload.questions.length) {
        questions = payload.questions
        wx.removeStorageSync('ct_generated_questions')
      }
    } catch (e) {}
    if (!questions.length) questions = llm.gradeLevelQuestions(subject, count, grade)
    // 兜底补齐学科和知识点，保证错题标题始终是知识点
    questions = questions.map(q => Object.assign({}, q, {
      subject: q.subject || subject,
      knowledge: q.knowledge || subject,
      options: q.options || []
    }))
    this.setData({
      subject,
      level: parseInt(options.level) || 1,
      questions,
      charImg: app.globalData.charImages.think,
      levelBg: app.randomLevelImage()
    })
  },

  // 语音识别或键盘输入都会走到这里，统一写进答案
  onAnswerChange(e) {
    this.setData({ userAnswer: e.detail.value })
  },

  // ========== 中途退出：不保存、不同步本次已做的题 ==========
  exitChallenge() {
    if (this.data.grading) {
      util.toast('判题中，请稍候')
      return
    }
    wx.showModal({
      title: '退出闯关',
      content: '退出后本次答题不保存，已做的题不会同步到错题本，也不做分析。',
      confirmText: '退出',
      confirmColor: '#FF6B6B',
      cancelText: '继续答题',
      success: res => {
        if (res.confirm) this.quitChallenge()
      }
    })
  },

  quitChallenge() {
    // 丢弃本次的错题暂存与题目缓存，避免被结算页或下次进入误用
    wx.removeStorageSync('ct_challenge_wrong')
    wx.removeStorageSync('ct_generated_questions')
    const backToChallenge = () => wx.switchTab({ url: '/pages/challenge/challenge' })
    const pages = getCurrentPages()
    if (pages.length > 1) {
      wx.navigateBack({ fail: backToChallenge })
    } else {
      backToChallenge()
    }
  },

  // ========== 手写板 ==========
  openPad() {
    this.setData({ showPad: true })
  },

  closePad() {
    this.setData({ showPad: false })
  },

  onPadDone(e) {
    const tempFilePath = e.detail && e.detail.tempFilePath
    if (!tempFilePath) return
    this.setData({ showPad: false, padImage: tempFilePath })
  },

  removePadImage() {
    this.setData({ padImage: '' })
  },

  // ========== 提交答案 ==========
  async submitAnswer() {
    if (this.data.grading || this.data.showResult) return
    const { questions, current, userAnswer, padImage, subject } = this.data
    const q = questions[current]
    if (!q) return
    if (!userAnswer.trim() && !padImage) {
      util.toast('请先输入或手写作答')
      return
    }

    const app = getApp()
    const grade = app.globalData.currentGrade

    // 有手写内容：先让 AI 识别手写再判题
    if (padImage) {
      this.setData({ grading: true })
      // 思考型模型识别手写较慢，走秒显示进度（loading 标题最多 7 个汉字）
      const stopLoading = util.loadingTick(s => (s < 6 ? 'AI识别手写中' : '识别中 ' + s + 's'))
      try {
        const questionForAI = q.question + (q.figure ? '（题目配有几何图形）' : '')
        const result = await llm.checkHandwriting(padImage, questionForAI, q.subject || subject, grade)
        stopLoading()
        this.setData({ grading: false })
        this.finishAnswer(result.isCorrect, {
          myAnswer: result.recognized || userAnswer || '（手写作答）',
          recognized: result.recognized,
          feedback: result.feedback,
          explanation: result.explanation || q.explanation,
          correctAnswer: result.correctAnswer || q.answer
        })
      } catch (err) {
        stopLoading()
        this.setData({ grading: false })
        const msg = (err && err.message) || '手写判题失败'
        console.warn('[challengeplay] 手写判题失败:', msg)
        wx.showModal({
          title: '手写判题失败',
          content: msg + '\n\n可以改用文字输入答案，或检查当前模型是否支持图片识别。',
          confirmText: '改用文字',
          cancelText: '再试一次',
          success: res => {
            if (res.confirm) this.setData({ padImage: '' })
          }
        })
      }
      return
    }

    this.finishAnswer(this.checkAnswer(userAnswer, q.answer), {
      myAnswer: userAnswer,
      recognized: '',
      feedback: '',
      explanation: q.explanation,
      correctAnswer: q.answer
    })
  },

  finishAnswer(isCorrect, extra = {}) {
    const { questions, current } = this.data
    const q = questions[current]
    const app = getApp()
    const myAnswer = extra.myAnswer || this.data.userAnswer

    this.setData({
      resultRecognized: extra.recognized || '',
      resultFeedback: extra.feedback || '',
      resultExplanation: extra.explanation || q.explanation || '',
      resultAnswer: extra.correctAnswer || q.answer
    })

    // 消退：闯关同样按知识点累计；若正好考到错题本里的原题，也推进该错题
    const fadedResult = fade.recordAnswer({
      question: q.question,
      subject: q.subject || this.data.subject,
      knowledge: q.knowledge,
      correct: isCorrect,
      source: '闯关'
    })

    if (isCorrect) {
      this.setData({
        correctCount: this.data.correctCount + 1,
        score: this.data.score + 10,
        charImg: app.globalData.charImages.happy
      })
      this.toastFade(fadedResult)
    } else {
      // 答错的题加入错题本候选，标题使用知识点；全科时按题目自身学科归档
      const qSubject = q.subject || this.data.subject
      this.setData({
        wrongQuestions: this.data.wrongQuestions.concat([{
          id: util.uid(),
          subject: qSubject,
          knowledge: q.knowledge || qSubject,
          title: q.knowledge || qSubject,
          question: q.question,
          myAnswer,
          correctAnswer: extra.correctAnswer || q.answer,
          analysis: extra.explanation || q.explanation || '',
          difficulty: '中档',
          source: '闯关',
          status: '在册',
          correctCount: 0,
          createdAt: util.formatTime(new Date()),
          records: []
        }]),
        charImg: app.globalData.charImages.sad
      })
    }

    this.setData({ showResult: true, isCorrect })
  },

  // 消退提示：知识点答对累计达到阈值时告知
  toastFade(r) {
    if (!r) return
    if (r.wrongFaded && r.wrongFaded.length) {
      util.toast('这道错题已消退', 'success')
    } else if (r.knowledgeFaded && r.knowledgeFaded.length) {
      util.toast('知识点「' + r.knowledgeFaded[0].name + '」已掌握', 'success')
    }
  },

  checkAnswer(input, correct) {
    // 简单匹配：去除空格标点后比较
    const clean = s => String(s || '').replace(/\s/g, '').replace(/[，。！？、,.!?]/g, '')
    return clean(input) === clean(correct) || clean(input).includes(clean(correct)) || clean(correct).includes(clean(input))
  },

  nextQuestion() {
    const { current, questions } = this.data
    if (current + 1 >= questions.length) {
      // 结算
      wx.redirectTo({
        url: `/pages/challengesettle/challengesettle?subject=${this.data.subject}&score=${this.data.score}&correct=${this.data.correctCount}&total=${questions.length}&wrongCount=${this.data.wrongQuestions.length}`
      })
      // 暂存错题供结算页确认入库
      wx.setStorageSync('ct_challenge_wrong', this.data.wrongQuestions)
      return
    }
    this.setData({
      current: current + 1,
      userAnswer: '',
      showResult: false,
      charImg: getApp().globalData.charImages.think,
      padImage: '',
      answerReset: this.data.answerReset + 1,
      resultRecognized: '',
      resultFeedback: '',
      resultExplanation: '',
      resultAnswer: ''
    })
  }
})
