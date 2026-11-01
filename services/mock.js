// services/mock.js - 模拟数据（用于离线演示，真实接入时替换为 lexiang/llm 服务）
const util = require('../utils/util.js')

// 模拟错题本数据
const mockWrongbook = () => {
  return [
    {
      id: 'w001',
      subject: '数学',
      knowledge: '一元二次方程',
      title: '解方程 x² - 5x + 6 = 0',
      question: '解方程：x² - 5x + 6 = 0',
      myAnswer: 'x = 1, x = 6',
      correctAnswer: 'x = 2, x = 3',
      analysis: '因式分解错误，应为 (x-2)(x-3)=0',
      difficulty: '基础',
      source: '拍照',
      status: '在册',
      correctCount: 3,
      createdAt: '2026-10-20 09:30:15',
      records: [
        { date: '2026-10-20', correct: false },
        { date: '2026-10-21', correct: true },
        { date: '2026-10-22', correct: true },
        { date: '2026-10-23', correct: true }
      ]
    },
    {
      id: 'w002',
      subject: '数学',
      knowledge: '分数应用题',
      title: '工程问题',
      question: '一项工程，甲单独做需12天，乙单独做需18天，两人合作几天完成？',
      myAnswer: '15天',
      correctAnswer: '7.2天',
      analysis: '合作效率 = 1/12 + 1/18 = 5/36，时间 = 36/5 = 7.2天',
      difficulty: '中档',
      source: '闯关',
      status: '在册',
      correctCount: 1,
      createdAt: '2026-10-22 14:20:00',
      records: [
        { date: '2026-10-22', correct: false },
        { date: '2026-10-23', correct: true }
      ]
    },
    {
      id: 'w003',
      subject: '语文',
      knowledge: '古诗词默写',
      title: '《静夜思》默写',
      question: '默写李白《静夜思》',
      myAnswer: '床前明月光，疑是地上霜。举头望明月，低头思故乡。',
      correctAnswer: '床前明月光，疑是地上霜。举头望明月，低头思故乡。',
      analysis: '本题实际答对，因书写潦草被误判，已纠正。',
      difficulty: '基础',
      source: '拍照',
      status: '在册',
      correctCount: 5,
      createdAt: '2026-10-18 10:00:00',
      records: [
        { date: '2026-10-18', correct: false },
        { date: '2026-10-19', correct: true },
        { date: '2026-10-20', correct: true },
        { date: '2026-10-21', correct: true },
        { date: '2026-10-22', correct: true },
        { date: '2026-10-23', correct: true }
      ]
    },
    {
      id: 'w004',
      subject: '英语',
      knowledge: '一般现在时',
      title: '动词第三人称单数',
      question: 'She ___ (go) to school every day.',
      myAnswer: 'go',
      correctAnswer: 'goes',
      analysis: '主语为第三人称单数，动词需加-es',
      difficulty: '基础',
      source: '拍照',
      status: '在册',
      correctCount: 0,
      createdAt: '2026-10-23 16:45:00',
      records: [
        { date: '2026-10-23', correct: false }
      ]
    }
  ]
}

// 模拟 AI 出题（举一反三）
const mockGenerateQuestions = (subject, count = 10, grade = '四年级') => {
  const templates = {
    '数学': [
      { q: '计算：25 × 4 + 36 ÷ 6 = ?', a: '106', exp: '先乘除后加减：25×4=100，36÷6=6，100+6=106', k: '四则混合运算' },
      { q: '一个长方形长 8cm，宽 5cm，周长是多少？', a: '26cm', exp: '周长 = (长+宽)×2 = (8+5)×2 = 26cm', k: '长方形的周长', figure: { type: 'rectangle', labels: { top: '8cm', bottom: '8cm', left: '5cm', right: '5cm' } } },
      { q: '小明有 36 颗糖，平均分给 6 个小朋友，每人几颗？', a: '6颗', exp: '36 ÷ 6 = 6', k: '平均分除法' },
      { q: '分数比较：3/4 和 5/6 哪个大？', a: '5/6', exp: '通分：3/4=9/12，5/6=10/12，所以 5/6 大', k: '分数大小比较' },
      { q: '一件衣服原价 200 元，打八折后多少元？', a: '160元', exp: '200 × 0.8 = 160', k: '折扣问题' },
      { q: '一个数的 3/4 是 24，这个数是多少？', a: '32', exp: '24 ÷ 3/4 = 24 × 4/3 = 32', k: '分数除法' },
      { q: '圆的半径是 5cm，面积是多少？（π取3.14）', a: '78.5cm²', exp: 'S = πr² = 3.14 × 25 = 78.5', k: '圆的面积', figure: { type: 'circle', labels: { radius: '5cm' } } },
      { q: '三角形中两个角分别是 60° 和 70°，第三个角是多少度？', a: '50°', exp: '三角形内角和 180°，180°-60°-70°=50°', k: '三角形内角和', figure: { type: 'triangle', labels: ['60°', '?', '70°'] } },
      { q: '如图，∠1 = 35°，∠1 与 ∠2 组成直角，∠2 是多少度？', a: '55°', exp: '直角是 90°，∠2 = 90° - 35° = 55°', k: '角的度量', figure: { type: 'angle', label: '∠1=35°' } },
      { q: '一个平行四边形底 12cm，高 5cm，面积是多少？', a: '60cm²', exp: '平行四边形面积 = 底 × 高 = 12 × 5 = 60', k: '平行四边形的面积', figure: { type: 'parallelogram', labels: ['12cm', '12cm', '5cm', '5cm'] } },
      { q: '一个正方形边长 6cm，面积是多少？', a: '36cm²', exp: '正方形面积 = 边长 × 边长 = 6 × 6 = 36', k: '正方形的面积', figure: { type: 'square', labels: { top: '6cm', bottom: '6cm', left: '6cm', right: '6cm' } } },
      { q: '一个数除以 8 商 12 余 5，这个数是多少？', a: '101', exp: '8×12+5 = 101', k: '有余数的除法' }
    ],
    '语文': [
      { q: '"春眠不觉晓"的下一句是？', a: '处处闻啼鸟', exp: '出自孟浩然《春晓》', k: '古诗默写' },
      { q: '"欲穷千里目，更上一层楼"出自哪首诗？', a: '《登鹳雀楼》', exp: '王之涣《登鹳雀楼》', k: '古诗作者' },
      { q: '填写反义词：谦虚——（  ）', a: '骄傲', exp: '谦虚的反义词是骄傲', k: '反义词' },
      { q: '"画蛇添足"这个成语告诉我们什么道理？', a: '多此一举反而坏事', exp: '比喻做了多余的事，非但无益，反而不合适', k: '成语理解' },
      { q: '下列哪个字是多音字？A. 山 B. 长 C. 水', a: 'B. 长', exp: '长：cháng（长短）/ zhǎng（长大）', k: '多音字' },
      { q: '"飞流直下三千尺"运用了什么修辞手法？', a: '夸张', exp: '三千尺是夸张手法', k: '修辞手法' },
      { q: '改病句：我估计他这道题一定做错了。', a: '去掉"一定"或"估计"', exp: '估计和一定矛盾', k: '修改病句' },
      { q: '"亡羊补牢"中"亡"的意思是？', a: '丢失', exp: '亡：丢失；牢：羊圈', k: '文言字词' },
      { q: '《西游记》的作者是？', a: '吴承恩', exp: '明代小说家吴承恩', k: '文学常识' },
      { q: '用"终于"造句：', a: '经过努力，我终于学会了骑自行车。', exp: '终于表示经过较长过程最后出现某种结果', k: '词语造句' }
    ],
    '英语': [
      { q: '选择：I ___ a student. A. am B. is C. are', a: 'A. am', exp: 'I 用 am', k: 'be动词' },
      { q: '翻译：我喜欢苹果。', a: 'I like apples.', exp: '喜欢 like，苹果 apple 用复数', k: '句型翻译' },
      { q: '填空：There ___ a book on the desk.', a: 'is', exp: 'a book 是单数，用 is', k: 'There be句型' },
      { q: '复数形式：child → ___', a: 'children', exp: '不规则变化', k: '名词复数' },
      { q: '选择：She ___ to school by bus. A. go B. goes C. going', a: 'B. goes', exp: '第三人称单数', k: '一般现在时' },
      { q: '翻译：早上好。', a: 'Good morning.', exp: '固定问候语', k: '日常问候' },
      { q: '填空：What ___ you doing?', a: 'are', exp: '现在进行时，you 用 are', k: '现在进行时' },
      { q: '选择：How many ___ are there? A. boy B. boys C. boies', a: 'B. boys', exp: 'many 后接复数', k: '可数名词复数' },
      { q: '翻译：这是我的书。', a: 'This is my book.', exp: 'This is... 句型', k: '指示代词' },
      { q: '填空：I have ___ apple. (a/an)', a: 'an', exp: 'apple 以元音开头，用 an', k: '冠词' }
    ]
  }
  const pool = templates[subject] || templates['数学']
  const defaultKnowledge = subject === '语文' ? '语文基础' : subject === '英语' ? '英语基础' : '综合计算'
  // 随机取 count 道
  const shuffled = [...pool].sort(() => Math.random() - 0.5)
  return shuffled.slice(0, count).map((item, idx) => ({
    id: 'q' + idx,
    question: item.q,
    answer: item.a,
    explanation: item.exp,
    knowledge: item.k || defaultKnowledge,
    figure: item.figure || null,
    type: 'short',
    options: []
  }))
}

// 模拟 AI 对话回复
const mockChatReply = (msg) => {
  const replies = [
    '这道题的关键是先理解题意，找出已知条件和问题。',
    '我们可以换个角度思考：从结果倒推回去。',
    '这是一个典型的题型，记住解题步骤很重要哦！',
    '让我来帮你分析一下：第一步审题，第二步找关系，第三步列式计算。',
    '别急，我们一步一步来。你先说说你是怎么想的？',
    '你已经掌握了大部分，只差最后一步啦！加油！'
  ]
  return replies[Math.floor(Math.random() * replies.length)]
}

// 模拟 OCR 整理错题
const mockOCRResult = () => ({
  subject: '数学',
  knowledge: '一元二次方程',
  title: '解方程 x² - 5x + 6 = 0',
  question: '解方程：x² - 5x + 6 = 0',
  myAnswer: 'x = 1, x = 6',
  correctAnswer: 'x = 2, x = 3',
  analysis: '因式分解错误，应为 (x-2)(x-3)=0，所以 x=2 或 x=3',
  difficulty: '基础'
})

// 模拟学习记忆
const mockMemory = (subject) => ({
  subject,
  weakPoints: subject === '数学' ? ['一元二次方程判别式应用', '辅助线作法'] : ['待总结'],
  masteredPoints: subject === '数学' ? ['整式运算', '小数乘除法'] : ['待总结'],
  commonErrors: ['审题漏条件', '符号错误'],
  preference: '多出中档应用题',
  updatedAt: util.formatTime(new Date())
})

module.exports = {
  mockWrongbook,
  mockGenerateQuestions,
  mockChatReply,
  mockOCRResult,
  mockMemory
}
