// 중앙 API 키 관리 — 벤더별 키를 한 곳에서 입력/보관한다.
// 저장은 옵트인 하나로 통제: 켜면 입력된 키 전부 localStorage, 끄면 전부 삭제(메모리만).
// Anthropic·OpenRouter의 storage 이름은 구버전(정확측정·실험대 개별 입력 시절)과
// 호환되도록 그대로 유지한다.

export const KEY_VENDORS = [
  { vendor: 'Anthropic',    storage: 'tokencalc_anthropic_key',  placeholder: 'sk-ant-...', issue: 'console.anthropic.com' },
  { vendor: 'OpenAI',       storage: 'tokencalc_openai_key',     placeholder: 'sk-...',     issue: 'platform.openai.com' },
  { vendor: 'Google',       storage: 'tokencalc_google_key',     placeholder: 'AIza...',    issue: 'aistudio.google.com/apikey' },
  { vendor: 'DeepSeek',     storage: 'tokencalc_deepseek_key',   placeholder: 'sk-...',     issue: 'platform.deepseek.com' },
  { vendor: 'Zhipu (Z.ai)', storage: 'tokencalc_glm_key',        placeholder: 'xxxx.xxxx',  issue: 'z.ai / bigmodel.cn' },
  { vendor: 'OpenRouter',   storage: 'tokencalc_openrouter_key', placeholder: 'sk-or-...',  issue: 'openrouter.ai/keys' },
]

const PERSIST_FLAG = 'tokencalc_keys_persist'
const GLM_ENDPOINT_STORAGE = 'tokencalc_glm_endpoint' // 'z'(국제판) | 'cn'(중국판)

const mem = new Map() // vendor -> key (항상 메모리가 원본, localStorage는 부본)

export function initKeys() {
  for (const v of KEY_VENDORS) {
    const saved = localStorage.getItem(v.storage)
    if (saved) mem.set(v.vendor, saved)
  }
  // 과거 버전은 키 존재 자체가 저장 동의였다 — 플래그 없이 키가 있으면 동의로 승계
  return localStorage.getItem(PERSIST_FLAG) === '1' || mem.size > 0
}

export function getKey(vendor) {
  return mem.get(vendor)?.trim() || null
}

export function setKey(vendor, value, persist) {
  const v = value.trim()
  if (v) mem.set(vendor, v)
  else mem.delete(vendor)
  const storage = KEY_VENDORS.find((k) => k.vendor === vendor)?.storage
  if (!storage) return
  if (persist && v) localStorage.setItem(storage, v)
  else localStorage.removeItem(storage)
}

export function setPersist(persist) {
  localStorage.setItem(PERSIST_FLAG, persist ? '1' : '0')
  for (const v of KEY_VENDORS) {
    const key = mem.get(v.vendor)
    if (persist && key) localStorage.setItem(v.storage, key)
    else localStorage.removeItem(v.storage)
  }
}

export function getGlmEndpoint() {
  return localStorage.getItem(GLM_ENDPOINT_STORAGE) === 'cn' ? 'cn' : 'z'
}

export function setGlmEndpoint(v) {
  localStorage.setItem(GLM_ENDPOINT_STORAGE, v)
}
