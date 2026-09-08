// src/env.ts
// .env 파일을 읽어서 프로그램 전체에서 쓰는 설정값(config)을 만듭니다.
// 초보자 안내: 값을 바꾸고 싶으면 .env 파일만 수정하면 됩니다. 이 파일은 건드릴 필요가 거의 없습니다.

import path from "path";
import fs from "fs";
import dotenv from "dotenv";

dotenv.config({ path: path.join(__dirname, "..", ".env") });

function toBool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v === "") return fallback;
  return v.trim().toLowerCase() === "true" || v.trim() === "1";
}

function toInt(v: string | undefined, fallback: number): number {
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

// package.json의 "version"을 읽습니다. 화면에 표시하는 버전 문자열에 그대로 씁니다
// (별도로 하드코딩하지 않음).
function readAppVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf-8"));
    return typeof pkg.version === "string" && pkg.version ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const config = {
  PORT: toInt(process.env.PORT, 3970),
  TZ: process.env.TZ || "Asia/Seoul",

  // 안전장치의 핵심: 기본값은 반드시 true (실제 발행 안 함)
  DRY_RUN: toBool(process.env.DRY_RUN, true),

  THREADS_ACCESS_TOKEN: process.env.THREADS_ACCESS_TOKEN || "",
  THREADS_USER_ID: process.env.THREADS_USER_ID || "",
  THREADS_GRAPH_BASE: "https://graph.threads.net/v1.0",

  // 컨테이너 생성 후 발행 전 대기 시간(ms). 메타 공식 문서 권장: 평균 30초 정도.
  THREADS_PUBLISH_WAIT_MS: toInt(process.env.THREADS_PUBLISH_WAIT_MS, 30000),

  DAILY_MAX_PUBLISH: toInt(process.env.DAILY_MAX_PUBLISH, 6),

  // Phase 12.5.4: 이 앱은 127.0.0.1/::1에만 바인딩되는 로컬 전용 서버라(server.ts 참고) 로컬
  // 미디어 파일을 그 자체로는 Meta 서버가 절대 가져갈 수 없습니다(localhost/127.0.0.1/file:///
  // 사설 LAN 금지). 이 값은 운영자가 스스로 마련한 공개 접근 경로(예: 터널/리버스 프록시)의
  // base origin(https://... 스킴 필수)입니다 - 특정 벤더 SDK를 앱에 내장하지 않습니다.
  //
  // 보안 감사 후 수정(같은 Phase 내 correction): 이 origin은 딸깍 메인 서버(PORT, 대시보드/
  // 드래프트/예약/설정 등 전체 /api가 있는 포트)가 아니라 아래 THREADS_MEDIA_GATEWAY_PORT
  // (그 경로 하나만 서빙하는 별도 listener)를 가리켜야 합니다 - 메인 서버 포트에 터널을 걸면
  // 그 동안 대시보드/DB/설정 API까지 함께 외부에 노출됩니다. "이 origin + 서버가 만든
  // 짧은-수명 opaque token" 조합으로 공개 URL을 만듭니다(threadsMediaUrlProvider.ts +
  // threadsMediaGateway.ts + threadsMediaListener.ts 참고 - 실제 로컬 파일명은 token 뒤에
  // 절대 노출되지 않습니다). 비어 있거나 유효하지 않으면(https 아님/localhost·사설 IP)
  // 이미지·영상 발행은 THREADS_MEDIA_PUBLIC_URL_REQUIRED로 명확히 실패합니다 - 조용히
  // TEXT로 강등하지 않습니다.
  THREADS_MEDIA_PUBLIC_BASE_URL: process.env.THREADS_MEDIA_PUBLIC_BASE_URL || "",

  // Threads 전용 미디어 게이트웨이 listener(threadsMediaListener.ts)가 열 포트. 비어
  // 있으면(기본값) 이 listener 자체를 시작하지 않습니다 - 아직 공개 미디어 URL 기능을 쓰지
  // 않는 사용자에게 여는 포트를 늘리지 않기 위함입니다. 터널/리버스 프록시는 딸깍 메인
  // PORT가 아니라 반드시 이 포트를 대상으로 해야 합니다(위 THREADS_MEDIA_PUBLIC_BASE_URL
  // 주석 참고).
  THREADS_MEDIA_GATEWAY_PORT: toInt(process.env.THREADS_MEDIA_GATEWAY_PORT, 0),

  // 미디어 게이트웨이 token의 유효 시간(ms). 컨테이너 생성 대기(THREADS_PUBLISH_WAIT_MS,
  // 기본 30초) + 영상 상태 폴링(THREADS_VIDEO_POLL_INTERVAL_MS × _MAX_ATTEMPTS, 기본
  // 최대 5분) 전체를 여유 있게 덮도록 기본 30분으로 둡니다. 이 시간이 지나면 같은 token으로
  // 다시 요청해도 410로 거부됩니다(메모리에만 존재 - 서버 재시작 시에도 전부 무효화).
  THREADS_MEDIA_TOKEN_TTL_MS: toInt(process.env.THREADS_MEDIA_TOKEN_TTL_MS, 30 * 60 * 1000),

  // Phase 12.5.6C: production media relay(Cloudflare Worker, workers/threads-media-relay/)의
  // base URL. 비어 있으면(기본값) relay를 쓰지 않고 위 THREADS_MEDIA_GATEWAY_PORT/
  // THREADS_MEDIA_PUBLIC_BASE_URL 기반 local gateway를 그대로 사용합니다(dev/QA 기본값 -
  // docs/design/threads-media-production-relay-design.md 16~17절). 설정하면 반드시
  // https://여야 하며, IMAGE/VIDEO/CAROUSEL 발행 시 threadsMediaUrlProvider.ts가 이 주소로
  // 세션을 발급받아 presigned PUT/GET을 사용합니다. R2 access key/secret, Worker HMAC
  // signing secret 등 서버 전용 값은 이 앱 어디에도 필요하지 않습니다 - 여기 필요한 건 공개
  // base URL 하나뿐입니다(요청서 8절 "필요한 최소 설정만").
  THREADS_MEDIA_RELAY_BASE_URL: process.env.THREADS_MEDIA_RELAY_BASE_URL || "",

  // P0.5: BYO Threads OAuth의 HTTPS code relay(workers/threads-oauth-relay) 공개 base URL.
  // media relay와 같은 정책 - 비밀이 아닌 공개 URL 하나뿐이며, release staging이 real .env에서
  // 주입한다(미설정이면 staging 빌드 실패). 이 Worker는 App Secret/token을 절대 받지 않고
  // authorization code를 잠시 중계만 하므로, 구매자 PC에 필요한 값은 이 주소뿐이다.
  THREADS_OAUTH_RELAY_URL: process.env.THREADS_OAUTH_RELAY_URL || "",

  // Threads 영상(VIDEO) 컨테이너는 생성 직후 바로 발행 가능하다고 가정하지 않습니다(공식 문서:
  // status 필드가 IN_PROGRESS일 수 있음). 공식 문서 권장("1분마다, 최대 5분") 그대로 기본값을
  // 둡니다. IMAGE 컨테이너도 동일한 status 확인 절차를 재사용합니다(threads-api.ts 참고).
  THREADS_VIDEO_POLL_INTERVAL_MS: toInt(process.env.THREADS_VIDEO_POLL_INTERVAL_MS, 60000),
  THREADS_VIDEO_POLL_MAX_ATTEMPTS: toInt(process.env.THREADS_VIDEO_POLL_MAX_ATTEMPTS, 5),

  DB_PATH: process.env.DB_PATH
    ? path.join(__dirname, "..", process.env.DB_PATH)
    : path.join(__dirname, "..", "data", "app.db"),

  // 테스트에서 실제 logs/ 폴더(과거 실패 로그·감사 로그 등)를 건드리지 않도록 DB_PATH/UPLOAD_DIR과
  // 동일한 패턴으로 환경변수 오버라이드를 지원합니다(기본값은 기존과 동일하게 "logs/").
  LOG_DIR: process.env.LOG_DIR ? path.join(__dirname, "..", process.env.LOG_DIR) : path.join(__dirname, "..", "logs"),

  // 테스트/CI 환경에서 스케줄러(cron)를 자동 시작하지 않도록 하는 옵션
  DISABLE_SCHEDULER: toBool(process.env.DISABLE_SCHEDULER, false),

  // 판매용 설명서(문서) 캡처 전용 모드. 기본값은 반드시 false(기존 동작 그대로).
  // true일 때만 checkClaudeCli/validateThreadsToken이 실제 CLI 실행·네트워크 호출 없이
  // 고정된 가상 연결 상태를 반환합니다(docs/tools 참고).
  DOCS_MODE: toBool(process.env.DOCS_MODE, false),

  // 실제로 spawn할 Claude Code CLI 실행 파일 이름/경로. 기본값 "claude"(PATH에서 탐색).
  // 테스트에서만 가짜 실행 파일을 주입하기 위한 용도이며, 실제 운영에서는 절대 바꿀 필요가 없습니다.
  CLAUDE_BIN: process.env.CLAUDE_BIN || "claude",

  // 테스트에서 CLAUDE_BIN을 node 실행 파일처럼 "그 자체로는 스크립트 경로가 필요한" 것으로 지정할
  // 때, 실제 인자(-p 등) 앞에 추가로 넣을 인자 목록(JSON 배열 문자열, 예: ["C:/.../fixture.js"]).
  // 운영에서는 절대 설정하지 않으며, 기본값은 빈 배열이라 기존 동작에 영향이 없습니다.
  CLAUDE_ARGS_PREFIX: (() => {
    const raw = process.env.CLAUDE_ARGS_PREFIX;
    if (!raw) return [] as string[];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map((x) => String(x)) : [];
    } catch {
      return [] as string[];
    }
  })(),

  // 쿠파스 상품 홍보 모드의 "내 사진·영상 첨부" 저장 위치. 테스트에서는 UPLOAD_DIR을 별도 폴더로
  // 지정해 실제 업로드 폴더를 건드리지 않습니다(DB_PATH와 동일한 패턴).
  UPLOAD_DIR: process.env.UPLOAD_DIR ? path.join(__dirname, "..", process.env.UPLOAD_DIR) : path.join(__dirname, "..", "data", "uploads"),

  // 첨부 파일 최대 크기(바이트). 기본 50MB.
  MAX_MEDIA_UPLOAD_BYTES: toInt(process.env.MAX_MEDIA_UPLOAD_BYTES, 50 * 1024 * 1024),

  // 상품 레이더 브라우저 확장프로그램 폴더의 고정 경로. "확장프로그램 폴더 열기" API가 여는
  // 유일한 경로이며, 클라이언트 요청에서 경로를 받지 않습니다(src/productRadar/installFolder.ts
  // 참고). 개발 환경(저장소 루트)과 Windows 설치본(스테이징 루트) 모두에서 __dirname 기준
  // 상대 경로가 동일하게 맞도록 DB_PATH/UPLOAD_DIR과 같은 패턴을 씁니다 - 설치 시
  // scripts/build-windows-staging.js가 이 폴더를 스테이징 루트(dist/public과 같은 위치)에
  // 그대로 복사하기 때문입니다. 테스트에서만 격리된 폴더로 오버라이드합니다.
  EXTENSION_FOLDER_PATH: process.env.PRODUCT_RADAR_EXTENSION_FOLDER_PATH
    ? path.join(__dirname, "..", process.env.PRODUCT_RADAR_EXTENSION_FOLDER_PATH)
    : path.join(__dirname, "..", "browser-extension"),

  // Phase 8: ProductRadarBrowser.exe의 두 가지 가능한 고정 위치. Windows 설치본에서는
  // scripts/add-product-radar-browser.js가 스테이징 루트(dist/public과 같은 위치)의
  // ProductRadarBrowser\ 아래에 배치하고, 개발 환경에서는 scripts/build-product-radar-browser.js가
  // launcher\ProductRadarBrowser\bin\ 아래에 남겨둡니다. EXTENSION_FOLDER_PATH와 달리 두 환경의
  // __dirname 기준 상대 위치가 서로 다르므로 값 하나가 아니라 후보 배열로 두고, 실제 파일이
  // 존재하는 쪽을 src/productRadar/browserLaunch.ts가 우선순위대로(설치본 먼저) 선택합니다.
  // 클라이언트 요청은 이 값에 전혀 영향을 주지 않으며, 테스트에서만 완전히 다른 고정 경로
  // 하나로 오버라이드합니다(DB_PATH/EXTENSION_FOLDER_PATH와 동일한 원칙).
  PRODUCT_RADAR_BROWSER_EXE_PATH_OVERRIDE: process.env.PRODUCT_RADAR_BROWSER_EXE_PATH
    ? path.join(__dirname, "..", process.env.PRODUCT_RADAR_BROWSER_EXE_PATH)
    : "",
  PRODUCT_RADAR_BROWSER_EXE_CANDIDATES: [
    path.join(__dirname, "..", "ProductRadarBrowser", "ProductRadarBrowser.exe"),
    path.join(__dirname, "..", "launcher", "ProductRadarBrowser", "bin", "ProductRadarBrowser.exe"),
  ],

  // Phase 12.5.3.9: LGPL FFmpeg(h264_mf) self-contained 바이너리의 고정 위치.
  // scripts/add-ffmpeg-runtime.js가 Windows 설치본 스테이징 루트(dist/public과 같은 위치)의
  // third-party\ffmpeg\ 아래에 배치한다(add-windows-runtime.js의 runtime\node.exe와 동일한
  // "빌드 시점에 검증해서 심어두고, 앱은 그 고정 경로만 읽는다" 패턴). PATH 전역 탐색은 절대
  // 하지 않는다(요청서 8절) - 여기 두 후보 경로에 실제로 파일이 있는지만 확인한다. 테스트/개발
  // 환경에서만 환경변수로 완전히 다른 경로(예: scratchpad에 검증용으로 받아둔 빌드)를 가리킬 수
  // 있다(DB_PATH/PRODUCT_RADAR_BROWSER_EXE_PATH와 동일한 override 원칙).
  FFMPEG_EXE_PATH_OVERRIDE: process.env.FFMPEG_EXE_PATH || "",
  FFPROBE_EXE_PATH_OVERRIDE: process.env.FFPROBE_EXE_PATH || "",
  FFMPEG_EXE_CANDIDATES: [path.join(__dirname, "..", "third-party", "ffmpeg", "ffmpeg.exe")],
  FFPROBE_EXE_CANDIDATES: [path.join(__dirname, "..", "third-party", "ffmpeg", "ffprobe.exe")],

  APP_VERSION: readAppVersion(),

  // Community 판본에는 상용 라이선스 인증이 없습니다. LICENSE_SERVER_URL / LICENSE_PRODUCT_ID /
  // LICENSE_PUBLIC_KEY_PEM / LICENSE_RECHECK_HOURS / LICENSE_OFFLINE_GRACE_DAYS /
  // LICENSE_CACHE_DIR 설정은 전부 제거했습니다.

  // self-host relay(workers/threads-media-relay, workers/threads-oauth-relay) 접근 키.
  // relay를 직접 배포한 사람이 Worker 쪽에도 같은 값을 등록해 두고, 이 앱이 relay를 부를 때
  // 자신을 증명하는 데 씁니다. 비워두면 relay를 쓰는 기능(미디어 발행 / Threads 계정 연결)이
  // 기존과 동일한 경로로 실패합니다 - 임의의 대체값을 만들지 않습니다.
  THREADS_RELAY_CLIENT_KEY: process.env.THREADS_RELAY_CLIENT_KEY || "",

  // Threads 자격증명(액세스 토큰/사용자 ID) 저장 폴더. 비워두면
  // %APPDATA%\DdalkkakThreadsFactoryCommunity\threads(Windows) 또는
  // ~/.config/DdalkkakThreadsFactoryCommunity/threads(그 외 OS, 개발용)를 사용합니다.
  // DB_PATH/UPLOAD_DIR과 동일하게 "어디에 저장할지"만 바꾸는 격리용 설정입니다
  // (src/threadsCredentials.ts 참고).
  THREADS_CREDENTIALS_DIR: process.env.THREADS_CREDENTIALS_DIR || "",
};

export function maskToken(token: string): string {
  if (!token) return "(미설정)";
  if (token.length <= 8) return "****";
  return token.slice(0, 4) + "..." + token.slice(-4);
}
