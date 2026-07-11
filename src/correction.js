// 캘리브레이션 보정 모듈 — 로컬 토큰 수를 실측 배율로 보정하고 정확도 등급을 판정한다.
// 데이터: public/calibration.json (scripts/calibrate.mjs 실측 결과 사본)
//
// 정확도 3등급:
//   exact      — 로컬 어휘가 공식 토크나이저와 동일 (오픈소스 모델, DeepSeek는 실측으로 ×1.000 검증됨)
//   calibrated — 공식 API 실측 배율로 보정된 추정치 (Claude 신형, Gemini)
//   approx     — 미검증 근사치 (GPT-5.6 세대: o200k 가정, 실측 전)

let calib = null

export async function loadCalibration() {
  if (!calib) {
    try {
      const res = await fetch('calibration.json')
      calib = res.ok ? await res.json() : { vendors: {} }
    } catch { calib = { vendors: {} } }
  }
  return calib
}

// ── 텍스트 프로파일 감지 (보정계수 선택용) ──
export function detectProfile(text) {
  const t = text.slice(0, 4000)
  let hangul = 0, han = 0, latin = 0, total = 0
  for (const ch of t) {
    const c = ch.codePointAt(0)
    if (c <= 0x20) continue
    total++
    if ((c >= 0xac00 && c <= 0xd7a3) || (c >= 0x1100 && c <= 0x11ff)) hangul++
    else if (c >= 0x4e00 && c <= 0x9fff) han++
    else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) latin++
  }
  if (!total) return 'mixed'
  const codeSignals = (t.match(/[{};]|=>|\bfunction\b|\bconst\b|\bimport\b|\breturn\b/g) ?? []).length
  if (codeSignals > total / 40 && latin / total > 0.4) return 'code'
  if (hangul / total > 0.5) return 'ko'
  if (han / total > 0.4) return 'zh'
  if (latin / total > 0.7) return 'en'
  return 'mixed'
}

export const PROFILE_LABELS = { ko: '한국어', en: '영어', zh: '중국어', code: '코드', mixed: '혼합' }

const CATEGORY_BY_PROFILE = {
  ko: ['ko-prose', 'ko-instruction'],
  en: ['en-prose'],
  zh: ['zh-prose'],
  code: ['code'],
  mixed: ['mixed'],
}

// 모델 → 보정 소스 매핑
const MODEL_CALIB = {
  'claude-fable-5':        { vendor: 'Anthropic', model: 'claude-fable-5' },
  'claude-opus-4-8':       { vendor: 'Anthropic', model: 'claude-opus-4-8' },
  'claude-sonnet-5':       { vendor: 'Anthropic', model: 'claude-sonnet-5' },
  'claude-haiku-4-5':      { vendor: 'Anthropic', model: 'claude-haiku-4-5' },
  'gemini-3-pro':          { vendor: 'Google', model: 'gemini-3.5-flash', note: '동일 계열(Flash) 실측치 적용' },
  'gemini-3-5-flash':      { vendor: 'Google', model: 'gemini-3.5-flash' },
  'gemini-3-1-flash-lite': { vendor: 'Google', model: 'gemini-3.1-flash-lite' },
  'deepseek-v4-pro':       { exact: true, measured: true },
  'deepseek-v4-flash':     { exact: true, measured: true },
  'glm-5.2':               { exact: true, measured: true }, // OpenRouter 경유 ×1.000 실측 (Claude 교차검증 통과)
  'glm-5':                 { exact: true, measured: false },
  'llama3-local':          { exact: true, measured: false },
  'gpt-5.6-sol':           { approx: true },
  'gpt-5.6-terra':         { approx: true },
  'gpt-5.6-luna':          { approx: true },
}

/**
 * @returns { tokens, accuracy: 'exact'|'calibrated'|'approx', label, ratio?, note? }
 */
export function correctTokens(rawCount, modelId, profile) {
  const m = MODEL_CALIB[modelId]
  if (!m) return { tokens: rawCount, accuracy: 'approx', label: '근사치' }
  if (m.exact) {
    return {
      tokens: rawCount, accuracy: 'exact',
      label: m.measured ? '정확 (실측 검증)' : '정확 (공식 공개 토크나이저)',
    }
  }
  if (m.approx) return { tokens: rawCount, accuracy: 'approx', label: '근사치 (신형 토크나이저 미검증)' }

  const entry = calib?.vendors?.[m.vendor]?.[m.model]
  if (!entry) return { tokens: rawCount, accuracy: 'approx', label: '근사치 (보정 데이터 없음)' }

  const cats = CATEGORY_BY_PROFILE[profile] ?? ['mixed']
  const ratios = cats.map((c) => entry[c]?.ratio).filter((r) => typeof r === 'number')
  const ratio = ratios.length
    ? ratios.reduce((a, b) => a + b, 0) / ratios.length
    : entry._summary?.meanRatio ?? 1

  return {
    tokens: Math.round(rawCount * ratio),
    accuracy: 'calibrated',
    ratio,
    label: `보정됨 ×${ratio.toFixed(2)} · ${PROFILE_LABELS[profile] ?? profile} 기준`,
    note: m.note,
  }
}
