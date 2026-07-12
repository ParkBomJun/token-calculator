// 벤더 직행 호출 어댑터 — "본인 키가 있으면 벤더 공식 API 직행(중개 마진 0),
// 없으면 OpenRouter 폴백" 라우팅을 한 곳에서 처리한다.
// 6개 벤더 전부 브라우저 CORS 허용이 실측 확인됨 (2026-07-12, README §1.7).
// 직행 모델명은 models.json의 directId(없으면 id) — 캘리브레이션에서 검증된 표기.

import { getKey, getGlmEndpoint } from './keys.js'

const GLM_ENDPOINTS = {
  z: 'https://api.z.ai/api/paas/v4/chat/completions',
  cn: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
}

async function postJSON(url, headers, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => null)
    throw new Error(err?.error?.message ?? err?.error ?? `API 오류 (${res.status})`)
  }
  return res.json()
}

// OpenAI 호환 응답(OpenAI·DeepSeek·GLM·OpenRouter) → 공통 형태
function fromOpenAIStyle(data) {
  const text = data.choices?.[0]?.message?.content ?? ''
  if (!text) throw new Error(`빈 응답 (finish: ${data.choices?.[0]?.finish_reason ?? '?'}) — max_tokens가 추론에 다 쓰였을 수 있습니다. 예상 출력 토큰을 늘려보세요`)
  return {
    text,
    usage: {
      prompt_tokens: data.usage?.prompt_tokens ?? 0,
      completion_tokens: data.usage?.completion_tokens ?? 0,
    },
    truncated: data.choices?.[0]?.finish_reason === 'length',
  }
}

const ADAPTERS = {
  Anthropic: async (model, prompt, maxTokens, key, system) => {
    const data = await postJSON('https://api.anthropic.com/v1/messages', {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    }, {
      model: model.directId ?? model.id,
      max_tokens: maxTokens,
      ...(system ? { system } : {}),
      messages: [{ role: 'user', content: prompt }],
    })
    const text = data.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
    if (!text) throw new Error(`빈 응답 (stop: ${data.stop_reason ?? '?'})`)
    return {
      text,
      usage: {
        prompt_tokens: data.usage?.input_tokens ?? 0,
        completion_tokens: data.usage?.output_tokens ?? 0,
      },
      truncated: data.stop_reason === 'max_tokens',
    }
  },

  OpenAI: async (model, prompt, maxTokens, key, system) => {
    // GPT-5 세대는 max_tokens를 거부한다 — max_completion_tokens 사용
    const data = await postJSON('https://api.openai.com/v1/chat/completions',
      { authorization: `Bearer ${key}` }, {
        model: model.directId ?? model.id,
        max_completion_tokens: maxTokens,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: prompt },
        ],
      })
    return fromOpenAIStyle(data)
  },

  Google: async (model, prompt, maxTokens, key, system) => {
    const id = model.directId ?? model.id
    const data = await postJSON(
      `https://generativelanguage.googleapis.com/v1beta/models/${id}:generateContent`,
      { 'x-goog-api-key': key }, {
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: maxTokens },
      })
    // thought: true 파트는 "사고 과정 요약" — 본문에 섞으면 답변이 중간부터 시작하는
    // 것처럼 보인다 (실사용 버그로 발견). 반드시 걸러낸다.
    const text = (data.candidates?.[0]?.content?.parts ?? [])
      .filter((p) => !p.thought)
      .map((p) => p.text ?? '').join('')
    if (!text) throw new Error(`빈 응답 (finish: ${data.candidates?.[0]?.finishReason ?? '?'}) — 출력 한도가 사고 토큰에 다 쓰였을 수 있습니다. 예상 출력 토큰을 늘려보세요`)
    const u = data.usageMetadata ?? {}
    return {
      text,
      usage: {
        prompt_tokens: u.promptTokenCount ?? 0,
        // 과금 기준에 맞춰 사고 토큰도 출력에 합산
        completion_tokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
      },
      truncated: data.candidates?.[0]?.finishReason === 'MAX_TOKENS',
    }
  },

  DeepSeek: async (model, prompt, maxTokens, key, system) => {
    const data = await postJSON('https://api.deepseek.com/chat/completions',
      { authorization: `Bearer ${key}` }, {
        model: model.directId ?? model.id,
        max_tokens: maxTokens,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: prompt },
        ],
      })
    return fromOpenAIStyle(data)
  },

  'Zhipu (Z.ai)': async (model, prompt, maxTokens, key, system) => {
    const data = await postJSON(GLM_ENDPOINTS[getGlmEndpoint()],
      { authorization: `Bearer ${key}` }, {
        model: model.directId ?? model.id,
        max_tokens: maxTokens,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: prompt },
        ],
      })
    return fromOpenAIStyle(data)
  },
}

async function viaOpenRouter(model, prompt, maxTokens, key, system) {
  const data = await postJSON('https://openrouter.ai/api/v1/chat/completions', {
    authorization: `Bearer ${key}`,
    'x-title': 'token-calculator',
  }, {
    model: model.openrouter,
    max_tokens: maxTokens,
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: prompt },
    ],
  })
  return fromOpenAIStyle(data)
}

export function routeFor(model) {
  if (ADAPTERS[model.vendor] && getKey(model.vendor)) return '직행'
  if (model.openrouter && getKey('OpenRouter')) return 'OpenRouter'
  return null
}

/**
 * 모델 1회 생성 — 벤더 키 직행 우선, 없으면 OpenRouter 폴백.
 * @returns { text, usage: { prompt_tokens, completion_tokens }, via, truncated? }
 */
// 벤더별 출력 상한 — 문서상 한도를 넘겨 보내면 요청 자체가 거부되므로 여기서 클램프
const OUTPUT_CAPS = { DeepSeek: 8192 }

export async function generate(model, prompt, maxTokens, { system } = {}) {
  maxTokens = Math.min(maxTokens, OUTPUT_CAPS[model.vendor] ?? Infinity)
  const directKey = ADAPTERS[model.vendor] ? getKey(model.vendor) : null
  if (directKey) {
    const r = await ADAPTERS[model.vendor](model, prompt, maxTokens, directKey, system)
    return { ...r, via: '직행' }
  }
  const orKey = getKey('OpenRouter')
  if (model.openrouter && orKey) {
    const r = await viaOpenRouter(model, prompt, maxTokens, orKey, system)
    return { ...r, via: 'OpenRouter' }
  }
  throw new Error(model.openrouter
    ? `${model.vendor} 키 또는 OpenRouter 키가 필요합니다 — 🔑 API 키 패널에 입력하세요`
    : `${model.vendor} 키가 필요합니다 (이 모델은 OpenRouter 미지원) — 🔑 API 키 패널에 입력하세요`)
}
