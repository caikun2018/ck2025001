// components/handwriting-pad/handwriting-pad.js
// 手写板：canvas 2d 绘制 → 导出图片，交给视觉模型识别判题
Component({
  options: {
    multipleSlots: true
  },

  properties: {
    visible: {
      type: Boolean,
      value: false
    }
  },

  data: {
    hasInk: false,
    peek: false // true 时切换为「看题目」视图，手写内容保留
  },

  observers: {
    visible(val) {
      if (val) {
        this.setData({ hasInk: false, peek: false })
        setTimeout(() => this.initCanvas(), 60)
      } else {
        this.setData({ peek: false })
      }
    }
  },

  methods: {
    noop() {},

    // 手写 / 题目 两个视图互相切换
    togglePeek() {
      this.setData({ peek: !this.data.peek })
    },

    initCanvas(retry = 0) {
      this.createSelectorQuery()
        .select('#pad')
        .fields({ node: true, size: true, rect: true })
        .exec(res => {
          const info = res && res[0]
          if (!info || !info.node || !info.width || !info.height) {
            if (retry < 3) setTimeout(() => this.initCanvas(retry + 1), 100)
            return
          }
          const dpr = (wx.getWindowInfo && wx.getWindowInfo().pixelRatio) ||
            (wx.getSystemInfoSync && wx.getSystemInfoSync().pixelRatio) || 2
          const canvas = info.node
          canvas.width = info.width * dpr
          canvas.height = info.height * dpr
          const ctx = canvas.getContext('2d')
          ctx.scale(dpr, dpr)
          ctx.lineCap = 'round'
          ctx.lineJoin = 'round'
          ctx.strokeStyle = '#2B2340'
          ctx.lineWidth = 3
          this._canvas = canvas
          this._ctx = ctx
          this._w = info.width
          this._h = info.height
          this._rect = { left: info.left || 0, top: info.top || 0 }
          this._drawing = false
          this.paintBackground()
        })
    },

    paintBackground() {
      const ctx = this._ctx
      if (!ctx) return
      ctx.fillStyle = '#FFFFFF'
      ctx.fillRect(0, 0, this._w, this._h)
      ctx.strokeStyle = '#2B2340'
      ctx.lineWidth = 3
    },

    pointOf(e) {
      const t = e.touches && e.touches[0]
      if (!t) return null
      if (typeof t.x === 'number' && typeof t.y === 'number') {
        return { x: t.x, y: t.y }
      }
      const rect = this._rect || { left: 0, top: 0 }
      return { x: t.clientX - rect.left, y: t.clientY - rect.top }
    },

    onTouchStart(e) {
      if (!this._ctx) return
      const p = this.pointOf(e)
      if (!p) return
      this._drawing = true
      this._last = p
      this._ctx.beginPath()
      this._ctx.moveTo(p.x, p.y)
      this._ctx.lineTo(p.x + 0.1, p.y + 0.1)
      this._ctx.stroke()
      if (!this.data.hasInk) this.setData({ hasInk: true })
    },

    onTouchMove(e) {
      if (!this._drawing || !this._ctx) return
      const p = this.pointOf(e)
      if (!p) return
      const last = this._last || p
      this._ctx.beginPath()
      this._ctx.moveTo(last.x, last.y)
      this._ctx.lineTo(p.x, p.y)
      this._ctx.stroke()
      this._last = p
    },

    onTouchEnd() {
      this._drawing = false
      this._last = null
    },

    clearPad() {
      this.paintBackground()
      this.setData({ hasInk: false })
    },

    closePad() {
      this.triggerEvent('close')
    },

    confirmPad() {
      if (!this.data.hasInk || !this._canvas) {
        wx.showToast({ title: '请先写下你的答案', icon: 'none' })
        return
      }
      wx.showLoading({ title: '生成手写图片...', mask: true })
      wx.canvasToTempFilePath({
        canvas: this._canvas,
        fileType: 'png',
        success: res => {
          wx.hideLoading()
          this.triggerEvent('done', { tempFilePath: res.tempFilePath })
        },
        fail: err => {
          wx.hideLoading()
          wx.showToast({ title: '手写图片导出失败：' + (err.errMsg || ''), icon: 'none' })
        }
      })
    }
  }
})
