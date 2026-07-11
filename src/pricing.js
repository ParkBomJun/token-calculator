// 토큰 비용 계산 모듈 — 토큰 "계산"(tokenizers.js)과 "비용"(이 파일)을 분리.
// 가격 미등록 모델은 estimateCost()가 null을 반환 → UI는 토큰 수만 표시.
// 사용자가 UI에서 직접 입력한 가격은 localStorage에 저장되어 기본값을 덮어쓴다.

const OVERRIDE_KEY = 'tokencalc_price_overrides'

// Claude 가격: Anthropic 공식 요금표 (2026-06 확인, USD per 1M tokens)
// 캐시 배율: 읽기 0.1x / 쓰기(5분) 1.25x / 쓰기(1시간) 2x
export const MODELS = [
  { id: 'claude-fable-5',   name: 'Claude Fable 5',   tokenizer: 'claude', input: 10, output: 50, verified: '2026-06', exactApi: 'anthropic' },
  { id: 'claude-opus-4-8',  name: 'Claude Opus 4.8',  tokenizer: 'claude', input: 5,  output: 25, verified: '2026-06', exactApi: 'anthropic' },
  { id: 'claude-sonnet-5',  name: 'Claude Sonnet 5',  tokenizer: 'claude', input: 3,  output: 15, verified: '2026-06', exactApi: 'anthropic' },
  { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', tokenizer: 'claude', input: 1,  output: 5,  verified: '2026-06', exactApi: 'anthropic' },
  // 이하 가격 미등록(null) — UI에서 직접 입력 가능, 입력 전까지는 토큰 수만 계산
  { id: 'gpt-o200k',   name: 'OpenAI GPT (o200k: 4o/o1/5)',  tokenizer: 'o200k',       input: null, output: null, verified: null },
  { id: 'gpt-cl100k',  name: 'OpenAI GPT (cl100k: GPT-4)',   tokenizer: 'cl100k',      input: null, output: null, verified: null },
  { id: 'deepseek-v4', name: 'DeepSeek V4',                  tokenizer: 'deepseek-v4', input: null, output: null, verified: null },
  { id: 'deepseek',    name: 'DeepSeek (V2/V3)',             tokenizer: 'deepseek',    input: null, output: null, verified: null },
  { id: 'glm5',        name: 'GLM 5',                        tokenizer: 'glm5',        input: null, output: null, verified: null },
  { id: 'glm4',        name: 'GLM 4/4.5/4.6',                tokenizer: 'glm4',        input: null, output: null, verified: null },
  { id: 'gemini',      name: 'Gemini (Gemma 토크나이저)',     tokenizer: 'gemma',       input: null, output: null, verified: null },
  { id: 'llama3',      name: 'Llama 3 (로컬/자체호스팅)',      tokenizer: 'llama3',      input: null, output: null, verified: null },
]

export function loadOverrides() {
  try { return JSON.parse(localStorage.getItem(OVERRIDE_KEY)) ?? {} } catch { return {} }
}

export function saveOverride(modelId, input, output) {
  const o = loadOverrides()
  if (input == null && output == null) delete o[modelId]
  else o[modelId] = { input, output }
  localStorage.setItem(OVERRIDE_KEY, JSON.stringify(o))
}

/** 오버라이드가 반영된 유효 가격. 없으면 {input:null, output:null} */
export function effectivePricing(model) {
  const ov = loadOverrides()[model.id]
  return {
    input: ov?.input ?? model.input,
    output: ov?.output ?? model.output,
    overridden: !!ov,
  }
}

const perTok = (perMTok) => perMTok / 1_000_000

/**
 * @param usage {inputTokens, outputTokens?, cacheReadTokens?, cacheWriteTokens?, cacheWriteTTL?}
 * @returns CostEstimate | null (가격 미등록이면 null)
 */
export function estimateCost(model, usage) {
  const p = effectivePricing(model)
  if (p.input == null || p.output == null) return null

  const cacheReadRate = p.input * 0.1
  const cacheWriteRate = usage.cacheWriteTTL === '1h' ? p.input * 2 : p.input * 1.25

  const inputCost = usage.inputTokens * perTok(p.input)
  const outputCost = (usage.outputTokens ?? 0) * perTok(p.output)
  const cacheReadCost = (usage.cacheReadTokens ?? 0) * perTok(cacheReadRate)
  const cacheWriteCost = (usage.cacheWriteTokens ?? 0) * perTok(cacheWriteRate)

  const totalWithoutCache =
    (usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)) * perTok(p.input)
    + outputCost

  return {
    inputCost, outputCost, cacheReadCost, cacheWriteCost,
    totalCost: inputCost + outputCost + cacheReadCost + cacheWriteCost,
    totalWithoutCache,
    overridden: p.overridden,
  }
}

export function formatUSD(v) {
  if (v === 0) return '$0'
  if (v < 0.01) return '$' + v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')
  return '$' + v.toFixed(4)
}
