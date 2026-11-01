#!/usr/bin/env node
// tools/lexiang-check.js - 部署自检脚本（不依赖任何第三方库）
//
// 用途：在你把小程序跑起来之前，先在电脑上确认「乐享凭证 + 知识库坐标」是对的。
//       部署失败十有八九卡在这一步，而小程序里的报错信息往往看不出根因。
//
// 用法（在仓库根目录执行，需要已存在 utils/config.js）：
//   node tools/lexiang-check.js                 # 用 utils/config.js 里的配置做全量自检
//   node tools/lexiang-check.js --spaces <团队ID>  # 列出该团队下的知识库，并给出 spaceId + rootEntryId
//   node tools/lexiang-check.js --list          # 列出知识库顶层节点（用于找 rootEntryId）
//   node tools/lexiang-check.js --list <id>     # 列出指定节点下的子节点
//
// 说明：脚本只读，不会创建/修改/删除任何知识库内容；输出里的凭证一律打码。

const https = require('https')
const path = require('path')
const fs = require('fs')

const ROOT = path.resolve(__dirname, '..')
const CONFIG_PATH = path.join(ROOT, 'utils', 'config.js')

const BASE_URL = 'https://lxapi.lexiangla.com/cgi-bin/v1'
const TOKEN_URL = 'https://lxapi.lexiangla.com/cgi-bin/token'
// 乐享 WAF 会拦截移动端 UA，服务端请求需要带一个常规桌面 UA
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const OK = '[ OK ]'
const BAD = '[FAIL]'
const WARN = '[WARN]'

const mask = (s) => {
  const v = String(s || '')
  if (!v) return '(空)'
  if (v.length <= 8) return v.slice(0, 2) + '***'
  return v.slice(0, 4) + '***' + v.slice(-4)
}

const request = (method, url, headers, body) => new Promise((resolve, reject) => {
  const u = new URL(url)
  const req = https.request({
    hostname: u.hostname,
    port: 443,
    path: u.pathname + u.search,
    method,
    headers: Object.assign({ 'User-Agent': UA }, headers, body ? { 'Content-Length': Buffer.byteLength(body) } : {})
  }, res => {
    let text = ''
    res.setEncoding('utf8')
    res.on('data', d => { text += d })
    res.on('end', () => resolve({ status: res.statusCode, text }))
  })
  req.on('error', reject)
  req.setTimeout(20000, () => req.destroy(new Error('请求超时（20s）')))
  if (body) req.write(body)
  req.end()
})

const parse = (text) => {
  try { return JSON.parse(text) } catch (e) { return { _raw: String(text || '').slice(0, 200) } }
}

async function getToken(appKey, appSecret) {
  const res = await request('POST', TOKEN_URL, { 'Content-Type': 'application/json; charset=utf-8' }, JSON.stringify({
    grant_type: 'client_credentials',
    app_key: appKey,
    app_secret: appSecret
  }))
  const data = parse(res.text)
  if (res.status === 200 && data.access_token) return data.access_token
  throw new Error('HTTP ' + res.status + ' ' + JSON.stringify(data).slice(0, 160))
}

async function api(method, p, token, staffId, query) {
  let url = BASE_URL + p
  if (query && Object.keys(query).length) {
    url += '?' + Object.keys(query)
      .filter(k => query[k] !== undefined && query[k] !== null && query[k] !== '')
      .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(query[k]))
      .join('&')
  }
  const res = await request(method, url, {
    'Content-Type': 'application/json; charset=utf-8',
    'Authorization': 'Bearer ' + token,
    'x-staff-id': staffId || ''
  })
  return { status: res.status, data: parse(res.text) }
}

// 列出某节点下的子节点；parentId 为空时列顶层
async function listEntries(token, staffId, spaceId, parentId) {
  const r = await api('GET', '/kb/entries', token, staffId, { space_id: spaceId, parent_id: parentId, page_size: 100 })
  if (r.status !== 200) return { ok: false, status: r.status, items: [], raw: r.data }
  const items = (r.data && r.data.data) || []
  return {
    ok: true,
    items: items.map(it => ({
      id: it.id,
      name: (it.attributes && it.attributes.name) || it.name || '(未命名)',
      type: (it.attributes && it.attributes.entry_type) || it.entry_type || '?'
    }))
  }
}

// 列出某团队下的知识库：连同 root_entry 一起返回，一次拿全 spaceId + rootEntryId
async function listSpaces(token, staffId, teamId) {
  const r = await api('GET', '/kb/spaces', token, staffId, { team_id: teamId })
  if (r.status !== 200) return { ok: false, status: r.status, raw: r.data, items: [] }
  const items = (r.data && r.data.data) || []
  return {
    ok: true,
    items: items.map(it => ({
      id: it.id,
      name: (it.attributes && it.attributes.name) || '(未命名)',
      rootEntryId: (it.relationships && it.relationships.root_entry && it.relationships.root_entry.data && it.relationships.root_entry.data.id) || ''
    }))
  }
}

async function entryExists(token, staffId, spaceId, id) {
  const r = await api('GET', '/kb/entries/' + id, token, staffId, { space_id: spaceId })
  if (r.status === 200) {
    const a = (r.data && r.data.data && r.data.data.attributes) || {}
    return { ok: true, name: a.name || '?', type: a.entry_type || '?' }
  }
  return { ok: false, status: r.status }
}

const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - String(s).length))

async function main() {
  const args = process.argv.slice(2)

  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(BAD + ' 找不到 utils/config.js')
    console.error('        请先执行：cp utils/config.example.js utils/config.js')
    process.exit(1)
  }

  const config = require(CONFIG_PATH)
  const LX = config.LEXIANG || {}
  const { appKey, appSecret, staffId, spaceId, rootEntryId } = LX

  console.log('='.repeat(64))
  console.log(' 错题智练 · 乐享知识库配置自检')
  console.log('='.repeat(64))
  console.log('配置文件 : ' + CONFIG_PATH)
  console.log()

  // ---------- 0. 本地配置形状检查 ----------
  console.log('【0】本地配置')
  const rows = [
    ['appKey', appKey],
    ['appSecret', appSecret],
    ['staffId', staffId],
    ['spaceId', spaceId],
    ['rootEntryId', rootEntryId]
  ]
  for (const [k, v] of rows) {
    console.log('  ' + pad(k, 13) + (v ? OK + ' ' + mask(v) : WARN + ' 未填'))
  }
  console.log('  ' + pad('teamId', 13) + (LX.teamId ? '已填（脚本用它反查 spaceId；小程序运行时并不使用）' : '未填（小程序运行不依赖；填了可用 --spaces 反查 spaceId）'))
  console.log()

  // --spaces 模式只需要凭证 + 团队 ID，不需要 spaceId
  const spacesMode = args[0] === '--spaces'

  const missing = []
  if (!appKey) missing.push('appKey')
  if (!appSecret) missing.push('appSecret')
  if (!spacesMode && !spaceId) missing.push('spaceId')
  if (missing.length) {
    console.error(BAD + ' 缺少必填项：' + missing.join(' / '))
    if (missing.indexOf('spaceId') >= 0) {
      console.error('        不知道 spaceId 时先跑：node tools/lexiang-check.js --spaces <团队ID>')
      console.error('        该命令会直接列出 spaceId 与 rootEntryId，一次性拿全')
    } else {
      console.error('        appKey / appSecret 从「乐享开放平台 → 我的应用」获取，详见 README「部署指南 · 第 3 步」')
    }
    process.exit(1)
  }

  // ---------- 1. 换取 token ----------
  console.log('【1】换取 access_token')
  let token
  try {
    token = await getToken(appKey, appSecret)
    console.log('  ' + OK + ' 成功 ' + mask(token) + '（有效期约 2 小时，脚本内自动缓存）')
  } catch (e) {
    console.error('  ' + BAD + ' 失败：' + e.message)
    console.error('        → appKey / appSecret 不正确，或该应用已被停用/凭证已轮换')
    process.exit(1)
  }
  console.log()

  // ---------- 2. --spaces 模式：由团队 ID 反查知识库 ----------
  if (spacesMode) {
    const teamId = args[1] || LX.teamId || ''
    console.log('【2】列出团队下的知识库')
    if (!teamId) {
      console.error('  ' + BAD + ' 缺少团队 ID')
      console.error('        用法：node tools/lexiang-check.js --spaces <团队ID>')
      console.error('        团队 ID 可先填进 utils/config.js 的 teamId 字段，之后省略参数也能用')
      process.exit(1)
    }
    console.log('  团队 ID：' + teamId)
    const r = await listSpaces(token, staffId, teamId)
    if (!r.ok) {
      console.error('  ' + BAD + ' 列取失败：HTTP ' + r.status + ' ' + JSON.stringify(r.raw).slice(0, 160))
      console.error('        → 团队 ID 不对，或该应用不属于这个团队（部分版本此接口需更高版本，见 README 排错表）')
      process.exit(1)
    }
    if (!r.items.length) {
      console.log('  （该团队下没有可见的知识库）')
      return
    }
    console.log('  共 ' + r.items.length + ' 个知识库：')
    console.log()
    r.items.forEach(it => {
      console.log('    ' + pad(it.name, 20) + 'spaceId     = ' + it.id)
      console.log('    ' + pad('', 20) + 'rootEntryId = ' + (it.rootEntryId || '(接口未返回，用 --list 查)'))
      console.log()
    })
    console.log('  把上面两个值填进 utils/config.js 的 spaceId 与 rootEntryId，然后重跑：')
    console.log('    node tools/lexiang-check.js')
    return
  }

  // ---------- 3. --list 模式：只列节点 ----------
  if (args[0] === '--list') {
    const parent = args[1] || ''
    console.log('【2】列出' + (parent ? '节点 ' + parent + ' 下' : '顶层') + '的子节点')
    if (!staffId) console.log('  ' + WARN + ' staffId 未填，部分帐号下可能列不出内容')
    const r = await listEntries(token, staffId, spaceId, parent)
    if (!r.ok) {
      console.error('  ' + BAD + ' 列取失败：HTTP ' + r.status + ' ' + JSON.stringify(r.raw).slice(0, 160))
      console.error('        → 大概率是 spaceId 不对，或该应用没有这个知识库的权限')
      process.exit(1)
    }
    if (!r.items.length) {
      console.log('  （空，该节点下没有子节点）')
    } else {
      console.log('  共 ' + r.items.length + ' 项：')
      r.items.forEach(it => {
        console.log('    ' + pad(it.type, 7) + pad(it.name, 24) + it.id)
      })
      console.log()
      console.log('  把需要的 id 填进 utils/config.js 对应字段即可。')
    }
    return
  }

  // ---------- 3. 校验 rootEntryId ----------
  console.log('【2】校验 rootEntryId')
  if (!rootEntryId) {
    console.log('  ' + WARN + ' 未填 rootEntryId')
    console.log('        → 先跑一次 node tools/lexiang-check.js --list 列出顶层节点，找到知识库根节点后填入')
  } else {
    const r = await entryExists(token, staffId, spaceId, rootEntryId)
    if (r.ok) {
      console.log('  ' + OK + ' 存在：' + r.name + '（' + r.type + '）')
    } else {
      console.log('  ' + BAD + ' 不存在或无权访问（HTTP ' + r.status + '）')
      console.log('        → 检查 rootEntryId 是否抄错，或该应用未加入这个知识库')
    }
  }
  console.log()

  // ---------- 4. 校验其余已填的 entryId ----------
  console.log('【3】校验其它已填的 entryId')
  const named = []
  if (LX.rootEntryId) named.push(['rootEntryId', LX.rootEntryId])
  if (LX.identityEntryId) named.push(['identityEntryId', LX.identityEntryId])
  if (LX.sessionEntryId) named.push(['sessionEntryId', LX.sessionEntryId])
  if (LX.grade4EntryId) named.push(['grade4EntryId', LX.grade4EntryId])
  Object.keys(LX.subjects || {}).forEach(s => {
    const it = LX.subjects[s] || {}
    if (it.entryId) named.push(['subjects.' + s + '.entryId', it.entryId])
    if (it.wrongId) named.push(['subjects.' + s + '.wrongId', it.wrongId])
    if (it.memoryId) named.push(['subjects.' + s + '.memoryId', it.memoryId])
  })

  const skipped = ['rootEntryId']
  let bad = 0
  if (!named.length) {
    console.log('  （除 rootEntryId 外未填任何 entryId）')
  } else {
    for (const [label, id] of named) {
      if (skipped.indexOf(label) >= 0) continue
      const r = await entryExists(token, staffId, spaceId, id)
      if (r.ok) {
        console.log('  ' + pad(label, 26) + OK + ' ' + r.name)
      } else {
        bad++
        console.log('  ' + pad(label, 26) + BAD + ' HTTP ' + r.status + '（节点不存在或无权访问）')
      }
    }
  }
  console.log()

  // ---------- 5. 目录结构建议 ----------
  console.log('【4】目录结构检查')
  console.log('  说明：学科目录（错题 / 学习记忆 / 题库）**不需要手工创建**，')
  console.log('        小程序首次归档时会自动在你填的年级目录下建好。')
  console.log('        但「年级」目录本身要先存在（四年级也可直接用 grade4EntryId 指定）。')
  console.log()
  if (rootEntryId) {
    const r = await listEntries(token, staffId, spaceId, rootEntryId)
    if (r.ok) {
      const folders = r.items.filter(it => it.type === 'folder')
      console.log('  根节点下现有 ' + r.items.length + ' 项，其中文件夹：' +
        (folders.length ? folders.map(f => f.name).join('、') : '无'))
      const grades = folders.filter(f => /年级/.test(f.name))
      if (grades.length) {
        console.log('  ' + OK + ' 找到年级目录：' + grades.map(g => g.name + '(' + g.id + ')').join('、'))
      } else {
        console.log('  ' + WARN + ' 根节点下没有名字带「年级」的文件夹，请先在乐享里建一个，或在 config.js 填 grade4EntryId')
      }
    }
  } else {
    console.log('  ' + WARN + ' 未填 rootEntryId，跳过结构检查')
  }
  console.log()

  // ---------- 6. 代理通道提示 ----------
  console.log('【5】代理通道')
  const cloudEnv = config.CLOUD_ENV_ID
  const proxyUrl = config.LEXIANG_PROXY_URL
  const proxyKey = config.LEXIANG_PROXY_KEY
  if (cloudEnv) console.log('  ' + OK + ' 微信云开发环境：' + mask(cloudEnv) + '（需已部署云函数 lexiang-proxy）')
  else console.log('  ' + WARN + ' CLOUD_ENV_ID 未填（不用微信云函数可忽略）')
  if (proxyUrl) {
    console.log('  ' + OK + ' 公网代理：' + proxyUrl)
    console.log('       ' + (proxyKey ? OK + ' 已配 LEXIANG_PROXY_KEY，与服务端一致才通' : BAD + ' 未配 LEXIANG_PROXY_KEY，服务端会拒绝所有请求'))
  } else {
    console.log('  ' + WARN + ' LEXIANG_PROXY_URL 未填（不用 SCF / Worker 可忽略）')
  }
  if (!cloudEnv && !proxyUrl) {
    console.log('  ' + BAD + ' 两条通道都没配：真机上一定跑不通（开发者工具可直连，真机不行）')
  }
  console.log()

  // ---------- 结论 ----------
  console.log('='.repeat(64))
  if (missing.length || bad) {
    console.log(' 结论：仍有 ' + bad + ' 个 entryId 不可用，按上面的 FAIL 项修正后重跑')
    process.exitCode = 1
  } else {
    console.log(' 结论：凭证与知识库坐标全部可用，可以导入开发者工具了')
  }
  console.log('='.repeat(64))
}

main().catch(e => {
  console.error(BAD + ' 脚本异常：' + (e && e.message))
  process.exit(1)
})
