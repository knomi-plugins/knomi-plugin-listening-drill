// ============================================================
// listening-drill - 英语精听 v2（托福雅思教学视角重设计，2026-09-26）
// 管什么：英文材料 → sys-hub「英语精听/」落盘 + 会话元数据登记（plugin_kv session）→
//         start_practice 就地逐句听写（句题为会话内即时投影，不入题库）→
//         错词（practice_attempts 权威流水重建）归因成卡（选择填空入题库，SM-2 复习）；
//         难度标尺（本地 1 万高频词覆盖，i+1 选材参考）+ 逐句中译（ctx.llm，异步补全 fail-open）。
// 教学主线（PRD 2026-09-23 + v2 计划）：可理解输入 i+1 → 盲听逐句精听（多遍/慢速）→
//         对照文本精准纠错 → 错词归因成卡 → SM-2 复习。句子是「过程」，错词卡与材料文档是「资产」
//         ——听写句不再进题库/复习队列（v0.1.0 曾逐句 insertQuestion，复习队列被句子淹没，用户反馈「错乱」）。
// 不管什么：听写判分与渲染（core/knowledge/question-types + QuestionCard 权威）；
//          SM-2 调度/到期触达/统计（宿主 practice / study-reminder / study-analytics）；
//          TTS 播放（主窗 voice-player 单例，本插件零播放器代码；英文音色由平台按文本语言自动选）。
// 数据契约：错词卡走 ADR-102（sourceSnippet=原句，禁幻觉）；错词重建读 practice_attempts
//          （文档锚点权威流水，response_text 作答快照）；会话元数据落 plugin_kv（sentences 内嵌，
//          句题即时投影 id=ld-<docId8>-<序号>，题库轨因无库行自然跳过）。
// 被谁调用：nav.entry 页（plugin:invoke：pageDictation/startListeningSession/generateMaterial/
//          startDictationPractice/openMaterialDoc/makeWordCardNoHeard/makeWordCardUnknown/
//          makeWordCard/useDocMaterial）、Agent 工具（start_listening_drill/make_word_card/generate_material）。
// ============================================================

const path = require('path')

const PLUGIN_ID = 'listening-drill'
const DICTATION_TYPE = 'dictation'
const GENERATOR_DICTATION = '精听听写'
const GENERATOR_WORD_CARD = '错词填空'
const MAX_SENTENCES = 20
const MAX_TEXT_CHARS = 20000
const SESSION_NS = 'session'
const MAX_SESSIONS = 30
/** 会话内即时句题 id 前缀（无库行 → recordAttempt 题库轨自动跳过，只记文档轨流水） */
const SENT_PREFIX = 'ld-'
const ATTRIBUTIONS = [
  { value: '听不出', label: '听不出（音系解码）' },
  { value: '不认识', label: '不认识（词汇缺口）' },
  { value: '拼错', label: '认识但拼错（正字法）' },
]

let ctx = null
/** 最近一次 listSessions 隔离的垃圾会话数（页面如实告知用） */
let quarantinedLastRun = 0

// ============================================================
// 纯函数（无 ctx 依赖，供单测；导出即测试面）
// ============================================================

/** 听写分词。与 core/knowledge/question-types.ts tokenizeSentence 同规则——
 *  插件无法 require core TS（运行时无编译产物），改任一侧必须同步另一侧；
 *  tests/question-types-dictation.test.ts 固化两侧一致性用例（TODO:REFACTOR core 下沉 CJS 后合并） */
function tokenizeForDiff(s) {
  return String(s || '')
    .split(/\s+/)
    .map((t) => t.toLowerCase().replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, ''))
    .filter(Boolean)
}

/** 英文切句 v3（库内选材垃圾句实证修复）：先剥知识文档结构——YAML frontmatter 整块、
 *  HTML 注释、代码围栏、表格行、wikilink/链接/图片/行内标记——再折行切句；句子级英文密度
 *  过滤（纯拉丁词 ≥2 且占比 ≥0.6）：YAML 键名行被整块剥除，中文句 token 消融后自然出局 */
function splitEnglishSentences(text) {
  if (!text || String(text).length > MAX_TEXT_CHARS) return []
  const raw = String(text)
    .replace(/\r\n?/g, '\n')
    .replace(/^---\n[\s\S]*?\n---/, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^\s*\|.*$/gm, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g, (_m, a, b) => b || a)
    .replace(/^#{1,6}\s+.*$/gm, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/[ \t]*\n[ \t]*/g, ' ')
    .replace(/[*_`~]/g, '')
    // CJK 串当句界分隔符：听写句必须是纯英文——黏连段（如 wikilink 中文名+英文正文）在此拆开，
    // 纯中文片段切出后无 token 自然出局（tokenizeForDiff 对 CJK 消融，词级过滤看不见中文）
    .replace(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g, '. ')
    .trim()
  if (!raw) return []
  const eDot = '\u0001'
  const guarded = raw
    .replace(/\b(Mr|Mrs|Ms|Dr|Prof|St|Sr|Jr|vs|etc|approx)\./gi, (m) => m.replace(/\./g, eDot))
    .replace(/\b(e\.g|i\.e)\./gi, (m) => m.replace(/\./g, eDot))
  const parts = guarded.match(/[^.!?]+[.!?]+["')\]]*|\S[^.!?]*$/g) || []
  const isEnglishSentence = (s) => {
    const tokens = tokenizeForDiff(s)
    if (tokens.length < 2) return false
    const latinWords = tokens.filter((t) => /^[a-z][a-z']*$/.test(t)).length
    if (latinWords < 2) return false
    // 占比口径含数字 token（"e.g. 42 and 7" 这类数字句是正常英文）；中文已被句界替换消融
    const clean = tokens.filter((t) => /^[a-z0-9']+$/.test(t)).length
    return clean / tokens.length >= 0.6
  }
  return parts
    .map((s) => s.replace(new RegExp(eDot, 'g'), '.').replace(/^[,;:、。！？；：\s]+/, '').trim())
    .filter(isEnglishSentence)
    .slice(0, MAX_SENTENCES)
}

/** 错词提取（词集差，无需对齐）：原句有、作答无的词，去重保序。
 *  精确到词位的三色反馈在作答时已由 core 呈现；此处供错词清单回流。 */
function extractWrongWords(answer, response) {
  const got = new Set(tokenizeForDiff(response))
  const seen = new Set()
  const out = []
  for (const w of tokenizeForDiff(answer)) {
    if (!got.has(w) && !seen.has(w)) {
      seen.add(w)
      out.push(w)
    }
  }
  return out
}

/** 挖空题干（题式规范 v2：题干=挖空原句，无题型前缀） */
function clozeSentenceOf(sentence, word) {
  const esc = String(word).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (new RegExp(`\\b${esc}\\b`, 'i').test(sentence)) return sentence.replace(new RegExp(`\\b${esc}\\b`, 'i'), '______')
  return sentence.replace(new RegExp(esc, 'i'), '______')
}

/** 干扰项：同句其他词优先，不足从他句补齐；凑不满 3 个返回 null（材料过短不成卡） */
function pickDistractors(sentence, word, allSentences) {
  const target = String(word).toLowerCase()
  const pool = []
  const push = (s) => {
    for (const t of tokenizeForDiff(s)) {
      if (t !== target && !pool.includes(t)) pool.push(t)
    }
  }
  push(sentence)
  for (const s of allSentences || []) {
    if (pool.length >= 8) break
    push(s)
  }
  return pool.slice(0, 3).length >= 3 ? pool.slice(0, 3) : null
}

/** 选择填空卡部件（选项含正确词，位置随机——题式规范：正确答案不集中同一位置） */
function buildClozeCard(sentence, word, allSentences) {
  const distractors = pickDistractors(sentence, word, allSentences)
  if (!distractors) return null
  const options = [word, ...distractors]
  for (let i = options.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[options[i], options[j]] = [options[j], options[i]]
  }
  return { question: clozeSentenceOf(sentence, word), options, answer: word }
}

/** 安全文件名（路径分隔符/非法字符 → -） */
function safeFileName(name) {
  return String(name || '').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 60) || '精听材料'
}

/** 旧版切句器污染检测（纯函数，自愈判据）：听写句必须纯英文，句中含 CJK 的句子占比 ≥50%
 *  → 该会话是元数据碎片（v0.1.0/v0.2.0 把中文文档 frontmatter 切成了句子，实证：量化交易等
 *  三个会话全是 taxonomy 键名行）。空句子数组同样判无效。以多数原则保护含个别 CJK 的正常英文会话 */
function contaminatedSession(session) {
  const sentences = Array.isArray(session && session.sentences) ? session.sentences : []
  if (sentences.length === 0) return true
  const cjk = sentences.filter((s) => /[一-鿿぀-ヿ가-힯]/.test(String(s))).length
  return cjk / sentences.length >= 0.5
}

/** 会话内即时句题 id（稳定：同会话同句序不变，挂起-恢复/进度缓存按此为键） */
function sentenceIdOf(docId, n) {
  return `${SENT_PREFIX}${String(docId || '').slice(0, 8)}-${n}`
}

/** 从句题 id 解析句序（错词回流定位句号；非句题 id 返回 0） */
function parseSentenceNo(snapId) {
  const m = /-(\d+)$/.exec(String(snapId || ''))
  return m ? Number(m[1]) : 0
}

// ============================================================
// 难度标尺（F5）：本地 1 万高频词覆盖（i+1 选材参考，粗粒度）
// 词表：data/wordlist-10k.txt（google-10000-english，Google 万亿词料频序前 1 万词；
// 纯词序事实数据无创意附加内容；COCA 20k 候选源无 LICENSE 弃用，换源只需替换此文件）
// ============================================================

let wordRankCache = null

/** 词表加载（插件目录相对读取，沙箱 require 白名单内；文件缺失/为空 → 标尺禁用） */
function loadWordRank() {
  if (wordRankCache !== null) return wordRankCache
  try {
    const fs = require('fs')
    const lines = fs.readFileSync(path.join(__dirname, 'data', 'wordlist-10k.txt'), 'utf8').split(/\r?\n/)
    const rank = new Map()
    let r = 0
    for (const line of lines) {
      const w = line.trim().toLowerCase()
      if (!w || w.startsWith('#')) continue
      r += 1
      if (!rank.has(w)) rank.set(w, r)
    }
    wordRankCache = rank.size > 0 ? rank : null
  } catch {
    wordRankCache = null
  }
  return wordRankCache
}

/** 覆盖率分析（纯函数，rankOf 注入供单测）：按词例计的 top-N 覆盖 + 超纲词样例（去重保序）。
 *  阈值 0.93：覆盖 93% 以上判定「适合精听」（可理解输入 i+1 的粗粒度下界），否则「偏难」 */
function analyzeCoverage(sentences, rankOf, topN) {
  const N = topN || 10000
  let total = 0
  let matched = 0
  const outOfList = []
  const seen = new Set()
  for (const s of sentences || []) {
    for (const t of tokenizeForDiff(s)) {
      total += 1
      const r = rankOf(t)
      if (r && r <= N) matched += 1
      else if (!seen.has(t)) {
        seen.add(t)
        outOfList.push(t)
      }
    }
  }
  const coverage = total > 0 ? matched / total : 0
  return {
    total,
    matched,
    coverage,
    coveragePct: Math.round(coverage * 100),
    outOfList: outOfList.slice(0, 8),
    outOfListCount: outOfList.length,
    label: total === 0 ? '无有效文本' : coverage >= 0.93 ? '适合精听' : '偏难',
  }
}

function formatDifficultyNote(d) {
  if (!d || d.total === 0) return ''
  const rare = d.outOfList.length > 0 ? `，超纲词 ${d.outOfListCount}（如 ${d.outOfList.slice(0, 4).join('、')}）` : ''
  return `难度标尺：${d.label}（1 万高频词覆盖 ${d.coveragePct}%${rare}）`
}

// ============================================================
// 逐句中译（双语态；ctx.llm fail-open——未配置/失败/行数不符一律跳过，不阻塞建会话）
// ============================================================

/** 解析中译载荷（纯函数）：接受 ["…"] 或 {"t":["…"]}，行数必须严格相等且无空译 */
function parseTranslationPayload(text, expected) {
  try {
    const raw = String(text || '').replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
    const v = JSON.parse(raw)
    const arr = Array.isArray(v) ? v : Array.isArray(v && v.t) ? v.t : null
    if (!arr || arr.length !== expected) return null
    const out = arr.map((x) => String(x || '').trim())
    return out.every((x) => x) ? out : null
  } catch {
    return null
  }
}

async function translateSentences(sentences) {
  if (!ctx || !ctx.llm || typeof ctx.llm.complete !== 'function') return null
  const numbered = sentences.map((s, i) => `${i + 1}. ${s}`).join('\n')
  try {
    const out = String(await ctx.llm.complete({
      messages: [
        { role: 'system', content: '你是英译中翻译器。逐句翻译为自然、地道的简体中文；不解释、不合并、不增删句子。' },
        { role: 'user', content: `把下面 ${sentences.length} 行英文各翻译成一句中文。只输出 JSON：{"t":["第1句译文", ...]}，数组长度必须等于 ${sentences.length}。\n\n${numbered}` },
      ],
      json: true,
      temperature: 0.2,
      maxTokens: Math.min(4000, sentences.length * 80 + 200),
      timeoutMs: 60000,
    })).trim()
    return parseTranslationPayload(out, sentences.length)
  } catch {
    return null
  }
}

// ============================================================
// 材料来源扩展（M4 + v2 考试档位）：库内直取（A）+ AI 分级生成（B，标尺回环校准）
// ============================================================

/** AI 生成档位（纯数据）：日常三档（CEFR 阶梯）+ 考试实战四档（雅思/托福题型风格）。
 *  countSpec 传给 LLM 的句数规格；target 为标尺回环校准靶心（万词覆盖率）；defaultTopic 供话题缺省 */
const GENERATION_LEVELS = [
  { value: '入门', group: '日常', label: '入门（CEFR A2 · 最高频词汇简单句）', target: 0.97, countSpec: '恰好 5 句', spec: 'CEFR A2 水平：只用最高频词汇与简单句式（一般现在时/一般过去时），单句 8-12 词' },
  { value: '进阶', group: '日常', label: '进阶（CEFR B1 · 常用词为主含从句）', target: 0.93, countSpec: '恰好 5 句', spec: 'CEFR B1 水平：常用词汇为主，可含从句，单句 10-16 词' },
  { value: '挑战', group: '日常', label: '挑战（CEFR C1 · 可含低频与复杂句）', target: 0.88, countSpec: '恰好 5 句', spec: 'CEFR C1 水平：可用低频词与复杂句式，但保持自然地道，单句 12-20 词' },
  {
    value: '雅思·生存对话', group: '考试', target: 0.93, countSpec: '6 到 8 句',
    label: '雅思 Section 1 风格（B1 · 生活场景，含数字信息）',
    spec: 'IELTS Listening Section 1 风格：日常生存场景（咨询/预订/报名）的独白或往来对话，口语自然，含具体信息（时间/价格/地点等数字细节），单句 10-16 词',
    defaultTopic: '在图书馆办理借书卡',
  },
  {
    value: '雅思·学术讨论', group: '考试', target: 0.90, countSpec: '8 到 10 句',
    label: '雅思 Section 4 风格（B2-C1 · 学术讲座片段）',
    spec: 'IELTS Listening Section 4 风格：学术讲座片段，主题式展开，含举例与转折（however / in contrast / for instance），单句 12-20 词',
    defaultTopic: '城市热岛效应',
  },
  {
    value: '托福·校园对话', group: '考试', target: 0.92, countSpec: '7 到 9 句',
    label: 'TOEFL Campus Conversation（B2 · 校园事务）',
    spec: 'TOEFL Listening campus conversation 风格：学生与教职员之间的往来对话（提出问题→给建议→确定行动），口语自然带语气词，单句 10-18 词',
    defaultTopic: '申请转专业',
  },
  {
    value: '托福·学术讲座', group: '考试', target: 0.90, countSpec: '8 到 10 句',
    label: 'TOEFL Lecture（B2-C1 · 大学课堂节选）',
    spec: 'TOEFL Listening lecture 风格：大学教授课堂节选，含定义-举例-设问结构（Now, / So why does this matter? / Let us take an example），单句 12-22 词',
    defaultTopic: '沙漠植物的水分策略',
  },
]

/** 档位 → 目标覆盖率（纯函数；未知档位按「进阶」兜底） */
function targetCoverageFor(level) {
  const hit = GENERATION_LEVELS.find((l) => l.value === level)
  return hit ? hit.target : 0.93
}

/** 标尺校准判定（纯函数）：未达靶心 → 给出带超纲词的重试提示；达标 → 通过 */
function retryHintFor(difficulty, target) {
  if (!difficulty || difficulty.total === 0 || difficulty.coverage >= target) return null
  const rare = difficulty.outOfList.slice(0, 8).join(', ')
  return `改写降低词汇难度：这些词超出目标常用范围，请换成更常用的表达——${rare || '（整体用词偏难）'}。句子数与话题保持不变。`
}

/** 单次生成（fail-open 由调用方兜）：返回原文文本或 null */
async function llmGeneratePassage(level, topic, retryHint) {
  if (!ctx || !ctx.llm || typeof ctx.llm.complete !== 'function') return null
  const lv = GENERATION_LEVELS.find((l) => l.value === level) || GENERATION_LEVELS[1]
  const theme = String(topic || '').trim() || lv.defaultTopic || '一个日常且有趣的话题（如科技/自然/职场/旅行）'
  const messages = [
    { role: 'system', content: '你是英语分级听力材料作者。只写符合难度规格的自然英文，不解释、不翻译。' },
    {
      role: 'user',
      content: `写一段英文听力短文：${lv.countSpec}、围绕同一话题（${theme}）、难度与风格规格：${lv.spec}。句与句之间用空格分隔，不要列表/标题。只输出 JSON：{"text":"..."}`,
    },
  ]
  if (retryHint) messages.push({ role: 'user', content: retryHint })
  try {
    const out = String(await ctx.llm.complete({
      messages,
      json: true,
      temperature: 0.7,
      maxTokens: 1200,
      timeoutMs: 60000,
    })).trim()
    const v = JSON.parse(out.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim())
    const text = String((v && (v.text ?? v.passage)) || '').trim()
    return text || null
  } catch {
    return null
  }
}

/** AI 生成材料（B）：生成 → 标尺回环校准（至多重试一次，最终难度如实标注）→ 走 createSession 常规落库 */
async function generateMaterial(values) {
  if (!ctx) return { error: '英语精听未激活' }
  const v = values || {}
  const level = String(v.level || '进阶')
  const lv = GENERATION_LEVELS.find((l) => l.value === level) || GENERATION_LEVELS[1]
  const target = targetCoverageFor(level)
  let text = await llmGeneratePassage(level, v.topic)
  if (!text) return { error: 'AI 生成需要已配置模型（Agent 面板「模型」Tab 配置后可用）；也可以直接粘贴文本建会话' }
  let sentences = splitEnglishSentences(text)
  if (sentences.length === 0) return { error: '生成结果未切出有效句子，请重试或改换话题' }
  const rank = loadWordRank()
  let difficulty = rank ? analyzeCoverage(sentences, (w) => rank.get(w) || 0) : null
  const hint = retryHintFor(difficulty, target)
  if (hint) {
    const text2 = await llmGeneratePassage(level, v.topic, hint)
    const s2 = splitEnglishSentences(text2 || '')
    if (s2.length > 0) {
      text = text2
      sentences = s2
      difficulty = rank ? analyzeCoverage(sentences, (w) => rank.get(w) || 0) : difficulty
    }
  }
  const theme = String(v.topic || '').trim()
  const title = `生成·${level}${theme ? `·${theme}` : ''}`
  const r = await createSession(sentences.join(' '), title, `AI·${level}`)
  if (r.error) return { error: r.error }
  const note = formatDifficultyNote(r.material.difficulty)
  const calibration = difficulty && difficulty.coverage < target
    ? `（目标覆盖 ${(target * 100).toFixed(0)}%，实测 ${(difficulty.coverage * 100).toFixed(0)}%——已按标尺如实标注）`
    : ''
  return {
    title: `已生成「${r.material.title}」（${r.created} 句）`,
    markdown: [
      ...(note ? [`> ${note}${calibration}`, ''] : []),
      ...(Array.isArray(r.material.translations) && r.material.translations.length
        ? r.sentences.map((s, i) => `${i + 1}. ${s}\n   > 译：${r.material.translations[i] || '—'}`).join('\n')
        : r.sentences.map((s, i) => `${i + 1}. ${s}`).join('\n')),
      '',
      '> 点击页头「**▶ 精听最近会话**」进入逐句听写；逐句中译在后台补全，稍后刷新可见。',
    ].join('\n'),
    message: `AI 生成材料「${r.material.title}」就绪（${r.created} 句）`,
  }
}

/** 库内候选（纯函数）：排除本插件材料/译文/晨报产物，按入库时间新→旧取 30 篇
 *  （getDocuments 按 title 字母序返回，无近期性——必须显式按 createdAt 倒排） */
function candidateDocs(docs) {
  return (docs || [])
    .filter((d) => d && d.filePath)
    .filter((d) => {
      const p = normPath(d.filePath)
      return !p.includes('/英语精听/') && !p.includes('/翻译/') && !p.includes('sys-hub/小诺晨报')
    })
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .slice(0, 30)
}

/** 库内直取（A）：读库内文档 → 常规建会话（中文/空文本走 createSession 既有 fail-closed） */
async function useDocMaterial(docPath) {
  if (!ctx) return { error: '英语精听未激活' }
  const fp = String(docPath || '').trim()
  if (!fp) return { error: '缺少文档路径' }
  let content = ''
  try {
    content = await ctx.readFile(fp)
  } catch {
    return { error: `文档不可读（未索引或已移动）：${fp}` }
  }
  const title = safeFileName(String(fp).replace(/\\/g, '/').split('/').pop().replace(/\.(md|markdown|txt)$/i, ''))
  const r = await createSession(content, title, '库内选材')
  if (r.error) return { error: `${r.error}（文档：${title}）` }
  return { message: `已从库内建会话「${r.material.title}」：${r.created} 句听写。中译后台补全，可立即开始精听。` }
}

// ============================================================
// 会话模型（v2）：材料元数据按会话登记 plugin_kv，历史可达；句子不入题库
// ============================================================

const normPath = (p) => String(p || '').replace(/\\/g, '/').toLowerCase()

async function resolveSysHub() {
  const repos = (await ctx.listRepositories()) || []
  return repos.find((r) => r.name === 'sys-hub') || null
}

async function saveSession(session) {
  await ctx.storage.set(SESSION_NS, session.docId, session)
}

async function getSession(docId) {
  if (!docId) return null
  try {
    return (await ctx.storage.get(SESSION_NS, docId)) || null
  } catch {
    return null
  }
}

/** 会话列表（新→旧）。首次升级桥接：v0.1.0 只有 latest 一条且句子在题库时，
 *  从题库读回句序注册为会话（一次性迁移，之后走 session 命名空间） */
async function listSessions() {
  let rows = []
  try {
    rows = (await ctx.storage.list(SESSION_NS)) || []
  } catch {
    rows = []
  }
  let sessions = rows.map((r) => r && r.value).filter((s) => s && s.docId)
  if (sessions.length === 0) {
    const legacy = await loadLegacyLatestSession()
    if (legacy) {
      await saveSession(legacy)
      sessions = [legacy]
    }
  }
  // 旧版污染自愈：元数据碎片会话自动隔离（仅删会话元数据；材料文件与已生成的错词卡保留），
  // 清理数经 quarantinedLastRun 供页面如实告知——用户不应被要求手动清理产品自身的坏数据
  const clean = []
  const garbage = []
  for (const session of sessions) (contaminatedSession(session) ? garbage : clean).push(session)
  quarantinedLastRun = garbage.length
  for (const session of garbage) {
    try {
      await ctx.storage.delete(SESSION_NS, session.docId)
    } catch {
      /* 隔离失败下次再清，不影响本次返回 */
    }
  }
  return clean.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
}

async function loadLegacyLatestSession() {
  try {
    const material = (await ctx.storage.get('material', 'latest')) || null
    if (!material || !material.docId) return null
    const rows = (await ctx.query(
      `SELECT answer, rowid FROM questions WHERE document_id = ? AND type = ? AND status != 'retired' ORDER BY rowid`,
      [material.docId, DICTATION_TYPE]
    )) || []
    if (rows.length === 0) return null
    return {
      docId: material.docId,
      filePath: material.filePath || '',
      title: material.title || '精听材料',
      count: rows.length,
      sentences: rows.map((r) => r.answer),
      createdAt: material.createdAt || new Date().toISOString(),
      difficulty: material.difficulty || null,
      translations: Array.isArray(material.translations) ? material.translations : null,
      tag: '粘贴',
    }
  } catch {
    return null
  }
}

function buildMaterialDoc({ title, sentences, translations, difficultyNote, tag }) {
  const fm = [
    '---',
    'type: listening-material',
    `plugin: ${PLUGIN_ID}`,
    `sentences: ${sentences.length}`,
    ...(tag ? [`tag: ${tag}`] : []),
    `created-at: ${new Date().toISOString()}`,
    '---',
    '',
    `# 精听材料：${title}`,
    '',
    ...(difficultyNote ? [`> ${difficultyNote}`, ''] : []),
    ...sentences.map((s, i) => `${i + 1}. ${s}${translations?.[i] ? `\n   > 译：${translations[i]}` : ''}`),
    '',
    `> 听写错词生成选择填空卡（${GENERATOR_WORD_CARD}），按 SM-2 调度复习；本文件为材料原文存档（「原文」态：听写前可在此对照双语）。`,
    '',
  ]
  return fm.join('\n')
}

/** 同名防覆盖：会话列表里已有同名 → 追加时间戳（v0.1.0 直接覆盖文件导致旧句题残留成孤儿） */
async function uniqueTitleOf(title, sessions) {
  const base = safeFileName(title)
  const taken = new Set((sessions || []).map((s) => String(s.title || '')))
  if (!taken.has(base)) return base
  return `${base} ${new Date().toISOString().slice(5, 16).replace('T', ' ')}`
}

/** 会话裁剪：超出 MAX_SESSIONS 删最旧元数据（材料文件保留在 sys-hub，可重新导入） */
async function pruneSessions() {
  const sessions = await listSessions()
  for (const s of sessions.slice(MAX_SESSIONS)) {
    try {
      await ctx.storage.delete(SESSION_NS, s.docId)
    } catch {
      /* 裁剪失败不阻塞 */
    }
  }
}

/** 建听写会话（v2 快速路径）：切句+难度 → 材料落 sys-hub「英语精听/」+ 会话登记，秒级返回；
 *  逐句中译后台补全（enrichTranslationsAsync），不阻塞。听写句不入题库（会话内即时投影）。 */
async function createSession(text, title, tag) {
  const sentences = splitEnglishSentences(text)
  if (sentences.length === 0) {
    return { error: `未从文本中切出可用句子（需每句 ≥2 词、总量 ≤${MAX_TEXT_CHARS} 字符；中文文本不适用本插件）` }
  }
  const hubRepo = await resolveSysHub()
  if (!hubRepo) return { error: 'NO_SYS_HUB（系统仓库 sys-hub 不存在，无法落盘材料）' }

  const rank = loadWordRank()
  const difficulty = rank ? analyzeCoverage(sentences, (w) => rank.get(w) || 0) : null
  const difficultyNote = formatDifficultyNote(difficulty)

  const existing = await listSessions()
  const finalTitle = await uniqueTitleOf(title || `精听 ${new Date().toISOString().slice(5, 16).replace('T', ' ')}`, existing)
  const fp = path.join(hubRepo.localPath, '英语精听', `${finalTitle}.md`)
  await ctx.writeFile(fp, buildMaterialDoc({ title: finalTitle, sentences, difficultyNote, tag }))
  await ctx.reindexRepository(hubRepo.id)

  const docs = (await ctx.getDocuments(hubRepo.id)) || []
  const doc = docs.find((d) => normPath(d.filePath) === normPath(fp))
  if (!doc) return { error: `材料已写入但重索引后未找到文档（${fp}），请稍后在精听页重试` }

  const session = {
    docId: doc.id,
    filePath: fp,
    title: finalTitle,
    count: sentences.length,
    sentences,
    createdAt: new Date().toISOString(),
    difficulty,
    translations: null,
    tag: String(tag || '粘贴'),
  }
  await saveSession(session)
  try {
    await ctx.storage.set('material', 'latest', session) // 兼容保留：旧读面/排障入口
  } catch {
    /* latest 非必需 */
  }
  await pruneSessions()
  void enrichTranslationsAsync(session.docId)

  return { material: session, created: sentences.length, sentences }
}

/** 中译后台补全：完成后更新会话元数据并重写材料文件（双语态）；失败落 'failed' 如实呈现 */
async function enrichTranslationsAsync(docId) {
  try {
    const session = await getSession(docId)
    if (!session || !Array.isArray(session.sentences) || session.sentences.length === 0) return
    const translations = await translateSentences(session.sentences)
    const fresh = await getSession(docId)
    if (!fresh) return
    fresh.translations = translations || 'failed'
    await saveSession(fresh)
    if (translations) {
      const hubRepo = await resolveSysHub()
      if (hubRepo) {
        await ctx.writeFile(fresh.filePath, buildMaterialDoc({
          title: fresh.title, sentences: fresh.sentences, translations,
          difficultyNote: formatDifficultyNote(fresh.difficulty), tag: fresh.tag,
        }))
        await ctx.reindexRepository(hubRepo.id)
      }
    }
  } catch {
    /* 后台补全失败静默：页面按「未生成」如实呈现，不阻塞任何主路径 */
  }
}

// ============================================================
// 作答流水读取（practice_attempts 权威，摆脱题库行依赖）
// ============================================================

/** 拉取若干会话的听写流水（rowid 序 = 时间序） */
async function loadAttempts(docIds) {
  const ids = (docIds || []).filter(Boolean)
  if (ids.length === 0) return []
  const ph = ids.map(() => '?').join(',')
  return (await ctx.query(
    `SELECT document_id AS docId, question_snapshot AS snap, correct, response_text AS response
     FROM practice_attempts WHERE question_type = ? AND document_id IN (${ph}) ORDER BY rowid`,
    [DICTATION_TYPE, ...ids]
  )) || []
}

/** 解析流水行 → { 句题id → 最近一次作答 }（snap 损坏行跳过） */
function latestAttemptBySentence(rows) {
  const byId = new Map()
  for (const r of rows || []) {
    let snap = null
    try {
      snap = JSON.parse(String(r.snap || '{}'))
    } catch {
      continue
    }
    if (!snap || !snap.id) continue
    byId.set(snap.id, { correct: r.correct, response: String(r.response || ''), answer: String(snap.answer || '') })
  }
  return byId
}

/** 会话进度统计：已练 = 有作答史的句数；全对 = 最近一次作答正确的句数 */
function sessionStatsOf(session, attempts) {
  const rows = (attempts || []).filter((r) => r.docId === session.docId)
  const latest = latestAttemptBySentence(rows)
  let practiced = 0
  let perfect = 0
  for (const info of latest.values()) {
    practiced += 1
    if (info.correct === 1) perfect += 1
  }
  return { practiced, perfect }
}

/** 会话错词清单：每句取最近一次「判 0」作答，词集差重建；已成卡标注状态 */
async function loadWrongWords(session, attempts) {
  const rows = (attempts || []).filter((r) => r.docId === session.docId)
  const latestWrong = new Map()
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]
    let snap = null
    try {
      snap = JSON.parse(String(r.snap || '{}'))
    } catch {
      continue
    }
    if (!snap || !snap.id || r.correct !== 0) continue
    if (!latestWrong.has(snap.id)) latestWrong.set(snap.id, { response: String(r.response || ''), answer: String(snap.answer || '') })
  }
  if (latestWrong.size === 0) return []
  const byWord = new Map()
  for (const [, info] of latestWrong) {
    for (const w of extractWrongWords(info.answer, info.response)) {
      if (!byWord.has(w)) byWord.set(w, { word: w, status: '待标注' })
    }
  }
  if (byWord.size === 0) return []
  const carded = (await ctx.query(
    `SELECT answer FROM questions
     WHERE document_id = ? AND type = 'single_choice' AND plugin_id = ? AND status != 'retired'`,
    [session.docId, PLUGIN_ID]
  )) || []
  const cardedSet = new Set(carded.map((r) => String(r.answer).toLowerCase()))
  return [...byWord.values()].map((r) => ({
    ...r,
    status: cardedSet.has(r.word.toLowerCase()) ? '已成卡' : '待标注',
  }))
}

// ============================================================
// plugin:invoke 方法（PackPage 契约）
// ============================================================

/** 会话句状态行（详情卡/错词定位共用）：句序、原文、中译、最近听写结果 */
function sessionRowsOf(session, attempts) {
  const latest = latestAttemptBySentence((attempts || []).filter((r) => r.docId === session.docId))
  const hasZh = Array.isArray(session.translations)
  return {
    hasZh,
    rows: (session.sentences || []).map((s, i) => {
      const info = latest.get(sentenceIdOf(session.docId, i + 1))
      return {
        idx: i + 1,
        sentence: s,
        ...(hasZh ? { zh: session.translations[i] || '—' } : {}),
        status: info ? (info.correct === 1 ? '✅ 全对' : '❌ 有错') : '未练',
      }
    }),
  }
}

/** nav.entry 页数据：会话列表（历史可达）+ 三种材料来源 + 最近会话详情 + 错词一键成卡 */
async function pageDictation() {
  if (!ctx) return { error: '英语精听未激活' }
  const sessions = await listSessions()
  const recent = sessions.slice(0, 10)
  const attempts = await loadAttempts(recent.map((s) => s.docId))
  const cards = []

  if (recent.length > 0) {
    cards.push({
      type: 'table',
      title: '我的精听会话',
      hint: '「▶ 继续精听」重开任意会话；「📄 原文」听前对照；「移除」只清会话记录（材料与错词卡保留）。',
      columns: [
        { key: 'title', label: '材料' },
        { key: 'tag', label: '来源', width: 120 },
        { key: 'count', label: '句数', width: 60 },
        { key: 'progress', label: '进度', width: 130 },
        { key: 'difficulty', label: '难度', width: 150 },
      ],
      rows: recent.map((s) => {
        const st = sessionStatsOf(s, attempts)
        const d = s.difficulty
        return {
          title: s.title,
          tag: s.tag || '粘贴',
          count: s.count,
          progress: `${st.practiced}/${s.count} 练 · ${st.perfect} 全对`,
          difficulty: d ? `${d.label} ${d.coveragePct}%` : '—',
          docId: s.docId,
          filePath: s.filePath,
        }
      }),
      rowActions: [
        { label: '▶ 继续精听', method: 'startDictationPractice', paramKey: 'docId' },
        { label: '📄 原文', method: 'openMaterialDoc', paramKey: 'filePath' },
        { label: '移除', method: 'deleteSession', paramKey: 'docId' },
      ],
    })
  }

  cards.push(
    {
      type: 'form',
      title: '新建：粘贴英文',
      hint: '粘贴一段英文（新闻 / 播客文字稿 / 课文，3-20 句最合适），秒级建会话，随时可以「继续精听」。',
      fields: [
        { key: 'text', label: '英文文本', type: 'textarea', required: true, placeholder: 'Paste English text here (3-20 sentences)…' },
        { key: 'title', label: '材料标题（可选）', placeholder: '如：BBC News 2026-09-26' },
      ],
      submitLabel: '生成听写会话',
      submitMethod: 'startListeningSession',
    },
    {
      type: 'form',
      title: '新建：AI 生成',
      hint: '没有合适的英文材料？选个档位让 AI 写一段：日常三档由易到难，考试四档按雅思/托福真实题型口吻出稿（雅思·生存对话 / 雅思·学术讨论 / 托福·校园对话 / 托福·学术讲座）。需已配置模型。',
      fields: [
        { key: 'level', label: '难度档位', type: 'select', required: true, options: GENERATION_LEVELS.map((l) => ({ value: l.value, label: l.label })) },
        { key: 'topic', label: '话题（可选，缺省用档位推荐话题）', placeholder: '如：climate / 职场 / university housing' },
      ],
      submitLabel: 'AI 生成并建会话',
      submitMethod: 'generateMaterial',
    },
  )

  const candidates = candidateDocs((await ctx.getDocuments()) || [])
  if (candidates.length > 0) {
    cards.push({
      type: 'table',
      title: '新建：知识库选篇（需英文内容）',
      columns: [
        { key: 'title', label: '文档' },
        { key: 'dir', label: '目录', width: 160 },
      ],
      rows: candidates.map((d) => {
        const norm = String(d.filePath).replace(/\\/g, '/')
        const dir = norm.slice(0, norm.lastIndexOf('/')).split('/').pop() || ''
        return { title: d.title || norm.split('/').pop(), dir, path: d.filePath }
      }),
      hint: '只适合英文文档；中文笔记会提示无法使用（听写练的是英文原句）。',
      rowAction: { label: '精听此篇', method: 'useDocMaterial', paramKey: 'path' },
    })
  }

  let stats
  let wrongWords = []
  const latest = recent[0]
  if (latest) {
    const { hasZh, rows } = sessionRowsOf(latest, attempts)
    const st = sessionStatsOf(latest, attempts)
    stats = [
      { label: '会话', value: sessions.length },
      { label: '本会话句数', value: latest.count },
      { label: '本会话已练', value: st.practiced },
      { label: '本会话全对', value: st.perfect },
    ]
    cards.push({
      type: 'table',
      title: `会话内容：${latest.title}`,
      hint: hasZh
        ? '听前在这里对照双语 → 听写时盲听 → 提交后逐词核对（绿=命中 红=听错 虚线=漏写）。'
        : latest.translations === 'failed'
          ? '中译没有生成（未配置模型或合成失败）；不影响听写本身。'
          : '逐句中译正在后台生成，稍后刷新即可看到；听写不依赖中译。',
      columns: [
        { key: 'idx', label: '#', width: 48 },
        { key: 'sentence', label: '句子' },
        ...(hasZh ? [{ key: 'zh', label: '中译（听前对照，听写时隐藏）' }] : []),
        { key: 'status', label: '最近听写', width: 90 },
      ],
      rows,
    })
    wrongWords = await loadWrongWords(latest, attempts)
    if (wrongWords.length > 0) {
      cards.push({
        type: 'table',
        title: '错词本（本次听写收集）',
        hint: '一键把错词做成填空卡进入复习：「听不出」是发音没分辨，「不认识」是词汇缺口；「拼错」会用表单补充标注。',
        columns: [
          { key: 'word', label: '错词', width: 140 },
          { key: 'status', label: '状态', width: 90 },
        ],
        rows: wrongWords,
        rowActions: [
          { label: '听不出·成卡', method: 'makeWordCardNoHeard', paramKey: 'word', when: { key: 'status', value: '待标注' } },
          { label: '不认识·成卡', method: 'makeWordCardUnknown', paramKey: 'word', when: { key: 'status', value: '待标注' } },
        ],
      })
    }
    const pending = wrongWords.filter((w) => w.status === '待标注')
    if (pending.length > 0) {
      cards.push({
        type: 'form',
        title: '错词归因（补标「拼错」等）',
        hint: '认得词但拼写错了？在这里标注归因生成填空卡；一词一卡，复习时看到的就是原句。',
        fields: [
          {
            key: 'word',
            label: '错词',
            type: 'select',
            required: true,
            options: pending.map((w) => ({ value: w.word, label: w.word })),
          },
          { key: 'attribution', label: '归因', type: 'select', required: true, options: ATTRIBUTIONS },
        ],
        submitLabel: '标注并生成填空卡',
        submitMethod: 'makeWordCard',
      })
    }
  }

  const quarantineNote = quarantinedLastRun > 0
    ? `已自动清理 ${quarantinedLastRun} 个无效会话（旧版把中文文档元数据切成了句子，无法用于听写；材料原文件仍在 sys-hub「英语精听/」，不需要可自行删除）。`
    : ''
  return {
    title: '英语精听',
    summary: [quarantineNote, '选一段英文 → 逐句盲听、听写 → 错词自动做成填空卡进复习。中文文档不适用；没有材料就用「AI 生成」。'].filter(Boolean).join(''),
    action: { label: '▶ 精听最近会话', method: 'startDictationPractice' },
    stats,
    cards,
  }
}

/** 表单提交：生成听写会话（秒级返回；中译后台补全，PackFormCard 契约） */
async function startListeningSession(values) {
  if (!ctx) return { error: '英语精听未激活' }
  const v = values || {}
  const r = await createSession(String(v.text || ''), String(v.title || ''), '粘贴')
  if (r.error) return { error: r.error }
  const note = formatDifficultyNote(r.material.difficulty)
  const list = r.sentences.map((s, i) => `${i + 1}. ${s}`).join('\n')
  return {
    title: `听写会话已就绪（${r.created} 句）`,
    markdown: [
      ...(note ? [`> ${note}`, ''] : []),
      list,
      '',
      '> 点击页头「**▶ 精听最近会话**」进入逐句听写——合成朗读（英文音色）不出原文，判分到词。逐句中译后台补全，稍后在会话详情对照。',
    ].join('\n'),
    message: `已生成 ${r.created} 句听写`,
  }
}

/** 页级/行内动作：会话听写题 → start_practice 意图（就地开做题会话）。
 *  句题为会话内即时投影（id=ld-*），题库轨自然跳过——复习队列只剩错词卡 */
async function startDictationPractice(docId) {
  if (!ctx) return { error: '英语精听未激活' }
  const sessions = await listSessions()
  const session = docId ? sessions.find((s) => s.docId === docId) : sessions[0]
  if (!session) return { message: docId ? '会话不存在或已被清理，请在精听页重新选择。' : '还没有听写材料——先粘贴英文或用 AI 生成一段。' }
  const sentences = Array.isArray(session.sentences) ? session.sentences : []
  if (sentences.length === 0) return { message: '该会话没有可用句子（可能被清理），请重新生成材料。' }
  const translations = Array.isArray(session.translations) ? session.translations : null
  const questions = sentences.map((sentence, i) => ({
    id: sentenceIdOf(session.docId, i + 1),
    documentId: session.docId,
    documentPath: session.filePath,
    type: DICTATION_TYPE,
    question: 'Listen and type what you hear.',
    options: [],
    answer: sentence,
    sourceSnippet: sentence,
    explanation: translations ? `译：${translations[i] || '—'}` : '',
    pluginId: PLUGIN_ID,
    generator: GENERATOR_DICTATION,
  }))
  return {
    message: `已就绪 ${questions.length} 句听写（材料：${session.title}）。`,
    ui: { intent: 'start_practice', questions, title: `英语精听 · ${session.title}（${questions.length} 句）` },
  }
}

/** 行内动作：在编辑器打开材料原文（三态字幕的「原文」态） */
async function openMaterialDoc(filePath) {
  const fp = String(filePath || '').trim()
  if (!fp) return { error: '缺少材料路径' }
  return { message: '已在编辑器打开材料原文。', ui: { intent: 'open_document', filePath: fp } }
}

/** 删除会话（仅元数据；材料文件与已成错词卡保留——复习资产独立于会话）。
 *  暂无声明式确认交互，未挂页面 rowAction；供清理/后续确认 UI/小诺调用 */
async function deleteSession(docId) {
  if (!ctx) return { error: '英语精听未激活' }
  const id = String(docId || '').trim()
  if (!id) return { error: '缺少会话 docId' }
  const session = await getSession(id)
  if (!session) return { message: `会话不存在（${id}），无需删除。` }
  await ctx.storage.delete(SESSION_NS, id)
  return { message: `已删除会话「${session.title}」（材料文件与已生成的错词卡保留）。` }
}

/** 错词归因成卡：选择填空（题干=挖空原句），归因写进解析；重复成卡如实告知。
 *  一词一卡：来自哪份材料就在哪份材料的原句上挖空（默认最近会话） */
async function makeWordCard(values) {
  if (!ctx) return { error: '英语精听未激活' }
  const v = values || {}
  const word = String(v.word || '').trim()
  const attribution = String(v.attribution || '').trim()
  if (!word) return { error: '缺少错词' }
  if (!ATTRIBUTIONS.some((a) => a.value === attribution)) return { error: '归因必须是：听不出 / 不认识 / 拼错' }
  const sessions = await listSessions()
  const session = sessions[0]
  if (!session) return { error: '没有听写材料，无法定位错词原句' }
  const sentences = Array.isArray(session.sentences) ? session.sentences : []
  const hitIdx = sentences.findIndex((s) => tokenizeForDiff(s).includes(word.toLowerCase()))
  if (hitIdx < 0) return { error: `最近材料中未找到含「${word}」的听写句` }
  const card = buildClozeCard(sentences[hitIdx], word, sentences)
  if (!card) return { error: '材料过短，凑不出干扰项（至少需要 4 个不同实词）' }
  // 插件层去重（按词，与选项顺序无关）：content_hash 含 options_json，而干扰项随机洗牌
  // 使同卡每次哈希不同——宿主去重对填空卡永不命中（v0.1.0 起潜伏，「重复成卡」验收项失效）
  const existed = (await ctx.query(
    `SELECT id FROM questions
     WHERE document_id = ? AND type = 'single_choice' AND plugin_id = ? AND status != 'retired' AND lower(answer) = ?`,
    [session.docId, PLUGIN_ID, word.toLowerCase()]
  )) || []
  if (existed.length > 0) return { message: `「${word}」的填空卡已存在（去重跳过），无需重复生成。` }
  const r = await ctx.insertQuestion({
    documentId: session.docId,
    type: 'single_choice',
    question: card.question,
    options: card.options,
    answer: card.answer,
    explanation: `听写归因：${attribution}｜原句：${sentences[hitIdx]}`,
    sourceSnippet: sentences[hitIdx],
    pluginId: PLUGIN_ID,
    generator: GENERATOR_WORD_CARD,
  })
  if (r.duplicate) return { message: `「${word}」的填空卡已存在（去重跳过），无需重复生成。` }
  if (!r.created) return { error: `入库失败：${r.reason || '未知原因'}` }
  return { message: `已生成「${word}」填空卡（归因：${attribution}），将按 SM-2 进入复习。` }
}

/** 错词表行内一键成卡（占精听错词绝大多数的两类）；「拼错」走 ⑦ 表单显式归因 */
async function makeWordCardNoHeard(word) {
  return makeWordCard({ word, attribution: '听不出' })
}

async function makeWordCardUnknown(word) {
  return makeWordCard({ word, attribution: '不认识' })
}

// ============================================================
// 插件生命周期
// ============================================================

module.exports = {
  id: PLUGIN_ID,
  name: '英语精听',
  version: '0.3.1',
  description: '盲听逐句精听（英文音色合成朗读，词级三色判分）→ 错词归因成卡（选择填空入题库，SM-2 复习）；会话历史可达，考试档位对齐雅思/托福',

  async activate(context) {
    ctx = context
    context.registerAgentTool(
      {
        name: 'start_listening_drill',
        description: '把一段英文文本变成精听会话：材料落盘 sys-hub「英语精听/」并登记会话（秒级返回，逐句中译后台补全），引导用户到「英语精听」页开始逐句听写。用户要求"练听力/精听/听写这段英文"且附带英文文本时使用。',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '英文材料原文（3-20 句为宜）' },
            title: { type: 'string', description: '材料标题（可选，如 BBC News 2026-09-26）' },
          },
          required: ['text'],
        },
      },
      async (args) => {
        const r = await createSession(String((args && args.text) || ''), String((args && args.title) || ''), '粘贴')
        if (r.error) return { output: '', error: r.error }
        return {
          output: `✅ 已建精听会话「${r.material.title}」：${r.created} 句。\n请到侧边栏「英语精听」页，点页头「▶ 精听最近会话」逐句听写（合成朗读，判分到词）；错词可就地归因成卡。`,
        }
      }
    )
    context.registerAgentTool(
      {
        name: 'make_word_card',
        description: '把最近精听材料中的某个错词归因后生成选择填空卡（题干=挖空原句），按 SM-2 复习。归因三选：听不出/不认识/拼错。用户说"把 xxx 做成单词卡/这张卡"时使用。',
        parameters: {
          type: 'object',
          properties: {
            word: { type: 'string', description: '错词（材料中出现的原词）' },
            attribution: { type: 'string', description: '归因：听不出 / 不认识 / 拼错' },
          },
          required: ['word', 'attribution'],
        },
      },
      async (args) => {
        const r = await makeWordCard({ word: (args && args.word) || '', attribution: (args && args.attribution) || '' })
        if (r.error) return { output: '', error: r.error }
        return { output: r.message }
      }
    )
    context.registerAgentTool(
      {
        name: 'generate_material',
        description: 'AI 生成一段分级英文听力材料并建成精听会话（经难度标尺回环校准，至多重试一次；需已配置模型）。日常三档按 CEFR；考试四档（雅思·生存对话/雅思·学术讨论/托福·校园对话/托福·学术讲座）按题型风格生成。用户说"给我来一段英语材料/生成一段进阶/雅思/托福风格的听力材料"时使用；用户自备文本时用 start_listening_drill。',
        parameters: {
          type: 'object',
          properties: {
            level: { type: 'string', description: '档位：入门 / 进阶 / 挑战 / 雅思·生存对话 / 雅思·学术讨论 / 托福·校园对话 / 托福·学术讲座（缺省 进阶）' },
            topic: { type: 'string', description: '话题（可选；缺省用档位推荐话题）' },
          },
        },
      },
      async (args) => {
        const r = await generateMaterial({ level: (args && args.level) || '进阶', topic: (args && args.topic) || '' })
        if (r.error) return { output: '', error: r.error }
        return { output: `${r.message}\n请到侧边栏「英语精听」页点页头「▶ 精听最近会话」逐句听写。` }
      }
    )
    context.log('listening-drill 已激活（英语精听 v2）')
  },

  async deactivate() {
    if (ctx) {
      ctx.unregisterAgentTool('start_listening_drill')
      ctx.unregisterAgentTool('make_word_card')
      ctx.unregisterAgentTool('generate_material')
    }
    ctx = null
  },

  // plugin:invoke 方法（nav.entry 页契约）
  pageDictation,
  startListeningSession,
  startDictationPractice,
  openMaterialDoc,
  deleteSession,
  makeWordCard,
  makeWordCardNoHeard,
  makeWordCardUnknown,
  generateMaterial,
  useDocMaterial,

  // 纯函数导出（单测面；production 语义见各函数注释）
  splitEnglishSentences,
  tokenizeForDiff,
  extractWrongWords,
  buildClozeCard,
  loadWordRank,
  analyzeCoverage,
  formatDifficultyNote,
  parseTranslationPayload,
  targetCoverageFor,
  retryHintFor,
  candidateDocs,
  sentenceIdOf,
  parseSentenceNo,
  contaminatedSession,
  sessionStatsOf,
  latestAttemptBySentence,
  GENERATION_LEVELS,
}
