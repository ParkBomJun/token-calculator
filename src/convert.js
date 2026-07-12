// 프롬프트 언어 변환기 — 추천 결과의 "권장 프롬프팅 언어"를 실제로 적용한다.
// 모드 ① 키 없음: 변환 지시문을 만들어 사용자가 평소 쓰는 AI에 붙여넣는다 (변환 비용 0)
// 모드 ② 본인 키: Haiku로 즉시 변환 — Anthropic 직행 또는 OpenRouter 폴백 (vendors.js)

import { LANG_LABELS } from './recommend.js'

export const CONVERT_MODEL = 'claude-haiku-4-5'

// 변환문 끝에 붙일 "결과물 언어 유지" 지시 — 대상 모델이 확실히 따르도록 대상 언어로 쓴다
const RESPOND_DIRECTIVES = {
  en: { ko: 'Always respond in Korean.', zh: 'Always respond in Chinese.', en: '' },
  zh: { ko: '请始终用韩语回答。', en: '请始终用英语回答。', zh: '' },
  ko: { en: '항상 영어로 답하세요.', zh: '항상 중국어로 답하세요.', ko: '' },
}

export function respondDirective(targetLang, outputLang) {
  return RESPOND_DIRECTIVES[targetLang]?.[outputLang] ?? ''
}

function conversionRules(targetLang, outputLang) {
  const directive = respondDirective(targetLang, outputLang)
  return [
    `단순 번역이 아니라 "AI에게 줄 프롬프트"로서 ${LANG_LABELS[targetLang]}로 자연스럽게 다시 쓴다 (지시의 의도·구조·순서 보존)`,
    '코드 블록·변수명·고유명사·수치·플레이스홀더({변수} 등)는 원문 그대로 둔다',
    directive && `변환문 맨 끝에 다음 한 줄을 덧붙인다: "${directive}"`,
    '변환된 프롬프트만 출력한다 (설명·인사말 없이)',
  ].filter(Boolean)
}

/** 모드 ①: 아무 AI 채팅에나 붙여넣을 변환 지시문 */
export function buildKeylessPrompt(text, targetLang, outputLang) {
  const rules = conversionRules(targetLang, outputLang).map((r, i) => `${i + 1}. ${r}`).join('\n')
  return `아래 [원문] 프롬프트를 ${LANG_LABELS[targetLang]}로 변환해줘.\n${rules}\n\n[원문]\n${text}`
}

/** 모드 ②의 시스템 프롬프트 — 전송은 vendors.js generate()가 담당한다 */
export function conversionSystem(targetLang, outputLang) {
  return `당신은 프롬프트 변환기다. 사용자가 보낸 프롬프트를 ${LANG_LABELS[targetLang]}로 변환한다. 규칙:\n` +
    conversionRules(targetLang, outputLang).map((r, i) => `${i + 1}. ${r}`).join('\n')
}
