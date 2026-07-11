import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const MODEL = 'gpt-5.6-luna'
const SESSION_ID = process.argv[2]
const FIRST_INPUT_TOKENS = Number(process.argv[3])
const OUT = resolve('gpt_calibration_output.json')
const REPLY_INSTRUCTION = 'Reply with exactly ok and nothing else. Do not call tools.'

if (!SESSION_ID || !Number.isInteger(FIRST_INPUT_TOKENS)) {
  console.error('Usage: node scripts/run-gpt-calibration-b-log.mjs <session-id> <first-input-tokens>')
  process.exit(2)
}

const samples = {
  'ko-prose': '고블린 동굴 깊은 곳, 횃불이 만들어내는 그림자가 벽면을 따라 일렁였다. 모험가 일행은 좁은 통로를 지나 마침내 넓은 공동에 도착했고, 그곳에는 오래된 제단과 함께 알 수 없는 문자가 새겨진 석판이 놓여 있었다. 리더는 조심스럽게 석판에 손을 얹었다. 차가운 감촉과 함께 희미한 빛이 문자를 따라 흐르기 시작했다. 뒤에 서 있던 마법사가 낮은 목소리로 경고했다. 이것은 봉인이다. 함부로 건드리면 안 된다. 하지만 이미 늦었다. 석판의 빛은 점점 강해졌고, 공동 전체가 진동하기 시작했다.',
  'ko-instruction': '당신은 고객 상담 어시스턴트입니다. 다음 규칙을 반드시 지키세요. 첫째, 근거 문서에 없는 내용은 절대 답변하지 마세요. 둘째, 환불이나 결제 취소 요청은 즉시 상담사에게 이관하세요. 셋째, 답변은 세 문장 이내로 간결하게 작성하되 정중한 존댓말을 유지하세요. 넷째, 고객이 화를 내거나 부정적인 감정을 표현하면 공감 표현을 먼저 하고 해결책을 제시하세요. 다섯째, 개인정보를 요구하지 마세요.',
  'en-prose': 'Deep within the goblin cave, shadows cast by torchlight danced along the walls. The party of adventurers passed through a narrow corridor and finally reached a wide chamber, where an ancient altar stood beside a stone tablet engraved with unknown characters. The leader carefully placed a hand on the tablet. A faint light began to flow along the characters. The mage standing behind warned in a low voice: this is a seal, do not touch it carelessly. But it was already too late.',
  'zh-prose': '在哥布林洞穴的深处，火把投下的影子沿着墙壁摇曳。冒险者一行穿过狭窄的通道，终于到达了一个宽阔的洞厅，那里有一座古老的祭坛，旁边放着一块刻有未知文字的石板。队长小心翼翼地把手放在石板上，一道微弱的光芒开始沿着文字流动。站在后面的法师低声警告说：这是封印，不要随便触碰。但已经太迟了，石板的光芒越来越强，整个洞厅开始震动。',
  code: `export async function buildComparison(text, opts) {
  const needTier = requiredTier(opts.taskType, opts.tolerance)
  const models = getModels()
  const tokenCounts = new Map()
  for (const tk of [...new Set(models.map((m) => m.tokenizer))]) {
    try { tokenCounts.set(tk, (await tokenize(text, tk)).length) }
    catch { tokenCounts.set(tk, null) }
  }
  return models.map((model) => ({ model, tokens: tokenCounts.get(model.tokenizer) }))
}`,
  mixed: '프로젝트 마감은 7/25(금)입니다. API 응답의 p95 latency가 3.5s를 초과하면 rollback 하세요. 담당: 김민수(minsu.kim@example.com), Slack #proj-alpha 채널. 예산: $12,400 (약 1,700만 원). 진행률 78% 🚀 남은 태스크: DB 마이그레이션, i18n 적용, QA 2 라운드.',
}

const doubled = (text) => `${text}\n${text}`
const turns = []
for (const [name, text] of Object.entries(samples)) {
  turns.push({ name, scale: 'x1', text })
  turns.push({ name, scale: 'x2', text: doubled(text) })
}

const output = {
  model: MODEL,
  method: 'B-log',
  results: Object.fromEntries(Object.keys(samples).map((name) => [name, { x1: 0, x2: 0 }])),
}
output.results['ko-prose'].x1 = FIRST_INPUT_TOKENS
writeFileSync(OUT, `${JSON.stringify(output, null, 2)}\n`)

for (let index = 1; index < turns.length; index += 1) {
  const turn = turns[index]
  const args = [
    'exec', 'resume',
    '--ignore-user-config',
    '--skip-git-repo-check',
    '--json',
    '-m', MODEL,
    '-c', 'approval_policy="never"',
    '-c', `developer_instructions=${JSON.stringify(REPLY_INSTRUCTION)}`,
    '-c', 'web_search="disabled"',
    '-c', 'model_reasoning_effort="low"',
    SESSION_ID,
    turn.text,
  ]

  const run = spawnSync('codex', args, {
    cwd: '/tmp',
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
    stdio: ['inherit', 'pipe', 'pipe'],
  })

  if (run.status !== 0) {
    console.error(run.stderr.trim())
    process.exit(run.status ?? 1)
  }

  const events = run.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  const completed = events.findLast((event) => event.type === 'turn.completed')
  const reply = events.findLast(
    (event) => event.type === 'item.completed' && event.item?.type === 'agent_message',
  )?.item?.text
  const inputTokens = completed?.usage?.input_tokens

  if (reply !== 'ok' || !Number.isInteger(inputTokens)) {
    console.error(`Unexpected turn result for ${turn.name}/${turn.scale}: ${JSON.stringify({ reply, inputTokens })}`)
    process.exit(1)
  }

  output.results[turn.name][turn.scale] = inputTokens
  writeFileSync(OUT, `${JSON.stringify(output, null, 2)}\n`)
  console.log(`[${index + 1}/${turns.length}] ${turn.name}/${turn.scale}: ${inputTokens}`)
  await new Promise((resolveSleep) => setTimeout(resolveSleep, 300))
}

console.log(OUT)
