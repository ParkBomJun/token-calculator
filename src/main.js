import { loadCatalog, getModels, getModel, estimateCost, effectivePricing, saveOverride, formatUSD, tierLabel } from './pricing.js'
import { tokenize, countTokensExact } from './tokenizers.js'
import { TASK_TYPES, TOLERANCES, buildComparison, explain, LANG_LABELS } from './recommend.js'
import { loadCalibration, detectProfile, correctTokens } from './correction.js'
import { buildKeylessPrompt, convertViaAnthropic, CONVERT_MODEL } from './convert.js'

const $ = (id) => document.getElementById(id)
const KEY_STORAGE = 'tokencalc_anthropic_key'

let currentTokens = []   // 원시 토큰 배열 (보정 전)
let currentCorr = null   // 보정 결과 { tokens, accuracy, label }
let lastTime = 0

const selectedModel = () => getModel($('model').value)

// ── 초기화: 카탈로그 로드 후 UI 구성 ──
async function init() {
  await Promise.all([loadCatalog(), loadCalibration()])

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
    currentCorr = correctTokens(currentTokens.length, model.id, detectProfile(text))
    $('time').textContent = text
      ? `계산 시간 ${lastTime.toFixed(1)} ms`
      : ''
  } catch (e) {
    $('time').textContent = `오류: ${e.message}`
    currentTokens = []
    currentCorr = null
  }
  render()
}

const ACCURACY_CLASS = { exact: 'green', calibrated: '', approx: 'red' }

function render() {
  const model = selectedModel()
  if (!model) return
  const inTok = currentCorr?.tokens ?? 0
  const outTok = Math.max(0, Number($('out-tokens').value) || 0)

  // 정확도 배지
  if (currentCorr && currentTokens.length) {
    const cls = ACCURACY_CLASS[currentCorr.accuracy] ?? ''
    $('accuracy-badge').innerHTML =
      `<span class="${cls}">${currentCorr.label}</span>` +
      (currentCorr.note ? ` <span class="dim">· ${currentCorr.note}</span>` : '')
  } else {
    $('accuracy-badge').textContent = ''
  }

  $('in-tokens').textContent = inTok.toLocaleString()
  $('total-tokens').textContent = (inTok + outTok).toLocaleString()
  $('tok-count').textContent = currentTokens.length
  $('tokens-raw').textContent = currentTokens.length ? JSON.stringify(currentTokens) : ''

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
      outputLang: $('reco-lang').value,
      allowConvert: $('reco-convert').checked,
      onProgress: (msg) => { $('reco-progress').textContent = msg },
    }
    const result = await buildComparison(text, opts)
    $('reco-progress').textContent = ''
    lastReco = { result, opts, text }
    renderConverter(result, opts)

    // 추천 문구 + 언어 축 조언
    let verdictHtml = explain(result, opts).replace(/\*\*(.+?)\*\*/g, '<b class="green">$1</b>')
    if (result.langAdvice?.promptLang) {
      const p = result.langAdvice.promptLang
      verdictHtml += `<div style="margin-top:8px">${p.allowed ? '🌐 ' : ''}<span class="${p.allowed ? '' : 'dim'}">${p.text}</span></div>`
    }
    if (result.langAdvice?.qualityAlt) {
      verdictHtml += `<div style="margin-top:6px" class="dim">✍ ${result.langAdvice.qualityAlt.text}</div>`
    }
    $('reco-verdict').innerHTML = verdictHtml

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
      const accMark = r.accuracy === 'calibrated' ? '<span class="dim" style="font-size:0.7rem"> 보정</span>'
        : r.accuracy === 'approx' ? '<span class="dim" style="font-size:0.7rem"> 근사</span>' : ''
      return `<tr${style}>
        <td style="text-align:left">${r.model.name}<span class="dim" style="font-size:0.75rem"> ${r.model.vendor}</span></td>
        <td>${tierLabel(r.model.tier)}</td>
        <td style="text-align:right">${r.tokens != null ? r.tokens.toLocaleString() + accMark : '—'}</td>
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

// ── 프롬프트 언어 변환기 ──
// 추천 결과에 "권장 프롬프팅 언어" 조언이 있고 변환 허용이 켜진 경우에만 표시된다.
let lastReco = null      // { result, opts, text } — 변환·측정의 기준
let lastConvCost = null  // 모드 ②(Haiku) 변환 비용 (모드 ①은 0)

function convTargetLang() {
  return $('conv-lang-row').style.display !== 'none'
    ? $('conv-lang').value
    : lastReco?.result.langAdvice?.promptLang?.langs[0]
}

function renderConverter(result, opts) {
  const p = result.langAdvice?.promptLang
  const show = !!(p && p.allowed && result.recommended)
  $('convert-panel').style.display = show ? '' : 'none'
  if (!show) return
  // 후보 언어가 여럿이면 선택지 제공, 하나면 라벨로만 표시
  $('conv-lang-row').style.display = p.langs.length > 1 ? '' : 'none'
  if (p.langs.length > 1) {
    $('conv-lang').innerHTML = p.langs
      .map((l) => `<option value="${l}">${LANG_LABELS[l]}</option>`).join('')
  }
  $('conv-target-label').textContent =
    `— ${LANG_LABELS[opts.outputLang]} 프롬프트를 ${p.langs.map((l) => LANG_LABELS[l]).join('/')}로`
  $('conv-output').value = ''
  $('conv-status').textContent = ''
  $('conv-savings').textContent = ''
  lastConvCost = null
}

$('conv-copy').addEventListener('click', async () => {
  if (!lastReco) return
  const prompt = buildKeylessPrompt(lastReco.text, convTargetLang(), lastReco.opts.outputLang)
  await navigator.clipboard.writeText(prompt)
  $('conv-copy-msg').textContent = '복사됨 — 쓰는 AI 채팅에 붙여넣으세요'
  setTimeout(() => { $('conv-copy-msg').textContent = '' }, 4000)
})

$('conv-copy-out').addEventListener('click', async () => {
  const out = $('conv-output').value
  if (!out) return
  await navigator.clipboard.writeText(out)
  $('conv-out-msg').textContent = '복사됨'
  setTimeout(() => { $('conv-out-msg').textContent = '' }, 3000)
})

$('conv-run').addEventListener('click', async () => {
  if (!lastReco) return
  const key = $('conv-key').value.trim()
  if (!key) { $('conv-status').innerHTML = '<span class="red">Anthropic API 키를 입력하세요 (또는 방법 ①을 쓰세요)</span>'; return }
  if ($('conv-key-save').checked) localStorage.setItem(KEY_STORAGE, key)
  $('conv-run').disabled = true
  $('conv-status').textContent = `변환 중... (${CONVERT_MODEL})`
  try {
    const r = await convertViaAnthropic(lastReco.text, convTargetLang(), lastReco.opts.outputLang, key)
    $('conv-output').value = r.text
    const haiku = getModel(CONVERT_MODEL)
    lastConvCost = haiku ? estimateCost(haiku, {
      inputTokens: r.usage?.input_tokens ?? 0,
      outputTokens: r.usage?.output_tokens ?? 0,
    }).totalCost : null
    $('conv-status').innerHTML =
      `변환 완료 · 변환 비용 ${lastConvCost != null ? formatUSD(lastConvCost) : '?'}` +
      (r.truncated ? ' · <span class="red">출력 한도로 잘렸습니다 — 원문을 나눠 변환하세요</span>' : '')
    if (!r.truncated) await measureSavings()
  } catch (e) {
    $('conv-status').innerHTML = `<span class="red">${e.message}</span>`
  } finally {
    $('conv-run').disabled = false
  }
})

$('conv-measure').addEventListener('click', () => measureSavings())

async function measureSavings() {
  if (!lastReco) return
  const converted = $('conv-output').value.trim()
  if (!converted) { $('conv-savings').innerHTML = '<span class="red">변환 결과가 비어 있습니다 — 방법 ①의 결과를 붙여넣거나 즉시 변환을 실행하세요</span>'; return }
  const { result, opts, text } = lastReco
  const model = result.recommended.model
  $('conv-savings').textContent = '측정 중...'
  try {
    const before = correctTokens((await tokenize(text, model.tokenizer)).length, model.id, detectProfile(text))
    const after = correctTokens((await tokenize(converted, model.tokenizer)).length, model.id, detectProfile(converted))
    const usage = (tok) => ({ inputTokens: tok, outputTokens: opts.outputTokens })
    const costB = estimateCost(model, usage(before.tokens))
    const costA = estimateCost(model, usage(after.tokens))
    const pct = before.tokens ? ((after.tokens - before.tokens) / before.tokens * 100) : 0
    let html =
      `${model.name} 기준 입력 토큰 ${before.tokens.toLocaleString()} → <b>${after.tokens.toLocaleString()}</b> ` +
      `(<b class="${pct <= 0 ? 'green' : 'red'}">${pct > 0 ? '+' : ''}${pct.toFixed(1)}%</b>)`
    if (costB && costA) {
      const monthly = (costB.totalCost - costA.totalCost) * opts.runsPerMonth
      html += ` · 요청당 ${formatUSD(costB.totalCost)} → ${formatUSD(costA.totalCost)}` +
        ` · 월 ${opts.runsPerMonth}회 기준 <b class="${monthly >= 0 ? 'green' : 'red'}">${monthly >= 0 ? '−' : '+'}${formatUSD(Math.abs(monthly))}</b>`
      if (lastConvCost != null && monthly > 0) {
        const perRunSave = costB.totalCost - costA.totalCost
        html += ` · 변환 비용은 ${Math.ceil(lastConvCost / perRunSave).toLocaleString()}회 실행이면 회수`
      }
    }
    if (pct > 0) {
      html += '<br /><span class="dim">토큰이 오히려 늘었습니다 — 이 경우 변환의 이득은 비용이 아니라 지시 이해도입니다. 반복 실행 프롬프트가 아니면 원문 유지도 고려하세요.</span>'
    }
    $('conv-savings').innerHTML = html
  } catch (e) {
    $('conv-savings').innerHTML = `<span class="red">측정 오류: ${e.message}</span>`
  }
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
// 키 저장은 옵트인: 체크 시에만 localStorage, 기본은 메모리(탭 닫으면 소멸)
const savedKey = localStorage.getItem(KEY_STORAGE)
if (savedKey) {
  $('api-key').value = savedKey; $('key-save').checked = true
  $('conv-key').value = savedKey; $('conv-key-save').checked = true
}
// 정확측정·변환기 두 패널이 같은 키 저장소를 공유한다 — 어느 쪽에서 꺼도 함께 삭제
function bindKeySave(checkboxId, inputId, otherCheckboxId) {
  $(checkboxId).addEventListener('change', () => {
    const on = $(checkboxId).checked
    $(otherCheckboxId).checked = on
    if (!on) localStorage.removeItem(KEY_STORAGE)
    else if ($(inputId).value.trim()) localStorage.setItem(KEY_STORAGE, $(inputId).value.trim())
  })
}
bindKeySave('key-save', 'api-key', 'conv-key-save')
bindKeySave('conv-key-save', 'conv-key', 'key-save')
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
    const corrected = currentCorr?.tokens ?? 0
    const dev = corrected ? ((corrected - exact) / exact * 100) : 0
    $('exact-result').innerHTML =
      `정확 토큰: <b class="green">${exact.toLocaleString()}</b> · 보정 추정 ${corrected.toLocaleString()} ` +
      `(편차 <b>${dev > 0 ? '+' : ''}${dev.toFixed(1)}%</b>) · 원시 로컬 ${currentTokens.length.toLocaleString()}`
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
