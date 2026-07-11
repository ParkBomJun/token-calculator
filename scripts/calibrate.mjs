// 로컬 Claude 토크나이저(구세대 claude.json) vs 공식 count_tokens API 편차 측정 스크립트
//
// 목적: 언어·유형별 보정계수를 한 번 측정해 models.json에 내장하면,
//       일반 사용자는 API 키 없이 "보정된 추정치"를 받을 수 있다.
//
// 사용법:
//   ANTHROPIC_API_KEY=sk-ant-... node scripts/calibrate.mjs
//
// 비용: count_tokens는 무료 엔드포인트 (과금 없음, 레이트리밋만 존재)
// 결과: scripts/calibration-result.json + 콘솔 요약표

import { readFile, writeFile, copyFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

const API_KEY = process.env.ANTHROPIC_API_KEY
if (!API_KEY) {
  console.error('사용법: ANTHROPIC_API_KEY=sk-ant-... node scripts/calibrate.mjs')
  process.exit(1)
}

// 보정 대상 Claude 모델 (토크나이저 세대가 달라 모델별로 편차가 다름)
const MODELS = ['claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5']

// 유형별 샘플 — 실사용 분포를 흉내 낸다 (각 300자 이상, 짧으면 비율이 불안정)
const SAMPLES = {
  'ko-prose': '고블린 동굴 깊은 곳, 횃불이 만들어내는 그림자가 벽면을 따라 일렁였다. 모험가 일행은 좁은 통로를 지나 마침내 넓은 공동에 도착했고, 그곳에는 오래된 제단과 함께 알 수 없는 문자가 새겨진 석판이 놓여 있었다. 리더는 조심스럽게 석판에 손을 얹었다. 차가운 감촉과 함께 희미한 빛이 문자를 따라 흐르기 시작했다. 뒤에 서 있던 마법사가 낮은 목소리로 경고했다. 이것은 봉인이다. 함부로 건드리면 안 된다. 하지만 이미 늦었다. 석판의 빛은 점점 강해졌고, 공동 전체가 진동하기 시작했다.',
  'ko-instruction': '당신은 고객 상담 어시스턴트입니다. 다음 규칙을 반드시 지키세요. 첫째, 근거 문서에 없는 내용은 절대 답변하지 마세요. 둘째, 환불이나 결제 취소 요청은 즉시 상담사에게 이관하세요. 셋째, 답변은 세 문장 이내로 간결하게 작성하되 정중한 존댓말을 유지하세요. 넷째, 고객이 화를 내거나 부정적인 감정을 표현하면 공감 표현을 먼저 하고 해결책을 제시하세요. 다섯째, 개인정보를 요구하지 마세요.',
  'en-prose': 'Deep within the goblin cave, shadows cast by torchlight danced along the walls. The party of adventurers passed through a narrow corridor and finally reached a wide chamber, where an ancient altar stood beside a stone tablet engraved with unknown characters. The leader carefully placed a hand on the tablet. A faint light began to flow along the characters. The mage standing behind warned in a low voice: this is a seal, do not touch it carelessly. But it was already too late.',
  'zh-prose': '在哥布林洞穴的深处，火把投下的影子沿着墙壁摇曳。冒险者一行穿过狭窄的通道，终于到达了一个宽阔的洞厅，那里有一座古老的祭坛，旁边放着一块刻有未知文字的石板。队长小心翼翼地把手放在石板上，一道微弱的光芒开始沿着文字流动。站在后面的法师低声警告说：这是封印，不要随便触碰。但已经太迟了，石板的光芒越来越强，整个洞厅开始震动。',
  'code': 'export async function buildComparison(text, opts) {\n  const needTier = requiredTier(opts.taskType, opts.tolerance)\n  const models = getModels()\n  const tokenCounts = new Map()\n  for (const tk of [...new Set(models.map((m) => m.tokenizer))]) {\n    try { tokenCounts.set(tk, (await tokenize(text, tk)).length) }\n    catch { tokenCounts.set(tk, null) }\n  }\n  return models.map((model) => ({ model, tokens: tokenCounts.get(model.tokenizer) }))\n}',
  'mixed': '프로젝트 마감은 7/25(금)입니다. API 응답의 p95 latency가 3.5s를 초과하면 rollback 하세요. 담당: 김민수(minsu.kim@example.com), Slack #proj-alpha 채널. 예산: $12,400 (약 1,700만 원). 진행률 78% 🚀 남은 태스크: DB 마이그레이션, i18n 적용, QA 2 라운드.',
}

// ── 로컬 토크나이저 로드 (web-tokenizers UMD → CJS 우회) ──
async function loadLocalClaude() {
  const src = join(ROOT, 'node_modules/@mlc-ai/web-tokenizers/lib/index.js')
  const tmp = join(ROOT, 'scripts/.wt-tmp.cjs')
  await copyFile(src, tmp)
  const require = createRequire(import.meta.url)
  const { Tokenizer } = require(tmp)
  const buf = await readFile(join(ROOT, 'public/token/claude/claude.json'))
  return Tokenizer.fromJSON(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
}

async function countExact(text, model) {
  const res = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: text }] }),
  })
  if (!res.ok) throw new Error(`${model}: ${res.status} ${(await res.text()).slice(0, 200)}`)
  return (await res.json()).input_tokens
}

const local = await loadLocalClaude()
const result = { measuredAt: new Date().toISOString().slice(0, 10), note: 'ratio = 공식 count_tokens / 로컬 claude.json 추정. 로컬값 × ratio = 보정 추정치', models: {} }

for (const model of MODELS) {
  result.models[model] = {}
  console.log(`\n■ ${model}`)
  for (const [name, text] of Object.entries(SAMPLES)) {
    const localCount = local.encode(text).length
    let exact
    try {
      exact = await countExact(text, model)
    } catch (e) {
      console.log(`  ${name.padEnd(16)} 실패: ${e.message}`)
      continue
    }
    const ratio = exact / localCount
    result.models[model][name] = { local: localCount, exact, ratio: Number(ratio.toFixed(4)) }
    console.log(`  ${name.padEnd(16)} 로컬 ${String(localCount).padStart(5)} → 공식 ${String(exact).padStart(5)}  (×${ratio.toFixed(3)})`)
    await new Promise((r) => setTimeout(r, 300)) // 레이트리밋 예방
  }
  const ratios = Object.values(result.models[model]).map((v) => v.ratio)
  if (ratios.length) {
    const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length
    const spread = Math.max(...ratios) - Math.min(...ratios)
    result.models[model]._summary = { meanRatio: Number(mean.toFixed(4)), spread: Number(spread.toFixed(4)) }
    console.log(`  → 평균 ×${mean.toFixed(3)}, 유형 간 편차폭 ${spread.toFixed(3)} (편차폭이 크면 언어별 보정 필요)`)
  }
}

const out = join(ROOT, 'scripts/calibration-result.json')
await writeFile(out, JSON.stringify(result, null, 2))
console.log(`\n저장됨: ${out}`)
console.log('다음 단계: 이 파일을 커밋하면, UI가 언어를 감지해 보정된 추정치를 표시하도록 연결한다.')
