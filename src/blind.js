// A/B 블라인드 실험대 — "벤치마크 말고 내 작업으로 직접 판정한다"
// 두 모델에 같은 프롬프트를 보내 무작위 순서로 익명 제시 → 사용자가 투표 → 공개·전적 누적.
// 호출은 OpenRouter 단일 경유: 키 하나로 전 카탈로그를 커버하고, 네이티브 usage
// 패스스루가 실측 검증돼 있어(캘리브레이션 ×1.000) 토큰·비용 집계가 정확하다.
// 벤더 직행을 안 여는 이유: CSP connect-src에 도메인을 늘릴수록 키 유출 표면이 커진다.
// (6개 벤더 전부 CORS 자체는 열려 있음을 2026-07-12 실측 — README §7 기록)

const TALLY_STORAGE = 'tokencalc_blind_tally'

/** OpenRouter로 1회 생성. @returns { text, usage: { prompt_tokens, completion_tokens } } */
export async function callOpenRouter(orModelId, prompt, maxTokens, apiKey) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
      'x-title': 'token-calculator',
    },
    body: JSON.stringify({
      model: orModelId,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => null)
    throw new Error(err?.error?.message ?? `OpenRouter 오류 (${res.status})`)
  }
  const data = await res.json()
  const text = data.choices?.[0]?.message?.content ?? ''
  if (!text) throw new Error(`빈 응답 (finish: ${data.choices?.[0]?.finish_reason ?? '?'}) — max_tokens가 추론에 다 쓰였을 수 있습니다. 예상 출력 토큰을 늘려보세요`)
  return { text, usage: data.usage ?? {} }
}

// ── 전적 (localStorage, 모델쌍 단위) ──

function pairKey(idA, idB) {
  return [idA, idB].sort().join('|')
}

export function loadTally(idA, idB) {
  try {
    const all = JSON.parse(localStorage.getItem(TALLY_STORAGE) ?? '{}')
    return all[pairKey(idA, idB)] ?? { wins: {}, ties: 0, trials: 0 }
  } catch {
    return { wins: {}, ties: 0, trials: 0 }
  }
}

/** @param winnerId 승자 모델 id, 무승부는 null */
export function recordResult(idA, idB, winnerId) {
  let all
  try { all = JSON.parse(localStorage.getItem(TALLY_STORAGE) ?? '{}') } catch { all = {} }
  const key = pairKey(idA, idB)
  const t = all[key] ?? { wins: {}, ties: 0, trials: 0 }
  t.trials++
  if (winnerId) t.wins[winnerId] = (t.wins[winnerId] ?? 0) + 1
  else t.ties++
  all[key] = t
  localStorage.setItem(TALLY_STORAGE, JSON.stringify(all))
  return t
}

export function resetTally(idA, idB) {
  try {
    const all = JSON.parse(localStorage.getItem(TALLY_STORAGE) ?? '{}')
    delete all[pairKey(idA, idB)]
    localStorage.setItem(TALLY_STORAGE, JSON.stringify(all))
  } catch { /* 저장소 손상 시 무시 */ }
}
