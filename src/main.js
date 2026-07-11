import { MODELS, estimateCost, effectivePricing, saveOverride, formatUSD } from './pricing.js'
import { tokenize, countTokensExact } from './tokenizers.js'

const $ = (id) => document.getElementById(id)
const KEY_STORAGE = 'tokencalc_anthropic_key'

let currentTokens = []
let lastTime = 0

// ── 모델 셀렉트 구성 ──
for (const m of MODELS) {
  const opt = document.createElement('option')
  opt.value = m.id
  opt.textContent = m.name
  $('model').appendChild(opt)
}

const selectedModel = () => MODELS.find((m) => m.id === $('model').value)

// ── 계산 (디바운스) ──
let timer
function scheduleRecalc() {
  clearTimeout(timer)
  timer = setTimeout(recalc, 250)
}

async function recalc() {
  const model = selectedModel()
  const text = $('input').value
  try {
    const start = performance.now()
    currentTokens = await tokenize(text, model.tokenizer)
    lastTime = performance.now() - start
    $('time').textContent = text
      ? `계산 시간 ${lastTime.toFixed(1)} ms · 로컬 토크나이저(${model.tokenizer}) 기준 추정치`
      : ''
  } catch (e) {
    $('time').textContent = `오류: ${e.message}`
    currentTokens = []
  }
  render()
}

function render() {
  const model = selectedModel()
  const inTok = currentTokens.length
  const outTok = Math.max(0, Number($('out-tokens').value) || 0)

  $('in-tokens').textContent = inTok.toLocaleString()
  $('total-tokens').textContent = (inTok + outTok).toLocaleString()
  $('tok-count').textContent = inTok
  $('tokens-raw').textContent = inTok ? JSON.stringify(currentTokens) : ''

  // 가격 상태 표시
  const p = effectivePricing(model)
  if (p.input != null) {
    $('price-status').textContent =
      `가격: 입력 $${p.input}/1M · 출력 $${p.output}/1M` +
      (p.overridden ? ' (직접 입력값)' : model.verified ? ` (${model.verified} 공식 요금표)` : '')
  } else {
    $('price-status').textContent = '가격 미등록 — 토큰 수만 계산됩니다'
  }

  // 비용 패널
  const useCache = $('use-cache').checked
  $('cache-ttl').style.display = useCache ? '' : 'none'
  $('cache-note').style.display = useCache ? '' : 'none'

  const usage = useCache
    ? { inputTokens: 0, outputTokens: outTok, cacheReadTokens: inTok, cacheWriteTTL: $('cache-ttl').value }
    : { inputTokens: inTok, outputTokens: outTok }
  const cost = inTok > 0 ? estimateCost(model, usage) : null
  const costPlain = inTok > 0 ? estimateCost(model, { inputTokens: inTok, outputTokens: outTok }) : null

  $('cost-panel').style.display = cost ? '' : 'none'
  $('no-price-msg').style.display = (!cost && p.input == null && inTok > 0) ? '' : 'none'

  if (cost) {
    $('cost-basis').textContent = 'USD / 요청당'
    const rows = []
    if (useCache) {
      rows.push(['캐시 읽기 (' + inTok.toLocaleString() + ' tok)', formatUSD(cost.cacheReadCost)])
    } else {
      rows.push(['입력 (' + inTok.toLocaleString() + ' tok)', formatUSD(cost.inputCost)])
    }
    rows.push(['출력 (' + outTok.toLocaleString() + ' tok)', formatUSD(cost.outputCost)])
    let html = rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')
    html += `<tr class="total"><td>합계</td><td>${formatUSD(cost.totalCost)}</td></tr>`
    if (useCache && costPlain) {
      const saved = costPlain.totalCost - cost.totalCost
      html += `<tr><td>캐시 미사용 시</td><td>${formatUSD(costPlain.totalCost)} <span class="green">(−${formatUSD(saved)})</span></td></tr>`
    }
    $('cost-table').innerHTML = html
  }

  // Claude 정확 측정 패널
  $('exact-panel').style.display = model.exactApi === 'anthropic' ? '' : 'none'
}

// ── 가격 직접 입력 ──
$('price-toggle').addEventListener('click', () => {
  const box = $('price-edit')
  box.classList.toggle('open')
  if (box.classList.contains('open')) {
    const p = effectivePricing(selectedModel())
    $('price-in').value = p.input ?? ''
    $('price-out').value = p.output ?? ''
  }
})
$('price-save').addEventListener('click', () => {
  const inp = $('price-in').value === '' ? null : Number($('price-in').value)
  const out = $('price-out').value === '' ? null : Number($('price-out').value)
  saveOverride(selectedModel().id, inp, out)
  render()
})
$('price-reset').addEventListener('click', () => {
  saveOverride(selectedModel().id, null, null)
  const p = effectivePricing(selectedModel())
  $('price-in').value = p.input ?? ''
  $('price-out').value = p.output ?? ''
  render()
})

// ── Claude 정확 측정 ──
$('api-key').value = localStorage.getItem(KEY_STORAGE) ?? ''
$('exact-btn').addEventListener('click', async () => {
  const key = $('api-key').value.trim()
  const text = $('input').value
  if (!key) { $('exact-result').innerHTML = '<span class="red">API 키를 입력하세요</span>'; return }
  if (!text) { $('exact-result').innerHTML = '<span class="red">먼저 텍스트를 입력하세요</span>'; return }
  localStorage.setItem(KEY_STORAGE, key)
  $('exact-btn').disabled = true
  $('exact-result').textContent = '측정 중...'
  try {
    const exact = await countTokensExact(text, selectedModel().id, key)
    const local = currentTokens.length
    const dev = local ? ((local - exact) / exact * 100) : 0
    $('exact-result').innerHTML =
      `정확 토큰: <b class="green">${exact.toLocaleString()}</b> · 로컬 추정 ${local.toLocaleString()} ` +
      `(편차 <b>${dev > 0 ? '+' : ''}${dev.toFixed(1)}%</b>)`
  } catch (e) {
    $('exact-result').innerHTML = `<span class="red">${e.message}</span>`
  } finally {
    $('exact-btn').disabled = false
  }
})

// ── 이벤트 바인딩 ──
$('input').addEventListener('input', scheduleRecalc)
$('model').addEventListener('change', recalc)
$('out-tokens').addEventListener('input', render)
$('use-cache').addEventListener('change', render)
$('cache-ttl').addEventListener('change', render)

render()
