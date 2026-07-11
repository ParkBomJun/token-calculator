import { loadCatalog, getModels, getModel, estimateCost, effectivePricing, saveOverride, formatUSD, tierLabel } from './pricing.js'
import { tokenize, countTokensExact } from './tokenizers.js'
import { TASK_TYPES, TOLERANCES, buildComparison, explain } from './recommend.js'

const $ = (id) => document.getElementById(id)
const KEY_STORAGE = 'tokencalc_anthropic_key'

let currentTokens = []
let lastTime = 0

const selectedModel = () => getModel($('model').value)

// ── 초기화: 카탈로그 로드 후 UI 구성 ──
async function init() {
  await loadCatalog()

  // 모델 셀렉트 (벤더별 그룹)
  const byVendor = new Map()
  for (const m of getModels()) {
    if (!byVendor.has(m.vendor)) byVendor.set(m.vendor, [])
    byVendor.get(m.vendor).push(m)
  }
  for (const [vendor, models] of byVendor) {
    const group = document.createElement('optgroup')
    group.label = vendor
    for (const m of models) {
      const opt = document.createElement('option')
      opt.value = m.id
      opt.textContent = m.name + (m.input == null ? ' (토큰 수만)' : '')
      group.appendChild(opt)
    }
    $('model').appendChild(group)
  }

  // 추천 폼 셀렉트
  for (const t of TASK_TYPES) {
    const opt = document.createElement('option')
    opt.value = t.id; opt.textContent = t.label
    $('reco-task').appendChild(opt)
  }
  for (const t of TOLERANCES) {
    const opt = document.createElement('option')
    opt.value = t.id; opt.textContent = t.label
    if (t.id === 'medium') opt.selected = true
    $('reco-tol').appendChild(opt)
  }

  render()
}

// ── 계산 (디바운스) ──
let timer
function scheduleRecalc() {
  clearTimeout(timer)
  timer = setTimeout(recalc, 250)
}

async function recalc() {
  const model = selectedModel()
  if (!model) return
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
  if (!model) return
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
      `가격: 입력 $${p.input}/1M · 출력 $${p.output}/1M · ${tierLabel(model.tier)} 등급` +
      (p.overridden ? ' (직접 입력값)' : model.verified ? ` (${model.verified} 확인)` : '')
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

  // Claude 정확 측정 패널 (Anthropic 모델만)
  $('exact-panel').style.display = model.vendor === 'Anthropic' ? '' : 'none'
}

// ── 파일 불러오기 ──
$('file-btn').addEventListener('click', () => $('file-input').click())
$('file-input').addEventListener('change', async (e) => {
  const file = e.target.files?.[0]
  if (!file) return
  $('input').value = await file.text()
  $('file-name').textContent = `${file.name} (${(file.size / 1024).toFixed(1)} KB)`
  recalc()
})

// ── 모델 추천 ──
$('reco-btn').addEventListener('click', async () => {
  const text = $('input').value
  if (!text) {
    $('reco-progress').innerHTML = '<span class="red">먼저 위에 계획서/텍스트를 입력하거나 파일을 불러오세요</span>'
    return
  }
  $('reco-btn').disabled = true
  $('reco-result').style.display = 'none'
  try {
    const opts = {
      taskType: $('reco-task').value,
      tolerance: $('reco-tol').value,
      outputTokens: Math.max(0, Number($('out-tokens').value) || 0),
      runsPerMonth: Math.max(1, Number($('reco-runs').value) || 1),
      onProgress: (msg) => { $('reco-progress').textContent = msg },
    }
    const result = await buildComparison(text, opts)
    $('reco-progress').textContent = ''

    // 추천 문구
    $('reco-verdict').innerHTML = explain(result, opts).replace(/\*\*(.+?)\*\*/g, '<b class="green">$1</b>')

    // 비교표
    const tbody = $('reco-table').querySelector('tbody')
    tbody.innerHTML = result.rows.map((r) => {
      const isReco = r.model.id === result.recommended?.model.id
      const verdict = isReco ? '<b class="green">✓ 추천</b>'
        : r.tokens == null ? '<span class="red">실측 실패</span>'
        : r.perRun === null ? '<span class="dim">가격 없음</span>'
        : r.eligible ? '충족'
        : '<span class="dim">등급 미달</span>'
      const style = isReco ? ' style="color:var(--green); font-weight:700"' : ''
      return `<tr${style}>
        <td style="text-align:left">${r.model.name}<span class="dim" style="font-size:0.75rem"> ${r.model.vendor}</span></td>
        <td>${tierLabel(r.model.tier)}</td>
        <td style="text-align:right">${r.tokens != null ? r.tokens.toLocaleString() : '—'}</td>
        <td style="text-align:right">${r.perRun ? formatUSD(r.perRun.totalCost) : '—'}</td>
        <td style="text-align:right">${r.monthly != null ? formatUSD(r.monthly) : '—'}</td>
        <td style="text-align:right">${verdict}</td>
      </tr>`
    }).join('')
    $('reco-result').style.display = ''
  } catch (e) {
    $('reco-progress').innerHTML = `<span class="red">오류: ${e.message}</span>`
  } finally {
    $('reco-btn').disabled = false
  }
})

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
// 키 저장은 옵트인: 체크 시에만 localStorage, 기본은 메모리(탭 닫으면 소멸)
const savedKey = localStorage.getItem(KEY_STORAGE)
if (savedKey) { $('api-key').value = savedKey; $('key-save').checked = true }
$('key-save').addEventListener('change', () => {
  if (!$('key-save').checked) localStorage.removeItem(KEY_STORAGE)
  else if ($('api-key').value.trim()) localStorage.setItem(KEY_STORAGE, $('api-key').value.trim())
})
$('exact-btn').addEventListener('click', async () => {
  const key = $('api-key').value.trim()
  const text = $('input').value
  if (!key) { $('exact-result').innerHTML = '<span class="red">API 키를 입력하세요</span>'; return }
  if (!text) { $('exact-result').innerHTML = '<span class="red">먼저 텍스트를 입력하세요</span>'; return }
  if ($('key-save').checked) localStorage.setItem(KEY_STORAGE, key)
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

init().catch((e) => { $('time').textContent = `초기화 오류: ${e.message}` })
