// utils/fileParser.js - 端上解析常用办公文档，把内容转成纯文本给 AI 读
// 支持：docx / xlsx / pptx / pdf / txt(md、csv、json 等纯文本)
// 说明：Office 文档本质是 zip 压缩包，这里内置了极简 DEFLATE 解压实现，不依赖任何第三方库

const MAX_BYTES = 20 * 1024 * 1024   // 允许上传的最大文件体积
const MAX_CHARS = 12000             // 交给 AI 的最大字符数
const MAX_INFLATE = 8 * 1024 * 1024 // 单个压缩块解压上限，防止异常文件撑爆内存

const TEXT_EXT = ['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'log', 'xml', 'html', 'htm', 'yaml', 'yml', 'ini']
const DOC_EXT = ['docx']
const SHEET_EXT = ['xlsx', 'xlsm']
const SLIDE_EXT = ['pptx']
const PDF_EXT = ['pdf']
const SUPPORTED_EXT = DOC_EXT.concat(SHEET_EXT, SLIDE_EXT, PDF_EXT, TEXT_EXT)

const extOf = (name) => {
  const s = String(name || '')
  const i = s.lastIndexOf('.')
  return i >= 0 ? s.slice(i + 1).toLowerCase() : ''
}

const isSupported = (name) => SUPPORTED_EXT.indexOf(extOf(name)) >= 0

const unsupportedMessage = (name) => {
  const ext = extOf(name)
  const label = ext ? '.' + ext + ' 格式' : '这种格式'
  return '这个文件（' + label + '）我暂时解析不了。目前支持 Word(.docx)、Excel(.xlsx)、PPT(.pptx)、PDF 和 txt/文本类文件。可以把内容截图发给我，我用图片识别来看。'
}

const failMessage = (name, reason) => {
  const ext = extOf(name)
  const label = ext ? '.' + ext : '这个文件'
  return '这个 ' + label + ' 文件我没能读出内容（' + reason + '）。可以换个文件，或者把内容截图发给我，我用图片识别来看。'
}

/* ==================== 文本工具 ==================== */

// utf-8 字节转字符串（小程序部分基础库没有 TextDecoder，这里自己解）
const utf8Decode = (u8) => {
  let out = ''
  let i = 0
  while (i < u8.length) {
    const b = u8[i++]
    if (b < 0x80) {
      out += String.fromCharCode(b)
    } else if (b >= 0xc0 && b < 0xe0) {
      out += String.fromCharCode(((b & 0x1f) << 6) | (u8[i++] & 0x3f))
    } else if (b >= 0xe0 && b < 0xf0) {
      out += String.fromCharCode(((b & 0x0f) << 12) | ((u8[i++] & 0x3f) << 6) | (u8[i++] & 0x3f))
    } else if (b >= 0xf0) {
      const cp = ((b & 0x07) << 18) | ((u8[i++] & 0x3f) << 12) | ((u8[i++] & 0x3f) << 6) | (u8[i++] & 0x3f)
      const c = cp - 0x10000
      out += String.fromCharCode(0xd800 + (c >> 10), 0xdc00 + (c & 0x3ff))
    } else {
      out += '\ufffd'
    }
  }
  return out
}

// 字节按单字节编码转字符串（pdf 结构用）
const latin1Decode = (u8) => {
  let out = ''
  for (let i = 0; i < u8.length; i++) out += String.fromCharCode(u8[i])
  return out
}

const decodeXml = (s) => String(s)
  .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(parseInt(d, 10)))
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'")
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')

// 解析标签属性：<sheet name="x" r:id="rId1"/>
const attrOf = (tag, name) => {
  const re = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*=\\s*"([^"]*)"')
  const m = re.exec(tag)
  return m ? decodeXml(m[1]) : ''
}

// 判断文本是否“像正常文字”，用于过滤乱码（大量控制字符）
const readableRatio = (s) => {
  if (!s) return 0
  let good = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c === 9 || c === 10 || c === 13) good++
    else if (c >= 32 && c < 127) good++
    else if (c >= 0x4e00 && c <= 0x9fff) good++
    else if (c >= 0x3000 && c <= 0x303f) good++
    else if (c >= 0xff00 && c <= 0xffef) good++
  }
  return good / s.length
}

const normalize = (text) => {
  const t = String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (t.length <= MAX_CHARS) return { text: t, chars: t.length, truncated: false }
  return {
    text: t.slice(0, MAX_CHARS) + '\n……（文件较长，以上只截取了前 ' + MAX_CHARS + ' 字）',
    chars: t.length,
    truncated: true
  }
}

/* ==================== DEFLATE 解压（zip 条目 / pdf 流） ==================== */

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]
const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]

const readBits = (st, n) => {
  while (st.bitcnt < n) {
    if (st.pos >= st.data.length) throw new Error('压缩数据不完整')
    st.bitbuf |= st.data[st.pos++] << st.bitcnt
    st.bitcnt += 8
  }
  const v = st.bitbuf & ((1 << n) - 1)
  st.bitbuf >>>= n
  st.bitcnt -= n
  return v
}

// 规范哈夫曼表（counts 每种码长的数量，symbols 按码长排序的符号）
const buildHuffman = (lengths) => {
  const counts = new Uint16Array(16)
  for (let i = 0; i < lengths.length; i++) counts[lengths[i]]++
  counts[0] = 0
  const offs = new Uint16Array(16)
  for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + counts[i - 1]
  const symbols = new Uint16Array(lengths.length)
  for (let i = 0; i < lengths.length; i++) {
    const l = lengths[i]
    if (l) symbols[offs[l]++] = i
  }
  return { counts, symbols }
}

const decodeSymbol = (st, huff) => {
  let code = 0
  let first = 0
  let index = 0
  for (let len = 1; len <= 15; len++) {
    code |= readBits(st, 1)
    const count = huff.counts[len]
    if (code - first < count) return huff.symbols[index + (code - first)]
    index += count
    first = (first + count) << 1
    code <<= 1
  }
  throw new Error('压缩数据损坏')
}

let FIXED_LIT = null
let FIXED_DIST = null
const fixedTables = () => {
  if (!FIXED_LIT) {
    const lit = new Uint8Array(288)
    for (let i = 0; i < 144; i++) lit[i] = 8
    for (let i = 144; i < 256; i++) lit[i] = 9
    for (let i = 256; i < 280; i++) lit[i] = 7
    for (let i = 280; i < 288; i++) lit[i] = 8
    const dist = new Uint8Array(30)
    for (let i = 0; i < 30; i++) dist[i] = 5
    FIXED_LIT = buildHuffman(lit)
    FIXED_DIST = buildHuffman(dist)
  }
  return { lit: FIXED_LIT, dist: FIXED_DIST }
}

const ensureOut = (st, need) => {
  if (st.len + need <= st.out.length) return
  if (st.len + need > st.maxOut) throw new Error('文件内容过大')
  let size = st.out.length * 2
  while (size < st.len + need) size *= 2
  const next = new Uint8Array(size)
  next.set(st.out.subarray(0, st.len))
  st.out = next
}

const inflateBlock = (st, lit, dist) => {
  for (;;) {
    const sym = decodeSymbol(st, lit)
    if (sym < 256) {
      ensureOut(st, 1)
      st.out[st.len++] = sym
      continue
    }
    if (sym === 256) return
    const li = sym - 257
    if (li >= 29) throw new Error('压缩数据损坏')
    const length = LEN_BASE[li] + readBits(st, LEN_EXTRA[li])
    const ds = decodeSymbol(st, dist)
    if (ds >= 30) throw new Error('压缩数据损坏')
    const distance = DIST_BASE[ds] + readBits(st, DIST_EXTRA[ds])
    if (distance > st.len) throw new Error('压缩数据损坏')
    ensureOut(st, length)
    for (let k = 0; k < length; k++) {
      st.out[st.len] = st.out[st.len - distance]
      st.len++
    }
  }
}

// raw deflate 解压；zlib 包装（pdf 的 FlateDecode）自动跳过 2 字节头
const inflate = (input, maxOut = MAX_INFLATE) => {
  let data = input
  if (data.length > 2 && (data[0] & 0x0f) === 8 && (((data[0] << 8) | data[1]) % 31) === 0) {
    data = data.subarray(2)
  }
  const st = {
    data,
    pos: 0,
    bitbuf: 0,
    bitcnt: 0,
    out: new Uint8Array(Math.min(maxOut, Math.max(1024, data.length * 4))),
    len: 0,
    maxOut
  }
  let final = 0
  while (!final) {
    final = readBits(st, 1)
    const type = readBits(st, 2)
    if (type === 0) {
      // 不压缩块：先对齐到字节
      st.bitbuf = 0
      st.bitcnt = 0
      if (st.pos + 4 > data.length) throw new Error('压缩数据不完整')
      const blockLen = data[st.pos] | (data[st.pos + 1] << 8)
      st.pos += 4
      if (st.pos + blockLen > data.length) throw new Error('压缩数据不完整')
      ensureOut(st, blockLen)
      st.out.set(data.subarray(st.pos, st.pos + blockLen), st.len)
      st.len += blockLen
      st.pos += blockLen
    } else if (type === 1) {
      const t = fixedTables()
      inflateBlock(st, t.lit, t.dist)
    } else if (type === 2) {
      const hlit = readBits(st, 5) + 257
      const hdist = readBits(st, 5) + 1
      const hclen = readBits(st, 4) + 4
      const clens = new Uint8Array(19)
      for (let i = 0; i < hclen; i++) clens[CLEN_ORDER[i]] = readBits(st, 3)
      const clHuff = buildHuffman(clens)
      const total = hlit + hdist
      const lengths = new Uint8Array(total)
      let i = 0
      while (i < total) {
        const sym = decodeSymbol(st, clHuff)
        if (sym < 16) {
          lengths[i++] = sym
        } else if (sym === 16) {
          if (!i) throw new Error('压缩数据损坏')
          const prev = lengths[i - 1]
          let repeat = 3 + readBits(st, 2)
          while (repeat-- > 0 && i < total) lengths[i++] = prev
        } else if (sym === 17) {
          let repeat = 3 + readBits(st, 3)
          while (repeat-- > 0 && i < total) lengths[i++] = 0
        } else {
          let repeat = 11 + readBits(st, 7)
          while (repeat-- > 0 && i < total) lengths[i++] = 0
        }
      }
      inflateBlock(st, buildHuffman(lengths.subarray(0, hlit)), buildHuffman(lengths.subarray(hlit)))
    } else {
      throw new Error('压缩数据损坏')
    }
  }
  return st.out.subarray(0, st.len)
}

/* ==================== ZIP 读取 ==================== */

// 读出 zip 里的目录表，按需解压单个条目（office 文档都是这种结构）
const openZip = (buffer) => {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
  let eocd = -1
  const minPos = Math.max(0, u8.length - 22 - 65535)
  for (let i = u8.length - 22; i >= minPos; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('文件打不开，可能被加密或不是这种格式')

  const count = dv.getUint16(eocd + 10, true)
  let p = dv.getUint32(eocd + 16, true)
  const entries = {}
  for (let i = 0; i < count; i++) {
    if (p + 46 > u8.length || dv.getUint32(p, true) !== 0x02014b50) break
    const method = dv.getUint16(p + 10, true)
    const csize = dv.getUint32(p + 20, true)
    const usize = dv.getUint32(p + 24, true)
    const nameLen = dv.getUint16(p + 28, true)
    const extraLen = dv.getUint16(p + 30, true)
    const commentLen = dv.getUint16(p + 32, true)
    const localOff = dv.getUint32(p + 42, true)
    const name = utf8Decode(u8.subarray(p + 46, p + 46 + nameLen))
    if (localOff + 30 <= u8.length) {
      const lNameLen = dv.getUint16(localOff + 26, true)
      const lExtraLen = dv.getUint16(localOff + 28, true)
      entries[name] = { method, start: localOff + 30 + lNameLen + lExtraLen, csize, usize }
    }
    p += 46 + nameLen + extraLen + commentLen
  }

  const names = Object.keys(entries)
  const read = (name) => {
    const e = entries[name]
    if (!e) return null
    let raw = u8.subarray(e.start, Math.min(u8.length, e.start + e.csize))
    if (e.method === 0) return raw
    if (e.method === 8) return inflate(raw)
    throw new Error('不支持的压缩方式')
  }

  return {
    names,
    has: (name) => !!entries[name],
    read,
    text: (name) => {
      const bytes = read(name)
      return bytes ? utf8Decode(bytes) : ''
    }
  }
}

/* ==================== Office 文档 ==================== */

// 按顺序拼接某个标签内的全部文本（表格/幻灯片里的富文本跑多次）
const pickText = (xml, tag) => {
  const re = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + tag + '>', 'g')
  let out = ''
  let m
  while ((m = re.exec(xml))) out += decodeXml(m[1])
  return out
}

const readDocx = (zip) => {
  const xml = zip.text('word/document.xml')
  if (!xml) throw new Error('文档内容为空')
  // 正文文本、段落换行、制表符、手动换行
  let out = ''
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:(tab|br|cr)\b[^>]*\/>|<\/w:p>/g
  let m
  while ((m = re.exec(xml))) {
    if (m[1] !== undefined) out += decodeXml(m[1])
    else if (m[2] === 'tab') out += '\t'
    else out += '\n'
  }
  return out
}

const columnIndex = (ref) => {
  const m = /^([A-Za-z]+)/.exec(String(ref || ''))
  if (!m) return -1
  const letters = m[1].toUpperCase()
  let n = 0
  for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64)
  return n - 1
}

const readXlsx = (zip) => {
  // 共享字符串表
  const shared = []
  const ssXml = zip.text('xl/sharedStrings.xml')
  if (ssXml) {
    const re = /<si\b[^>]*>([\s\S]*?)<\/si>/g
    let m
    while ((m = re.exec(ssXml))) shared.push(pickText(m[1], 't'))
  }

  // workbook 里工作表的名字 + r:id
  const sheets = []
  const wbXml = zip.text('xl/workbook.xml')
  if (wbXml) {
    const re = /<sheet\b[^>]*\/?>/g
    let m
    while ((m = re.exec(wbXml))) {
      const tag = m[0]
      sheets.push({ name: attrOf(tag, 'name'), rid: attrOf(tag, 'r:id') || attrOf(tag, 'id') })
    }
  }

  // r:id -> 工作表文件
  const rels = {}
  const relXml = zip.text('xl/_rels/workbook.xml.rels')
  if (relXml) {
    const re = /<Relationship\b[^>]*\/?>/g
    let m
    while ((m = re.exec(relXml))) {
      const tag = m[0]
      const target = attrOf(tag, 'Target')
      if (target) rels[attrOf(tag, 'Id')] = target.replace(/^\/?(xl\/)?/, 'xl/')
    }
  }

  let files = zip.names.filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
  files.sort((a, b) => parseInt(a.replace(/\D/g, ''), 10) - parseInt(b.replace(/\D/g, ''), 10))

  const plan = []
  sheets.forEach((s, i) => {
    let f = rels[s.rid]
    if (!f || !zip.has(f)) f = files[i]
    if (f && zip.has(f)) plan.push({ name: s.name || ('Sheet' + (i + 1)), file: f })
  })
  if (!plan.length) files.forEach((f, i) => plan.push({ name: 'Sheet' + (i + 1), file: f }))
  if (!plan.length) throw new Error('表格内容为空')

  const parts = []
  plan.forEach(sheet => {
    const xml = zip.text(sheet.file)
    if (!xml) return
    const lines = []
    const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g
    let rm
    while ((rm = rowRe.exec(xml))) {
      const cells = []
      const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g
      let cm
      while ((cm = cellRe.exec(rm[1]))) {
        const tag = '<c' + cm[1] + '>'
        const body = cm[2] || ''
        const type = attrOf(tag, 't')
        let value = ''
        if (type === 's') {
          const v = /<v>([\s\S]*?)<\/v>/.exec(body)
          if (v) value = shared[parseInt(v[1], 10)] || ''
        } else if (type === 'inlineStr') {
          value = pickText(body, 't')
        } else {
          const v = /<v>([\s\S]*?)<\/v>/.exec(body)
          if (v) value = decodeXml(v[1])
        }
        const idx = columnIndex(attrOf(tag, 'r'))
        const pos = idx >= 0 && idx < 60 ? idx : cells.length
        cells[pos] = value
      }
      const line = cells.map(c => (c === undefined || c === null ? '' : String(c).replace(/\s+/g, ' ').trim())).join('\t').replace(/\t+$/, '')
      if (line.trim()) lines.push(line)
      if (lines.length > 400) break
    }
    if (lines.length) parts.push('【工作表 ' + sheet.name + '】\n' + lines.join('\n'))
  })

  if (!parts.length) throw new Error('表格里没有文字内容')
  return parts.join('\n\n')
}

const readPptx = (zip) => {
  const files = zip.names
    .filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => parseInt(a.replace(/\D/g, ''), 10) - parseInt(b.replace(/\D/g, ''), 10))
  if (!files.length) throw new Error('幻灯片内容为空')
  const parts = []
  files.forEach((f, i) => {
    const xml = zip.text(f)
    if (!xml) return
    // 段落结束当作换行，其余取 a:t 文本
    const marked = xml.replace(/<\/a:p>/g, '\u0000')
    let text = ''
    const re = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>|\u0000/g
    let m
    while ((m = re.exec(marked))) {
      text += m[1] !== undefined ? decodeXml(m[1]) : '\n'
    }
    const t = text.trim()
    if (t) parts.push('【第 ' + (i + 1) + ' 页】\n' + t)
  })
  if (!parts.length) throw new Error('幻灯片里没有文字内容')
  return parts.join('\n\n')
}

/* ==================== PDF ==================== */

const indexOfBytes = (u8, str, from) => {
  const need = str.length
  const first = str.charCodeAt(0)
  for (let i = Math.max(0, from); i <= u8.length - need; i++) {
    if (u8[i] !== first) continue
    let ok = true
    for (let k = 1; k < need; k++) {
      if (u8[i + k] !== str.charCodeAt(k)) { ok = false; break }
    }
    if (ok) return i
  }
  return -1
}

// pdf 字符串转义：\n \r \t \( \) \\ \ddd
const decodePdfString = (raw) => {
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    if (c !== '\\') { out += c; continue }
    const n = raw[++i]
    if (n === undefined) break
    if (n === 'n') out += '\n'
    else if (n === 'r') out += '\r'
    else if (n === 't') out += '\t'
    else if (n === 'b') out += '\b'
    else if (n === 'f') out += '\f'
    else if (n === '(' || n === ')' || n === '\\') out += n
    else if (n >= '0' && n <= '7') {
      let oct = n
      while (oct.length < 3 && raw[i + 1] >= '0' && raw[i + 1] <= '7') oct += raw[++i]
      out += String.fromCharCode(parseInt(oct, 8))
    } else if (n === '\n') { /* 续行 */ }
    else out += n
  }
  return out
}

// pdf 十六进制字符串：可能是单字节（ASCII），也可能是 UTF-16BE（中文常见），取可读性更好的一种
const decodePdfHex = (hex) => {
  const h = hex.replace(/[^0-9a-fA-F]/g, '')
  if (!h) return ''
  let single = ''
  for (let i = 0; i + 1 < h.length; i += 2) {
    single += String.fromCharCode(parseInt(h.substr(i, 2), 16))
  }
  let wide = ''
  for (let i = 0; i + 3 < h.length; i += 4) {
    wide += String.fromCharCode(parseInt(h.substr(i, 4), 16))
  }
  return readableRatio(wide) > readableRatio(single) ? wide : single
}

/* ---------- 字体 ToUnicode：中文 PDF 必须靠它才能还原文字 ---------- */

const isWsByte = (b) => b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09 || b === 0x00

const skipWs = (u8, i) => {
  while (i < u8.length && isWsByte(u8[i])) i++
  return i
}

// 十六进制按 UTF-16BE 还原成文字（ToUnicode 的映射目标）
const hexToUnicode = (hex) => {
  const h = String(hex || '').replace(/[^0-9a-fA-F]/g, '')
  let out = ''
  for (let i = 0; i + 3 < h.length; i += 4) out += String.fromCharCode(parseInt(h.substr(i, 4), 16))
  if (h.length % 4 === 2) out += String.fromCharCode(parseInt(h.substr(h.length - 2, 2), 16))
  return out
}

const padHex = (n, w) => {
  let s = n.toString(16).toUpperCase()
  while (s.length < w) s = '0' + s
  return s
}

// 解析一份 ToUnicode CMap，得到「字形编号 → 文字」对照表
const parseCMap = (text) => {
  const map = {}
  let codeLen = 0
  let size = 0
  const cs = /begincodespacerange([\s\S]{0,2000}?)endcodespacerange/.exec(text)
  if (cs) {
    const m = /<([0-9A-Fa-f]+)>/.exec(cs[1])
    if (m) codeLen = m[1].length >> 1
  }
  const put = (code, dst, len) => {
    map[code] = dst
    size++
    if (!codeLen && len) codeLen = len
  }

  let m
  const charRe = /beginbfchar([\s\S]*?)endbfchar/g
  while ((m = charRe.exec(text))) {
    const pairRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g
    let p
    while ((p = pairRe.exec(m[1]))) {
      const len = p[1].length >> 1
      if (!len) continue
      put(parseInt(p[1], 16), hexToUnicode(p[2]), len)
    }
  }

  const rangeRe = /beginbfrange([\s\S]*?)endbfrange/g
  while ((m = rangeRe.exec(text))) {
    const itemRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]+)>|\[([\s\S]*?)\])/g
    let p
    while ((p = itemRe.exec(m[1]))) {
      const lo = parseInt(p[1], 16)
      const hi = parseInt(p[2], 16)
      const len = p[1].length >> 1
      if (!len || !(hi >= lo) || hi - lo > 65535) continue
      if (p[3]) {
        const width = Math.max(4, p[3].length)
        const base = parseInt(p[3], 16)
        for (let i = 0; i <= hi - lo; i++) {
          put(lo + i, hexToUnicode(padHex(base + i, width)), len)
        }
      } else if (p[4]) {
        const arrRe = /<([0-9A-Fa-f]*)>/g
        let a
        let i = 0
        while ((a = arrRe.exec(p[4])) && lo + i <= hi) {
          put(lo + i, hexToUnicode(a[1]), len)
          i++
        }
      }
    }
  }

  return size ? { map, size, codeLen: codeLen || 1 } : null
}

// 取对象流字节（FlateDecode 就解压），返回 latin1 文本
const streamText = (u8, obj) => {
  if (!obj || obj.start < 0 || obj.end < 0) return ''
  let bytes = u8.subarray(obj.start, obj.end)
  if (/\/FlateDecode/i.test(obj.dict)) {
    try {
      bytes = inflate(bytes)
    } catch (err) {
      return ''
    }
  }
  return latin1Decode(bytes)
}

// 扫描 PDF 里的对象字典，并把对象流（/ObjStm）里压缩的字典一并解出来
const pdfObjects = (u8) => {
  const objs = {}
  let p = 0
  let guard = 0
  let total = 0
  while (guard++ < 20000 && total < 3 * 1024 * 1024) {
    const i = indexOfBytes(u8, 'obj', p)
    if (i < 0) break
    p = i + 3
    // 往前核对 "<数字> 0 obj"
    let l = i - 1
    while (l >= 0 && isWsByte(u8[l])) l--
    if (u8[l] !== 0x30) continue
    l--
    while (l >= 0 && isWsByte(u8[l])) l--
    const numEnd = l
    while (l >= 0 && u8[l] >= 0x30 && u8[l] <= 0x39) l--
    if (numEnd <= l) continue
    const num = parseInt(latin1Decode(u8.subarray(l + 1, numEnd + 1)), 10)
    if (!isFinite(num) || objs[num]) continue
    const d = skipWs(u8, i + 3)
    if (u8[d] !== 0x3c || u8[d + 1] !== 0x3c) continue
    const endobj = indexOfBytes(u8, 'endobj', d)
    const stream = indexOfBytes(u8, 'stream', d)
    const hasStream = stream >= 0 && (endobj < 0 || stream < endobj)
    const dictEnd = hasStream ? stream : endobj
    if (dictEnd < 0 || dictEnd - d > 300000) continue
    const start = hasStream ? skipWs(u8, stream + 6) : -1
    const end = hasStream ? indexOfBytes(u8, 'endstream', start) : -1
    if (hasStream && end < 0) continue
    const dict = latin1Decode(u8.subarray(d, dictEnd))
    total += dict.length
    objs[num] = { dict, start, end }
  }

  // 对象流里存着一批普通对象字典（字体、页面资源常被压在这里）
  Object.keys(objs).forEach(k => {
    const o = objs[k]
    if (!/\/Type\s*\/ObjStm/.test(o.dict)) return
    const text = streamText(u8, o)
    if (!text) return
    const first = parseInt((/\/First\s+(\d+)/.exec(o.dict) || [])[1], 10)
    const count = parseInt((/\/N\s+(\d+)/.exec(o.dict) || [])[1], 10)
    if (!(first > 0) || !(count > 0) || count > 5000) return
    const nums = text.slice(0, first).trim().split(/\s+/)
    for (let i = 0; i + 1 < nums.length && i / 2 < count; i += 2) {
      const n = parseInt(nums[i], 10)
      const off = parseInt(nums[i + 1], 10)
      const next = parseInt(nums[i + 3], 10)
      if (!isFinite(n) || !isFinite(off) || objs[n]) continue
      const startPos = first + off
      const endPos = isFinite(next) ? first + next : text.length
      if (startPos >= text.length) continue
      objs[n] = { dict: text.slice(startPos, endPos), start: -1, end: -1 }
    }
  })

  return objs
}

// 资源名（/FT8）→ ToUnicode 表；内容流里靠 "/FT8 Tf" 切换字体
const pdfFontMaps = (u8) => {
  const objs = pdfObjects(u8)
  const cmaps = {}
  const fontCMap = {}
  Object.keys(objs).forEach(k => {
    const ref = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(objs[k].dict)
    if (!ref) return
    const target = ref[1]
    if (cmaps[target] === undefined) {
      const t = objs[target]
      cmaps[target] = t ? parseCMap(streamText(u8, t)) : null
    }
    if (cmaps[target]) fontCMap[k] = cmaps[target]
  })

  const byName = {}
  Object.keys(objs).forEach(k => {
    const dict = objs[k].dict
    // /Font 既可能直接写字典，也可能是指向另一个对象的引用
    let seg = ''
    const inline = dict.search(/\/Font\s*<</)
    if (inline >= 0) {
      const close = dict.indexOf('>>', inline + 8)
      seg = close > 0 ? dict.slice(inline, close) : dict.slice(inline, inline + 4000)
    } else {
      const ref = /\/Font\s+(\d+)\s+\d+\s+R/.exec(dict)
      if (ref && objs[ref[1]]) seg = objs[ref[1]].dict
    }
    if (!seg) return
    const re = /\/([^\s/<>{}\[\]()%]+)\s+(\d+)\s+\d+\s+R/g
    let m
    while ((m = re.exec(seg))) {
      const cm = fontCMap[m[2]]
      if (cm && !byName[m[1]]) byName[m[1]] = cm
    }
  })
  return byName
}

const cmapHexText = (cmap, hex) => {
  const h = hex.replace(/[^0-9a-fA-F]/g, '')
  const len = (cmap.codeLen || 2) * 2
  let out = ''
  for (let i = 0; i + len <= h.length; i += len) {
    const v = cmap.map[parseInt(h.substr(i, len), 16)]
    if (v !== undefined) out += v
  }
  return out
}

const cmapByteText = (cmap, str) => {
  const len = cmap.codeLen || 2
  let out = ''
  for (let i = 0; i + len <= str.length; i += len) {
    let code = 0
    for (let k = 0; k < len; k++) code = (code << 8) | (str.charCodeAt(i + k) & 0xff)
    const v = cmap.map[code]
    if (v !== undefined) out += v
  }
  return out
}

// 从内容流里抽文本：靠 Tj/TJ 判定文本，靠 Tm/Td 的纵向位移判定换行
// （很多 PDF 每个字都单独定位，不看坐标就会一字一行）
const pdfContentText = (content, fonts) => {
  const re = /\/([^\s/<>{}\[\]()%]+)\s+([-\d.]+)\s+Tf|([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+Tm|([-\d.]+)\s+([-\d.]+)\s+T[dD]|\bT\*|\((?:\\.|[^\\()])*\)|<(?!<)[0-9A-Fa-f\s]*>|\bT[Jj]|\bET\b/g
  let out = ''
  let buf = ''
  let cmap = null
  let fs = 12
  let scale = 1
  let curX = null
  let curY = null
  let lineY = null
  let m
  const flush = () => {
    if (buf) {
      out += buf
      buf = ''
    }
  }
  const newline = () => {
    flush()
    if (out && out.charAt(out.length - 1) !== '\n') out += '\n'
  }
  // 到达新的一行才换行；同一行里的横向微调保持连写
  const ensureLine = () => {
    if (curY === null) return
    if (lineY === null) {
      lineY = curY
      return
    }
    const tol = Math.max(0.5, Math.abs(fs * scale) * 0.35)
    if (Math.abs(curY - lineY) > tol) {
      newline()
      lineY = curY
    }
  }
  while ((m = re.exec(content))) {
    const t = m[0]
    if (m[1] !== undefined) {
      cmap = (fonts && fonts[m[1]]) || null
      const n = parseFloat(m[2])
      if (n) fs = n
    } else if (m[3] !== undefined) {
      const a = parseFloat(m[3])
      const b = parseFloat(m[4])
      scale = Math.sqrt(a * a + b * b) || 1
      curX = parseFloat(m[7])
      curY = parseFloat(m[8])
      flush()
    } else if (m[9] !== undefined) {
      curX = (curX || 0) + parseFloat(m[9]) * scale
      curY = (curY || 0) + parseFloat(m[10]) * scale
    } else if (t === 'T*') {
      newline()
      lineY = null
    } else if (t.charCodeAt(0) === 40) {
      ensureLine()
      const raw = t.slice(1, -1)
      buf += cmap ? cmapByteText(cmap, raw) : decodePdfString(raw)
    } else if (t.charCodeAt(0) === 60) {
      ensureLine()
      const hex = t.slice(1, -1)
      buf += cmap ? cmapHexText(cmap, hex) : decodePdfHex(hex)
    } else if (t === 'Tj' || t === 'TJ') {
      flush()
    }
    // ET 可能只是分段，接着还会在同一行继续写，所以不换行
  }
  return out + buf
}

const readPdf = (u8) => {
  // 先建字体对照表（没有它，中文 PDF 抽出来全是乱码）
  let fonts = null
  try {
    fonts = pdfFontMaps(u8)
  } catch (err) {
    fonts = null
  }

  let pos = 0
  const parts = []
  let sawText = false
  let guard = 0
  while (guard++ < 400) {
    const s = indexOfBytes(u8, 'stream', pos)
    if (s < 0) break
    const dictStart = Math.max(0, s - 400)
    const dict = latin1Decode(u8.subarray(dictStart, s))
    let dataStart = s + 6
    if (u8[dataStart] === 0x0d) dataStart++
    if (u8[dataStart] === 0x0a) dataStart++
    const e = indexOfBytes(u8, 'endstream', dataStart)
    if (e < 0) break
    pos = e + 9

    // 图片、字体程序、对象流一律跳过，避免白解压几 MB 数据
    if (/\/Image|\/DCTDecode|\/JPXDecode|\/CCITTFaxDecode|\/FontFile|\/Length1|\/Type\s*\/ObjStm/i.test(dict)) continue
    let bytes = u8.subarray(dataStart, e)
    if (/\/FlateDecode/i.test(dict)) {
      try {
        bytes = inflate(bytes)
      } catch (err) {
        continue
      }
    }
    if (bytes.length < 8) continue
    // 只处理内容流：解压后应是可读的文本绘图指令（有的图稿前面垫了几千字节图形指令）
    const head = latin1Decode(bytes.subarray(0, Math.min(bytes.length, 4000)))
    if (!/(^|[\s>])BT[\s<]|T[Jj]\b|T[fdsm]\b/.test(head)) continue
    sawText = true
    const text = pdfContentText(latin1Decode(bytes), fonts)
    if (text && readableRatio(text) >= 0.7) parts.push(text)
  }

  const merged = parts.join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  if (merged.replace(/\s/g, '').length < 10) {
    throw new Error(sawText ? '文字用了特殊字体编码' : '里面没有文字，可能是扫描件')
  }
  return merged
}

/* ==================== 纯文本 ==================== */

const readPlainText = (u8) => {
  if (u8.length >= 3 && u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) {
    return utf8Decode(u8.subarray(3))
  }
  const text = utf8Decode(u8)
  const bad = (text.match(/\ufffd/g) || []).length
  if (text.length && bad / text.length > 0.05) {
    throw new Error('文件不是 UTF-8 编码，请另存为 UTF-8 后再发')
  }
  return text
}

/* ==================== 对外接口 ==================== */

// 直接解析 ArrayBuffer（node 下也能用来测试）
const parseBuffer = (buffer, ext, fileName) => {
  const e = String(ext || extOf(fileName)).toLowerCase()
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  let text = ''

  if (DOC_EXT.indexOf(e) >= 0) {
    text = readDocx(openZip(u8))
  } else if (SHEET_EXT.indexOf(e) >= 0) {
    text = readXlsx(openZip(u8))
  } else if (SLIDE_EXT.indexOf(e) >= 0) {
    text = readPptx(openZip(u8))
  } else if (PDF_EXT.indexOf(e) >= 0) {
    text = readPdf(u8)
  } else if (TEXT_EXT.indexOf(e) >= 0) {
    text = readPlainText(u8)
  } else {
    throw new Error('unsupported')
  }

  const r = normalize(text)
  if (!r.text || r.text.replace(/\s/g, '').length < 2) throw new Error('文件里没有可读的文字')
  return { text: r.text, chars: r.chars, truncated: r.truncated, kind: e }
}

// 读取并解析小程序临时文件
const parseFile = (filePath, fileName, size) => new Promise((resolve, reject) => {
  const ext = extOf(fileName)
  if (SUPPORTED_EXT.indexOf(ext) < 0) {
    reject(new Error(unsupportedMessage(fileName)))
    return
  }
  if (size && size > MAX_BYTES) {
    reject(new Error('文件有点大（' + (size / 1024 / 1024).toFixed(1) + 'MB），请发送 ' + (MAX_BYTES / 1024 / 1024) + 'MB 以内的文件。'))
    return
  }
  wx.getFileSystemManager().readFile({
    filePath,
    success: (res) => {
      let r
      try {
        r = parseBuffer(res.data, ext, fileName)
      } catch (err) {
        const msg = (err && err.message) || ''
        reject(new Error(msg && msg !== 'unsupported' ? failMessage(fileName, msg) : unsupportedMessage(fileName)))
        return
      }
      resolve(r)
    },
    fail: (err) => {
      reject(new Error('读取文件失败：' + ((err && err.errMsg) || '未知错误')))
    }
  })
})

module.exports = {
  MAX_BYTES,
  MAX_CHARS,
  SUPPORTED_EXT,
  extOf,
  isSupported,
  unsupportedMessage,
  parseBuffer,
  parseFile
}
