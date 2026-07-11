// 멀티 벤더 토크나이저 캘리브레이션 스크립트
// 로컬 어휘 파일 추정치 vs 각 벤더 공식 API 실측치의 배율(보정계수)을 측정한다.
//
// 사용법 (가진 키만 넣으면 됨 — 없는 벤더는 자동 스킵):
//   ANTHROPIC_API_KEY=... GEMINI_API_KEY=... DEEPSEEK_API_KEY=... \
//   GLM_API_KEY=... OPENAI_API_KEY=... node scripts/calibrate.mjs
//
// 비용: Anthropic·Google은 무료 카운트 API. DeepSeek·GLM·OpenAI는 초소형 실호출
//       (벤더당 1~2센트 미만, usage 필드만 읽고 출력은 8토큰으로 제한)
//
// 정확도 장치 — 델타 측정법:
//   API 실측치에는 메시지 포장 오버헤드(고정 토큰)가 포함된다. 같은 텍스트를
//   1배/2배로 두 번 재서 (실측2−실측1)/(로컬2−로컬1)로 배율을 구하면 고정분이 상쇄된다.

import { readFile, writeFile, copyFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
async function loadWT() {
  const src = join(ROOT, 'node_modules/@mlc-ai/web-tokenizers/lib/index.js')
  const tmp = join(ROOT, 'scripts/.wt-tmp.cjs')
  await copyFile(src, tmp)
  return createRequire(import.meta.url)(tmp).Tokenizer
}
async function buildLocals() {
  const Tokenizer = await loadWT()
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

// ── 벤더별 실측 함수 (text → 공식 입력 토큰 수) ──
async function post(url, headers, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(json).slice(0, 200)}`)
  return json
}

const VENDORS = [
  {
    name: 'Anthropic', env: 'ANTHROPIC_API_KEY', local: 'claude', free: true,
    models: ['claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5'],
    count: async (text, model, key) =>
      (await post('https://api.anthropic.com/v1/messages/count_tokens',
        { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        { model, messages: [{ role: 'user', content: text }] })).input_tokens,
  },
  {
    name: 'Google', env: 'GEMINI_API_KEY', local: 'gemma', free: true,
    models: ['gemini-3-pro', 'gemini-3.5-flash', 'gemini-3.1-flash-lite'],
    count: async (text, model, key) =>
      (await post(`https://generativelanguage.googleapis.com/v1beta/models/${model}:countTokens?key=${key}`,
        {}, { contents: [{ parts: [{ text }] }] })).totalTokens,
    onModelError: async (key) => {
      // 모델 ID가 다르면 실제 목록을 보여준다
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`)
      const json = await res.json().catch(() => ({}))
      const names = (json.models ?? []).map((m) => m.name?.replace('models/', '')).filter((n) => n?.startsWith('gemini'))
      console.log('  사용 가능한 Gemini 모델 ID:', names.slice(0, 15).join(', '))
    },
  },
  {
    name: 'DeepSeek', env: 'DEEPSEEK_API_KEY', local: 'deepseek-v4', free: false,
    models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    count: async (text, model, key) =>
      (await post('https://api.deepseek.com/chat/completions',
        { authorization: `Bearer ${key}` },
        { model, messages: [{ role: 'user', content: text }], max_tokens: 8 })).usage.prompt_tokens,
  },
  {
    name: 'Zhipu(GLM)', env: 'GLM_API_KEY', local: 'glm5', free: false,
    models: ['glm-5.2', 'glm-5'],
    count: async (text, model, key) =>
      (await post('https://open.bigmodel.cn/api/paas/v4/chat/completions',
        { authorization: `Bearer ${key}` },
        { model, messages: [{ role: 'user', content: text }], max_tokens: 8 })).usage.prompt_tokens,
  },
  {
    name: 'OpenAI', env: 'OPENAI_API_KEY', local: 'o200k', free: false,
    models: ['gpt-5.6-luna'], // 같은 세대는 토크나이저 공유 가정 — luna(최저가)로 대표 측정
    count: async (text, model, key) =>
      (await post('https://api.openai.com/v1/chat/completions',
        { authorization: `Bearer ${key}` },
        { model, messages: [{ role: 'user', content: text }], max_completion_tokens: 8 })).usage.prompt_tokens,
  },
]

// ── 실행 ──
const locals = await buildLocals()
const result = {
  measuredAt: new Date().toISOString().slice(0, 10),
  method: 'delta: ratio = (exact(2x)-exact(1x)) / (local(2x)-local(1x)) — 메시지 고정 오버헤드 상쇄',
  vendors: {},
}

for (const v of VENDORS) {
  const key = process.env[v.env]
  if (!key) { console.log(`\n○ ${v.name}: ${v.env} 없음 → 스킵`); continue }
  console.log(`\n■ ${v.name} ${v.free ? '(무료)' : '(초소액 과금)'}`)
  result.vendors[v.name] = {}

  for (const model of v.models) {
    const entry = {}
    console.log(`  [${model}]`)
    let failed = false
    for (const [name, text] of Object.entries(SAMPLES)) {
      const l1 = locals[v.local].encode(text).length
      const l2 = locals[v.local].encode(doubled(text)).length
      try {
        const e1 = await v.count(text, model, key)
        await sleep(250)
        const e2 = await v.count(doubled(text), model, key)
        await sleep(250)
        const ratio = (e2 - e1) / (l2 - l1)
        const overhead = e1 - Math.round(l1 * ratio)
        entry[name] = { local: l1, exact: e1, ratio: Number(ratio.toFixed(4)), fixedOverhead: overhead }
        console.log(`    ${name.padEnd(15)} 로컬 ${String(l1).padStart(5)} → 공식 ${String(e1).padStart(5)}  배율 ×${ratio.toFixed(3)}  고정분 ${overhead >= 0 ? '+' : ''}${overhead}`)
      } catch (e) {
        console.log(`    ${name.padEnd(15)} 실패: ${e.message}`)
        failed = true
        break // 모델 ID 오류면 나머지 샘플도 실패하므로 중단
      }
    }
    const ratios = Object.values(entry).map((x) => x.ratio)
    if (ratios.length) {
      const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length
      const spread = Math.max(...ratios) - Math.min(...ratios)
      entry._summary = { meanRatio: Number(mean.toFixed(4)), spread: Number(spread.toFixed(4)), samples: ratios.length }
      console.log(`    → 평균 ×${mean.toFixed(3)} · 유형 간 편차폭 ${spread.toFixed(3)} ${spread < 0.05 ? '(균일 — 단일 계수로 충분)' : '(언어별 계수 필요)'}`)
    }
    result.vendors[v.name][model] = entry
    if (failed && v.onModelError) await v.onModelError(key)
  }
}

const out = join(ROOT, 'scripts/calibration-result.json')
await writeFile(out, JSON.stringify(result, null, 2))
console.log(`\n저장됨: ${out}`)
console.log('다음 단계: git add scripts/calibration-result.json → 커밋·푸시하면 UI 연동 작업을 진행합니다.')
