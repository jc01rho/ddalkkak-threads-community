# threads-media-relay (개발자 전용 문서)

공식 프로젝트 안내: <https://pulse-audio.co.kr/>

> 구매자(딸깍 Threads 공장 사용자)를 위한 문서가 아닙니다. 이 Worker는 구매자가 직접
> 설치/설정/실행하는 대상이 아니며, 판매자(운영자) 측 인프라의 일부입니다.

## 상태 (2026-08-12 기준)

**QA/local 전용 - 아직 배포되지 않았습니다.** 실 Cloudflare 계정, 실 R2 bucket, 실
secret이 존재하지 않고 이 저장소 어디에도 없습니다. `npm test`는 전부 in-memory
fake/mock 대상으로만 동작하며 실 Cloudflare/R2/Apps Script를 호출하지 않습니다.
`wrangler deploy`/`wrangler login`은 이 Phase에서 한 번도 실행하지 않았습니다.

배경/설계 근거는 [`docs/design/threads-media-production-relay-design.md`](../../docs/design/threads-media-production-relay-design.md)
(특히 22절 "Phase 12.5.6B 구현 결과")를 참고하세요.

## 무엇을 하는 Worker인가

Windows app("딸깍 Threads 공장")이 Threads에 IMAGE/VIDEO/CAROUSEL을 발행할 때, 로컬
파일을 Meta가 fetch할 수 있는 공개 HTTPS URL로 바꿔주는 **production media relay**의
control-plane API입니다. 미디어 바이트 자체는 이 Worker를 절대 거치지 않습니다 -
Windows app이 R2에 직접 PUT하고, Meta가 R2에서 직접 GET합니다(control-plane/data-plane
분리). Worker가 하는 일은 정확히: license 검증, presigned URL 발급, 업로드 검증,
정리(cleanup)뿐입니다.

## 독립성

이 디렉터리는 root Windows app(저장소 루트, 예: `<repo-root>`)과 완전히 분리된
서브프로젝트입니다. 자체 `package.json`/`node_modules`/`tsconfig.json`을 가지며, root의
`package.json`/`package-lock.json`은 이 Worker와 무관하게 유지됩니다. 절대 병합하지
마세요.

## 디렉터리 구조

```
src/
  types.ts            Env 인터페이스, 공용 타입
  config.ts           media 검증 상수(크기 상한/item 개수/allowlist), TTL
  errors.ts           구조화된 error code -> HTTP status 매핑
  logging.ts          최소 sanitizer(actor 파생 해시, URL redact)
  http.ts             JSON body 파싱(크기 상한 포함), jsonResponse 헬퍼
  rateLimit.ts         Rate Limiting binding wrapper(burst 보호, best-effort)
  sessionToken.ts      HMAC-SHA256 stateless session token
  licenseValidator.ts  Apps Script license 서버 검증(RSA-SHA256, Web Crypto)
  r2Signer.ts          aws4fetch 기반 presigned PUT/GET
  r2Bucket.ts          R2Bucket binding(HEAD/DELETE) adapter
  validation.ts        POST /session 요청 검증
  routes/
    createSession.ts   POST /v1/threads-media/session
    readySession.ts    POST /v1/threads-media/ready
    cleanupSession.ts  POST /v1/threads-media/cleanup
    health.ts          GET /health
  index.ts             라우터(fetch handler) - 여기서만 경로/메서드/rate limit 처리
test/                 100+ mock/unit 테스트(실 Cloudflare/R2 미사용)
wrangler.jsonc.example  배포 설정 템플릿(실 값 없음 - 그대로 배포에 쓸 수 없음)
```

## 로컬 개발

```bash
npm install
npm run typecheck
npm run build
npm test
```

`npm test`는 `pretest`로 먼저 `build`를 실행한 뒤 `dist/test/*.test.js`를 실행합니다.
(주: 이 개발 환경의 Node 설치본은 `node --test <디렉터리>`처럼 디렉터리를 통째로
넘기면 테스트 러너가 아니라 일반 진입 스크립트로 오인하는 현상이 있어, 명시적
`dist/test/*.test.js` glob을 씁니다. 다른 환경에서는 `node --test dist/test`도 될 수
있으나 이 저장소 기준 스크립트는 glob 방식으로 고정했습니다.)

`wrangler`는 설치/실행하지 않았습니다 - 이 Phase는 로컬 코드/테스트까지만입니다.

## 배포 전 반드시 필요한 것 (다음 Phase)

1. Cloudflare 계정 + R2 bucket 생성
2. `wrangler.jsonc.example`을 `wrangler.jsonc`로 복사하고 `R2_ACCOUNT_ID`/`R2_BUCKET_NAME`/
   `PRESIGNED_URL_TTL_SECONDS` 값을 채움(이 파일은 `.gitignore`에 있어 커밋되지 않음)
3. secret은 반드시 `wrangler secret put`으로만 등록(절대 `wrangler.jsonc`에 평문으로
   적지 않음): `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `RELAY_SESSION_HMAC_SECRET`,
   `THREADS_RELAY_CLIENT_KEY`(앱 `.env`의 같은 이름 값과 동일해야 함)
4. R2 bucket binding(`RELAY_BUCKET`)과 Rate Limiting binding(`SESSION_RATE_LIMITER`,
   선택)을 `wrangler.jsonc`에 연결
5. `wrangler deploy`

이 문서를 작성하는 시점까지 위 1~5는 **어느 것도 수행하지 않았습니다.**

## 알려진 제약/향후 판단이 필요한 것

- Rate Limiting binding은 burst 방지용일 뿐 정확한 일일 quota 집행 수단이 아닙니다.
  정확한 quota가 필요하면 별도 카운팅 저장소(D1/Durable Object)가 필요하며 이번
  Phase 범위 밖입니다.
- 만료된 session token은 `/cleanup`에서도 거부합니다 - 드문 orphan object는 R2
  lifecycle 규칙(일 단위, 최대 24시간 이내 삭제)이 최종 backstop입니다.
- Pulse Factory가 이 Worker를 실제로 호스팅할 플랫폼인지는 아직 확인되지 않았습니다
  (design doc 19절).

## 절대 하지 말 것

- R2 Access Key/Secret, `RELAY_SESSION_HMAC_SECRET`을 Windows app/installer/`.env.example`/
  로그/커밋에 포함시키지 않습니다.
- 이 Worker에 미디어 바이너리를 프록시하는 route를 추가하지 않습니다(control-plane만).
- client가 object key를 직접 지정하게 하지 않습니다(항상 서버가 난수 생성).
- presigned URL을 장기(수 시간~일 단위)로 발급하지 않습니다.
