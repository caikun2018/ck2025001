// utils/config.example.js - 全局配置模板（脱敏）
//
// 用法：复制本文件为 utils/config.js，然后填入你自己的值。
//      utils/config.js 已在 .gitignore 中，不会被提交，避免凭证意外泄漏。
//
// 安全提示（重要）：
//   1. appSecret 等同于知识库的完整读写权，**不要**写死在小程序包里 ——
//      小程序包可被解包还原。留空即可，lexiang.js 会自动改走云函数/代理通道。
//   2. 云函数侧的同名凭证请在「环境变量」中配置（LX_APP_KEY / LX_APP_SECRET / LX_STAFF_ID）。
//   3. 凭证一旦提交到公开仓库就视为已泄露，必须到乐享开放平台重新签发。

// 微信云开发环境 ID（用于乐享 API 代理云函数）
// 开通云环境后，在「云开发控制台 → 环境设置」复制环境 ID 填到此处
const CLOUD_ENV_ID = ''

// 公网代理地址（可选，不填则只用云函数）
// 微信小程序真机无法自定义 User-Agent，乐享 WAF 会拦截移动端 UA，真机需服务端转发。
// 若填写，需在小程序后台把该域名加入 request 合法域名。
const LEXIANG_PROXY_URL = ''

// 乐享开放平台凭证
// appKey / appSecret 在「乐享开放平台 → 我的应用」获取，用于换取 access_token（2 小时有效，代码内自动缓存刷新）
// teamId / spaceId / 各 entryId 是你在乐享知识库里的目录坐标，需自行建好结构后填入
const LEXIANG = {
  appKey: '',
  appSecret: '',            // 建议留空，改由云函数环境变量提供
  teamId: '',
  staffId: '',              // 乐享成员帐号，创建/修改知识节点时作为操作者
  spaceId: '',
  rootEntryId: '',          // 知识库根节点
  // 根级全局
  identityEntryId: '',      // 身份和习惯
  sessionEntryId: '',       // 会话记录文件夹
  // 年级分层：每个年级一个文件夹
  grade4EntryId: '',
  subjects: {
    // 每个学科三项：entryId（学科目录）、memoryId（学习记忆页）、wrongId（错题目录）
    '语文': { entryId: '', memoryId: '', wrongId: '' },
    '数学': { entryId: '', memoryId: '', wrongId: '' },
    '英语': { entryId: '', memoryId: '', wrongId: '' }
  }
}

// LLM 供应商列表
// baseUrl 为 OpenAI 兼容接口的根地址，chat 端点 = baseUrl + '/chat/completions'
// key 由使用方在小程序「设置」页自行录入，不写进仓库
const LLM_PROVIDERS = [
  {
    key: 'sensenova',
    name: '商汤日日新',
    baseUrl: 'https://token.sensenova.cn/v1',
    models: ['sensenova-6.8-flash-lite']
  },
  { key: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-reasoner'] },
  { key: 'qwen', name: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-max', 'qwen-plus', 'qwen-turbo'] },
  { key: 'kimi', name: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1', models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'] },
  { key: 'doubao', name: '豆包', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', models: ['doubao-pro-32k', 'doubao-lite-32k'] },
  { key: 'glm', name: '智谱', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4', 'glm-4-flash', 'glm-3-turbo'] },
  { key: 'hunyuan', name: '腾讯混元', baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1', models: ['hunyuan-lite', 'hunyuan-standard'] },
  { key: 'wenxin', name: '百度文心', baseUrl: 'https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop', models: ['ernie-4.0', 'ernie-3.5'] },
  { key: 'mimo', name: '小米', baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1', models: ['mimo-v1', 'mimo-v1-lite'] },
  { key: 'stepfun', name: '阶跃星辰', baseUrl: 'https://api.stepfun.com/v1', models: ['step-1', 'step-1-flash', 'step-2'] },
  {
    key: 'siliconflow',
    name: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    models: [
      'deepseek-ai/DeepSeek-V3',
      'Qwen/Qwen2.5-72B-Instruct',
      'Qwen/Qwen2-VL-72B-Instruct',
      'FunAudioLLM/SenseVoiceSmall'
    ]
  }
]

// 预设账号：本项目为单人/家庭成员使用，不开放注册
// 建议改成自己的账号；若用于公开部署，请改为服务端校验
const PRESET_ACCOUNTS = [
  { username: '你的账号', password: '你的密码', grade: '四年级' }
]

// 固定的学习参数：写死，不暴露给用户，也不参与云同步
const FIXED = {
  fadeThreshold: 5,    // 同一道错题连续答对 5 次即消退
  challengeCount: 5    // 每关闯关题量
}

// 教材按学科写死：英语用沪教版，其余学科用人教版
const DEFAULT_TEXTBOOK = '人教版'
const TEXTBOOK_BY_SUBJECT = { '英语': '沪教版' }

// 某学科的教材版本；没传学科时按默认人教版
const getTextbook = (subject) => {
  const name = String(subject || '').trim()
  return TEXTBOOK_BY_SUBJECT[name] || DEFAULT_TEXTBOOK
}

// 说明文案：给 AI 的上下文用（不分学科时讲清规则）
const textbookSummary = () => Object.keys(TEXTBOOK_BY_SUBJECT)
  .map(name => name + '用' + TEXTBOOK_BY_SUBJECT[name])
  .concat('其余学科用' + DEFAULT_TEXTBOOK)
  .join('，')

module.exports = {
  CLOUD_ENV_ID,
  LEXIANG_PROXY_URL,
  LEXIANG,
  LLM_PROVIDERS,
  PRESET_ACCOUNTS,
  FIXED,
  DEFAULT_TEXTBOOK,
  TEXTBOOK_BY_SUBJECT,
  getTextbook,
  textbookSummary,
  DEFAULT_FADE_THRESHOLD: FIXED.fadeThreshold,
  DEFAULT_CHALLENGE_COUNT: FIXED.challengeCount
}
