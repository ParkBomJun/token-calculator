// 비용 계산 모듈 — 토큰 "계산"(tokenizers.js)과 "비용"(이 파일)을 분리.
// 모델 카탈로그는 public/models.json에서 로드한다 (코드 수정 없이 데이터만 갱신 가능 — git이 곧 DB).
// 가격 미등록(null) 모델은 estimateCost()가 null을 반환 → UI는 토큰 수만 표시.
// 사용자가 UI에서 직접 입력한 가격은 localStorage에 저장되어 카탈로그 값을 덮어쓴다.

const OVERRIDE_KEY = 'tokencalc_price_overrides'

let catalog = null

/** models.json 로드 (1회). { updated, tierLabels, models } */
export async function loadCatalog() {
  if (!catalog) {
    const res = await fetch('models.json')
    if (!res.ok) throw new Error(`모델 카탈로그 로드 실패 (${res.status})`)
    catalog = await res.json()
  }
  return catalog
}

export function getModels() {
  return catalog?.models ?? []
}

export function getModel(id) {
  return getModels().find((m) => m.id === id)
}

export function tierLabel(tier) {
  return catalog?.tierLabels?.[String(tier)] ?? `T${tier}`
}

// ── 사용자 가격 오버라이드 ──
export function loadOverrides() {
  try { return JSON.parse(localStorage.getItem(OVERRIDE_KEY)) ?? {} } catch { return {} }
}

export function saveOverride(modelId, input, output) {
  const o = loadOverrides()
  if (input == null && output == null) delete o[modelId]
  else o[modelId] = { input, output }
  localStorage.setItem(OVERRIDE_KEY, JSON.stringify(o))
}

/** 오버라이드가 반영된 유효 가격 */
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

  // 캐시 요율: 카탈로그 명시값 우선, 없으면 관례(읽기 0.1x / Anthropic식 쓰기 1.25x·2x)로 추정
  const cacheReadRate = model.cacheRead ?? p.input * 0.1
  const cacheWriteRate = usage.cacheWriteTTL === '1h'
    ? (model.cacheWrite1h ?? p.input * 2)
    : (model.cacheWrite5m ?? p.input * 1.25)

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
  if (v < 100) return '$' + v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
  return '$' + v.toFixed(2)
}
