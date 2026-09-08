// src/threadsCredentials.ts
// 구매자가 연결한 Threads 계정의 액세스 토큰/사용자 ID를 로컬에 저장합니다.
//
// 저장 위치를 이렇게 정한 이유:
// - 이 프로그램은 지금까지 원시(복원 가능한) 비밀을 data\app.db에 넣은 적이 없습니다.
//   확장프로그램 토큰은 해시+접두사만, 라이선스는 서명 payload와 key_last4만 저장합니다.
//   Threads 토큰은 게시할 때마다 Meta로 그대로 보내야 해서 해시가 불가능하므로, DB가 아니라
//   라이선스 캐시와 동일한 "사용자 프로필 안의 전용 파일" 방식을 그대로 따릅니다.
//   (src/license/cache.ts와 같은 패턴: APPDATA 경로 → mkdir → tmp 기록 → 원자적 rename)
// - 설치 폴더가 아닌 %APPDATA% 아래이므로 재설치/업데이트에도 값이 유지되고, 사용자가
//   프로그램 폴더를 통째로 복사·공유해도 토큰이 함께 딸려가지 않습니다.
//
// 라이선스 캐시 파일과는 완전히 분리된 별도 파일입니다(같은 파일을 공유하거나 섞지 않음).
// 이 파일에는 Threads 연결에 필요한 값만 담고, 라이선스 정보/기기 식별값/이메일/기타 설정/
// 디버그 정보는 절대 담지 않습니다.
//
// P0.5(BYO OAuth): schemaVersion은 1 그대로 두고 선택 필드(username/expiresAtIso/appId/source)만
// 추가했습니다. 기존 수동 연결 파일(토큰+userId만 있는 형태)은 그대로 읽히고, 새 필드가 없으면
// "만료 시각 미상"으로 취급합니다. **App Secret은 어떤 경우에도 이 파일에 저장하지 않습니다** -
// refresh(th_refresh_token)에는 secret이 필요 없으므로 최초 교환 뒤 보관할 이유가 없습니다.
//
// 과장 금지: 이것은 암호화 저장소가 아니라 Windows 사용자 프로필 안의 로컬 자격증명 파일입니다.
// (.env에 평문으로 두던 기존 방식과 노출 수준은 같고, 위치만 더 안전한 곳으로 옮긴 것입니다.)

import fs from "fs";
import path from "path";
import os from "os";
import { config } from "./env";

export type ThreadsCredentialSource = "manual" | "oauth";

export interface ThreadsCredentialsFile {
  schemaVersion: 1;
  accessToken: string;
  userId: string;
  savedAtIso: string;
  // ---- P0.5 선택 필드(하위호환: 없을 수 있음) ----
  username?: string; // /me 검증에서 확인한 실제 계정명(@ 없음)
  expiresAtIso?: string; // long-lived token 만료 예정 시각. 없으면 미상(수동 연결)
  appId?: string; // 구매자 자기 Threads 앱 ID(비밀 아님). 재연결 안내/표시용
  source?: ThreadsCredentialSource;
  // P0.5B: App Secret의 Windows DPAPI(CurrentUser) 암호문(base64). 평문 secret 필드는 존재하지 않으며
  // 만들지도 않는다. 같은 Windows 사용자 계정에서만 복호화되어 [Threads 다시 연결하기]에 재사용된다.
  appSecretProtected?: string;
}

export interface ThreadsCredentialExtras {
  username?: string;
  expiresAtIso?: string;
  appId?: string;
  source?: ThreadsCredentialSource;
  appSecretProtected?: string;
}

function resolveCredentialsDir(): string {
  // 테스트/문서 캡처 격리용 오버라이드(DB_PATH/UPLOAD_DIR과 동일한 기존 패턴).
  // 저장 "위치"만 바꿀 뿐이며, 이 값으로 검증을 우회할 수는 없습니다.
  if (config.THREADS_CREDENTIALS_DIR) return config.THREADS_CREDENTIALS_DIR;

  // 문서 캡처 모드에서는 어떤 경우에도 실제 사용자의 %APPDATA% 자격증명을 읽지 않습니다.
  // (설명서 캡처에 실제 연결 계정명이 찍힌 사고를 데이터 소스 단계에서 차단합니다.)
  // 오버라이드를 깜빡해도 실제 경로로 새지 않도록, DOCS_MODE면 프로젝트 안의 문서 전용
  // 폴더로 강제합니다. 실제 자격증명 파일은 읽지도 쓰지도 않습니다.
  if (config.DOCS_MODE) {
    return path.join(process.cwd(), "docs", "seed-data", "docs-threads-credentials");
  }

  const appData = process.env.APPDATA; // Windows: C:\Users\<사용자>\AppData\Roaming
  const base = appData && appData.trim() ? appData : path.join(os.homedir(), ".config");
  return path.join(base, "DdalkkakThreadsFactoryCommunity", "threads");
}

function credentialsFilePath(): string {
  return path.join(resolveCredentialsDir(), "threads-credentials.json");
}

// 테스트에서 "DOCS_MODE일 때 실제 %APPDATA%를 가리키지 않는다"를 정적 검사가 아니라
// 실제 해석 결과로 확인하기 위한 읽기 전용 노출입니다(경로만 돌려주며 파일을 열지 않습니다).
export function threadsCredentialsPathForTest(): string {
  return credentialsFilePath();
}

// 저장된 값이 없거나 파일이 손상됐으면 null을 돌려줍니다(= 저장된 적 없음과 동일 취급).
// 프로그램이 멈추지 않고 .env fallback으로 넘어가게 하기 위함입니다.
export function readThreadsCredentials(): ThreadsCredentialsFile | null {
  const file = credentialsFilePath();
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (!parsed || parsed.schemaVersion !== 1) return null;
    if (typeof parsed.accessToken !== "string" || typeof parsed.userId !== "string") return null;
    if (!parsed.accessToken || !parsed.userId) return null;
    const out: ThreadsCredentialsFile = {
      schemaVersion: 1,
      accessToken: parsed.accessToken,
      userId: parsed.userId,
      savedAtIso: typeof parsed.savedAtIso === "string" ? parsed.savedAtIso : "",
    };
    if (typeof parsed.username === "string" && parsed.username) out.username = parsed.username;
    if (typeof parsed.expiresAtIso === "string" && parsed.expiresAtIso) out.expiresAtIso = parsed.expiresAtIso;
    if (typeof parsed.appId === "string" && parsed.appId) out.appId = parsed.appId;
    if (parsed.source === "manual" || parsed.source === "oauth") out.source = parsed.source;
    if (typeof parsed.appSecretProtected === "string" && parsed.appSecretProtected) out.appSecretProtected = parsed.appSecretProtected;
    return out;
  } catch {
    return null; // 파일 손상 → 저장 안 된 것으로 처리
  }
}

// 원자적 저장: 임시 파일에 먼저 쓰고 rename으로 교체합니다. 쓰는 도중 프로세스가 죽어도
// 기존 파일이 반쯤 덮인 상태로 남지 않습니다(license/cache.ts와 동일).
// 호출부 계약: "모든 검증이 끝난 뒤 마지막에 1회"만 부릅니다 - 그래서 새 연결 시도가 실패해도
// 기존 정상 파일은 이 함수가 불리지 않아 그대로 남습니다.
export function writeThreadsCredentials(accessToken: string, userId: string, extras: ThreadsCredentialExtras = {}): void {
  const dir = resolveCredentialsDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = credentialsFilePath();
  const tmp = file + ".tmp";
  const payload: ThreadsCredentialsFile = {
    schemaVersion: 1,
    accessToken,
    userId,
    savedAtIso: new Date().toISOString(),
  };
  if (extras.username) payload.username = extras.username;
  if (extras.expiresAtIso) payload.expiresAtIso = extras.expiresAtIso;
  if (extras.appId) payload.appId = extras.appId;
  if (extras.source) payload.source = extras.source;
  if (extras.appSecretProtected) payload.appSecretProtected = extras.appSecretProtected;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 0), "utf-8");
  fs.renameSync(tmp, file);
}

export function clearThreadsCredentials(): void {
  const file = credentialsFilePath();
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    // 삭제 실패는 치명적이지 않습니다(다음 저장 때 덮어씀).
  }
}

// 서버 시작 시 1회 호출합니다. 저장된 자격증명이 있으면 그것을, 없으면 기존 .env 값을
// 그대로 씁니다(기존 개발/테스트 환경 무변경). 반환값은 "저장된 파일을 썼는지" 여부입니다.
export function applyStoredThreadsCredentialsToConfig(): boolean {
  const saved = readThreadsCredentials();
  if (!saved) return false;
  config.THREADS_ACCESS_TOKEN = saved.accessToken;
  config.THREADS_USER_ID = saved.userId;
  return true;
}
