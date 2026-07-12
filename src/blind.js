// A/B 블라인드 실험대 — "벤치마크 말고 내 작업으로 직접 판정한다"
// 두 모델에 같은 프롬프트를 보내 무작위 순서로 익명 제시 → 사용자가 투표 → 공개·전적 누적.
// 전송은 vendors.js generate()가 담당(벤더 키 직행 우선, OpenRouter 폴백) — 이 파일은
// 전적(localStorage) 관리만 남는다.

const TALLY_STORAGE = 'tokencalc_blind_tally'

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
