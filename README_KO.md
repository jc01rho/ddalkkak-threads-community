# 딸깍 Threads 공장 Community

**무료 오픈소스 Community 버전**입니다. AGPL-3.0으로 공개합니다.

개인용 Threads 콘텐츠 제작 및 예약 발행 **로컬 실행 프로그램**입니다. Windows 10/11의
내 PC에서만 돌아가고, 서버는 `127.0.0.1`/`::1`에만 바인딩되며 기본 포트는 **3970**입니다
(`http://localhost:3970`). 브라우저 자동화(Playwright/Selenium/CDP)나 비공식 조작,
탐지 회피 기법을 전혀 사용하지 않습니다. Threads 게시는 **Meta 공식 Threads API**
(`graph.threads.net`)만 사용합니다.

공식 사이트: [https://pulse-audio.co.kr/](https://pulse-audio.co.kr/) (Pulse Factory)

---

## 주요 기능

- **자료 수집** — RSS 피드, 직접 입력한 URL, 붙여넣은 텍스트, 키워드·주제
- **글 생성** — Claude Code CLI로 Threads 게시글 초안 생성
- **검토 → 승인 → 예약 → 발행** — 초안함에서 수정·승인하고 원하는 시간에 예약, 자동 발행
- **미디어 발행** — 이미지 / 영상 / 캐러셀(2~3장)
- **말투(페르소나) 설정** — 모든 글 만들기에 공통 적용
- **데이터 백업 / 초기화**

## Windows 실행 파일(EXE)

Community **v1.11.7**을 공개했습니다. Windows 설치 파일을 **GitHub Releases**에서 바로
받을 수 있습니다.

- [v1.11.7 Release](https://github.com/apache3563-bit/ddalkkak-threads-community/releases/tag/v1.11.7)
- 설치 파일: `DdalkkakThreadsFactory_Community_Setup_1.11.7.exe`

설치 파일이 가장 간단한 경로입니다. Node.js를 따로 설치하지 않아도 되고, 필요한 실행 환경이
설치본 안에 함께 들어 있습니다. 소스에서 직접 빌드해 쓰는 방법도 계속 지원합니다(아래 "1. 설치 방법").

---

## 목차
0. Relay(self-host) 설정 (아래 별도 절)
1. 설치 방법
2. Claude Code 로그인 확인
3. Meta 개발자 앱 생성 절차
4. Threads API 권한과 토큰 설정
5. DRY_RUN 테스트 방법
6. 실제 발행 전 체크리스트
7. Windows 시작 시 자동 실행하는 방법
8. 오류 해결법
9. 사용량 및 보안 주의사항
10. 이 도구가 탐지 회피 프로그램이 아니라는 점

---

## 1. 설치 방법

설치 방법은 두 가지입니다. **프로그램을 쓰려는 것이라면 A를 권합니다.**

### A. 설치 파일로 설치 (일반 사용자 · 권장)

1. [v1.11.7 Release](https://github.com/apache3563-bit/ddalkkak-threads-community/releases/tag/v1.11.7)에서 `DdalkkakThreadsFactory_Community_Setup_1.11.7.exe`를 내려받습니다.
2. 내려받은 파일을 실행해 설치합니다. 관리자 권한이 필요하지 않습니다.
3. 시작 메뉴나 바탕화면의 바로가기로 실행하면 기본 브라우저가 열립니다.

Node.js 설치, `install.bat`, `start.bat`은 이 경로에서 필요하지 않습니다.

### B. 소스에서 직접 실행 (개발 · 검증용)

1. [Node.js 22 이상](https://nodejs.org)을 설치합니다 (LTS 버전 권장).
   - 의존성 중 `better-sqlite3`가 Node.js 22 이상을 요구합니다.
   - (참고) 이 저장소의 빌드·동작 검증은 Node.js 24.13.1에서 수행했습니다.
2. 이 저장소 폴더에서 `install.bat`을 더블클릭합니다.
   - Node.js 버전을 확인합니다.
   - `claude` CLI 설치 여부를 확인합니다(없어도 설치는 계속됩니다).
   - `npm ci --ignore-scripts`로 의존성을 설치합니다(수 분 소요 가능).
   - `npm run build`로 TypeScript를 빌드합니다.
   - `.env.example`을 복사해 `.env`를 만듭니다(기본값 `DRY_RUN=true`).
   - `data`, `logs` 폴더를 만듭니다.
3. 설치가 끝나면 `start.bat`을 실행합니다. 서버가 켜지고,
   브라우저에서 `http://localhost:3970` 로 접속하면 됩니다.

### C. Linux · macOS에서 실행

소스 실행(B)과 같은 방법으로 `npm ci && npm run build && npm start`로 띄웁니다.
- 상품 레이더의 짧은 영상·GIF 만들기를 쓰려면 시스템에 `ffmpeg`가 있어야 합니다(예: `sudo apt install ffmpeg`).
  Windows 번들의 h264_mf 대신 libx264(없으면 libopenh264)로 인코딩합니다.
- Threads 앱 시크릿은 암호화 없이 본인만 읽을 수 있는 파일(권한 600)로 저장되어, 재연결 때 다시 입력하지 않아도 됩니다.

> `npm ci`가 실패하면: 인터넷 연결, Node.js 버전(`node --version`이 v22 이상인지)을 확인하세요.
> `better-sqlite3` 설치 중 오류가 나면 8번 "오류 해결법"을 참고하세요.

---

## 2. Claude Code 로그인 확인

이 프로그램은 별도의 Anthropic API 키를 요구하지 않고, **현재 컴퓨터에 로그인된 Claude Code CLI**를
그대로 사용합니다. 시작 시 자동으로 `claude --version`을 실행해 설치 여부를 확인합니다.

### 이미 Claude Desktop을 쓰고 있다면

Windows용 Claude Desktop 중 Claude Code를 함께 설치하는 버전은
`%APPDATA%\Claude\claude-code\<버전>\claude.exe`에 실행 파일을 둡니다. 이 위치는 PATH에
등록되지 않아 `where claude`로는 찾을 수 없지만, **딸깍이 이 경로를 직접 확인하므로
Claude Code를 따로 설치하지 않아도 그대로 연결됩니다.**

- 이 경우 아래 설치 절차는 건너뛰고 3번으로 넘어가세요.
- 다만 **모든 Claude Desktop 버전이 Claude Code를 포함하는 것은 아닙니다.** 위 폴더가 없거나
  프로그램이 계속 "미연결"로 표시되면 아래 절차로 Claude Code를 설치하세요.
- 딸깍은 Claude 로그인 정보(비밀번호·API 키·토큰)를 요구하거나 저장하지 않습니다.
  이미 로그인된 Claude Code를 그대로 호출할 뿐입니다.

### Claude Code를 직접 설치하는 경우

1. `where claude`(cmd) 또는 `Get-Command claude`(PowerShell)로 이미 설치되어 있는지 먼저 확인하세요.
   "찾지 못했습니다"가 나오면 PATH에 없는 것입니다. 위의 Desktop 경로도 함께 확인해 보세요.
2. 설치 (Windows, 공식 설치 스크립트 - 관리자 권한 필요 없음):
   - **PowerShell**: `irm https://claude.ai/install.ps1 | iex`
   - **cmd**: `curl -fsSL https://claude.ai/install.cmd -o install.cmd && install.cmd && del install.cmd`
   - 설치 후 아무 터미널에서나 `claude`를 입력하면 로그인 절차(브라우저 인증)가 시작됩니다.
     Claude Code는 Pro/Max/Team/Enterprise 계정이 필요하며, 무료 claude.ai 플랜으로는 사용할 수 없습니다.
   - `npm install -g` 로 설치한 경우(`%APPDATA%\npm\claude.cmd`)도 딸깍이 함께 인식합니다.
3. 설치/로그인 후 새 터미널(cmd)을 열고 아래 명령이 버전을 출력하는지 확인하세요.
   ```
   claude --version
   ```
   (기존에 열어둔 cmd 창은 PATH가 갱신되지 않으니, 설치 후에는 반드시 새 창에서 확인하세요.)
4. 정상 동작하면 "Threads 글 6개 만들기" 버튼을 눌렀을 때 프로그램이 내부적으로
   `claude -p --output-format json --max-turns 2` 형태로 호출합니다.
   (인자는 배열로 전달되어 셸 인젝션 위험이 없습니다. 프롬프트는 명령행 인자가 아니라 stdin으로
   전달합니다 - Windows에서 프롬프트를 인자로 넘기면 "stdin 데이터를 기다렸다가 진행합니다"
   경고와 함께 응답이 실패하는 문제가 있었습니다. Claude에게 파일 수정이나 명령 실행 권한을
   전혀 주지 않고, 글 JSON 생성만 요청합니다.)

claude CLI가 없어도 서버는 켜지지만, 글 생성 버튼을 누르면 오류가 표시되고
"다시 시도" 안내가 나옵니다.

---

## 3. Meta 개발자 앱 생성 절차

> **처음 연결하는 경우** 화면 그림이 함께 있는 공식 연결설명서를 먼저 참고하세요 —
> <https://pulse-audio.co.kr/pages/ddalkkak-threads-connect.html>

아래 절차는 2026년 8월 기준 Meta for Developers 공식 문서
(`developers.facebook.com/docs/threads`)를 근거로 작성했습니다. 블로그나 오래된 영상의
예제를 따라하지 말고, 실제 진행 시에도 공식 문서를 함께 확인하세요.

1. https://developers.facebook.com/apps 에서 새 앱을 만듭니다.
2. 앱 생성 과정에서 **"Threads" 사용 사례(Use Case)**를 추가합니다.
   - 이때 일반 Facebook 앱 ID/Secret과 별도로 **Threads 앱 ID / Threads 앱 Secret**이 발급됩니다.
     Threads API 호출에는 반드시 Threads용 앱 ID/Secret을 사용하세요.
3. **App Dashboard → App roles → Roles** 에서 "Add People" → **Threads Tester**로
   본인의 Threads 계정을 초대합니다. (개인용 도구이므로 본인 계정만 추가하면 됩니다)
4. Threads 앱/웹의 **설정 → Website permissions**에서 초대를 수락합니다.
5. 이제 OAuth 인증(Authorization Window)을 통해 아래 권한(permission)에 대한 동의를 받고
   Authorization Code → 단기 토큰 → 장기 토큰 순으로 발급받습니다. (4번 참고)

---

## 4. Threads API 권한과 토큰 설정

### 필요한 권한(permission)
- `threads_basic` — 모든 Threads API 호출에 필수
- `threads_content_publish` — 게시(발행) 기능에 필수

### 토큰 발급 절차 (공식 문서 기준)
1. Authorization Window로 사용자 동의를 받고 **Authorization Code**(1시간 유효)를 받습니다.
2. Authorization Code를 **단기 액세스 토큰**(1시간 유효)으로 교환합니다.
3. 단기 토큰을 **장기 액세스 토큰**(60일 유효)으로 교환합니다:
   ```
   GET https://graph.threads.net/access_token
     ?grant_type=th_exchange_token
     &client_secret=<THREADS_APP_SECRET>
     &access_token=<SHORT_LIVED_ACCESS_TOKEN>
   ```
4. 만료 전에 아래 요청으로 60일씩 갱신할 수 있습니다(24시간 이상 지난 토큰만 갱신 가능):
   ```
   GET https://graph.threads.net/refresh_access_token
     ?grant_type=th_refresh_token
     &access_token=<LONG_LIVED_ACCESS_TOKEN>
   ```
5. 아래 요청으로 본인의 Threads 사용자 ID를 확인합니다:
   ```
   GET https://graph.threads.net/v1.0/me?fields=id,username&access_token=<TOKEN>
   ```

### .env 설정
`.env` 파일을 열어 아래 값을 채웁니다(웹 화면에서는 입력받지 않습니다 - 보안 때문입니다).
```
THREADS_ACCESS_TOKEN=여기에_장기_액세스_토큰
THREADS_USER_ID=여기에_확인한_사용자ID
```
저장 후 서버를 재시작하면 "Threads API 설정" 화면과 대시보드에서 연결 상태를 확인할 수 있습니다.
화면에는 토큰 앞 4자리/뒤 4자리만 마스킹되어 표시됩니다.

> Instagram/Threads 비밀번호, 쿠키, 세션 정보는 이 프로그램 어디에서도 요구하거나 저장하지 않습니다.

---

## 5. DRY_RUN 테스트 방법

`.env`의 `DRY_RUN=true`가 기본값입니다. 이 상태에서는:
- 예약 시간이 지난 글이 있어도 **실제로 Threads에 게시되지 않습니다.**
- 대신 "발행 기록" 화면에 `[DRY_RUN]` 표시가 붙은 로그가 남습니다(모의 발행 내용 기록).
- 처리된 초안의 상태는 `dry_run_done`으로 바뀝니다(실제 `published`와 구분되며, "다음 예약"/예약함 목록에서는 빠집니다).

**중요: 대시보드의 "자동 발행" 토글이 켜져 있어야 스케줄러가 동작합니다.** 이 토글이 꺼진 상태(기본값)에서는
예약 시간이 지난 글이 있어도 스케줄러가 조회만 하고 아무 것도 처리하지 않습니다(DRY_RUN 모의 처리도 하지 않음).
가장 안전한 기본 상태를 유지하기 위한 설계입니다.

DRY_RUN 모드는 Threads 액세스 토큰/사용자 ID가 없어도 항상 정상 동작합니다(토큰 검사를 하지 않습니다).
Threads API 설정 검사는 실제 게시(DRY_RUN=false)를 시도할 때만 수행됩니다.

테스트 순서:
1. 대시보드에서 "자동 발행" 체크박스를 켭니다.
2. 초안함에서 글을 승인(approve) → 예약함에서 가까운 시간(Asia/Seoul 기준 현재 시각 근처)으로 예약합니다.
3. 예약 시간이 지나면(스케줄러가 1분마다 확인) 발행 기록에 `[DRY_RUN]` 로그가 남고,
   초안 상태가 `dry_run_done`으로 바뀌는지 확인합니다. 서버를 실행한 콘솔(cmd) 창에도
   `[scheduler] 글 #.. → DRY_RUN 처리 완료` 같은 로그가 출력됩니다.
4. `test.bat`을 실행하면 이 과정(자동 발행 꺼짐/켜짐, DRY_RUN 처리, 상태 전환, 중복 방지, 시간대 변환)을
   자동으로 검증하는 통합 테스트가 함께 돌아갑니다.

---

## 6. 실제 발행 전 체크리스트

아래를 **모두** 만족해야 실제 발행이 이루어집니다(하나라도 빠지면 발행되지 않습니다).

- [ ] `.env`의 `THREADS_ACCESS_TOKEN`, `THREADS_USER_ID`가 올바르게 설정됨
- [ ] "Threads API 설정" 화면에서 "토큰 검증하기"를 눌러 성공 확인
- [ ] `.env`의 `DRY_RUN`을 `false`로 변경 (기본값 `true`에서 의도적으로 바꿔야 함)
- [ ] 글 상태가 `scheduled`(예약됨)인지 확인 — `draft` 상태 글은 절대 발행되지 않습니다
- [ ] 예약 시간이 실제로 도달했는지 확인
- [ ] 본문이 비어 있지 않은지 확인
- [ ] 같은 글이 이미 발행 기록에 남아있지 않은지 확인(중복 발행 방지 로직이 자동으로 막아줍니다)
- [ ] `DAILY_MAX_PUBLISH`(기본 6개)로 하루 발행량이 과도하지 않게 설정됨

체크리스트를 다 지켰다면 `.env`를 저장하고 서버를 재시작하세요.

---

## 7. Windows 시작 시 자동 실행하는 방법

**방법 A: 작업 스케줄러(권장)**
1. Windows 검색에서 "작업 스케줄러"를 엽니다.
2. "기본 작업 만들기" → 이름 입력(예: 딸칵Threads공장) → 트리거: "로그온할 때" 선택
3. 동작: "프로그램 시작" → 프로그램/스크립트에 `start.bat`의 전체 경로 입력
   (예: `<설치폴더>\start.bat`)
4. "시작 위치"에도 프로젝트 폴더 경로를 넣어야 상대경로(.env, data 등)가 제대로 동작합니다.

**방법 B: 시작 프로그램 폴더**
1. `Win + R` → `shell:startup` 입력 후 이동
2. `start.bat`의 바로가기를 만들어 이 폴더에 복사

두 방법 모두, 서버가 백그라운드에서 켜진 상태로 유지되며 예약 발행이 계속 확인됩니다.
(컴퓨터가 꺼져 있으면 당연히 예약 발행도 진행되지 않습니다.)

---

## 8. 오류 해결법

| 증상 | 원인/해결 |
|---|---|
| `install.bat` 실행 시 "Node.js가 설치되어 있지 않습니다" | nodejs.org 에서 Node 20+ 설치 후 콘솔 재시작 |
| `npm install` 중 better-sqlite3 관련 오류 | Node 버전을 20 LTS로 맞추거나, "Desktop development with C++" 워크로드(Visual Studio Build Tools)를 설치 후 재시도 |
| 대시보드에 "Claude Code: 미연결" | `claude --version`을 콘솔에서 직접 실행해 로그인 상태 확인 |
| "Threads 글 6개 만들기" 실패 + JSON 파싱 실패 | `logs/claude-failure-*.txt`에 원문 응답이 저장됩니다. 원인을 확인 후 "다시 시도" |
| Threads API 연결 실패 | 토큰 만료(60일) 가능성 - `refresh_access_token`으로 갱신하거나 재발급 |
| 발행이 안 되고 로그에 "인증 오류(재시도 안 함)" | 토큰/권한 문제입니다. 자동 재시도하지 않으므로 토큰을 재발급하세요 |
| 포트 3970 충돌 | `.env`의 `PORT` 값을 다른 번호로 변경 |
| 예약해도 계속 DRY_RUN 로그만 남음 | `.env`의 `DRY_RUN=false`로 바꾸고 서버 재시작했는지 확인 |

---

## 9. 사용량 및 보안 주의사항

- 하루 최대 발행 수는 기본 6개이며, Meta 공식 API의 하루 한도(약 250건)보다 훨씬 낮게 운영합니다.
- 비밀번호, Instagram 비밀번호, Chrome 쿠키, 세션 정보는 절대 요구/저장하지 않습니다.
- Threads 액세스 토큰은 `.env`에만 저장되며, 웹 화면과 로그에는 앞 4자리/뒤 4자리만 표시됩니다.
- `.gitignore`에 `.env`, 실제 DB 파일, 로그 파일, 말투 설정(개인 데이터), 토큰이 포함되지 않도록
  이미 설정되어 있습니다. 이 프로젝트를 Git 저장소로 올릴 계획이라면 커밋 전 반드시 재확인하세요.
- 인증 오류는 자동으로 재시도하지 않습니다(토큰 유출/무한 재시도로 인한 계정 위험 방지).

---

## 10. 이 도구가 탐지 회피 프로그램이 아니라는 점

- 이 프로그램은 브라우저 자동화(Playwright, Selenium), CDP(Chrome DevTools Protocol) 연결,
  비공식 Threads 조작, X(트위터) 무단 스크래핑을 **전혀 사용하지 않습니다.**
- 자료 수집은 공개 RSS 피드, 사용자가 직접 등록한 공개 웹페이지(URL), 사용자가 직접 붙여넣은
  텍스트, 사용자가 입력한 키워드·주제로만 제한됩니다. X/Threads/Instagram/Facebook 게시물을
  자동으로 긁어오지 않으며, 새로운 유료 검색 API도 사용하지 않습니다.
- URL 직접 입력은 SSRF 방지를 위해 localhost/사설 IP/내부망 주소 접근을 기본 차단합니다.
- Threads 게시는 Meta가 공식 제공하는 Threads Graph API(`graph.threads.net`)만 사용하며,
  OAuth로 발급받은 정식 액세스 토큰으로 인증합니다.
- 플랫폼의 정책이나 요청 빈도 제한을 우회하려는 로직이 없으며, 오히려 하루 발행 수를
  API 한도보다 훨씬 낮게 제한하는 안전장치를 기본 탑재하고 있습니다.
- 이 도구는 "내가 직접 승인한 글을, 내 계정으로, 공식 API를 통해, 내가 정한 시간에" 올려주는
  개인용 콘텐츠 제작/예약 발행 보조 도구입니다.

---

## Relay(self-host) 설정

이미지·영상·캐러셀 발행과 [Threads 계정 연결하기] 버튼은 **HTTPS 공개 주소**를 필요로 합니다.
로컬 PC(`127.0.0.1`)는 Meta 서버가 접근할 수 없기 때문입니다.

Community 버전은 **공용 중계 서버를 제공하지 않습니다.** 저장소의 `workers/` 폴더에 있는
Cloudflare Workers 소스를 **각자 자신의 Cloudflare 계정에 직접 배포(self-host)** 해서 씁니다.

- `workers/threads-media-relay/` — 이미지·영상·캐러셀 발행용 (R2 사용)
- `workers/threads-oauth-relay/` — Threads OAuth 콜백 중계용 (KV 사용)

각 폴더의 `README.md`와 `wrangler.jsonc.example`에 배포 절차가 있습니다.

### Relay 3종 설정값

Worker를 배포한 뒤, **설치 폴더의 `.env`** 를 열어 아래 3개를 채웁니다.
저장소에는 빈 값으로만 배포되며, 다른 사람의 Relay 주소나 키는 들어 있지 않습니다.

```
THREADS_MEDIA_RELAY_BASE_URL=   # 배포한 media relay Worker의 https base URL
THREADS_OAUTH_RELAY_URL=        # 배포한 oauth relay Worker의 https base URL
THREADS_RELAY_CLIENT_KEY=       # 두 Worker에 등록한 접속 키와 동일한 값
```

`THREADS_RELAY_CLIENT_KEY`는 직접 정한 뒤 Worker 쪽에도 같은 값을 등록합니다.

```
wrangler secret put THREADS_RELAY_CLIENT_KEY
```

값을 바꾼 뒤에는 프로그램을 다시 시작하세요.

### Relay를 설정하지 않으면

Relay 없이도 **대부분의 기능이 그대로 동작합니다.**

| 동작함 | 동작하지 않음 |
|---|---|
| 자료 수집 · 글 생성 · 검토 · 승인 · 예약 · **텍스트 발행** | 이미지 / 영상 / 캐러셀 발행 |
| 말투 설정 · 데이터 백업 | [Threads 계정 연결하기] 원클릭 OAuth |

Threads 계정 연결은 Relay 없이도 가능합니다 — 설정 화면의 **고급 연결 설정**에서 직접 발급한
액세스 토큰을 넣으면 됩니다(위 "4. Threads API 권한과 토큰 설정" 참고).

미디어 발행은 Relay 대신 직접 마련한 HTTPS 터널을 `THREADS_MEDIA_PUBLIC_BASE_URL`로
지정하는 방법도 있습니다(자세한 조건은 `.env.example` 주석 참고).


## 데이터와 자격증명 저장 위치

**모두 내 PC에만 저장됩니다.** 외부 서버로 보내지 않습니다.

| 항목 | 위치 |
|---|---|
| 수집 자료·초안·예약·발행 기록·상품 데이터 | 설치 폴더의 `data/app.db` (SQLite) |
| 업로드한 이미지·영상 | 설치 폴더의 `data/uploads/` |
| 로그 | 설치 폴더의 `logs/` |
| Threads 액세스 토큰 | `%APPDATA%\DdalkkakThreadsFactoryCommunity\threads\` |
| 설정값(포트·Relay 주소 등) | 설치 폴더의 `.env` |

Instagram/Threads 비밀번호, 쿠키, 세션 정보는 어디에서도 요구하거나 저장하지 않습니다.
화면과 로그에는 토큰의 앞 4자리/뒤 4자리만 표시됩니다.

---

## 더 자세한 설명서

화면별 사용법 등 상세 설명서는 공식 사이트에서 제공합니다.
<https://pulse-audio.co.kr/>

- Threads 연결설명서(연결 방식 선택, Relay 설정, 문제 해결) — <https://pulse-audio.co.kr/pages/ddalkkak-threads-connect.html>

---

## 폴더 구조

```
ddalkkak-threads-community/
├── package.json / tsconfig.json
├── src/
│   ├── server.ts        # Express 서버 진입점
│   ├── database.ts      # SQLite 스키마/쿼리
│   ├── claude.ts         # Claude Code CLI 호출
│   ├── rss.ts            # RSS/URL/텍스트/키워드 자료 수집
│   ├── urlSafety.ts      # URL 직접 입력 SSRF 방지
│   ├── excerpt.ts        # 자료 원문에서 관련 문단 우선 발췌
│   ├── keywordInput.ts   # 키워드·주제 입력 파싱
│   ├── threads-api.ts    # Meta 공식 Threads API 호출
│   ├── scheduler.ts      # node-cron 기반 예약 발행
│   └── routes/           # REST API 라우트
├── public/                # 프론트엔드 (Vanilla HTML/CSS/JS)
├── data/                  # default-persona.json, default-feeds.json, app.db(실행 후 생성)
├── workers/               # self-host Relay (Cloudflare Workers)
├── launcher/ installer/   # Windows 실행 파일·설치 파일 빌드 소스
├── scripts/               # Windows 빌드 스크립트
├── install.bat / start.bat / start-release.bat
└── .env.example
```

## 라이선스 및 책임

이 Community 버전의 소스는 **AGPL-3.0**으로 공개합니다. 전문은 저장소 루트의
[LICENSE](LICENSE) 파일을 참고하세요.

Copyright (c) 2026 Pulse Factory

Meta의 Threads API 이용 약관 및 플랫폼 정책을 준수할 책임은 이 도구를 사용하는
사용자 본인에게 있습니다.

---

## 공식 사이트

Pulse Factory — <https://pulse-audio.co.kr/>
