// 모델 추천 엔진 — 규칙 기반 (서버·AI 불필요)
// 원리: 작업 유형 → 필요 티어 산출 → 티어를 충족하는 모델 중, 모델별 "자기 토크나이저로 실측한
// 토큰 수 × 자기 가격"이 가장 싼 것을 추천. 습관적 최상위 모델 선택 대비 절약액을 병기한다.

import { getModels, estimateCost, effectivePricing, tierLabel } from './pricing.js'
import { tokenize } from './tokenizers.js'

export const TASK_TYPES = [
  { id: 'simple',  label: '분류 · 요약 · 추출 · 포맷 변환', baseTier: 1 },
  { id: 'general', label: '일반 대화 · 글쓰기 · 번역',        baseTier: 2 },
  { id: 'coding',  label: '코딩 · 디버깅',                   baseTier: 2 },
  { id: 'agent',   label: '고난도 추론 · 장기 에이전트 작업',  baseTier: 3 },
]

export const TOLERANCES = [
  { id: 'high',   label: '실수 허용 (검수하며 씀)',        tierDelta: -1 },
  { id: 'medium', label: '보통',                          tierDelta: 0 },
  { id: 'low',    label: '실수 비용 큼 (정확도 최우선)',    tierDelta: +1 },
]

export function requiredTier(taskTypeId, toleranceId) {
  const base = TASK_TYPES.find((t) => t.id === taskTypeId)?.baseTier ?? 2
  const delta = TOLERANCES.find((t) => t.id === toleranceId)?.tierDelta ?? 0
  return Math.min(3, Math.max(1, base + delta))
}

/**
 * 계획서 텍스트를 모델별 토크나이저로 실측해 비용 비교표를 만든다.
 * @param text 계획서 원문
 * @param opts { taskType, tolerance, outputTokens, runsPerMonth, onProgress? }
 * @returns { needTier, rows, recommended, topTierRow }
 *   rows: [{ model, tokens, perRun(CostEstimate|null), monthly, eligible }] 월비용 오름차순
 */
export async function buildComparison(text, opts) {
  const needTier = requiredTier(opts.taskType, opts.tolerance)
  const models = getModels()

  // 토크나이저별로 1회만 실측 (같은 어휘를 쓰는 모델은 공유)
  const tokenCounts = new Map()
  const uniqueTokenizers = [...new Set(models.map((m) => m.tokenizer))]
  for (const tk of uniqueTokenizers) {
    opts.onProgress?.(`토큰 실측 중... (${tk})`)
    try {
      tokenCounts.set(tk, (await tokenize(text, tk)).length)
    } catch (e) {
      tokenCounts.set(tk, null) // 어휘 로드 실패 → 해당 모델은 표에서 "실측 불가" 표시
    }
  }

  const rows = models.map((model) => {
    const tokens = tokenCounts.get(model.tokenizer)
    const usage = { inputTokens: tokens ?? 0, outputTokens: opts.outputTokens }
    const perRun = tokens != null ? estimateCost(model, usage) : null
    return {
      model,
      tokens,
      perRun,
      monthly: perRun ? perRun.totalCost * opts.runsPerMonth : null,
      eligible: model.tier >= needTier && perRun !== null,
    }
  })

  // 정렬: 비용 있는 것 오름차순 → 가격 미등록은 뒤로
  rows.sort((a, b) => (a.monthly ?? Infinity) - (b.monthly ?? Infinity))

  const recommended = rows.find((r) => r.eligible) ?? null
  // "습관적 최상위 선택" 기준점: 가격이 등록된 티어3 중 가장 비싼 것
  const topTierRow = [...rows].reverse().find((r) => r.model.tier === 3 && r.monthly != null) ?? null

  return { needTier, rows, recommended, topTierRow }
}

/** 추천 근거 문장 생성 */
export function explain(result, opts) {
  if (!result.recommended) return '조건을 충족하는 가격 등록 모델이 없습니다.'
  const r = result.recommended
  const task = TASK_TYPES.find((t) => t.id === opts.taskType)?.label
  let msg = `"${task}" 작업은 ${tierLabel(result.needTier)} 등급이면 충분합니다. ` +
    `필요 등급을 충족하는 모델 중 실측 비용이 가장 낮은 **${r.model.name}** (${r.model.vendor})를 추천합니다.`
  if (result.topTierRow && result.topTierRow.model.id !== r.model.id && result.topTierRow.monthly > r.monthly) {
    const saved = result.topTierRow.monthly - r.monthly
    const ratio = result.topTierRow.monthly / r.monthly
    msg += ` 최상위 모델(${result.topTierRow.model.name})을 습관적으로 쓰는 경우 대비 월 ${fmt(saved)} 절약` +
      ` (${ratio.toFixed(1)}배 차이).`
  }
  return msg
}

function fmt(v) {
  return v < 0.01 ? '$' + v.toFixed(6) : '$' + v.toFixed(2)
}
