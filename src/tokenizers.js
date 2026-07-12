// 토크나이저 로더 — 타입별 Promise 캐시 (참고 코드 검토에서 지적한 싱글턴 레이스 방지 구조)
// 동시 호출은 같은 Promise를 공유하고, 한 번 로드된 토크나이저는 세션 내내 재사용된다.

const cache = new Map() // type -> Promise<{ encode(text): number[] }>

async function build(type) {
  // OpenAI 계열: 순수 JS (gpt-tokenizer), WASM/에셋 다운로드 불필요
  if (type === 'o200k') {
    const m = await import('gpt-tokenizer/encoding/o200k_base')
    return { encode: (t) => m.encode(t) }
  }
  if (type === 'cl100k') {
    const m = await import('gpt-tokenizer/encoding/cl100k_base')
    return { encode: (t) => m.encode(t) }
  }

  // 나머지: HuggingFace tokenizer.json / SentencePiece → @mlc-ai/web-tokenizers (WASM)
  const { Tokenizer } = await import('@mlc-ai/web-tokenizers')
  const fetchBuf = async (path) => {
    const res = await fetch(path)
    if (!res.ok) throw new Error(`토크나이저 파일 로드 실패: ${path} (${res.status})`)
    return res.arrayBuffer()
  }

  switch (type) {
    case 'claude':      return wrap(await Tokenizer.fromJSON(await fetchBuf('token/claude/claude.json')))
    case 'llama3':      return wrap(await Tokenizer.fromJSON(await fetchBuf('token/llama/llama3.json')))
    case 'deepseek':    return wrap(await Tokenizer.fromJSON(await fetchBuf('token/deepseek/tokenizer.json')))
    case 'deepseek-v4': return wrap(await Tokenizer.fromJSON(await fetchBuf('token/deepseek/v4/tokenizer.json')))
    case 'glm4':        return wrap(await Tokenizer.fromJSON(await fetchBuf('token/glm4/tokenizer.json')))
    case 'glm5':        return wrap(await Tokenizer.fromJSON(await fetchBuf('token/glm5/tokenizer.json')))
    case 'gemma':       return wrap(await Tokenizer.fromSentencePiece(await fetchBuf('token/gemma/tokenizer.model')))
    default: throw new Error(`알 수 없는 토크나이저: ${type}`)
  }
}

function wrap(tok) {
  return { encode: (t) => Array.from(tok.encode(t)) }
}

export function getTokenizer(type) {
  if (!cache.has(type)) {
    const p = build(type)
    p.catch(() => cache.delete(type)) // 로드 실패 시 다음 호출에서 재시도 가능
    cache.set(type, p)
  }
  return cache.get(type)
}

export async function tokenize(text, type) {
  if (!text) return []
  return (await getTokenizer(type)).encode(text)
}

// ── Anthropic 공식 count_tokens API (무료) — Claude 3+ 정확 계산 ──
// 브라우저 직접 호출은 anthropic-dangerous-direct-browser-access 헤더로 허용됨.
// API 키는 localStorage에만 저장되고 Anthropic 외부로 전송되지 않는다.
export async function countTokensExact(text, modelId, apiKey) {
  const res = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: text }] }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => null)
    throw new Error(err?.error?.message ?? `API 오류 (${res.status})`)
  }
  return (await res.json()).input_tokens
}
