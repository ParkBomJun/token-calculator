// 멀티 벤더 토크나이저 캘리브레이션 — 대화형 마법사
//
// 실행:  node scripts/calibrate.mjs
//   → 벤더별로 1/5, 2/5... 순서대로 안내. 키를 붙여넣고 Enter = 측정, 그냥 Enter = 스킵.
//   → 측정할 때마다 scripts/calibration-result.json에 즉시 저장(병합)되므로
//     오늘 Anthropic만 하고 다음에 DeepSeek를 추가로 돌려도 된다.
//   → 환경변수(ANTHROPIC_API_KEY 등)가 있으면 자동 감지해서 물어본다.
//
// 원리 — 델타 측정법:
//   API 실측치에는 메시지 포장 오버헤드(고정 토큰)가 포함된다. 같은 텍스트를 1배/2배로
//   두 번 재서 (실측2−실측1)/(로컬2−로컬1)로 배율을 구하면 고정분이 상쇄된다.

import { readFile, writeFile, copyFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import readline from 'node:readline'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const OUT = join(ROOT, 'scripts/calibration-result.json')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 입력 유틸 (라인 이벤트 기반 — 조기 도착 입력은 큐에 버퍼링, EOF 안전) ──
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
let rlClosed = false
let pendingResolve = null
const inputQueue = []
rl.on('line', (line) => {
  if (pendingResolve) { const r = pendingResolve; pendingResolve = null; r(line) }
  else inputQueue.push(line)
})
rl.on('close', () => { rlClosed = true; if (pendingResolve) { const r = pendingResolve; pendingResolve = null; r('') } })
rl.stdoutMuted = false
rl._writeToOutput = function (str) {
  this.output.write(this.stdoutMuted ? '*'.repeat(str.replace(/[\r\n]/g, '').length) : str)
}

function nextLine() {
  if (inputQueue.length) return Promise.resolve(inputQueue.shift())
  if (rlClosed) return Promise.resolve('')
  return new Promise((resolve) => { pendingResolve = resolve })
}

async function ask(prompt) {
  process.stdout.write(prompt)
  const ans = (await nextLine()).trim()
  if (!process.stdin.isTTY) process.stdout.write('\n') // 파이프 입력은 에코가 없으므로 줄맞춤
  return ans
}

/** 키 입력용 — TTY면 *로 마스킹 */
async function askHidden(prompt) {
  if (!process.stdin.isTTY) return ask(prompt)
  process.stdout.write(prompt)
  rl.stdoutMuted = true
  const ans = (await nextLine()).trim()
  rl.stdoutMuted = false
  process.stdout.write('\n')
  return ans
}
// ── 샘플 (유형별, 각 300자+) ──
const SAMPLES = {
  'ko-prose': '고블린 동굴 깊은 곳, 횃불이 만들어내는 그림자가 벽면을 따라 일렁였다. 모험가 일행은 좁은 통로를 지나 마침내 넓은 공동에 도착했고, 그곳에는 오래된 제단과 함께 알 수 없는 문자가 새겨진 석판이 놓여 있었다. 리더는 조심스럽게 석판에 손을 얹었다. 차가운 감촉과 함께 희미한 빛이 문자를 따라 흐르기 시작했다. 뒤에 서 있던 마법사가 낮은 목소리로 경고했다. 이것은 봉인이다. 함부로 건드리면 안 된다. 하지만 이미 늦었다. 석판의 빛은 점점 강해졌고, 공동 전체가 진동하기 시작했다.',
  'ko-instruction': '당신은 고객 상담 어시스턴트입니다. 다음 규칙을 반드시 지키세요. 첫째, 근거 문서에 없는 내용은 절대 답변하지 마세요. 둘째, 환불이나 결제 취소 요청은 즉시 상담사에게 이관하세요. 셋째, 답변은 세 문장 이내로 간결하게 작성하되 정중한 존댓말을 유지하세요. 넷째, 고객이 화를 내거나 부정적인 감정을 표현하면 공감 표현을 먼저 하고 해결책을 제시하세요. 다섯째, 개인정보를 요구하지 마세요.',
  'en-prose': 'Deep within the goblin cave, shadows cast by torchlight danced along the walls. The party of adventurers passed through a narrow corridor and finally reached a wide chamber, where an ancient altar stood beside a stone tablet engraved with unknown characters. The leader carefully placed a hand on the tablet. A faint light began to flow along the characters. The mage standing behind warned in a low voice: this is a seal, do not touch it carelessly. But it was already too late.',
  'zh-prose': '在哥布林洞穴的深处，火把投下的影子沿着墙壁摇曳。冒险者一行穿过狭窄的通道，终于到达了一个宽阔的洞厅，那里有一座古老的祭坛，旁边放着一块刻有未知文字的石板。队长小心翼翼地把手放在石板上，一道微弱的光芒开始沿着文字流动。站在后面的法师低声警告说：这是封印，不要随便触碰。但已经太迟了，石板的光芒越来越强，整个洞厅开始震动。',
  'code': 'export async function buildComparison(text, opts) {\n  const needTier = requiredTier(opts.taskType, opts.tolerance)\n  const models = getModels()\n  const tokenCounts = new Map()\n  for (const tk of [...new Set(models.map((m) => m.tokenizer))]) {\n    try { tokenCounts.set(tk, (await tokenize(text, tk)).length) }\n    catch { tokenCounts.set(tk, null) }\n  }\n  return models.map((model) => ({ model, tokens: tokenCounts.get(model.tokenizer) }))\n}',
  'mixed': '프로젝트 마감은 7/25(금)입니다. API 응답의 p95 latency가 3.5s를 초과하면 rollback 하세요. 담당: 김민수(minsu.kim@example.com), Slack #proj-alpha 채널. 예산: $12,400 (약 1,700만 원). 진행률 78% 🚀 남은 태스크: DB 마이그레이션, i18n 적용, QA 2 라운드.',
}
const doubled = (t) => t + '\n' + t

// ── 로컬 토크나이저 ──
async function buildLocals() {
  const src = join(ROOT, 'node_modules/@mlc-ai/web-tokenizers/lib/index.js')
  const tmp = join(ROOT, 'scripts/.wt-tmp.cjs')
  await copyFile(src, tmp)
  const { Tokenizer } = createRequire(import.meta.url)(tmp)
  const buf = async (p) => {
    const b = await readFile(join(ROOT, 'public/token', p))
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
  }
  const { encode: o200k } = await import('gpt-tokenizer/encoding/o200k_base')
  return {
    claude: await Tokenizer.fromJSON(await buf('claude/claude.json')),
    gemma: await Tokenizer.fromSentencePiece(await buf('gemma/tokenizer.model')),
    'deepseek-v4': await Tokenizer.fromJSON(await buf('deepseek/v4/tokenizer.json')),
    glm5: await Tokenizer.fromJSON(await buf('glm5/tokenizer.json')),
    o200k: { encode: (t) => o200k(t) },
  }
}

// ── 벤더 정의 ──
async function post(url, headers, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) { const e = new Error(`HTTP ${res.status}: ${JSON.stringify(json).slice(0, 160)}`); e.status = res.status; throw e }
  return json
}

const VENDORS = [
  {
    name: 'Anthropic', env: 'ANTHROPIC_API_KEY', local: 'claude',
    info: '무료 (count_tokens는 과금 없음) · 발급: console.anthropic.com → API Keys',
    models: ['claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5'],
    count: async (text, model, key) =>
      (await post('https://api.anthropic.com/v1/messages/count_tokens',
        { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        { model, messages: [{ role: 'user', content: text }] })).input_tokens,
  },
  {
    name: 'Google', env: 'GEMINI_API_KEY', local: 'gemma',
    info: '무료 (countTokens 무과금) · 발급: aistudio.google.com/apikey',
    models: ['gemini-3-pro', 'gemini-3.5-flash', 'gemini-3.1-flash-lite'],
    count: async (text, model, key) =>
      (await post(`https://generativelanguage.googleapis.com/v1beta/models/${model}:countTokens?key=${key}`,
        {}, { contents: [{ parts: [{ text }] }] })).totalTokens,
    onModelError: async (key) => {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`)
      const json = await res.json().catch(() => ({}))
      const names = (json.models ?? []).map((m) => m.name?.replace('models/', '')).filter((n) => n?.startsWith('gemini'))
      if (names.length) console.log('    ↳ 이 키로 사용 가능한 Gemini ID:', names.slice(0, 15).join(', '))
    },
  },
  {
    name: 'DeepSeek', env: 'DEEPSEEK_API_KEY', local: 'deepseek-v4',
    info: '초소액 과금 (~1센트) · 발급: platform.deepseek.com',
    models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    count: async (text, model, key) =>
      (await post('https://api.deepseek.com/chat/completions',
        { authorization: `Bearer ${key}` },
        { model, messages: [{ role: 'user', content: text }], max_tokens: 8 })).usage.prompt_tokens,
  },
  {
    name: 'Zhipu(GLM)', env: 'GLM_API_KEY', local: 'glm5',
    info: '초소액 과금 (~1센트) · 발급: open.bigmodel.cn 또는 z.ai',
    models: ['glm-5.2', 'glm-5'],
    count: async (text, model, key) =>
      (await post('https://open.bigmodel.cn/api/paas/v4/chat/completions',
        { authorization: `Bearer ${key}` },
        { model, messages: [{ role: 'user', content: text }], max_tokens: 8 })).usage.prompt_tokens,
  },
  {
    name: 'OpenAI', env: 'OPENAI_API_KEY', local: 'o200k',
    info: '초소액 과금 (~1센트, 최저가 Luna로 대표 측정) · 발급: platform.openai.com',
    models: ['gpt-5.6-luna'],
    count: async (text, model, key) =>
      (await post('https://api.openai.com/v1/chat/completions',
        { authorization: `Bearer ${key}` },
        { model, messages: [{ role: 'user', content: text }], max_completion_tokens: 8 })).usage.prompt_tokens,
  },
  {
    name: 'OpenRouter', env: 'OPENROUTER_API_KEY',
    info: '초소액 과금 · GPT/GLM 대체 측정 + Claude 교차검증 · 발급: openrouter.ai/keys',
    // 모델마다 비교할 로컬 토크나이저가 다르다. claude 항목은 직접 실측과의 교차검증용 —
    // OpenRouter가 네이티브 토큰 수를 전달하는지(자체 정규화 여부)를 여기서 판별한다.
    models: [
      { id: 'openai/gpt-5.6-luna', local: 'o200k' },
      { id: 'z-ai/glm-5.2', local: 'glm5' },
      { id: 'anthropic/claude-sonnet-5', local: 'claude' },
    ],
    count: async (text, model, key) =>
      (await post('https://openrouter.ai/api/v1/chat/completions',
        { authorization: `Bearer ${key}` },
        { model, messages: [{ role: 'user', content: text }], max_tokens: 8, usage: { include: true } })).usage.prompt_tokens,
    onModelError: async (key) => {
      const res = await fetch('https://openrouter.ai/api/v1/models', { headers: { authorization: `Bearer ${key}` } })
      const json = await res.json().catch(() => ({}))
      const ids = (json.data ?? []).map((m) => m.id)
        .filter((id) => /^(openai\/gpt-5|z-ai\/glm-5|anthropic\/claude-sonnet-5)/.test(id))
      if (ids.length) console.log('    ↳ OpenRouter에서 매칭되는 모델 ID:', ids.slice(0, 12).join(', '))
    },
  },
]

// ── 측정 ──
async function measureVendor(v, key, locals) {
  const vendorResult = {}
  for (const spec of v.models) {
    const model = typeof spec === 'string' ? spec : spec.id
    const localKey = typeof spec === 'string' ? v.local : spec.local
    const entry = {}
    console.log(`  [${model}] (로컬 기준: ${localKey})`)
    for (const [name, text] of Object.entries(SAMPLES)) {
      const l1 = locals[localKey].encode(text).length
      const l2 = locals[localKey].encode(doubled(text)).length
      try {
        const e1 = await v.count(text, model, key)
        await sleep(250)
        const e2 = await v.count(doubled(text), model, key)
        await sleep(250)
        const ratio = (e2 - e1) / (l2 - l1)
        const overhead = e1 - Math.round(l1 * ratio)
        entry[name] = { local: l1, exact: e1, ratio: Number(ratio.toFixed(4)), fixedOverhead: overhead }
        console.log(`    ${name.padEnd(15)} 로컬 ${String(l1).padStart(5)} → 공식 ${String(e1).padStart(5)}  배율 ×${ratio.toFixed(3)}`)
      } catch (e) {
        console.log(`    ${name.padEnd(15)} 실패: ${e.message}`)
        if (e.status === 401 || e.status === 403) throw e // 키 문제 → 상위에서 재입력 처리
        if (v.onModelError) await v.onModelError(key)
        break // 모델 ID 문제 → 다음 모델로
      }
    }
    const ratios = Object.values(entry).map((x) => x.ratio)
    if (ratios.length) {
      const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length
      const spread = Math.max(...ratios) - Math.min(...ratios)
      entry._summary = { meanRatio: Number(mean.toFixed(4)), spread: Number(spread.toFixed(4)), samples: ratios.length }
      console.log(`    → 평균 ×${mean.toFixed(3)} · 편차폭 ${spread.toFixed(3)} ${spread < 0.05 ? '(균일 — 단일 계수 OK)' : '(언어별 계수 필요)'}`)
    }
    vendorResult[model] = entry
  }
  return vendorResult
}

async function saveMerged(result) {
  let existing = {}
  try { existing = JSON.parse(await readFile(OUT, 'utf8')) } catch {}
  const merged = {
    measuredAt: new Date().toISOString().slice(0, 10),
    method: 'delta: ratio = (exact(2x)-exact(1x)) / (local(2x)-local(1x))',
    vendors: { ...(existing.vendors ?? {}), ...result },
  }
  await writeFile(OUT, JSON.stringify(merged, null, 2))
  return merged
}

// ── 메인 흐름 ──
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
console.log(' 토크나이저 캘리브레이션 마법사')
console.log(' 벤더별로 안내합니다. 키 붙여넣고 Enter = 측정 / 그냥 Enter = 스킵')
console.log(' 측정 결과는 단계마다 즉시 저장되며, 나중에 다시 실행해 이어서 채울 수 있습니다.')
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

console.log('\n토크나이저 로드 중...')
const locals = await buildLocals()
const done = []

for (let i = 0; i < VENDORS.length; i++) {
  const v = VENDORS[i]
  console.log(`\n[${i + 1}/${VENDORS.length}] ${v.name} — ${v.info}`)

  let key = process.env[v.env] ?? ''
  if (key) {
    const use = await ask(`  환경변수 ${v.env} 감지됨. 사용할까요? (Enter=사용 / s=스킵): `)
    if (use.toLowerCase() === 's') key = ''
  } else {
    key = await askHidden(`  ${v.name} API 키 (없으면 그냥 Enter): `)
  }
  if (!key) { console.log('  → 스킵'); continue }

  while (true) {
    try {
      const vendorResult = await measureVendor(v, key, locals)
      if (Object.keys(vendorResult).some((m) => Object.keys(vendorResult[m]).length)) {
        await saveMerged({ [v.name]: vendorResult })
        console.log(`  ✔ ${v.name} 저장 완료`)
        done.push(v.name)
      }
      break
    } catch (e) {
      if (e.status === 401 || e.status === 403) {
        console.log(`  ✖ 키가 거부됐습니다 (${e.status}).`)
        key = await askHidden('  키 다시 입력 (그냥 Enter = 이 벤더 스킵): ')
        if (!key) break
      } else {
        console.log(`  ✖ 오류: ${e.message} → 이 벤더는 스킵`)
        break
      }
    }
  }
}

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
if (done.length) {
  console.log(` 완료: ${done.join(', ')} → ${OUT}`)
  console.log(' 다음 단계:')
  console.log('   git add scripts/calibration-result.json')
  console.log('   git commit -m "캘리브레이션 실측 결과"')
  console.log('   git push')
} else {
  console.log(' 측정된 벤더가 없습니다. 키를 준비한 뒤 다시 실행하세요: node scripts/calibrate.mjs')
}
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
rl.close()
