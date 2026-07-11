# 토큰 계산기 (token-calculator)

LLM 프롬프트의 **토큰 수와 API 비용**을 계산하는 웹 도구. 서버 없이 전부 브라우저 안에서 동작한다.

**▶ 바로 사용: https://parkbomjun.github.io/token-calculator/**

---

## 1. 왜 만들었나

이 프로젝트는 RisuAI(오픈소스 LLM 채팅 프론트엔드)의 토큰 계산 코드(`tokenizer.ts`)를
검토하던 작업에서 출발했다. 검토 과정에서 두 가지를 확인했다:

1. RisuAI 내장 토크나이저 화면은 토큰 ID 배열을 그대로 뿌리는 **개발자용 도구**라서,
   "이 프롬프트가 몇 토큰이고 얼마가 나오는가"라는 실사용 질문에 답하지 못한다.
2. 계산 로직 자체에도 버그가 있었다(아래 §5 참조). 앱에 종속된 코드를 고치는 것과 별개로,
   **앱 없이 누구나 쓸 수 있는 독립 도구**가 필요하다고 판단해 이 저장소를 만들었다.

캐릭터 봇 제작(프롬프트/로어북/페르소나 작성)에서는 토큰 수가 곧 비용이자 컨텍스트 예산인데,
기존 온라인 계산기는 대부분 OpenAI tiktoken 기반이라 Claude·GLM·DeepSeek 사용자에게는
숫자가 맞지 않는다는 실제 불편이 동기였다.

## 2. 어떤 문제를 해결하나

- **모델마다 토크나이저가 달라서 토큰 수가 크게 갈린다.** 같은 한국어 한 문장이 실측으로
  GPT(o200k) 21토큰 ~ Claude(구세대) 39토큰까지 벌어진다(약 1.9배). OpenAI 기준 계산기로
  Claude 비용을 어림하면 체계적으로 틀린다. → 모델별 실제 어휘 파일로 로컬 계산.
- **토큰 수만으로는 판단이 안 된다.** 입력/예상 출력/캐시를 합친 **요청당 USD 비용**과
  프롬프트 캐시 적용 시 절감액(읽기 0.1×, 쓰기 1.25~2×)까지 계산한다.
- **Claude 3+ 는 토크나이저가 비공개라 로컬 계산이 근사치다.** Anthropic 공식
  `count_tokens` API(무료)를 연동해 실제 청구 기준 토큰 수와 로컬 추정의 편차(%)를
  바로 확인할 수 있게 했다.

## 3. 기술·구조를 왜 그렇게 선택했나

### 웹(정적 페이지) vs 설치형 프로그램

| | 정적 웹 (채택) | 설치형(CLI/Electron) |
|---|---|---|
| 설치 | 불필요, URL만 | 런타임/배포 파일 필요 |
| 공유·폰 사용 | 링크 하나 | 사실상 불가 |
| 서버 비용 | 0 (GitHub Pages) | — |

토큰화는 WASM으로 브라우저 안에서 전부 처리 가능하므로(서버가 필요한 연산이 없음)
설치형이 주는 이점이 없었다. 유일한 걱정이던 API 직접 호출(CORS)도 Anthropic이
`anthropic-dangerous-direct-browser-access` 헤더로 공식 허용해서 해소됐다.

### 세부 선택

- **Vite + 바닐라 JS (프레임워크 없음)** — 화면이 1개고 상태가 단순해서 React/Svelte는
  과투자. 의존성이 적을수록 유지보수와 코드 검토(§5)가 쉽다.
- **토크나이저 이원화** — OpenAI 계열은 순수 JS인 `gpt-tokenizer`(정확, WASM 불필요),
  나머지(HuggingFace tokenizer.json / SentencePiece 형식)는 `@mlc-ai/web-tokenizers`(WASM).
  모두 dynamic import로 코드 스플리팅해서 선택한 모델의 어휘만 내려받는다.
- **타입별 Promise 캐시 구조** (`src/tokenizers.js`) — 원본 RisuAI 코드는 "현재 로드된
  토크나이저 1개"를 전역 싱글턴으로 들고 있어서, 서로 다른 모델의 계산이 동시에 일어나면
  잘못된 토크나이저로 인코딩되는 레이스가 가능했다. 이 저장소는 처음부터
  `Map<type, Promise<Tokenizer>>`로 설계해 레이스와 중복 다운로드를 구조적으로 차단했다.
- **토큰 계산(tokenizers.js)과 비용 계산(pricing.js)의 분리 + graceful fallback** —
  가격이 등록되지 않은 모델은 `estimateCost()`가 null을 반환하고 UI는 토큰 수만 보여준다.
  **검증하지 않은 가격을 하드코딩해서 틀린 비용을 보여주는 것보다, 안 보여주는 게 낫다**는
  원칙. 대신 사용자가 UI에서 요금을 직접 입력하면 localStorage에 저장되어 계산에 쓰인다.
- **API 키를 서버로 보내지 않음** — count_tokens 호출은 브라우저 → Anthropic 직행이고
  키는 localStorage에만 남는다. 정적 호스팅이라 애초에 키를 받을 서버도 없다.

## 4. 구현 중 겪은 문제와 해결

| 문제 | 해결 |
|---|---|
| 로컬 HTML 더블클릭(`file://`)으로는 토크나이저 파일 fetch가 브라우저 보안 정책에 막힘 | 배포 형태를 GitHub Pages(정적 호스팅)로 확정. `main` 푸시 → Actions 자동 빌드·배포 |
| `@mlc-ai/web-tokenizers`가 `"type": "module"`을 선언하고서 실제로는 UMD 번들이라, Node(ESM)에서 named import가 실패 → 배포 전 스모크 테스트가 막힘 | 번들 파일을 `.cjs`로 복사해 CJS 인터롭으로 로드하는 우회로 테스트 진행. 브라우저/Vite 경로는 Vite의 CJS 인터롭이 처리하므로 실사용에는 영향 없음을 확인 |
| 공개된 Claude 어휘(claude.json)는 구세대(Claude 2) 것이라 Claude 3+ 실청구와 편차 발생 — 특히 한국어에서 과대 추정 | 로컬 값을 "추정치"로 명시하고, 공식 count_tokens API(무료) 연동으로 정확값·편차를 병기. CORS는 공식 허용 헤더로 해결 |
| 타사(GLM/DeepSeek 등) 요금을 공식 확인 없이 넣으면 틀린 비용을 보여줄 위험 | 미등록 모델은 비용 표시 자체를 생략하고, "가격 직접 입력" 기능으로 사용자가 채우는 구조로 전환 |
| 어휘 파일이 총 ~43MB (GLM·Llama3 각 8MB대) — 첫 로드 부담 | 모델 선택 시에만 해당 파일을 지연 로드. 한 번 로드되면 세션 내 재사용(브라우저 캐시 + Promise 캐시) |
| 저장소 공개 범위(Public) 결정 | 무료 Pages 호스팅은 공개 저장소 전용 → 민감 정보가 코드에 없음을 확인하고 사용자 승인 후 공개로 생성 |

## 5. AI가 만든 코드를 어떻게 검토·수정하는가

이 저장소는 **사람(설계·방향 결정·최종 검토) ↔ AI(구현·사전 검증·설계 리뷰)** 의
교차 검토 방식으로 개발한다. 어느 쪽 산출물이든 상대가 검토한다.

**이 프로젝트의 출발점 자체가 AI 코드 검토였다.** RisuAI 원본 `tokenizer.ts`를 검토해
실제 버그를 찾아냈고, 그 교훈이 이 코드 설계에 반영됐다:

- llama3 선택 시 구형 llama 토크나이저로 계산되는 오매핑 (한 줄짜리 오타가 모든 llama3
  사용자의 토큰 수를 틀리게 만듦) → **이 저장소는 토크나이저 매핑을 switch 한 곳에 모으고
  스모크 테스트로 8종 전부의 결과를 실측**
- Gemma 토크나이저가 llama3 어휘를 로드하는 자산 불일치 → **어휘 파일 경로를 로더에
  명시적으로 1:1 대응시키고, 모델별 토큰 수가 서로 달라야 정상이라는 점을 테스트 관점으로 사용**
- 전역 싱글턴 레이스(§3) → **Promise 캐시 구조로 원천 차단**

이 저장소 코드에 대해 배포 전 실제로 수행한 검증:

1. **토크나이저 8종 실측 스모크 테스트** — 한국어+영어+이모지 혼합 문장을 8종 전부에
   통과시켜 결과가 (a) 오류 없이 나오고 (b) 모델별로 서로 다르며 (c) 알려진 경향(구형
   Claude가 한국어에서 최다 토큰)과 일치함을 확인. 실측값: o200k 21 / gemma 23 / llama3 24 /
   deepseek 27 / glm 29 / claude 39.
2. **빌드 검증** — `vite build` 성공 및 코드 스플리팅(어휘별 청크 분리) 확인.
3. **배포 후 검증** — 배포 URL의 페이지(200)와 어휘 파일 서빙(claude.json 200, 1.77MB)을
   직접 요청해서 확인.

한계도 기록해 둔다: 브라우저 UI 상호작용(버튼·캐시 토글 등)은 자동화 테스트가 아직 없고
수동 확인에 의존한다. vitest 기반 단위 테스트(비용 산식, 토크나이저 회귀) 추가가 다음 과제다.
AI가 작성한 코드에서 결함이 발견되면 이 README의 §4에 사례로 추가한다.

---

## 실행

```bash
npm install
npm run dev        # 개발 서버 (http://localhost:5173)
npm run build      # dist/ 정적 빌드
npm run preview    # 빌드 결과 로컬 확인
```

배포: `main`에 푸시하면 GitHub Actions가 자동 빌드·배포 (`.github/workflows/deploy.yml`).

## 구조

```
index.html          UI
src/main.js         이벤트/렌더링
src/tokenizers.js   토크나이저 로더 (타입별 Promise 캐시) + count_tokens API
src/pricing.js      가격 테이블 + 비용 산식 (미등록 가격 → 토큰 수만 계산으로 폴백)
public/token/       토크나이저 어휘 파일 (~43MB)
```

## 라이선스 / 출처

- 토크나이저 어휘 파일(`public/token/`)은 [RisuAI](https://github.com/kwaroran/RisuAI)
  저장소(GPL-3.0)에서 가져왔으며, 원 출처는 각 모델 제공사(Anthropic, Meta, DeepSeek, Zhipu, Google)다.
- 사용 라이브러리: [@mlc-ai/web-tokenizers](https://github.com/mlc-ai/tokenizers-cpp) (Apache-2.0),
  [gpt-tokenizer](https://github.com/niieani/gpt-tokenizer) (MIT)
- Claude 가격표: Anthropic 공식 요금(2026-06 확인). 캐시 배율: 읽기 0.1× / 쓰기 5분 1.25× / 1시간 2×.
