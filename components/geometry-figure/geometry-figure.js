// components/geometry-figure/geometry-figure.js
// 根据题目里的 figure 描述绘制几何图形（角度、三角形、长方形、正方形、圆、平行四边形）
Component({
  properties: {
    figure: {
      type: Object,
      value: null
    }
  },

  observers: {
    figure() {
      if (this._ctx) this.draw()
    }
  },

  lifetimes: {
    ready() {
      this.initCanvas()
    }
  },

  methods: {
    initCanvas() {
      this.createSelectorQuery()
        .select('#fig')
        .fields({ node: true, size: true })
        .exec(res => {
          const info = res && res[0]
          if (!info || !info.node) return
          const canvas = info.node
          const width = info.width
          const height = info.height
          const dpr = (wx.getWindowInfo && wx.getWindowInfo().pixelRatio) ||
            (wx.getSystemInfoSync && wx.getSystemInfoSync().pixelRatio) || 2
          canvas.width = width * dpr
          canvas.height = height * dpr
          const ctx = canvas.getContext('2d')
          ctx.scale(dpr, dpr)
          this._canvas = canvas
          this._ctx = ctx
          this._w = width
          this._h = height
          this.draw()
        })
    },

    draw() {
      const ctx = this._ctx
      const w = this._w
      const h = this._h
      const f = this.data.figure
      if (!ctx || !f) return
      ctx.clearRect(0, 0, w, h)
      ctx.strokeStyle = '#7B5EA7'
      ctx.fillStyle = '#333333'
      ctx.lineWidth = 2.5
      ctx.lineCap = 'round'
      ctx.font = '13px sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'

      const labels = f.labels || []
      const labelOf = (i, key) => {
        if (Array.isArray(labels)) return labels[i] || ''
        if (labels && typeof labels === 'object') return labels[key] || ''
        return ''
      }
      const line = (x1, y1, x2, y2) => {
        ctx.beginPath()
        ctx.moveTo(x1, y1)
        ctx.lineTo(x2, y2)
        ctx.stroke()
      }
      const text = (t, x, y) => {
        if (!t) return
        ctx.fillText(String(t), x, y)
      }

      if (f.type === 'angle') {
        const vx = w * 0.24, vy = h * 0.82
        const len = w * 0.68
        const rad = -Math.PI / 3
        line(vx, vy, vx + len, vy)
        line(vx, vy, vx + Math.cos(rad) * len, vy + Math.sin(rad) * len)
        ctx.beginPath()
        ctx.arc(vx, vy, 40, rad, 0)
        ctx.stroke()
        text(f.label || '∠?', vx + 70, vy - 40)
      } else if (f.type === 'triangle') {
        const A = { x: w / 2, y: h * 0.14 }
        const B = { x: w * 0.16, y: h * 0.86 }
        const C = { x: w * 0.84, y: h * 0.86 }
        line(A.x, A.y, B.x, B.y)
        line(B.x, B.y, C.x, C.y)
        line(C.x, C.y, A.x, A.y)
        text(labelOf(0, 'left'), (A.x + B.x) / 2 - 14, (A.y + B.y) / 2)
        text(labelOf(1, 'bottom'), (B.x + C.x) / 2, h * 0.93)
        text(labelOf(2, 'right'), (A.x + C.x) / 2 + 14, (A.y + C.y) / 2)
      } else if (f.type === 'rectangle' || f.type === 'square') {
        const x1 = w * 0.2, y1 = h * 0.16, x2 = w * 0.8, y2 = h * 0.84
        ctx.strokeRect(x1, y1, x2 - x1, y2 - y1)
        text(labelOf(0, 'top'), (x1 + x2) / 2, y1 - 14)
        text(labelOf(1, 'bottom'), (x1 + x2) / 2, y2 + 14)
        text(labelOf(2, 'left'), x1 - 26, (y1 + y2) / 2)
        text(labelOf(3, 'right'), x2 + 26, (y1 + y2) / 2)
      } else if (f.type === 'circle') {
        const cx = w / 2, cy = h / 2
        const r = Math.min(w, h) * 0.34
        ctx.beginPath()
        ctx.arc(cx, cy, r, 0, Math.PI * 2)
        ctx.stroke()
        line(cx, cy, cx + r, cy)
        ctx.beginPath()
        ctx.arc(cx, cy, 3, 0, Math.PI * 2)
        ctx.fill()
        text(labelOf(0, 'radius'), cx + r / 2, cy - 14)
      } else if (f.type === 'parallelogram') {
        const p1 = { x: w * 0.3, y: h * 0.18 }
        const p2 = { x: w * 0.86, y: h * 0.18 }
        const p3 = { x: w * 0.7, y: h * 0.82 }
        const p4 = { x: w * 0.14, y: h * 0.82 }
        line(p1.x, p1.y, p2.x, p2.y)
        line(p2.x, p2.y, p3.x, p3.y)
        line(p3.x, p3.y, p4.x, p4.y)
        line(p4.x, p4.y, p1.x, p1.y)
        text(labelOf(0, 'top'), (p1.x + p2.x) / 2, p1.y - 14)
        text(labelOf(1, 'bottom'), (p3.x + p4.x) / 2, p4.y + 14)
        text(labelOf(2, 'left'), (p1.x + p4.x) / 2 - 16, (p1.y + p4.y) / 2)
        text(labelOf(3, 'right'), (p2.x + p3.x) / 2 + 16, (p2.y + p3.y) / 2)
      } else if (f.type === 'line') {
        line(w * 0.15, h / 2, w * 0.85, h / 2)
        text(f.label || '', w / 2, h / 2 - 20)
      }
    }
  }
})
