# 토큰 계산기 (token-calculator)

LLM 프롬프트의 **토큰 수와 API 비용**을 계산하는 웹 도구. 서버 없이 전부 브라우저 안에서 동작한다.

## 기능

- **토크나이저 8종 로컬 계산**: Claude(구세대 추정), GPT o200k/cl100k, Llama3, DeepSeek V2/V4, GLM4/5, Gemma(Gemini)
- **비용 계산**: 입력/출력/총 토큰 → USD 비용. Claude는 공식 요금표 내장, 그 외 모델은 가격 직접 입력(브라우저에 저장)
- **프롬프트 캐시 비용 비교**: 캐시 읽기(0.1x)/쓰기(5분 1.25x, 1시간 2x) 적용 시 절감액 표시
- **Claude 정확 측정**: Anthropic 공식 `count_tokens` API(무료)로 실제 청구 기준 토큰 수 확인. API 키는 브라우저 localStorage에만 저장됨

## 실행

```bash
npm install
npm run dev        # 개발 서버 (http://localhost:5173)
npm run build      # dist/ 정적 빌드 → 아무 정적 호스팅에나 배포 가능
npm run preview    # 빌드 결과 로컬 확인
```

GitHub Pages: `main`에 푸시하면 Actions가 자동 빌드·배포한다 (`.github/workflows/deploy.yml`).
저장소 Settings → Pages → Source를 **GitHub Actions**로 설정할 것.

## 구조

```
index.html          UI
src/main.js         이벤트/렌더링
src/tokenizers.js   토크나이저 로더 (타입별 Promise 캐시 — 레이스 없음) + count_tokens API
src/pricing.js      가격 테이블 + 비용 산식 (가격 미등록 → 토큰 수만 계산으로 폴백)
public/token/       토크나이저 어휘 파일
```

## 정확도에 대한 주의

- 로컬 Claude 계산은 공개된 **구세대(Claude 2) 토크나이저** 기반이라 Claude 3 이후 모델의
  실제 청구 토큰과 차이가 있다(특히 한국어에서 과대 계산 경향). 정확한 값은 "정확 측정" 버튼 사용.
- OpenAI o200k/cl100k는 공식 tiktoken 어휘 그대로라 정확하다.

## 라이선스 / 출처

- 토크나이저 어휘 파일(`public/token/`)은 [RisuAI](https://github.com/kwaroran/RisuAI) 저장소(GPL-3.0)에서
  가져왔으며, 각 파일의 원 출처는 해당 모델 제공사(Anthropic, Meta, DeepSeek, Zhipu, Google)이다.
- 사용 라이브러리: [@mlc-ai/web-tokenizers](https://github.com/mlc-ai/tokenizers-cpp) (Apache-2.0),
  [gpt-tokenizer](https://github.com/niieani/gpt-tokenizer) (MIT)
