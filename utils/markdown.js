// utils/markdown.js - 轻量 Markdown 转 rich-text 节点
// 只处理模型最常输出的：小标题、整行加粗、有序/无序列表、行内加粗，避免引入额外依赖

const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')

// 行内标记：**加粗**、`代码`、[文字](链接) 只保留文字
const inline = (text) => escapeHtml(text)
  .replace(/\*\*([^*]+)\*\*/g, '<span style="font-weight:600;color:#3A2C55;">$1</span>')
  .replace(/`([^`]+)`/g, '<span style="background:#F2ECFF;padding:0 6rpx;border-radius:6rpx;">$1</span>')
  .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')

const mdToHtml = (md) => {
  const src = String(md || '').replace(/\r\n/g, '\n')
  if (!src.trim()) return ''

  const parts = []
  let listType = ''
  let listItems = []

  const flushList = () => {
    if (!listItems.length) return
    const tag = listType === 'ol' ? 'ol' : 'ul'
    const items = listItems.map(t => `<li style="margin:6rpx 0;font-size:28rpx;line-height:1.7;color:#333;">${t}</li>`).join('')
    parts.push(`<${tag} style="margin:8rpx 0;padding-left:40rpx;">${items}</${tag}>`)
    listItems = []
    listType = ''
  }

  src.split('\n').forEach(raw => {
    const line = raw.trim()
    if (!line) {
      flushList()
      return
    }

    // ## 小标题
    const h = line.match(/^(#{1,6})\s+(.+)$/)
    if (h) {
      flushList()
      const level = h[1].length
      const size = level <= 2 ? 33 : (level === 3 ? 30 : 28)
      parts.push(`<div style="font-size:${size}rpx;font-weight:600;color:#3A2C55;margin:20rpx 0 10rpx;">${inline(h[2])}</div>`)
      return
    }

    // 整行加粗也当小标题用
    const boldLine = line.match(/^\*\*(.+?)\*\*$/)
    if (boldLine) {
      flushList()
      parts.push(`<div style="font-size:29rpx;font-weight:600;color:#3A2C55;margin:18rpx 0 8rpx;">${escapeHtml(boldLine[1])}</div>`)
      return
    }

    // 分隔线
    if (/^([-*_])\1{2,}$/.test(line)) {
      flushList()
      parts.push('<div style="height:1rpx;background:#EEE6FA;margin:18rpx 0;"></div>')
      return
    }

    const ul = line.match(/^[-*•]\s+(.+)$/)
    if (ul) {
      if (listType === 'ol') flushList()
      listType = 'ul'
      listItems.push(inline(ul[1]))
      return
    }

    const ol = line.match(/^(\d+)[.、)]\s*(.+)$/)
    if (ol) {
      if (listType === 'ul') flushList()
      listType = 'ol'
      listItems.push(inline(ol[2]))
      return
    }

    flushList()
    parts.push(`<div style="font-size:28rpx;line-height:1.75;color:#333;margin:6rpx 0;">${inline(line)}</div>`)
  })

  flushList()
  return parts.join('')
}

module.exports = { mdToHtml }
