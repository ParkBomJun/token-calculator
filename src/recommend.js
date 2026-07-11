// 모델 추천 엔진 — 규칙 기반 (서버·AI 불필요)
// 원리: 작업 유형 → 필요 티어 산출 → 티어를 충족하는 모델 중, 모델별 "자기 토크나이저로 실측한
// 토큰 수 × 자기 가격"이 가장 싼 것을 추천. 습관적 최상위 모델 선택 대비 절약액을 병기한다.

import { getModels, estimateCost, effectivePricing, tierLabel } from './pricing.js'
import { tokenize } from './tokenizers.js'
import { detectProfile, correctTokens } from './correction.js'

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

  const profile = detectProfile(text)
  const rows = models.map((model) => {
    const raw = tokenCounts.get(model.tokenizer)
    const corr = raw != null ? correctTokens(raw, model.id, profile) : null
    const tokens = corr?.tokens ?? null
    const usage = { inputTokens: tokens ?? 0, outputTokens: opts.outputTokens }
    const perRun = tokens != null ? estimateCost(model, usage) : null
    return {
      model,
      tokens,
      accuracy: corr?.accuracy ?? null,
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

  const langAdvice = buildLangAdvice(recommended, rows, needTier, opts)

  return { needTier, rows, recommended, topTierRow, langAdvice }
}

export const LANG_LABELS = { ko: '한국어', en: '영어', zh: '중국어' }

/**
 * 언어 축 조언 — 두 축을 분리해서 판단한다:
 *  · understand(프롬프트 이해): 변환 허용 시 더 잘 이해하는 언어로 프롬프팅 권장 (우회 가능)
 *  · generate(출력 생성 품질): 결과물 언어의 품질 한계 — 변환으로 우회 불가, 대안 모델 병기
 */
function buildLangAdvice(recommended, rows, needTier, opts) {
  const outLang = opts.outputLang ?? 'ko'
  const lang = recommended?.model.lang
  if (!lang) return null
  const advice = { promptLang: null, qualityAlt: null }

  // ① 프롬프팅 언어: 변환 허용 시, 결과물 언어보다 더 잘 이해하는 언어가 있으면 권장
  const u = lang.understand
  const bestU = Math.max(u.ko ?? 0, u.en ?? 0, u.zh ?? 0)
  if ((u[outLang] ?? 0) < bestU) {
    const bests = Object.keys(LANG_LABELS).filter((l) => u[l] === bestU)
    advice.promptLang = {
      langs: bests,
      allowed: !!opts.allowConvert,
      text: opts.allowConvert
        ? `권장 프롬프팅 언어: ${bests.map((l) => LANG_LABELS[l]).join(' 또는 ')} — 이 모델은 ${LANG_LABELS[outLang]} 지시 이해가 상대적으로 약합니다. 변환 시 지시 준수율과 토큰 효율이 개선됩니다 (응답은 "${LANG_LABELS[outLang]}로 답하라" 지시로 유지)`
        : `참고: 이 모델은 ${bests.map((l) => LANG_LABELS[l]).join('·')} 프롬프트를 더 잘 이해합니다. "프롬프트 변환 허용"을 켜면 반영해 안내합니다`,
    }
  }

  // ② 출력 품질: 결과물 언어 생성이 만점이 아니면, 만점 모델 중 최저가 대안 병기
  if ((lang.generate?.[outLang] ?? 0) < 3) {
    const alt = rows.find((r) =>
      r.monthly != null && r.model.tier >= needTier &&
      r.model.lang?.generate?.[outLang] === 3 && r.model.id !== recommended.model.id)
    if (alt) {
      advice.qualityAlt = {
        row: alt,
        text: `${LANG_LABELS[outLang]} 결과물 품질이 최우선이면: ${alt.model.name} (월 ${alt.monthly < 0.01 ? '$' + alt.monthly.toFixed(6) : '$' + alt.monthly.toFixed(2)}) — ${LANG_LABELS[outLang]} 생성 상위권. 이 차이는 프롬프트 변환으로 메울 수 없습니다`,
      }
    }
  }
  return (advice.promptLang || advice.qualityAlt) ? advice : null
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
