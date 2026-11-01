// pages/practiceexam/practiceexam.js
const llm = require('../../services/llm.js')
const fade = require('../../services/fade.js')
const util = require('../../utils/util.js')

Page({
  data: {
    mode: 'exam', // original | exam
    questions: [],
    current: 0,
    userAnswer: '',
    showResult: false,
    isCorrect: false,
    retryCount: 0, // 原题练习答错重试一次
    showAnswer: false,
    correctCount: 0,
    // 考试模式
    remaining: 0,
    timeDisplay: '00:00',
    duration: 30,
    submitted: false,
    answers: {}, // 考试模式记录每题答案
    // 手写板
    showPad: false,
    padImage: '',
    grading: false,
    recognizedAnswer: '',
    retryHint: '', // 原题练习第一次答错的重试提示（不结束本题）
    answerReset: 0 // +1 让输入栏回到语音模式（换题/重试时用）
  },

  onLoad(options) {
    const mode = options.mode || 'exam'
    this.setData({ mode, duration: parseInt(options.duration) || 30 })

    if (mode === 'original') {
      // 原题练习：使用选中的错题
      const questions = wx.getStorageSync('ct_practice_questions') || []
      this.setData({ questions })
    } else {
      // 模拟考试：优先使用 waitloading 中 AI 生成的题目，没有再降级到预设题库
      const subject = options.subject || '数学'
      const count = parseInt(options.count) || 10
      const grade = getApp().globalData.currentGrade
      let questions = []
      try {
        const payload = wx.getStorageSync('ct_generated_questions')
        if (payload && payload.subject === subject && Array.isArray(payload.questions) && payload.questions.length) {
          questions = payload.questions
          wx.removeStorageSync('ct_generated_questions')
        }
      } catch (e) {}
      if (!questions.length) questions = llm.gradeLevelQuestions(subject, count, grade)
      questions = questions.map(q => Object.assign({}, q, {
        subject: q.subject || subject,
        knowledge: q.knowledge || subject
      }))
      this.setData({ questions })
      this.startTimer()
    }
  },

  startTimer() {
    const total = this.data.duration * 60
    this.setData({ remaining: total, timeDisplay: this.formatTime(total) })
    this._timer = setInterval(() => {
      const remaining = this.data.remaining - 1
      if (remaining <= 0) {
        clearInterval(this._timer)
        this.submitExam()
        return
      }
      this.setData({ remaining, timeDisplay: this.formatTime(remaining) })
    }, 1000)
  },

  onUnload() {
    if (this._timer) clearInterval(this._timer)
  },

  formatTime(s) {
    const m = Math.floor(s / 60)
    const sec = s % 60
    return `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`
  },

  // 语音识别 / 键盘输入都走这里；考试模式同步写入本题答案
  onAnswerChange(e) {
    const val = e.detail.value
    if (this.data.mode === 'exam') {
      const answers = this.data.answers
      answers[this.data.current] = val
      // 改用语音/键盘重答后，之前手写留下的判题结果作废
      if (this._padJudge) delete this._padJudge[this.data.current]
      this.setData({ answers })
    }
    this.setData({ userAnswer: val })
  },

  // ========== 手写板 ==========
  openPad() {
    if (this.data.grading) {
      util.toast('AI 还在识别，请稍候')
      return
    }
    this.setData({ showPad: true })
  },

  closePad() {
    this.setData({ showPad: false })
  },

  removePadImage() {
    this.setData({ padImage: '' })
  },

  // 手写完成：原题练习留图待判题；考试模式当场识别成文字，交卷时统一批改
  async onPadDone(e) {
    const tempFilePath = e.detail && e.detail.tempFilePath
    if (!tempFilePath) return
    this.setData({ showPad: false })
    if (this.data.mode === 'original') {
      this.setData({ padImage: tempFilePath })
      return
    }
    const q = this.data.questions[this.data.current]
    if (!q) return
    this.setData({ grading: true })
    const stopLoading = util.loadingTick(s => (s < 6 ? 'AI识别手写中' : '识别中 ' + s + 's'))
    try {
      const result = await llm.checkHandwriting(
        tempFilePath,
        q.question + (q.figure ? '（题目配有几何图形）' : ''),
        q.subject || '数学',
        getApp().globalData.currentGrade
      )
      stopLoading()
      this.setData({ grading: false })
      // 记住这次手写的判题结果，交卷时直接用，免得再识别一遍
      this._padJudge = this._padJudge || {}
      this._padJudge[this.data.current] = !!result.isCorrect
      const text = result.recognized || ''
      const answers = this.data.answers
      answers[this.data.current] = text || '（手写作答）'
      this.setData({ answers, userAnswer: answers[this.data.current], recognizedAnswer: text })
    } catch (err) {
      stopLoading()
      this.setData({ grading: false })
      wx.showModal({
        title: '手写识别失败',
        content: ((err && err.message) || '请稍后重试') + '\n\n也可以改用语音或键盘输入答案。',
        showCancel: false
      })
    }
  },

  // 原题练习：即时判分，答错重试一次（手写作答交给 AI 识别判题）
  async submitOriginal() {
    if (this.data.grading || this.data.showResult) return
    const { questions, current, userAnswer, retryCount, padImage } = this.data
    const q = questions[current]
    if (!q) return
    if (!String(userAnswer || '').trim() && !padImage) {
      util.toast('请说出或写下你的答案')
      return
    }

    this.setData({ retryHint: '' })
    let isCorrect = false
    if (padImage) {
      this.setData({ grading: true })
      // 思考型模型识别手写较慢，走秒显示进度（loading 标题最多 7 个汉字）
      const stopLoading = util.loadingTick(s => (s < 6 ? 'AI识别手写中' : '识别中 ' + s + 's'))
      try {
        const result = await llm.checkHandwriting(
          padImage,
          q.question + (q.figure ? '（题目配有几何图形）' : ''),
          q.subject || '数学',
          getApp().globalData.currentGrade
        )
        stopLoading()
        isCorrect = !!result.isCorrect
        // 把 AI 给出的正确答案与解析回填，供答错时展示
        if (result.correctAnswer) questions[current].correctAnswer = result.correctAnswer
        if (result.explanation) questions[current].analysis = result.explanation
        this.setData({
          grading: false,
          questions,
          recognizedAnswer: result.recognized || '',
          userAnswer: userAnswer || (result.recognized || '（手写作答）')
        })
      } catch (err) {
        stopLoading()
        this.setData({ grading: false })
        wx.showModal({
          title: '手写判题失败',
          content: ((err && err.message) || '请稍后重试') + '\n\n可以改用语音或键盘说答案，或检查当前模型是否支持图片识别。',
          confirmText: '改用文字',
          cancelText: '再试一次',
          success: res => {
            if (res.confirm) this.setData({ padImage: '' })
          }
        })
        return
      }
    } else {
      isCorrect = this.checkAnswer(userAnswer, q.correctAnswer || q.answer)
    }

    if (isCorrect) {
      // 答对：错题连续正确 +1，同时该知识点累计 +1
      const r = fade.recordAnswer({
        wrongId: q.id,
        question: q.question,
        subject: q.subject,
        knowledge: q.knowledge,
        correct: true,
        source: '原题练习'
      })
      this.setData({ correctCount: this.data.correctCount + 1, showResult: true, isCorrect: true, retryHint: '', padImage: '' })
      this.toastFade(r)
    } else {
      if (retryCount === 0) {
        // 第一次错：重试一次，不展示答案，输入区保留让孩子重说或重写
        this.setData({
          isCorrect: false,
          retryCount: 1,
          userAnswer: '',
          padImage: '',
          recognizedAnswer: '',
          retryHint: '❌ 还差一点，再想一想，说出或写下新的答案',
          answerReset: this.data.answerReset + 1
        })
      } else {
        // 第二次错：展示解析，清零连续正确
        fade.recordAnswer({
          wrongId: q.id,
          question: q.question,
          subject: q.subject,
          knowledge: q.knowledge,
          correct: false,
          source: '原题练习'
        })
        this.setData({ showResult: true, isCorrect: false, showAnswer: true })
      }
    }
  },

  // 消退提示（本单题 / 知识点）
  toastFade(r) {
    if (!r) return
    if (r.wrongFaded && r.wrongFaded.length) {
      util.toast('连续答对达到 ' + fade.getThreshold() + ' 次，这道错题已消退', 'success')
    } else if (r.knowledgeFaded && r.knowledgeFaded.length) {
      util.toast('知识点「' + r.knowledgeFaded[0].name + '」已掌握，相关错题已消退', 'success')
    }
  },

  nextQuestion() {
    const { current, questions, mode } = this.data
    if (current + 1 >= questions.length) {
      if (mode === 'original') {
        // 原题练习结束
        wx.redirectTo({
          url: `/pages/practiceresult/practiceresult?mode=original&correct=${this.data.correctCount}&total=${questions.length}`
        })
      }
      return
    }
    this.setData({
      current: current + 1,
      userAnswer: mode === 'exam' ? (this.data.answers[current + 1] || '') : '',
      showResult: false,
      retryCount: 0,
      showAnswer: false,
      padImage: '',
      recognizedAnswer: '',
      retryHint: '',
      answerReset: this.data.answerReset + 1
    })
  },

  prevQuestion() {
    if (this.data.current === 0) return
    const prev = this.data.current - 1
    this.setData({
      current: prev,
      userAnswer: this.data.answers[prev] || '',
      showResult: false,
      padImage: '',
      recognizedAnswer: '',
      answerReset: this.data.answerReset + 1
    })
  },

  // 考试交卷
  submitExam() {
    if (this.data.grading) {
      util.toast('手写还在识别，请稍候')
      return
    }
    if (this._timer) clearInterval(this._timer)
    const { questions, answers } = this.data
    let correct = 0
    const wrongQuestions = []
    const padJudge = this._padJudge || {}
    questions.forEach((q, idx) => {
      const ans = answers[idx] || ''
      // 手写作答：用当时 AI 识别出的判题结果，避免文字比对误判
      const isCorrect = padJudge[idx] !== undefined
        ? padJudge[idx]
        : this.checkAnswer(ans, q.answer)
      // 考试同样计入消退：知识点按题累计；若考到错题本里的原题，也推进该错题
      fade.recordAnswer({
        question: q.question,
        subject: q.subject,
        knowledge: q.knowledge,
        correct: isCorrect,
        source: '模拟考试'
      })
      if (isCorrect) correct++
      else {
        wrongQuestions.push({
          id: util.uid(),
          subject: q.subject || '数学',
          knowledge: q.knowledge || '综合练习',
          title: q.knowledge || '综合练习',
          question: q.question,
          myAnswer: ans,
          correctAnswer: q.answer,
          analysis: q.explanation,
          difficulty: '中档',
          source: '考试',
          status: '在册',
          correctCount: 0,
          createdAt: util.formatTime(new Date()),
          records: []
        })
      }
    })
    wx.setStorageSync('ct_exam_wrong', wrongQuestions)
    wx.redirectTo({
      url: `/pages/practiceresult/practiceresult?mode=exam&correct=${correct}&total=${questions.length}`
    })
  },

  checkAnswer(input, correct) {
    if (!correct) return false
    const clean = s => s.replace(/\s/g, '').replace(/[，。！？、,.!?]/g, '')
    const a = clean(input), b = clean(correct)
    return a === b || a.includes(b) || b.includes(a)
  }
})
