// services/llm.js - LLM 大模型服务
// 支持多连接切换，当前若无可用连接则降级 mock

const storage = require('./storage.js')
const mock = require('./mock.js')
const lexiang = require('./lexiang.js')
const fade = require('./fade.js')
const config = require('../utils/config.js')

// 版本标记：真机日志出现这一行，才说明手机上跑的是最新代码
console.log('[llm] 版本 v9 手写判题：坏 JSON 按字段宽松捞回（半角引号 / 截断）')

// 获取当前激活的模型连接
const getActiveConnection = () => storage.getActiveConnection()

// 图片识别连接：设置里选中的 image 类型优先，其次按模型特征自动挑选，最后退回文本模型
const VISION_HINT = /vl|vision|gpt-4o|4v|gemini|claude|deepseek-flash|step-1v|mimo-vl|internvl|llava|sensenova/i
const getVisionConnection = () => {
  const explicit = storage.findConnectionById(storage.getVisionModelId())
  if (explicit && explicit.key && explicit.type === 'image') return explicit
  const typed = storage.getRoleConnection('image')
  if (typed && typed.key) return typed
  const list = storage.getModelConnections().filter(c => c && c.key)
  const auto = list.find(c => VISION_HINT.test((c.model || '') + ' ' + (c.name || '')))
  return auto || getActiveConnection()
}

// 备用图片连接：当前图片模型不支持时，挑另一个有 Key 的连接（DeepSeek 等切换场景）
const getFallbackVisionConnection = (excludeId) => {
  const list = storage.getModelConnections().filter(c => c && c.key && c.id !== excludeId)
  const typed = list.filter(c => c.type === 'image')
  return typed[0] || list.find(c => VISION_HINT.test((c.model || '') + ' ' + (c.name || ''))) || list[0] || null
}

// 获取供应商默认模型列表（兜底用）
const getDefaultModels = (provider) => {
  const p = config.LLM_PROVIDERS.find(x => x.key === provider)
  return p ? p.models : []
}

// 讲解类回复的排版规范（只在聊天场景加，避免干扰需要返回 JSON 的结构化请求）
const DOC_FORMAT_PROMPT = [
  '【回复格式要求】',
  '1. 第一行先用一句话给出结论或答案，让人一眼看到结果。',
  '2. 需要展开时用小标题分段，格式为「## 标题」，例如：## 解题步骤 / ## 知识点 / ## 易错点。',
  '3. 每个步骤单独一行，用 1. 2. 3. 编号，按顺序写清楚每一步是怎么来的。',
  '4. 数学题要写出算式和中间结果，不要跳步。',
  '5. 句子尽量短，不要堆大段文字，也不要说客套话。'
].join('\n')

// 组装上下文（身份习惯 + 学科记忆）
// format='doc' 时追加讲解排版规范
const buildContext = (app, format) => {
  const identity = storage.getIdentity()
  const cfg = storage.getConfig() || {}
  const textbook = textbookRule()
  const grade = (app && app.globalData && app.globalData.currentGrade) || cfg.grade || '四年级'
  const context = []
  if (identity && identity.content) {
    context.push({ role: 'system', content: `【用户身份和习惯】\n${identity.content}` })
  } else {
    context.push({ role: 'system', content: '你是一个耐心的小学学习助手，用孩子能听懂的方式讲解题目。' })
  }
  // 教材版本和年级约束：默认按课内进度，但已存档的超纲错题/知识点必须保留
  context.push({
    role: 'system',
    content: `【学习信息】年级：${grade}；教材版本：${textbook}。出题、讲解、举例默认按${textbook}${grade}的课内进度，不要自行扩展到超纲内容；但学生已经存档的错题和知识点如果本身超纲，要照原样出题和讲解，不能跳过、删减或强行降成课内难度。`
  })
  // 语言约束：部分模型（思考型/多模态）会用英文作答，这里统一强制中文
  context.push({
    role: 'system',
    content: '【语言要求】所有输出必须是简体中文：讲解、步骤、点评、标题、总结都用中文书写，不要输出英文段落或英文解释，也不要中英对照；即使题目、图片、附件或思维链是英文的，最终回答也要翻成中文。数学符号、公式、必要的英文单词和专有名词可以保留原文。'
  })
  if (format === 'doc') {
    context.push({ role: 'system', content: DOC_FORMAT_PROMPT })
    // 保存能力：对话里不许说"无法保存"，三类内容各有落位
    context.push({
      role: 'system',
      content: [
        '【保存能力】学习内容可以长期保存到知识库，绝对不要回答"我无法永久保存"。落位规则：',
        '1. 学科知识点、知识清单（单词表、语法点、知识点汇总）→ 该学科的「学习记忆」（学习记忆就是知识点库）；',
        '2. 错题（题干 + 错答 + 正解 + 错因）→ 该学科的「错题」；',
        '3. 身份、习惯、爱好 → 「身份和习惯」。',
        '学生要求保存时，先用一句话说明会存到哪个学科的哪个位置，再由页面「归档」确认层完成写入；不要把保存说成做不到。'
      ].join('\n')
    })
  }
  return context
}

// 从模型回复中提取 JSON（兼容 ```json 包裹、前后有解释文字、被 max_tokens 截断、
// 字符串里带裸换行等情况）
// 最多检查的起点个数：条目很多时（错题/知识点各几十条）也要能找到最外层括号
const JSON_MAX_STARTS = 200

const tryParseJSON = (raw) => {
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? v : null
  } catch (e) {
    return null
  }
}

// 把字符串内部的裸换行/制表符转义掉（模型常把多行内容直接写进 JSON 字符串）
const escapeRawBreaks = (raw) => {
  let inStr = false
  let esc = false
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    if (inStr) {
      if (esc) {
        esc = false
        out += c
      } else if (c === '\\') {
        esc = true
        out += c
      } else if (c === '"') {
        inStr = false
        out += c
      } else if (c === '\n') {
        out += '\\n'
      } else if (c === '\r') {
        out += '\\r'
      } else if (c === '\t') {
        out += '\\t'
      } else {
        out += c
      }
      continue
    }
    if (c === '"') inStr = true
    out += c
  }
  return out
}

const parseJSONLoose = (raw) => tryParseJSON(raw) || tryParseJSON(escapeRawBreaks(raw))

// 从 start 处的开括号开始配平扫描（跳过字符串里的括号），返回配平的结束位置；配不上返回 -1
const matchBracket = (src, start) => {
  const stack = []
  let inStr = false
  let esc = false
  for (let i = start; i < src.length; i++) {
    const c = src[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') {
      inStr = true
    } else if (c === '{' || c === '[') {
      stack.push(c === '{' ? '}' : ']')
    } else if (c === '}' || c === ']') {
      if (stack[stack.length - 1] !== c) return -1
      stack.pop()
      if (!stack.length) return i
    }
  }
  return -1
}

// 补全被截断的 JSON：先闭合字符串，再补上缺失的右括号
const closeFragment = (raw) => {
  let inStr = false
  let esc = false
  const stack = []
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']')
    else if (c === '}' || c === ']') {
      if (stack[stack.length - 1] === c) stack.pop()
    }
  }
  let out = raw
  if (inStr) out += '"'
  out = out.replace(/[,:]\s*$/, '')
  return out + stack.reverse().join('')
}

// 尾部被截断时补全：从最后一个「完整值结尾」处回退（丢掉半截元素），再补引号和右括号
const repairJSON = (raw) => {
  const text = String(raw || '')
  const marks = [text.length]
  let inStr = false
  let esc = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '}' || c === ']') marks.push(i + 1)
  }
  const from = Math.max(0, marks.length - 80)
  for (let k = marks.length - 1; k >= from; k--) {
    const val = parseJSONLoose(closeFragment(text.slice(0, marks[k])))
    if (val) return val
  }
  return null
}

const extractJSON = (text, type = 'object') => {
  if (!text) return null
  const src = String(text).replace(/```json/gi, '').replace(/```/g, '')
  const open = type === 'array' ? '[' : '{'
  const starts = []
  for (let i = 0; i < src.length; i++) {
    if (src[i] === open) starts.push(i)
  }
  if (!starts.length) return null
  // 起点很多时只扫后 200 个，但最外层（第一个起点）永远要参与
  const from = Math.max(0, starts.length - JSON_MAX_STARTS)
  const order = []
  if (from > 0) order.push(0)
  for (let k = from; k < starts.length; k++) order.push(k)

  // 第一轮：完整配平的块。取「结束位置最靠后、起点最靠前」的那个，
  // 即最后一段 JSON 的最外层对象（思维链在前的、被嵌套的元素都不算）
  let best = null
  let firstUnbalanced = -1
  for (let i = 0; i < order.length; i++) {
    const s = starts[order[i]]
    const e = matchBracket(src, s)
    if (e <= s) {
      // 有起点配不平：输出可能被截断，记下最靠前的那个
      if (firstUnbalanced < 0 || s < firstUnbalanced) firstUnbalanced = s
      continue
    }
    const val = parseJSONLoose(src.slice(s, e + 1))
    if (!val) continue
    if (!best || e > best.end || (e === best.end && s < best.start)) {
      best = { start: s, end: e, val }
    }
  }
  // 最靠前的起点都没配平（外层被截断）时，best 只是某个内层元素，交给修复路径
  if (best && (firstUnbalanced < 0 || firstUnbalanced > best.start)) return best.val

  // 第二轮：多半是被 max_tokens 截断（括号没配平），从最外层起点开始回退补齐再试
  for (let i = 0; i < order.length; i++) {
    const val = repairJSON(src.slice(starts[order[i]]))
    if (val) return val
  }
  return null
}

// 从一个（可能坏掉的）JSON 片段里读字符串值：容忍字符串内部的半角引号、裸换行，
// 也容忍整体被截断（读到文本结尾就收下已看到的内容）
const readLooseString = (text, start) => {
  let out = ''
  let i = start + 1
  while (i < text.length) {
    const c = text[i]
    if (c === '\\') {
      const n = text[i + 1]
      if (n === 'n') out += '\n'
      else if (n === 't') out += '\t'
      else if (n === 'r') out += ''
      else if (n !== undefined) out += n
      i += 2
      continue
    }
    if (c === '"' || c === '”') {
      // 只有引号后面紧跟 , } ] 或已经是文本结尾，才算这个字段结束；
      // 否则认为是内容里混进来的半角引号，继续当作正文
      const after = text.slice(i + 1)
      if (/^\s*[,}\]]/.test(after) || !after.trim()) break
      out += c
      i++
      continue
    }
    out += c
    i++
  }
  return out.trim()
}

// 按字段名从坏 JSON 里捞一个值（字符串 / 布尔 / 数字 / 中文对错）
const looseField = (text, key) => {
  const patterns = [
    new RegExp('"' + key + '"\\s*[:：]\\s*'),
    new RegExp('(?:^|[\\s{,\\[])["“]?' + key + '["”]?\\s*[:：]\\s*')
  ]
  let m = null
  for (let k = 0; k < patterns.length && !m; k++) m = patterns[k].exec(text)
  if (!m) return undefined
  let i = m.index + m[0].length
  while (i < text.length && /\s/.test(text[i])) i++
  const c = text[i]
  if (c === undefined) return undefined
  if (c === '"' || c === '“') return readLooseString(text, i)
  const rest = text.slice(i)
  const bool = /^(true|false)/i.exec(rest)
  if (bool) return bool[1].toLowerCase() === 'true'
  const num = /^-?\d+(?:\.\d+)?/.exec(rest)
  if (num) return Number(num[0])
  const cn = /^(正确|错误|对|错|是|否)/.exec(rest)
  if (cn) return /^(正确|对|是)$/.test(cn[1] || cn[0])
  return undefined
}

// 手写判题的宽松解析：先按完整 JSON 取，取不到再逐字段捞。
// 视觉模型常把算式里的半角引号、多行内容直接写进字符串，整段 JSON 就不合法了，
// 但只要 recognized / isCorrect / correctAnswer 里有一个捞得到，就不该让孩子重写一遍。
const parseHandwritingResult = (text) => {
  const strict = extractJSON(text)
  const raw = String(text || '')
  const field = (key) => {
    if (strict && strict[key] !== undefined && strict[key] !== null && strict[key] !== '') return strict[key]
    return looseField(raw, key)
  }
  const toBool = (v) => {
    if (v === true || v === 1) return true
    if (v === false || v === 0) return false
    const s = String(v === undefined || v === null ? '' : v).trim().toLowerCase()
    if (!s) return null
    if (/^(true|yes|1|正确|对|是|√)$/.test(s)) return true
    if (/^(false|no|0|错误|错|否|×)$/.test(s)) return false
    return null
  }
  const recognized = String(field('recognized') || '').trim()
  const correctAnswer = String(field('correctAnswer') || '').trim()
  const isCorrect = toBool(field('isCorrect'))
  if (!recognized && !correctAnswer && isCorrect === null) return null
  return {
    recognized,
    isCorrect,
    correctAnswer,
    feedback: String(field('feedback') || '').trim(),
    explanation: String(field('explanation') || '').trim()
  }
}

// 读取本地文件为 base64
const readFileBase64 = (filePath) => new Promise((resolve, reject) => {
  wx.getFileSystemManager().readFile({
    filePath,
    encoding: 'base64',
    success: res => resolve(res.data),
    fail: err => reject(new Error('读取图片失败：' + (err.errMsg || '未知错误')))
  })
})

const imageMime = (filePath) => {
  const p = String(filePath || '').toLowerCase()
  if (p.indexOf('.png') >= 0) return 'image/png'
  if (p.indexOf('.webp') >= 0) return 'image/webp'
  if (p.indexOf('.gif') >= 0) return 'image/gif'
  return 'image/jpeg'
}

// 压缩图片：长边超过 maxSide 时等比缩放，减小 base64 请求体
const compressImage = (filePath, maxSide = 1280, quality = 75) => new Promise(resolve => {
  const fallback = () => resolve(filePath)
  wx.getImageInfo({
    src: filePath,
    success: info => {
      const w = info.width || 0
      const h = info.height || 0
      const longSide = Math.max(w, h)
      if (!longSide || longSide <= maxSide) return resolve(filePath)
      const scale = maxSide / longSide
      wx.compressImage({
        src: filePath,
        quality,
        compressedWidth: Math.round(w * scale),
        compressedHeight: Math.round(h * scale),
        success: res => resolve(res.tempFilePath || filePath),
        fail: () => {
          // 部分图片格式不支持指定宽高，退化为仅压缩质量
          wx.compressImage({
            src: filePath,
            quality,
            success: res => resolve(res.tempFilePath || filePath),
            fail: fallback
          })
        }
      })
    },
    fail: fallback
  })
})

// 兼容 content 为字符串或 [{type:'text',text:'...'}] 数组的情况
const pickContent = (content) => {
  if (!content) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === 'string') return part
      if (part && typeof part === 'object') return part.text || part.content || ''
      return ''
    }).join('')
  }
  return String(content)
}

// UTF-8 字节解码（部分基础库没有 TextDecoder）
const utf8Decode = (bytes) => {
  let out = ''
  let i = 0
  while (i < bytes.length) {
    const c = bytes[i++]
    if (c < 0x80) {
      out += String.fromCharCode(c)
    } else if (c < 0xe0) {
      out += String.fromCharCode(((c & 0x1f) << 6) | (bytes[i++] & 0x3f))
    } else if (c < 0xf0) {
      out += String.fromCharCode(((c & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f))
    } else {
      const cp = ((c & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f)
      out += String.fromCodePoint ? String.fromCodePoint(cp) : ''
    }
  }
  return out
}

// SSE 流式对话：思考型模型单次生成常超过 wx.request 的 60s 硬上限，
// 流式持续接收数据不会被掐断。返回 { content, reasoning, finishReason }
const streamChat = (opts) => new Promise((resolve, reject) => {
  const onDelta = opts.onDelta
  let content = ''
  let reasoning = ''
  let finishReason = ''
  let settled = false
  let pending = new Uint8Array(0)

  const done = (err, data) => {
    if (settled) return
    settled = true
    if (err) reject(err)
    else resolve(data)
  }

  const handleText = (text) => {
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      if (line.indexOf('data:') !== 0) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      let j
      try { j = JSON.parse(payload) } catch (e) { continue }
      if (j && j.error) {
        const e = new Error('请求失败：' + (j.error.message || j.error.code || ''))
        return done(e)
      }
      const ch = j && j.choices && j.choices[0]
      if (!ch) continue
      const d = ch.delta || {}
      if (d.reasoning) reasoning += d.reasoning
      if (d.content) {
        content += d.content
        if (onDelta) onDelta(content)
      }
      if (ch.finish_reason) finishReason = ch.finish_reason
    }
  }

  // 按换行切分事件，跨 chunk 的半行/半个汉字留到下一包
  const feed = (buf) => {
    const bytes = new Uint8Array(buf)
    const merged = new Uint8Array(pending.length + bytes.length)
    merged.set(pending, 0)
    merged.set(bytes, pending.length)
    let cut = -1
    for (let i = merged.length - 1; i >= 0; i--) {
      if (merged[i] === 10) { cut = i; break }
    }
    if (cut < 0) {
      pending = merged
      return
    }
    pending = merged.subarray(cut + 1)
    handleText(utf8Decode(merged.subarray(0, cut + 1)))
  }

  const task = wx.request({
    url: opts.url,
    method: 'POST',
    timeout: opts.timeout || 180000,
    responseType: 'arraybuffer',
    enableChunked: true,
    header: opts.header,
    data: Object.assign({}, opts.body, { stream: true }),
    success: res => {
      if (res && res.statusCode && res.statusCode !== 200) {
        const e = new Error('请求失败（HTTP ' + res.statusCode + '）')
        e.statusCode = res.statusCode
        return done(e)
      }
      // 兜底：部分环境不发 chunk 事件，用整包解析
      if (!content && !reasoning && res && res.data) {
        try { feed(res.data) } catch (e) {}
      }
      done(null, { content, reasoning, finishReason })
    },
    fail: err => {
      const msg = (err && err.errMsg) || '网络请求失败'
      const e = new Error('请求失败：' + msg)
      e.timeout = /time\s*-?\s*out/i.test(msg)
      done(e)
    }
  })

  if (task && typeof task.onChunkReceived === 'function') {
    task.onChunkReceived(res => {
      try { feed(res.data) } catch (e) { console.warn('[llm] chunk 解析异常:', e && e.message) }
    })
  } else {
    console.warn('[llm] 基础库不支持 onChunkReceived，流式降级为整包解析')
  }
})

// 判断接口厂商：商汤平台上托管的 DeepSeek 也按商汤的参数规范处理
const vendorOf = (conn, model) => {
  const host = String((conn && conn.baseUrl) || '').replace(/^https?:\/\//, '').split('/')[0]
  const m = String(model || '')
  if (/\.sensenova\.cn$/i.test(host) && /sensenova|deepseek/i.test(m)) return 'sensenova'
  if (/api\.deepseek\.com$/i.test(host) || /^deepseek/i.test(m)) return 'deepseek'
  return 'other'
}

// 图片模型是否强制思考（响应慢），页面据此显示"预计 30~60 秒"的进度提示
const isSlowVisionModel = () => {
  const conn = getVisionConnection()
  if (!conn) return false
  return vendorOf(conn, conn.model) === 'sensenova'
}

// 关闭思考模式的参数：各家写法不同，写错会被判为参数非法（400 invalid arguments）
// DeepSeek / 商汤日日新均支持顶层 thinking 对象：{type:'enabled'|'disabled'|'adaptive'}
const thinkOffParams = (conn, model) => {
  const vendor = vendorOf(conn, model)
  if (vendor === 'deepseek' || vendor === 'sensenova') return { thinking: { type: 'disabled' } }
  return {}
}

// 多模态请求：把图片以 data URL 放进 image_url，供视觉模型识别
const requestWithImage = (conn, model, textPrompt, filePath, maxTokens = 900) => {
  return compressImage(filePath).then(compressedPath => {
    console.log('[llm] 视觉请求图片:', compressedPath === filePath ? '原图' : '已压缩', compressedPath)
    return readFileBase64(compressedPath).then(b64 => {
      console.log('[llm] 视觉请求 base64 长度:', b64.length, 'model:', model)
      const url = conn.baseUrl.replace(/\/+$/, '') + '/chat/completions'
      const vendor = vendorOf(conn, model)
      // DeepSeek 思考模式的思维链会占用输出额度；商汤日日新同理
      const isDeepSeek = vendor === 'deepseek'
      const isSenseNova = vendor === 'sensenova'
      const dataUrl = `data:${imageMime(compressedPath)};base64,${b64}`
      console.log('[llm] 视觉请求 vendor:', vendor, 'url:', url, 'base64 长度:', b64.length)

      // 关闭思考的写法按厂商逐个尝试
      // 实测：商汤 6.8-flash-lite 会忽略 thinking.type 和 reasoning_effort，强制思考，
      // 因此不再传无效参数，改为「流式 + 充足 max_tokens」让其把思考跑完
      const thinkVariants = () => {
        if (isDeepSeek) return [{ thinking: { type: 'disabled' } }]
        return [{}]
      }
      const variants = thinkVariants()

      // 发一次视觉请求，返回 { content, finishReason }
      const send = (tokens, imgUrl, extra) => {
        // DeepSeek 思考模式的思维链会占用输出额度，给足空间
        // 商汤强制思考（thinking / reasoning_effort 实测都不生效），只能给足额度并走流式
        const finalTokens = isDeepSeek ? Math.max(tokens, 3000) : (isSenseNova ? Math.max(tokens, 6000) : tokens)
        const body = Object.assign({
          model,
          max_tokens: finalTokens,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: textPrompt },
              { type: 'image_url', image_url: { url: imgUrl } }
            ]
          }]
        }, extra || {})
        console.log('[llm] 视觉请求 max_tokens:', finalTokens, 'extra:', JSON.stringify(extra || {}), '流式:', isSenseNova)

        // 商汤单次生成常在 60s 以上，流式可持续接收，避开 wx.request 的超时上限
        if (isSenseNova) {
          return streamChat({
            url,
            header: { 'Authorization': 'Bearer ' + conn.key, 'Content-Type': 'application/json' },
            body
          }).then(r => {
            let content = r.content
            if (!String(content || '').trim() && r.reasoning) {
              const fromReasoning = extractJSON(r.reasoning)
              if (fromReasoning) content = JSON.stringify(fromReasoning)
            }
            if (!String(content || '').trim()) {
              console.warn('[llm] 流式视觉无正文', 'finish_reason:', r.finishReason,
                'reasoning 长度:', r.reasoning.length)
            }
            return { content, finishReason: r.finishReason }
          })
        }

        return new Promise((resolve, reject) => {
        wx.request({
          url,
          method: 'POST',
          timeout: 60000,
          header: {
            'Authorization': 'Bearer ' + conn.key,
            'Content-Type': 'application/json'
          },
          data: body,
          success: res => {
            const d = res.data || {}
            if (res.statusCode !== 200) {
              const detail = (d.error && (d.error.message || d.error.code)) || d.message || ''
              console.error('[llm] 视觉请求失败', res.statusCode, JSON.stringify(d).slice(0, 600), 'url:', url)
              const e = new Error('图片识别失败（HTTP ' + res.statusCode + '）' + (detail ? '：' + detail : '') +
                (res.statusCode === 400 ? '（已自动降级重试，仍失败可换支持图片的模型）' : ''))
              e.statusCode = res.statusCode
              e.visionUnsupported = res.statusCode === 400 &&
                /image|vision|modalit|content|variant|support|invalid/i.test(detail)
              reject(e)
              return
            }
            const choice = (d.choices && d.choices[0]) || {}
            const msg = choice.message || {}
            let content = pickContent(msg.content)
            if (!String(content || '').trim()) {
              // 思考模式下思维链在 reasoning_content / reasoning，尝试从中提取 JSON 兜底
              const reasoning = pickContent(msg.reasoning_content) || pickContent(msg.reasoning)
              const fromReasoning = extractJSON(reasoning)
              if (fromReasoning) {
                content = JSON.stringify(fromReasoning)
              } else {
                console.warn('[llm] 视觉请求返回空 content',
                  'finish_reason:', choice.finish_reason,
                  'reasoning 长度:', reasoning.length,
                  'thinking/reasoning_effort:', JSON.stringify(body.thinking || body.reasoning_effort || null),
                  '返回体:', JSON.stringify(d).slice(0, 400))
              }
            }
            resolve({ content, finishReason: choice.finish_reason })
          },
          fail: err => {
            const msg = (err && err.errMsg) || '网络请求失败'
            console.error('[llm] 视觉请求网络失败:', msg, 'url:', url)
            const e = new Error('图片识别请求失败：' + msg)
            e.timeout = /time\s*-?\s*out/i.test(msg)
            if (msg.indexOf('url not in domain list') >= 0) {
              e.message = '域名不在 request 合法域名中，请在公众平台配置 ' + conn.baseUrl
            }
            reject(e)
          }
        })
        })
      }

      // 依次尝试：换关闭思考的写法 -> 400 也换写法 -> 最后提高一次额度
      // 超时（60s 上限）说明思考关不掉，直接给出可操作提示，不再盲目重试
      let triedBigger = false
      const attempt = async (idx, tokens) => {
        const extra = variants[idx]
        let res
        try {
          res = await send(tokens, dataUrl, extra)
        } catch (err) {
          if (err.timeout) {
            console.error('[llm] 视觉请求超时，当前参数:', JSON.stringify(extra))
            throw new Error('图片识别超时：该模型思考时间过长，超过网络限制。请在「设置 → 图片识别模型」换一个响应更快的视觉模型（如 qwen-vl-max、glm-4v-flash）。')
          }
          if (err.statusCode === 400 && idx + 1 < variants.length) {
            console.warn('[llm] 视觉 400，换思考控制参数重试:', JSON.stringify(extra))
            return attempt(idx + 1, tokens)
          }
          throw err
        }
        const text = String(res.content || '').trim()
        if (text && res.finishReason !== 'length') return text
        if (idx + 1 < variants.length) {
          console.warn('[llm] 视觉正文为空/被截断，换思考控制参数重试:',
            JSON.stringify(extra), '->', JSON.stringify(variants[idx + 1]),
            'finish_reason:', res.finishReason)
          return attempt(idx + 1, tokens)
        }
        // 所有写法都拿不到正文：最后提高一次额度（商汤已按 6000 流式跑，不再重试）
        if (!triedBigger && tokens < 4096 && !isSenseNova) {
          triedBigger = true
          console.warn('[llm] 视觉仍无正文，提高 max_tokens 重试:', res.finishReason, tokens, '-> 4096')
          return attempt(idx, 4096)
        }
        return text
      }

      return attempt(0, maxTokens)
    })
  })
}

// 通用对话
const chat = (messages, { connection, model, onStream, format } = {}) => {
  const app = getApp()
  const conn = connection || getActiveConnection()
  model = model || (conn && conn.model)

  // 无连接或无 Key -> mock
  if (!conn || !conn.key) {
    console.warn('[llm] 未配置可用模型连接，使用 mock')
    const reply = mock.mockChatReply(messages[messages.length - 1]?.content || '')
    if (onStream) {
      let i = 0
      const timer = setInterval(() => {
        if (i < reply.length) {
          onStream(reply.slice(0, i + 1))
          i++
        } else {
          clearInterval(timer)
          onStream(null, true)
        }
      }, 50)
      return Promise.resolve({ content: reply })
    }
    return Promise.resolve({ content: reply })
  }

  const url = conn.baseUrl.replace(/\/+$/, '') + '/chat/completions'

  // 商汤强制思考，非流式很容易超过 60s 被掐断，走流式并实时回传
  if (vendorOf(conn, model) === 'sensenova') {
    return streamChat({
      url,
      header: { 'Authorization': 'Bearer ' + conn.key, 'Content-Type': 'application/json' },
      body: {
        model,
        max_tokens: 4096,
        messages: buildContext(app, format).concat(messages),
        thinking: { type: 'disabled' }
      },
      onDelta: onStream ? (partial) => onStream(partial) : undefined
    }).then(r => {
      const content = pickContent(r.content) || pickContent(r.reasoning)
      if (onStream) onStream(null, true)
      return { content, finishReason: r.finishReason }
    })
  }

  const post = (extra) => new Promise((resolve, reject) => {
    wx.request({
      url,
      method: 'POST',
      header: {
        'Authorization': 'Bearer ' + conn.key,
        'Content-Type': 'application/json'
      },
      data: Object.assign({
        model,
        messages: buildContext(app, format).concat(messages),
        max_tokens: 8192,
        stream: false
      }, extra || {}),
      success: res => {
        if (res.statusCode !== 200) {
          const d = res.data || {}
          const detail = (d.error && (d.error.message || d.error.code)) || d.message || ''
          console.error('[llm] chat 请求失败', res.statusCode, JSON.stringify(d).slice(0, 400))
          const e = new Error('对话失败（HTTP ' + res.statusCode + '）' + (detail ? '：' + detail : ''))
          e.statusCode = res.statusCode
          reject(e)
          return
        }
        const choice = (res.data && res.data.choices && res.data.choices[0]) || {}
        const msg = choice.message || {}
        // 思考模式下正文可能为空，用思维链内容兜底
        const content = pickContent(msg.content) || pickContent(msg.reasoning) || pickContent(msg.reasoning_content)
        resolve({ content, finishReason: choice.finish_reason || '' })
      },
      fail: reject
    })
  })

  // 400 多半是服务端不认识思考控制参数，去掉后重试一次
  return post(thinkOffParams(conn, model)).catch(err => {
    if (err.statusCode !== 400) throw err
    console.warn('[llm] chat 400，去掉思考控制参数重试')
    return post({})
  })
}

// 归档支持的科目（与乐享目录保持一致）
const ARCHIVE_SUBJECT_HINT = '语文、数学、英语、物理、化学、生物、历史、地理、政治、科学、道德与法治、古筝、练字、其他'

// 归档抽取失败时换个更简的 prompt 再要一次：只要结构、条目少、不用思考
const ARCHIVE_RETRY_PROMPT = [
  '只做一件事：把这段对话里的知识点和错题整理成 JSON。',
  '只返回一行 JSON，不要思考过程、不要解释文字、不要 Markdown 代码块。',
  '格式：{"summary":"80字以内总结","wrongQuestions":[{"subject":"科目","knowledge":"知识点","question":"题干","myAnswer":"","correctAnswer":"","analysis":"","difficulty":"中档"}],"knowledgePoints":[{"subject":"科目","title":"知识点名称","content":"一句话说明"}]}',
  '知识点和错题各最多 8 条，content 每条不超过 50 字。',
  '科目只能从以下选择：' + ARCHIVE_SUBJECT_HINT + '。'
].join('\n')

const unquote = (s) => {
  const t = String(s || '')
  try {
    return JSON.parse('"' + t.replace(/^"|"$/g, '') + '"')
  } catch (e) {
    return t
  }
}

// 字符串结构坏掉时按字段名取值（半角引号取不到再试中文引号）
const salvageField = (seg, key) => {
  const re = new RegExp('["\']?' + key + '["\']?\\s*[:：]\\s*"((?:[^"\\\\]|\\\\.)*)"')
  const m = re.exec(seg)
  if (m) return unquote(m[1])
  const re2 = new RegExp('["\']?' + key + '["\']?\\s*[:：]\\s*[\\u201c"]([^\\u201d"]*)[\\u201d"]')
  const m2 = re2.exec(seg)
  return m2 ? m2[1] : ''
}

// 以某个字段为锚点把一段坏 JSON 切成多条，每条取若干字段
const salvageItems = (raw, anchor, fields) => {
  const parts = String(raw || '').split(new RegExp('(?=["\']' + anchor + '["\']\\s*[:：])'))
  const list = []
  parts.forEach(seg => {
    const obj = {}
    let hit = 0
    fields.forEach(f => {
      const v = salvageField(seg, f)
      if (v) {
        obj[f] = v
        hit++
      }
    })
    if (hit >= 2) list.push(obj)
  })
  return list
}

// 把模型回复尽力解析成 { summary, wrongQuestions, knowledgePoints }，实在不行返回 null
const parseSessionResult = (raw) => {
  const text = String(raw || '')
  const obj = extractJSON(text, 'object')
  // 原文提到的容器字段必须在解析结果里出现，否则说明 JSON 结构被截断/写坏了
  const hasPoints = /["']?knowledgePoints["']?\s*[:：]/.test(text)
  const hasWrongs = /["']?wrongQuestions["']?\s*[:：]/.test(text)
  const okPoints = !!obj && Array.isArray(obj.knowledgePoints)
  const okWrongs = !!obj && Array.isArray(obj.wrongQuestions)
  const complete = !!obj && (!!obj.summary || okPoints || okWrongs) &&
    !(hasPoints && !okPoints) && !(hasWrongs && !okWrongs)
  if (complete) return obj
  // 模型只给了数组（全是知识点或全是错题）
  const arr = extractJSON(text, 'array')
  if (Array.isArray(arr) && arr.length) {
    if (arr.some(x => x && x.question)) return { wrongQuestions: arr }
    if (arr.some(x => x && (x.title || x.content))) return { knowledgePoints: arr }
  }
  // 模型只给了一个条目对象（原文里有容器字段名说明结构坏了，交给下面的捞回逻辑）
  if (!hasPoints && !hasWrongs && obj && (obj.title || obj.question)) {
    return obj.question ? { wrongQuestions: [obj] } : { knowledgePoints: [obj] }
  }
  // 结构被写坏（字符串里裸引号、尾逗号、中文引号）：按字段名捞回内容
  const wrongs = salvageItems(text, 'question',
    ['subject', 'knowledge', 'question', 'myAnswer', 'correctAnswer', 'analysis', 'difficulty'])
    .filter(q => q.question)
  const points = salvageItems(text, 'title', ['subject', 'title', 'content'])
    .filter(k => k.title || k.content)
  const summary = salvageField(text, 'summary')
  if (summary || wrongs.length || points.length) {
    return { summary, wrongQuestions: wrongs, knowledgePoints: points }
  }
  return null
}

// 统一整理成归档弹层用的结构
const mapSessionResult = (r) => {
  const wrongs = (Array.isArray(r.wrongQuestions) ? r.wrongQuestions : [])
    .filter(q => q && String(q.question || '').trim())
    .slice(0, 30)
    .map(q => ({
      subject: String(q.subject || '其他'),
      knowledge: String(q.knowledge || '未分类知识点'),
      title: String(q.knowledge || '错题'),
      question: String(q.question || ''),
      myAnswer: String(q.myAnswer || ''),
      correctAnswer: String(q.correctAnswer || ''),
      analysis: String(q.analysis || ''),
      difficulty: String(q.difficulty || '中档'),
      source: 'AI 助手归档'
    }))
  const points = (Array.isArray(r.knowledgePoints) ? r.knowledgePoints : [])
    .filter(k => k && (k.title || k.content))
    .slice(0, 30)
    .map(k => ({
      subject: String(k.subject || '其他'),
      title: String(k.title || '知识点'),
      content: String(k.content || '')
    }))
  // 总结用于弹层纯文本展示，去掉 Markdown 标记
  const summary = String(r.summary || '').replace(/[*#`>]/g, '').replace(/\n+/g, ' ').trim()
  return { summary, wrongQuestions: wrongs, knowledgePoints: points }
}

// 归档抽取失败时的本地兜底摘要：取学生最后几次提问拼一句，保证会话本身还能归档
const localSummary = (messages) => {
  const asks = (messages || [])
    .filter(m => m && m.role === 'user' && (m.content || m.context))
    .map(m => String(m.context || m.content || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(-3)
  const text = asks.join('；').slice(0, 80)
  return text ? '（AI 总结失败，按原文摘要）' + text : '（AI 总结失败，本次会话按原样归档）'
}

// 归档前的会话抽取：一句话总结 + 错题 + 知识点
const extractSessionItems = (messages) => {
  const conn = getActiveConnection()
  if (!conn || !conn.key) return Promise.reject(new Error('未配置对话模型，无法总结会话'))

  const dialog = (messages || [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && (m.content || m.context))
    .map(m => {
      if (m.type === 'image') return '我：［发了一张图片］'
      const text = String(m.context || m.content || '').replace(/\s+/g, ' ').slice(0, 400)
      return (m.role === 'user' ? '我：' : 'AI：') + text
    })
    .join('\n')
    .slice(-6000)

  const prompt = [
    '下面是一段小学生和 AI 学习助手的对话，请做两件事：',
    '1. 用 80 字以内总结这次对话讲了什么；',
    '2. 抽取出对话里出现的「错题」和「知识点」。',
    '只返回 JSON，不要解释文字，格式：',
    '{"summary":"总结","wrongQuestions":[{"subject":"科目","knowledge":"知识点","question":"完整题干","myAnswer":"学生当时的答案","correctAnswer":"正确答案","analysis":"错因或思路","difficulty":"基础/中档/难"}],"knowledgePoints":[{"subject":"科目","title":"知识点名称","content":"用2-4句话讲清这个知识点"}]}',
    '科目只能从以下选择：' + ARCHIVE_SUBJECT_HINT + '。知识点和错题的 subject 必须是学生要保存的那一科（例如发的是英语清单就填"英语"）。',
    '知识清单、单词表、语法汇总、知识总结要按条目拆成多条 knowledgePoints，每条 title 是一个具体知识点，不要合并成一条笼统的"某某知识清单"。',
    '错题和知识点各最多 30 条；条目更多时只保留最完整、最有代表性的 30 条，不要为了凑数省略 JSON 结构。',
    'JSON 里的换行必须写成 \\n，不要出现裸换行；不要用 Markdown 代码块包裹，也不要在 JSON 前后写解释。',
    '没有错题就给空数组，没有知识点也给空数组；错题必须是对话里真实出现过的题目，不要自己编。'
  ].join('\n')

  const ask = (userPrompt, text) => chat([{ role: 'user', content: userPrompt + '\n\n【对话记录】\n' + text }])

  return ask(prompt, dialog).then(res => {
    const raw = String((res && res.content) || '')
    const first = raw ? parseSessionResult(raw) : null
    if (first) return mapSessionResult(first)
    console.warn('[llm] 归档抽取解析失败 finish_reason:', (res && res.finishReason) || '未知',
      '长度:', raw.length, '片段:', raw.slice(0, 400))
    // 第二次：更短的对话 + 更少的条目，只要拿得到结构
    return ask(ARCHIVE_RETRY_PROMPT, dialog.slice(-3000)).then(res2 => {
      const raw2 = String((res2 && res2.content) || '')
      const second = raw2 ? parseSessionResult(raw2) : null
      if (second) return mapSessionResult(second)
      console.warn('[llm] 归档抽取二次解析失败 finish_reason:', (res2 && res2.finishReason) || '未知',
        '长度:', raw2.length, '片段:', raw2.slice(0, 400))
      // 留一份原始返回，方便在调试器 Storage 里查看 ct_llm_last_raw
      storage.set('ct_llm_last_raw', (raw2 || raw).slice(0, 4000))
      // 兜底：不让整个归档失败，用对话原文生成摘要，错题/知识点留空由用户决定
      return { summary: localSummary(messages), wrongQuestions: [], knowledgePoints: [], degraded: true }
    })
  })
}

// 允许渲染的几何图形类型
const FIGURE_TYPES = ['angle', 'triangle', 'rectangle', 'square', 'circle', 'parallelogram', 'line']

// 校验并收敛 AI 返回的图形描述，避免非法结构导致画布报错
const normalizeFigure = (f) => {
  if (!f || typeof f !== 'object') return null
  const type = String(f.type || '').toLowerCase()
  if (FIGURE_TYPES.indexOf(type) < 0) return null
  const out = { type }
  if (f.label !== undefined) out.label = String(f.label).slice(0, 30)
  if (f.degree !== undefined && !isNaN(Number(f.degree))) out.degree = Number(f.degree)
  if (Array.isArray(f.labels)) {
    out.labels = f.labels.slice(0, 4).map(x => String(x).slice(0, 20))
  } else if (f.labels && typeof f.labels === 'object') {
    out.labels = {}
    ;['top', 'bottom', 'left', 'right', 'radius'].forEach(k => {
      if (f.labels[k] !== undefined) out.labels[k] = String(f.labels[k]).slice(0, 20)
    })
  }
  return out
}

// 教材版本：按学科写死（英语沪教版，其余人教版），不再从设置读、也不参与云同步
const getTextbook = (subject) => config.getTextbook(subject)

// 说不清学科时（全科 / 对话上下文）给一句规则说明
const textbookRule = () => config.textbookSummary()

// 全科：综合乐享知识库里所有科目的知识点和错题出题
const ALL_SUBJECT = '全科'
// mock 题库只覆盖语数英，其他学科兜底时用这三科内容混合
const FALLBACK_SUBJECTS = ['语文', '数学', '英语']

// 收敛学科名：全科题按各题自带的学科归类，认不出的一律进「其他」
const resolveQuestionSubject = (raw, subject) => {
  if (subject !== ALL_SUBJECT) return subject
  const s = String(raw || '').trim()
  return lexiang.getSyncedSubjects().indexOf(s) >= 0 ? s : '其他'
}

// 统一整理 AI 生成的题目：补齐学科、知识点、图形、选项
const normalizeQuestions = (list, subject) => {
  if (!Array.isArray(list)) return []
  return list.filter(q => q && q.question && q.answer).slice(0, 60).map((q, idx) => {
    const subj = resolveQuestionSubject(q.subject, subject)
    return {
      id: 'q' + idx,
      subject: subj,
      question: String(q.question),
      answer: String(q.answer),
      explanation: String(q.explanation || ''),
      knowledge: String(q.knowledge || q.point || subj || '未分类知识点').slice(0, 40),
      figure: normalizeFigure(q.figure),
      type: q.type === 'choice' ? 'choice' : 'short',
      options: Array.isArray(q.options) ? q.options.slice(0, 6).map(o => String(o)) : []
    }
  })
}

// 当前年级水平的随机题：错题和知识点不够出题数时用来补位
const gradeLevelQuestions = (subject, count, grade) => {
  const len = Math.max(parseInt(count) || 1, 1)
  if (subject !== ALL_SUBJECT && FALLBACK_SUBJECTS.indexOf(subject) >= 0) {
    return mock.mockGenerateQuestions(subject, len, grade).map(q => Object.assign({}, q, { subject }))
  }
  // 全科 / 非语数英学科：语数英混合随机出题，保证题目标注的学科和内容一致
  const pool = []
  FALLBACK_SUBJECTS.forEach(s => {
    mock.mockGenerateQuestions(s, Math.max(len, 10), grade)
      .forEach(q => pool.push(Object.assign({}, q, { subject: s })))
  })
  pool.sort(() => Math.random() - 0.5)
  const out = []
  for (let i = 0; i < len && pool.length; i++) out.push(Object.assign({}, pool[i % pool.length]))
  return out
}

// 保证题目数量：不足的用年级水平随机题补齐，多余的截断
const fillQuestions = (list, subject, count, grade) => {
  const target = Math.max(parseInt(count) || 0, 1)
  const out = (Array.isArray(list) ? list : []).slice(0, target)
  if (out.length >= target) {
    out.forEach((q, i) => { q.id = 'q' + i })
    return out
  }
  const used = {}
  out.forEach(q => { used[String(q.question || '').replace(/\s/g, '')] = true })
  const pool = gradeLevelQuestions(subject, target * 3, grade)
  for (let i = 0; i < pool.length && out.length < target; i++) {
    const key = String(pool[i].question || '').replace(/\s/g, '')
    if (used[key]) continue
    used[key] = true
    out.push(Object.assign({}, pool[i]))
  }
  // 去重后仍不够就允许重复，确保题数一定达标
  for (let i = 0; out.length < target && pool.length; i++) {
    out.push(Object.assign({}, pool[i % pool.length]))
  }
  out.forEach((q, i) => { q.id = 'q' + i })
  return out
}

// 读懂图片内容（供 AI 助手对话用）：返回图片的文字描述，供后续追问作为上下文
const describeImage = (imagePath) => {
  const conn = getVisionConnection()
  if (!conn || !conn.key) return Promise.reject(new Error('没有可用的图片识别模型，请先在设置里配置'))
  const prompt = '把这张图片的内容如实描述出来：如果是题目，抄下完整题干、选项和图中出现的所有文字与数字；' +
    '如果是表格或图表，说明行列标题和具体数据；如果是普通照片，描述画面里有什么。只描述，不要评价，不要客套。'
  return requestWithImage(conn, conn.model, prompt, imagePath, 1200)
    .then(text => String(text || '').trim())
}

// OCR 整理错题：图片转 base64，按视觉模型格式发送
const ocrWrongQuestion = (imagePath) => {
  const conn = getVisionConnection()
  if (!conn || !conn.key) {
    return new Promise(resolve => {
      setTimeout(() => resolve(mock.mockOCRResult()), 1200)
    })
  }
  if (!imagePath) return Promise.reject(new Error('未获取到题目图片'))
  const prompt = `你是小学生错题录入助手。请识别图片中的题目，只返回 JSON，不要解释文字，格式：
{"subject":"语文/数学/英语/古筝/练字/其他","knowledge":"知识点名称","question":"完整题干","myAnswer":"学生写下的答案（看不清则留空）","correctAnswer":"正确答案（若图片中没有则由你解答）","analysis":"学生的错误原因或解题提示","difficulty":"基础/中档/难"}
如果图片不是题目，question 返回空字符串。`

  const parse = (text) => {
    const r = extractJSON(text)
    if (!r) {
      const preview = String(text || '').trim().slice(0, 120)
      console.warn('[llm] OCR 返回无法解析:', String(text).slice(0, 400))
      throw new Error(preview
        ? 'AI 返回内容无法解析（片段：' + preview + '）'
        : '模型没有返回最终答案（content 为空），请重试或更换图片识别模型')
    }
    if (!r.question) {
      throw new Error('AI 没有在图片里找到题目，请确认拍摄的是完整题目')
    }
    const subjects = lexiang.getSyncedSubjects()
    const knowledge = r.knowledge || '未分类知识点'
    return {
      subject: subjects.indexOf(r.subject) >= 0 ? r.subject : '其他',
      knowledge,
      title: knowledge,
      question: r.question || '',
      myAnswer: r.myAnswer || '',
      correctAnswer: r.correctAnswer || '',
      analysis: r.analysis || '',
      difficulty: ['基础', '中档', '难'].indexOf(r.difficulty) >= 0 ? r.difficulty : '中档'
    }
  }

  const run = (c) => requestWithImage(c, c.model, prompt, imagePath, 1000).then(parse)

  // 当前图片模型明确不支持图片时，自动换一个可用连接重试（切换供应商后仍能识别）
  return run(conn).catch(err => {
    if (!err.visionUnsupported) throw err
    const alt = getFallbackVisionConnection(conn.id)
    if (!alt) throw err
    console.warn('[llm]', conn.name, conn.model, '不支持图片，改用', alt.name, alt.model, '重试')
    return run(alt)
  })
}

// ==================== 关卡 × 知识点范围 ====================
// 第 1~9 关逐关扩大覆盖的知识点个数，第 10 关覆盖全部知识点（0 表示不限）
const LEVEL_KNOWLEDGE_COUNT = [1, 2, 3, 4, 5, 6, 7, 8, 9, 0]
const MAX_LEVEL = LEVEL_KNOWLEDGE_COUNT.length
// 模拟考试参考闯关的中等难度：取中间关卡的知识点范围 + 中档难度
const EXAM_LEVEL = Math.ceil(MAX_LEVEL / 2)

// 按薄弱程度排序的知识点清单：错题里出现越多越靠前，其次是学习记忆里的薄弱点
const knowledgePool = (subject) => {
  const subjects = subject === ALL_SUBJECT ? lexiang.getSyncedSubjects() : [subject]
  const weights = {}
  const order = []
  const push = (name) => {
    const key = String(name || '').trim()
    if (!key) return
    if (!(key in weights)) {
      weights[key] = 0
      order.push(key)
    }
  }
  const wrongbook = storage.getWrongbook() || []
  wrongbook.forEach(w => {
    if (subjects.indexOf(w.subject) < 0) return
    if (w.status === '已归档' || w.status === '已消退') return
    const k = w.knowledge || w.title
    if (!k) return
    push(k)
    weights[String(k).trim()] += 1
  })
  subjects.forEach(s => {
    const mem = storage.getMemory(s)
    if (!mem || !Array.isArray(mem.weakPoints)) return
    // 已消退的知识点不再进池：消退后不出题
    mem.weakPoints.filter(p => !fade.isKnowledgeFaded(s, p)).forEach(push)
  })
  return order
    .map((name, i) => ({ name, weight: weights[name], i }))
    .sort((a, b) => (b.weight - a.weight) || (a.i - b.i))
    .map(x => x.name)
}

// 某一关覆盖的知识点范围；level < 1（模拟考试等）返回全部
const levelScope = (pool, level) => {
  const list = pool || []
  const lv = parseInt(level) || 0
  if (lv < 1) return list
  const idx = Math.min(lv, MAX_LEVEL) - 1
  const n = LEVEL_KNOWLEDGE_COUNT[idx]
  return n > 0 ? list.slice(0, n) : list
}

// 举一反三出题（全科 = 综合乐享知识库全部学科的知识点与错题）
// level：关卡，用于限定知识点范围；不传或 <1 表示不限定
// difficulty：'中档' 时按本年级中等难度出题（模拟考试用），不传则按年级水平
// opts.knowledgeList：只出这几个知识点（题库补题用，优先于 level 范围）
// opts.exclude：避免与这些题干重复（题库把刚出掉的题传进来）
// opts.shouldStop：返回 true 表示调用方已不需要结果（等待页被返回），不再补题、不再发起第二次请求
const generateQuestions = (subject, count, grade, wrongbook, level, difficulty, opts) => {
  const stop = (opts && typeof opts.shouldStop === 'function') ? opts.shouldStop : null
  const stopped = () => !!(stop && stop())
  const conn = getActiveConnection()
  const target = Math.max(parseInt(count) || 0, 1)
  const isAll = subject === ALL_SUBJECT
  const lv = parseInt(level) || 0
  const pool = knowledgePool(subject)
  const focus = (opts && Array.isArray(opts.knowledgeList))
    ? opts.knowledgeList.map(k => String(k || '').trim()).filter(Boolean)
    : []
  const exclude = (opts && Array.isArray(opts.exclude))
    ? opts.exclude.map(s => String(s || '').replace(/\s/g, '').slice(0, 40)).filter(Boolean).slice(0, 10)
    : []
  const scope = focus.length ? focus : levelScope(pool, lv)
  const isFinalLevel = lv >= MAX_LEVEL
  if (!conn || !conn.key) {
    return new Promise(resolve => {
      setTimeout(() => resolve(fillQuestions(gradeLevelQuestions(subject, target, grade), subject, target, grade)), 2000)
    })
  }
  const subjects = isAll ? lexiang.getSyncedSubjects() : [subject]
  // 单科按该科教材（英语沪教版 / 其余人教版），全科则把规则写进 prompt
  const textbook = isAll ? textbookRule() : getTextbook(subject)
  console.log('[llm] 出题教材:', textbook, '年级:', grade, '学科:', subject, '知识点范围:', scope.join('、') || '不限')
  // 知识点：各科学习记忆（乐享知识库同步过来的薄弱点），已消退的不再出题
  const knowledgeLines = subjects.map(s => {
    const memory = storage.getMemory(s)
    const points = (memory && Array.isArray(memory.weakPoints))
      ? memory.weakPoints.filter(p => p && !fade.isKnowledgeFaded(s, p))
      : []
    if (!points.length) return ''
    return isAll ? `【${s}】${points.join('、')}` : points.join('、')
  }).filter(Boolean)
  const weakPoints = knowledgeLines.join('\n') || '无'

  // 错题样例只保留知识点范围内、且未消退未归档的错题
  const inScope = (w) => !scope.length || scope.indexOf(String(w.knowledge || w.title || '').trim()) >= 0
  const scopedWrong = (wrongbook || []).filter(w => w && w.status !== '已消退' && w.status !== '已归档').filter(inScope)
  const sampleLimit = isAll ? 12 : 6
  const errorSample = scopedWrong.slice(0, sampleLimit).map(w => {
    const tag = isAll ? `${w.subject || '综合'}·${w.knowledge || '未分类'}` : (w.knowledge || '未分类')
    return `【${tag}】${(w.question || w.title || '').slice(0, 60)}（错答：${w.myAnswer || ''}，正解：${w.correctAnswer || ''}）`
  }).join('\n') || '无'

  const subjectLine = isAll
    ? `你是一个${grade}全科老师，使用${textbook}教材，负责${subjects.join('、')}等学科。请综合下面各学科的真实错题和知识点，生成${target}道举一反三的练习题。`
    : `你是一个${grade}${subject}老师，使用${textbook}教材。请基于下面的真实错题和薄弱点，生成${target}道举一反三的练习题。`

  // 教材版本约束：已存档的错题/知识点即便超纲也必须出题，其余补充题按教材 + 年级
  const materialLine = isAll
    ? `教材版本：${textbook}（${grade}）。已经存档的错题和知识点，即使超出这个教材和年级范围（超纲），也必须照原样出题，不能省略、跳过或改成课内简单题；除这些知识点之外新增或补充的题目，一律按${textbook}${grade}的课内进度出题。该版本没有对应学科的（如古筝、练字），按同年级课内常规内容出题。`
    : `教材版本：${textbook}（${grade}）。已经存档的错题和知识点，即使超出这个教材和年级范围（超纲），也必须照原样出题，不能省略、跳过或改成课内简单题；除这些知识点之外新增或补充的题目，一律按${textbook}${grade}的课内进度出题。`

  // 知识点范围：scope 为空说明还没有错题知识点，只能按年级内容随机出
  let scopeLine = ''
  if (focus.length) {
    // 题库补题：只为这几个知识点出题，换数字、换情境，不要和刚出掉的题重复
    scopeLine = `知识点范围（本次只补这几个知识点，超纲的也要出，不要漏）：${focus.join('、')}`
  } else if (!lv) {
    scopeLine = '知识点范围：不限（覆盖提供的全部知识点，超纲的也要出）。'
  } else if (!scope.length) {
    scopeLine = `知识点范围：暂无错题知识点，请按${textbook}${grade}${isAll ? '各学科' : subject}课内基础内容出题。`
  } else if (isFinalLevel) {
    scopeLine = `知识点范围：全部知识点综合（${scope.join('、')}），超纲的也要出；在此之外可适当引入${textbook}${grade}同学科的新知识点。`
  } else {
    scopeLine = `知识点范围（只出这些知识点，超纲的也要出，不要漏）：${scope.join('、')}`
  }

  const difficultyLine = (difficulty === '中档' || difficulty === '中等')
    ? '本年级中等（以课内基础题和中档题为主，不要出超纲题、竞赛题或偏题）'
    : `符合${grade}水平`

  const rules = [
    isAll
      ? '1. 题目要覆盖多个学科，语文、数学、英语等交替搭配，不要只考一科；'
      : `1. 题目只考${subject}，不要出其他学科的内容；`,
    '2. 先覆盖上述知识点范围内的内容，每个知识点至少出 1 道题（题量不够时按薄弱程度依次覆盖）；换数字、换情境、换问法（正向/逆向），不要照抄原题；',
    `3. 已存档的错题和知识点如果超出${textbook}${grade}范围（超纲），也必须照原样出题，不能跳过、降级或替换成课内简单题；这类题的难度按知识点本身的要求来，不要强行压到年级水平；`,
    `4. 上述知识点之外新增或补充的题目，按${textbook}${grade}课内进度出题，难度：${difficultyLine}；题型要多样：应用题、计算题、选择题、几何图形题（角度、三角形、长方形、正方形、圆、平行四边形的边长/角度/周长/面积）；`,
    '5. 每道题必须有明确的唯一答案；',
    isAll ? '6. 每道题都要给出知识点字段 knowledge，并用 subject 标明所属学科。' : '6. 每道题都要给出知识点字段 knowledge。',
    `7. 如果上述知识点不足以支撑${target}道题，剩余题目用${textbook}${grade}${isAll ? '各学科' : subject}课内基础内容随机出题补齐，凑满${target}道。`,
    '8. 知识点命名必须稳定：同一知识点始终使用完全相同的名称（优先复用「薄弱知识点」里已有的名字，4~12 个字，具体到题型或考点），不要为同一类题目另造新名称，否则无法累计掌握次数。'
  ].join('\n')
  const subjectField = isAll ? `  "subject": "所属学科（${FALLBACK_SUBJECTS.join('/')}等）",\n` : ''
  const excludeLine = exclude.length
    ? '已经出过的题（必须换数字、换情境、换问法，不能重复）：\n' + exclude.join('\n') + '\n'
    : ''

  const prompt = `${subjectLine}
${materialLine}
要求：
${rules}
${scopeLine}
薄弱知识点：
${weakPoints}
错题样例：
${errorSample}
${excludeLine}请只返回 JSON 数组，不要任何解释文字。每项格式：
{
  "question": "题干",
  "answer": "答案",
  "explanation": "解析",
  "knowledge": "知识点名称",
${subjectField}  "type": "short 或 choice",
  "options": ["A. ...", "B. ..."]（choice 题必填，short 可省略）,
  "figure": 可选的几何图形描述（非几何题不要填）
}
figure 只能是下面之一：
- {"type":"angle","label":"∠A=?"}  两条射线组成的角
- {"type":"triangle","labels":["左边标签","底边标签","右边标签"]}
- {"type":"rectangle","labels":{"top":"长","bottom":"长","left":"宽","right":"宽"}}
- {"type":"square","labels":{"top":"边长","bottom":"边长","left":"边长","right":"边长"}}
- {"type":"circle","labels":{"radius":"半径"}}
- {"type":"parallelogram","labels":["上边","下边","左边","右边"]}
题干里要写清楚已知条件，图形标签只放数值和单位。`
  return chat([{ role: 'user', content: prompt }], { connection: conn, model: conn.model })
    .then(res => {
      // 等待页已经被返回：结果没人要了，别再补第二次请求
      if (stopped()) {
        console.log('[llm] 出题已取消，丢弃本次结果')
        return []
      }
      const parsed = extractJSON(res.content, 'array')
      const list = (parsed && parsed.length) ? normalizeQuestions(parsed, subject) : []
      // 知识点是否漏出：范围内每个知识点都应有题（超纲知识点同样不能漏）
      const covered = {}
      list.forEach(q => { covered[String(q.knowledge || '').trim()] = true })
      const missed = (scope.length && lv > 0)
        ? scope.filter(p => !covered[String(p).trim()])
        : []
      if (list.length >= target) return fillQuestions(list, subject, target, grade)
      // 数量不够：先让 AI 补一次，缺口和漏掉的知识点都写明确，仍不够才用本地题库兜底
      const missing = target - list.length
      const missText = missed.length ? `必须覆盖这些还没出到的知识点：${missed.join('、')}。` : ''
      return chat([{
        role: 'user',
        content: prompt + `\n\n注意：上面要求 ${target} 道，你只给了 ${list.length} 道。请再补充 ${missing} 道题目，${missText}` +
          `已经存档的知识点就算超纲也要照原样出；其余基础题按${textbook}${grade}课内内容。只返回这 ${missing} 道题组成的 JSON 数组。`
      }], { connection: conn, model: conn.model })
        .then(res2 => {
          const more = extractJSON(res2.content, 'array') || []
          return fillQuestions(list.concat(normalizeQuestions(more, subject)), subject, target, grade)
        })
        .catch(() => fillQuestions(list, subject, target, grade))
    })
    .catch(err => {
      if (stopped()) return []
      console.warn('[llm] generateQuestions 失败，降级随机题库:', err && err.errMsg || err)
      return fillQuestions([], subject, target, grade)
    })
}

// AI 解题思路：分步骤讲思路，并指出错在哪一步
// options.strict = true 时失败直接 reject（后台缓存用，避免把本地兜底文案当成 AI 思路存下来）
const explainQuestion = (item, options = {}) => {
  const conn = getActiveConnection()
  const grade = (getApp() && getApp().globalData.currentGrade) || '四年级'
  const textbook = getTextbook(item.subject)
  const localFallback = `【解题思路】\n1. 先读题，圈出已知条件和要求的问题。\n2. 回忆与「${item.knowledge || '本题考查的知识点'}」相关的公式或方法。\n3. 按步骤列式计算，最后检查单位、符号和答案是否合理。\n\n【你的错因】\n${item.analysis || '对照正确答案，重点检查自己在哪一步出现了偏差。'}`
  if (!conn || !conn.key) {
    return options.strict ? Promise.reject(new Error('未配置可用模型连接')) : Promise.resolve(localFallback)
  }

  const prompt = `你是耐心的${grade}${item.subject || ''}老师，使用${textbook}教材。请针对下面这道错题，用小学生能听懂的语言给出解题思路（讲解方法以${textbook}${grade}为主；如果这道题本身超纲，就按题目自己的知识层级讲清楚，不要跳过或简化成课内题）。
题目：${item.question || item.title || ''}
知识点：${item.knowledge || '未分类'}
学生的答案：${item.myAnswer || '（未填写）'}
正确答案：${item.correctAnswer || '（未填写）'}
参考错因：${item.analysis || '（未填写）'}

要求：
1. 先讲这道题的解题思路，拆成 2~4 个步骤，每步说明为什么这样做；
2. 再指出学生的答案具体错在哪一步；
3. 最后给一个同类题的提醒；
4. 全部用简体中文输出，不要出现英文句子或英文讲解；
5. 用中文短句，总字数 250 字以内，不要使用 Markdown 表格。`

  return chat([{ role: 'user', content: prompt }], { connection: conn, model: conn.model })
    .then(res => {
      const text = (res.content || '').trim()
      if (!text) throw new Error('模型没有返回解题思路')
      // 少数模型会整段回英文，中文太少就不缓存，避免存下英文思路
      const cn = (text.match(/[\u4e00-\u9fa5]/g) || []).length
      if (cn < 8) throw new Error('模型没有用中文回答')
      return text
    })
    .catch(err => {
      console.warn('[llm] explainQuestion 失败，使用本地思路:', err && err.message)
      if (options.strict) throw err
      return localFallback
    })
}

// 手写判题：识别手写内容并判断对错
const checkHandwriting = (imagePath, question, subject, grade) => {
  const conn = getVisionConnection()
  if (!conn || !conn.key) return Promise.reject(new Error('未配置可用模型连接'))
  const prompt = `你是${grade || '小学'}${subject || ''}老师。题目：${question}
图片是学生的手写作答（可能包含算式、竖式或图形）。请识别图片中的手写内容，判断答案是否正确，并分析学生的解题步骤。
只返回 JSON，不要解释文字，不要用 Markdown 代码块：
{"recognized":"识别到的手写内容","isCorrect":true或false,"correctAnswer":"正确答案","feedback":"一句鼓励的话","explanation":"分步骤解析，并指出学生错在哪一步"}
注意：每个字段的值里不要出现半角双引号，也不要换行；需要引用算式或答案时用中文引号「」。`
  const parse = (text) => {
    const r = parseHandwritingResult(text)
    if (!r) {
      console.warn('[llm] 手写判题返回无法解析:', String(text || '').slice(0, 400))
      // 留一份原始返回，方便在调试器 Storage 里查看 ct_llm_last_raw
      storage.set('ct_llm_last_raw', String(text || '').slice(0, 4000))
      throw new Error(String(text || '').trim()
        ? 'AI 的回答没能看懂，可以再试一次，或在「设置」里换一个图片识别模型'
        : '模型没有返回判题结果（content 为空），请重试或更换图片识别模型')
    }
    if (r.isCorrect === null) {
      console.warn('[llm] 手写判题缺少 isCorrect 字段:', JSON.stringify(r))
      storage.set('ct_llm_last_raw', String(text || '').slice(0, 4000))
      throw new Error('AI 没判断出对错，可以再试一次，或改用文字输入答案')
    }
    return {
      recognized: r.recognized,
      isCorrect: r.isCorrect,
      correctAnswer: r.correctAnswer,
      feedback: r.feedback,
      explanation: r.explanation
    }
  }

  const run = (c) => requestWithImage(c, c.model, prompt, imagePath, 1200).then(parse)

  return run(conn).catch(err => {
    if (!err.visionUnsupported) throw err
    const alt = getFallbackVisionConnection(conn.id)
    if (!alt) throw err
    console.warn('[llm]', conn.name, conn.model, '不支持图片，改用', alt.name, alt.model, '重试')
    return run(alt)
  })
}

// 语音转文字：录音文件上传到支持 ASR 的模型连接（如硅基流动 SenseVoice / OpenAI Whisper）
// 设置里显式指定的优先，否则按名称、模型或域名特征自动挑选，最后退回文本模型
const ASR_MODELS = ['FunAudioLLM/SenseVoiceSmall', 'whisper-1']
const looksLikeASR = (conn) => {
  if (!conn) return false
  const s = ((conn.model || '') + ' ' + (conn.name || '') + ' ' + (conn.baseUrl || '')).toLowerCase()
  return /sensevoice|whisper|asr|audio|speech/.test(s)
}

const getAsrConnection = () => {
  const typed = storage.getRoleConnection('voice')
  if (typed && typed.key) return typed
  const list = storage.getModelConnections().filter(c => c && c.key)
  return list.find(looksLikeASR) || getActiveConnection()
}

const transcribeWith = (conn, model, filePath) => new Promise(resolve => {
  wx.uploadFile({
    url: conn.baseUrl.replace(/\/+$/, '') + '/audio/transcriptions',
    filePath,
    name: 'file',
    header: { 'Authorization': 'Bearer ' + conn.key },
    formData: { model, response_format: 'json', language: 'zh' },
    timeout: 60000,
    success: res => {
      let data = {}
      try { data = JSON.parse(res.data || '{}') } catch (e) {}
      const text = data.text || data.transcript || (data.data && data.data.text) || ''
      if (res.statusCode === 200 && String(text).trim()) {
        resolve({ ok: true, text })
        return
      }
      const msg = (data.error && (data.error.message || data.error.code)) || data.message || ''
      // 402 / 余额不足：同一账户换模型也没用，直接明确提示
      const insufficient = res.statusCode === 402 || /insufficient|balance|余额/i.test(msg)
      // 按住没说话 / 声音太轻：服务端常见「200 但文本为空」或「400 音频为空或太短」，
      // 这不是故障，标成 empty 让调用方提示「没听到内容」而不是弹报错框
      const empty = !insufficient && (res.statusCode === 200 ||
        /empty|silence|no\s*speech|too\s*short|audio\s*(is\s*)?(empty|short|silence)|没有(识别|检测)到|(音频|语音|录音)为空|无语音/i.test(msg))
      console.warn('[llm] 语音识别未成功', conn.name, model, res.statusCode, JSON.stringify(data).slice(0, 300))
      resolve({
        ok: false,
        insufficient,
        empty,
        message: insufficient
          ? '账户余额不足（HTTP 402）'
          : 'HTTP ' + res.statusCode + (msg ? '：' + msg : '')
      })
    },
    fail: err => {
      const msg = (err && err.errMsg) || '网络请求失败'
      console.warn('[llm] 语音识别网络失败', conn.name, model, msg)
      resolve({ ok: false, message: msg.indexOf('url not in domain list') >= 0 ? '域名未加入 uploadFile 白名单' : msg })
    }
  })
})

const transcribeAudio = async (filePath) => {
  if (!filePath) throw new Error('未获取到录音文件')
  const conn = getAsrConnection()
  if (!conn || !conn.key) throw new Error('未配置可用的模型连接，无法进行语音识别')
  const primary = looksLikeASR(conn) && conn.model ? [conn.model] : []
  const models = primary.concat(ASR_MODELS.filter(m => m !== conn.model)).slice(0, 2)
  const errors = []
  for (const model of models) {
    const r = await transcribeWith(conn, model, filePath)
    if (r.ok) return String(r.text).trim()
    if (r.insufficient) {
      throw new Error('语音识别失败：' + conn.name + ' 账户余额不足（HTTP 402）。请登录该服务商充值，或在设置 → 语音模型中换成其他服务商的语音连接。')
    }
    // 音频本身没内容（没说话 / 声音太轻），换模型重试也是一样空，直接按「没听到」返回
    if (r.empty) {
      const e = new Error('没有识别到内容，请再说一遍')
      e.empty = true
      throw e
    }
    errors.push(conn.name + '/' + model + '：' + r.message)
  }
  throw new Error('语音识别失败（' + errors[0] + '）。请在设置 → 语音模型中选择一个支持语音转文字的连接，例如硅基流动：Base URL 填 https://api.siliconflow.cn/v1，模型填 FunAudioLLM/SenseVoiceSmall，并填入对应 API Key。')
}

// 拉取最新模型列表（GET {baseUrl}/models）
// 返回：{ ok: boolean, models: string[], message: string }
const fetchModels = (baseUrl, key) => {
  if (!baseUrl) return Promise.resolve({ ok: false, models: [], message: '未配置 Base URL' })
  return new Promise((resolve) => {
    wx.request({
      url: baseUrl.replace(/\/+$/, '') + '/models',
      method: 'GET',
      header: { 'Authorization': 'Bearer ' + key },
      success: res => {
        if (res.statusCode === 200 && res.data && Array.isArray(res.data.data)) {
          const models = res.data.data.map(m => m.id).filter(Boolean).sort()
          if (models.length) {
            resolve({ ok: true, models, message: '已获取 ' + models.length + ' 个模型' })
          } else {
            resolve({ ok: false, models: [], message: '返回模型列表为空' })
          }
        } else {
          resolve({ ok: false, models: [], message: '获取模型失败（' + res.statusCode + '）' })
        }
      },
      fail: err => {
        const msg = err && err.errMsg ? err.errMsg : '网络请求失败'
        if (msg.indexOf('url not in domain list') >= 0) {
          resolve({ ok: false, models: [], message: '域名不在白名单，请配置 request 合法域名' })
        } else {
          resolve({ ok: false, models: [], message: '请求失败：' + msg })
        }
      }
    })
  })
}

// 测试连接（指定 baseUrl + key + model）
// 返回：{ ok: boolean, message: string }
const testConnection = (baseUrl, key, model) => {
  if (!baseUrl) return Promise.resolve({ ok: false, message: '未配置 Base URL' })
  if (!key) return Promise.resolve({ ok: false, message: '未输入 API Key' })
  model = model || 'sensenova-6.8-flash-lite'
  const url = baseUrl.replace(/\/+$/, '') + '/chat/completions'
  console.log('[llm] testConnection url:', url, 'model:', model)
  return new Promise((resolve) => {
    wx.request({
      url,
      method: 'POST',
      header: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      data: { model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 },
      success: res => {
        if (res.statusCode === 200) {
          resolve({ ok: true, message: '连接成功，Key 有效' })
        } else if (res.statusCode === 401 || res.statusCode === 403) {
          resolve({ ok: false, message: '网络已通，但 API Key 无效（401）' })
        } else if (res.statusCode >= 400 && res.statusCode < 500) {
          resolve({ ok: true, message: '网络已通（' + res.statusCode + '），Key 可能有效' })
        } else {
          resolve({ ok: false, message: '服务器错误（' + res.statusCode + '）' })
        }
      },
      fail: err => {
        const msg = err && err.errMsg ? err.errMsg : '网络请求失败'
        console.error('[llm] testConnection fail:', msg, 'url:', baseUrl)
        if (msg.indexOf('url not in domain list') >= 0) {
          resolve({ ok: false, message: '域名不在白名单，请在公众平台配置 request 合法域名' })
        } else {
          resolve({ ok: false, message: '请求失败：' + msg })
        }
      }
    })
  })
}

module.exports = {
  chat,
  ocrWrongQuestion,
  describeImage,
  extractSessionItems,
  ALL_SUBJECT,
  MAX_LEVEL,
  EXAM_LEVEL,
  gradeLevelQuestions,
  knowledgePool,
  levelScope,
  generateQuestions,
  explainQuestion,
  checkHandwriting,
  transcribeAudio,
  testConnection,
  fetchModels,
  getActiveConnection,
  getDefaultModels,
  buildContext,
  isSlowVisionModel
}
