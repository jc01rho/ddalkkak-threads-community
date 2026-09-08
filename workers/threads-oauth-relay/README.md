# threads-oauth-relay

공식 프로젝트 안내: <https://pulse-audio.co.kr/>

딸깍 Threads 공장의 **BYO(Bring-Your-Own) Threads OAuth HTTPS Code Relay** Cloudflare Worker.

Meta는 Threads 앱의 Redirect Callback URL에 HTTPS를 요구하므로(`http://127.0.0.1:…` 등록 거부 실측),
구매자 PC의 로컬 딸깍이 직접 callback을 받을 수 없습니다. 이 Worker가 **authorization code를
몇 분간만 맡아** 로컬 딸깍에 넘깁니다. 그게 전부입니다.

## 이 Worker가 절대 다루지 않는 것

- 구매자 Meta/Threads **App Secret** — 구매자 PC에만 존재. code→token 교환은 거기서 일어남
- Threads **Access Token** — 이 Worker는 token 교환 API를 호출하지 않음
- Threads **User ID / username** — `/me` 호출도 하지 않음

취급하는 값은 `state`, `authorization code`, 상태(`pending | ready | denied | expired`)뿐입니다.

## 흐름

```
로컬 딸깍  ──POST /oauth/start {licenseId, machineHash}──▶ Worker (license 검증, state 생성, pending 저장)
          ◀── {state, pollToken, expiresAt} ───────────────
로컬 딸깍  ── 기본 브라우저로 threads.net/oauth/authorize?…&state=<state>&redirect_uri=<Worker>/oauth/callback
사용자     ── Meta 로그인/승인
Meta      ──GET /oauth/callback?code=…&state=…──────────▶ Worker (등록된 state에 code 저장 → ready, HTML 안내)
로컬 딸깍  ──POST /oauth/poll {state, pollToken}──────────▶ Worker (ready면 code 1회 반환 후 레코드 삭제)
로컬 딸깍  ── 자기 App Secret으로 code→token→long-lived→/me→username 비교→저장 (Worker 무관)
```

## 보안 요약

| 항목 | 구현 |
|---|---|
| state entropy | Worker가 32바이트 CSPRNG(256-bit) 생성 → 클라이언트가 약한 state를 등록할 경로 없음 |
| TTL | 600초. KV `expirationTtl` + 코드 수준 `createdAt` 이중 검사 |
| one-time consume | `/poll`이 ready/denied를 응답하기 직전 레코드 삭제 → 두 번째 poll은 `expired` |
| replay(callback) | 같은 state로 두 번째 callback이 오면 `STATE_ALREADY_USED`(첫 값을 덮어쓰지 않음) |
| unknown state | 등록되지 않은 state의 callback은 저장소에 아무것도 만들지 않음 |
| poll 자격 | `/start`가 발급한 HMAC `pollToken`(state·actor·exp 포함) — state만으로는 poll 불가 |
| 라이선스 게이트 | `/start`에서만 Apps Script 검증(fail-closed). `/callback`은 등록된 state만, `/poll`은 pollToken만 |
| 로그 | code/state/pollToken/raw IP/raw license 어디에도 기록 안 함(`test/noCodeLeak.test.ts`가 강제) |
| 오류 응답 | code/state/Meta 오류 원문을 응답에 포함하지 않음. callback 실패는 동일한 일반 HTML |
| 플랫폼 로그 | `observability.enabled=false`. Logpush/Tail Worker 연결 금지(URL query에 code가 있음) |

## Meta callback에 license 헤더가 없어도 안전한 이유

callback이 할 수 있는 일은 "이미 등록된 pending state에 code를 한 번 붙이는 것"뿐입니다.
등록된 state는 license 검증을 통과한 `/start`만 만들 수 있고 256-bit라 추측이 불가능하며, 붙인
code는 pollToken 보유자(= 그 `/start`를 호출한 로컬 딸깍)만 꺼낼 수 있습니다. 등록되지 않은
state로는 레코드가 생기지 않으므로 저장소를 채우는 남용도 불가능합니다.

## 개발

```bash
npm install
npm run typecheck
npm test          # build 후 dist/test/*.test.js 실행 - 전부 in-memory, 외부 호출 0
```

## 배포(다음 Phase - 이번 Phase에서는 실행하지 않음)

1. `cp wrangler.jsonc.example wrangler.jsonc` 후 placeholder 채우기
2. `wrangler kv namespace create OAUTH_STATE_KV` → 출력된 id를 `wrangler.jsonc`에 기입
3. `wrangler secret put OAUTH_POLL_HMAC_SECRET`
4. `wrangler deploy`
5. 배포 출력의 실제 URL `https://<name>.<subdomain>.workers.dev`를 확인하고
   `https://<name>.<subdomain>.workers.dev/oauth/callback`을 구매자 안내용 Redirect Callback URL로 확정
   (이 URL은 배포 후에만 알 수 있으며 미리 가정하지 않습니다)

`wrangler.jsonc`, `.dev.vars`는 `.gitignore`에 있어 커밋되지 않습니다.
