// src/threadsOAuth.ts
// P0.5: BYO(Bring-Your-Own Meta App) Threads OAuth - 로컬 클라이언트.
//
// P0.4 실전 smoke에서 production으로 실증된 순서를 그대로 제품 코드로 옮긴 것입니다:
//   /oauth/start(relay) → 기본 브라우저로 threads.net/oauth/authorize → /oauth/poll(relay)로
//   authorization code 수령 → 구매자 자기 App Secret으로 code→short-lived(POST
//   graph.threads.net/oauth/access_token) → short→long-lived(th_exchange_token) → /me?fields=
//   id,username → 사용자가 입력한 @username과 비교 → 전부 통과한 뒤에만 writeThreadsCredentials().
//
// 설계 원칙:
//   - 한 프로세스에 연결 시도(세션)는 1개. 새 시도가 오면 이전 미완료 세션은 메모리에서 폐기.
//   - App Secret은 세션 메모리에서만 살고, long-lived 교환이 끝나는 즉시 null로 지운다.
//     파일/DB/환경변수/로그/오류 객체 어디에도 넣지 않는다.
//   - state와 authorization URL은 TTL(10분) 동안 세션에 보관한다 - P0.3B에서 "state를 꺼낼 수
//     없어 브라우저를 다시 열 수 없었던" 문제의 제품 해법. [브라우저 다시 열기]는 같은 URL을 쓴다.
//   - 기존 정상 credential은 새 시도가 어떤 단계에서 실패하든 절대 건드리지 않는다. 저장은
//     모든 검증이 끝난 마지막 한 줄뿐이다.
//   - 구매자 화면/로그에 code/state/token/secret/Meta 원문 JSON/URL query를 내보내지 않는다.
//   - 모든 네트워크/브라우저 호출은 deps로 주입 가능해 테스트에서 실제 Meta/relay/브라우저를
//     전혀 건드리지 않는다.

import { spawn } from "child_process";
import { config } from "./env";
import { computeMachineHash } from "./deviceId";
import { readThreadsCredentials, writeThreadsCredentials } from "./threadsCredentials";
import { protectSecret, unprotectSecret } from "./windowsDpapi";

// ---------------------------------------------------------------------------------
// 상수(공식 엔드포인트 - P0.1에서 문서로 확정, P0.4에서 실측)
// ---------------------------------------------------------------------------------
export const THREADS_AUTHORIZE_URL = "https://threads.net/oauth/authorize";
export const THREADS_TOKEN_URL = "https://graph.threads.net/oauth/access_token";
export const THREADS_LONG_LIVED_URL = "https://graph.threads.net/access_token";
export const THREADS_REFRESH_URL = "https://graph.threads.net/refresh_access_token";
export const THREADS_OAUTH_SCOPE = "threads_basic,threads_content_publish";
export const OAUTH_POLL_INTERVAL_MS = 2500;
export const OAUTH_SESSION_TTL_MS = 10 * 60 * 1000; // relay TTL(600초)과 동일
const HTTP_TIMEOUT_MS = 20000;

// 자동 refresh 정책(공식: 24시간 이상 경과 + 미만료 토큰만 갱신 가능, 갱신 시 60일 재부여)
export const REFRESH_MIN_AGE_MS = 24 * 3600 * 1000;
export const REFRESH_BEFORE_EXPIRY_MS = 10 * 24 * 3600 * 1000; // 만료 10일 전부터 시도
const REFRESH_RETRY_COOLDOWN_MS = 6 * 3600 * 1000; // 실패 후 6시간 동안 재시도하지 않음

// ---------------------------------------------------------------------------------
// 타입
// ---------------------------------------------------------------------------------
export type OAuthSessionStatus =
  | "idle"
  | "starting"
  | "waiting_for_user"
  | "polling"
  | "exchanging"
  | "validating"
  | "success"
  | "failed"
  | "expired"
  | "denied";

// 구매자 화면에 보여줄 실패 사유 코드(문구는 프런트 i18n이 담당). raw 원문은 싣지 않는다.
export type OAuthFailureCode =
  | "LICENSE_INVALID"
  | "RELAY_UNAVAILABLE"
  | "APP_INFO_INVALID" // Meta가 App ID/Secret/redirect를 거부 → "Threads 앱 정보를 확인해 주세요"
  | "ACCOUNT_MISMATCH"
  | "DENIED"
  | "EXPIRED"
  | "GENERIC";

export interface OAuthPublicStatus {
  status: OAuthSessionStatus;
  failureCode?: OAuthFailureCode;
  targetUsername?: string;
  actualUsername?: string; // ACCOUNT_MISMATCH일 때만(승인된 계정명) - 비밀 아님
  connectedUsername?: string; // success일 때
  expiresAt?: string; // 세션(승인 대기) 만료 시각
  canReopen: boolean; // 살아 있는 authorization URL이 있어 [브라우저 다시 열기]가 가능한가
}

export interface RelayStartResponse {
  ok: true;
  state: string;
  pollToken: string;
  expiresAt: string;
}
export type RelayPollResponse = { ok: true; status: "pending" } | { ok: true; status: "ready"; code: string } | { ok: true; status: "expired" } | { ok: true; status: "denied" };

export interface ThreadsOAuthDeps {
  fetchImpl?: typeof fetch;
  openBrowser?: (url: string) => Promise<boolean>;
  now?: () => number;
  relayUrl?: string;
  // 테스트에서 setInterval 대신 수동으로 tick을 돌리기 위한 스위치
  disableTimer?: boolean;
  // 테스트에서 실제 라이선스 캐시/기기 해시 대신 쓰는 신원 공급자(기본: resolveLicenseIdentity)
  licenseIdentity?: () => { licenseId: string; machineHash: string } | null;
  // P0.5B: DPAPI 호출 주입(테스트에서 spawn 기록/실패 시뮬레이션)
  dpapi?: { spawnImpl?: (command: string, args: string[], options: any) => any; platform?: string };
}

interface OAuthSession {
  status: OAuthSessionStatus;
  failureCode?: OAuthFailureCode;
  createdAt: number;
  expiresAt: number;
  appId: string;
  appSecret: string | null; // long-lived 교환 직후 null
  targetUsername: string;
  state: string | null;
  pollToken: string | null;
  authorizationUrl: string | null;
  actualUsername?: string;
  connectedUsername?: string;
  timer: NodeJS.Timeout | null;
  busy: boolean; // tick 중복 실행 방지
}

// ---------------------------------------------------------------------------------
// 정규화/비교
// ---------------------------------------------------------------------------------
// 사용자 입력 @username 정규화(요청서 §5 최소 규칙: trim + 선행 @ 제거).
export function normalizeTargetUsername(raw: string): string {
  return String(raw || "").trim().replace(/^@+/, "").trim();
}

// P0.2 결론: Threads username의 공식 대소문자 규칙 문서를 찾지 못했고, P0.4 실측에서 /me는
// 소문자 원문을 돌려줬다. 사용자가 대문자를 섞어 입력했다고 "다른 계정"으로 막는 것이 더 큰
// 오판이므로 비교는 case-insensitive로 한다. 화면에는 API가 돌려준 원문(actual)을 보여준다.
export function usernamesMatch(target: string, actual: string): boolean {
  const a = normalizeTargetUsername(target).toLowerCase();
  const b = normalizeTargetUsername(actual).toLowerCase();
  return a.length > 0 && a === b;
}

export function isValidThreadsAppId(raw: string): boolean {
  return /^\d{6,32}$/.test(String(raw || "").trim());
}

// ---------------------------------------------------------------------------------
// 브라우저 열기(Windows 기본 브라우저)
// P0.3B에서 cmd /c start가 URL의 &를 명령 구분자로 해석해 실패했고, P0.4에서 PowerShell
// Start-Process + -EncodedCommand(인용 문제 원천 차단) 방식이 실측으로 검증됐다. 동기적으로
// 종료코드를 받는다. 비-Windows(개발 편의)에서는 xdg-open/open을 시도한다.
// ---------------------------------------------------------------------------------
export function openUrlInDefaultBrowser(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      let child;
      if (process.platform === "win32") {
        const psCommand = "Start-Process -FilePath '" + url.replace(/'/g, "''") + "'";
        const encoded = Buffer.from(psCommand, "utf16le").toString("base64");
        child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { stdio: "ignore", windowsHide: true });
      } else if (process.platform === "darwin") {
        child = spawn("open", [url], { stdio: "ignore" });
      } else {
        child = spawn("xdg-open", [url], { stdio: "ignore" });
      }
      child.on("error", () => resolve(false));
      child.on("exit", (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}

// ---------------------------------------------------------------------------------
// Threads Graph API 호출(전부 deps.fetchImpl 주입 가능)
// 오류 메시지에서 secret/token/code 원문을 항상 걸러낸다.
// ---------------------------------------------------------------------------------
function scrubAll(text: string, secrets: (string | null | undefined)[]): string {
  let out = String(text || "");
  for (const s of secrets) if (s && s.length >= 8) out = out.split(s).join("***");
  return out.slice(0, 300);
}

async function fetchJsonWithTimeout(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<{ ok: boolean; status: number; data: any }> {
  const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  const data: any = await res.json().catch(() => ({}));
  return { ok: res.ok && !data?.error, status: res.status, data };
}

export interface TokenExchangeResult {
  ok: boolean;
  accessToken?: string;
  userId?: string;
  expiresIn?: number;
  error?: string; // 이미 scrub된 문자열(로그용). 구매자 화면에는 내보내지 않는다.
}

export async function exchangeCodeForShortLivedToken(
  params: { appId: string; appSecret: string; code: string; redirectUri: string },
  fetchImpl: typeof fetch = fetch
): Promise<TokenExchangeResult> {
  const body = new URLSearchParams({
    client_id: params.appId,
    client_secret: params.appSecret,
    grant_type: "authorization_code",
    redirect_uri: params.redirectUri,
    code: params.code,
  });
  try {
    const r = await fetchJsonWithTimeout(fetchImpl, THREADS_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!r.ok || typeof r.data?.access_token !== "string") {
      return { ok: false, error: scrubAll(String(r.data?.error?.message || `HTTP ${r.status}`), [params.appSecret, params.code]) };
    }
    return { ok: true, accessToken: r.data.access_token, userId: r.data.user_id !== undefined ? String(r.data.user_id) : undefined };
  } catch (e: any) {
    return { ok: false, error: scrubAll(String(e?.message || e), [params.appSecret, params.code]) };
  }
}

export async function exchangeForLongLivedToken(
  params: { appSecret: string; shortLivedToken: string },
  fetchImpl: typeof fetch = fetch
): Promise<TokenExchangeResult> {
  const url =
    THREADS_LONG_LIVED_URL +
    "?grant_type=th_exchange_token&client_secret=" +
    encodeURIComponent(params.appSecret) +
    "&access_token=" +
    encodeURIComponent(params.shortLivedToken);
  try {
    const r = await fetchJsonWithTimeout(fetchImpl, url, { method: "GET" });
    if (!r.ok || typeof r.data?.access_token !== "string") {
      return { ok: false, error: scrubAll(String(r.data?.error?.message || `HTTP ${r.status}`), [params.appSecret, params.shortLivedToken]) };
    }
    return { ok: true, accessToken: r.data.access_token, expiresIn: Number(r.data.expires_in) || undefined };
  } catch (e: any) {
    return { ok: false, error: scrubAll(String(e?.message || e), [params.appSecret, params.shortLivedToken]) };
  }
}

// secret 불필요(공식). 24시간 이상 경과 + 미만료 long-lived 토큰만 갱신 가능.
export async function refreshLongLivedToken(longLivedToken: string, fetchImpl: typeof fetch = fetch): Promise<TokenExchangeResult> {
  const url = THREADS_REFRESH_URL + "?grant_type=th_refresh_token&access_token=" + encodeURIComponent(longLivedToken);
  try {
    const r = await fetchJsonWithTimeout(fetchImpl, url, { method: "GET" });
    if (!r.ok || typeof r.data?.access_token !== "string") {
      return { ok: false, error: scrubAll(String(r.data?.error?.message || `HTTP ${r.status}`), [longLivedToken]) };
    }
    return { ok: true, accessToken: r.data.access_token, expiresIn: Number(r.data.expires_in) || undefined };
  } catch (e: any) {
    return { ok: false, error: scrubAll(String(e?.message || e), [longLivedToken]) };
  }
}

export interface ThreadsMeResult {
  ok: boolean;
  id?: string;
  username?: string;
  error?: string;
}

// 토큰만으로 본인 id/username 확보(P0.2에서 공식 문서로 확인, P0.4 실측). 숫자 User ID를
// 사용자가 찾아 입력할 필요를 없애는 핵심 호출이다.
export async function fetchThreadsMe(accessToken: string, fetchImpl: typeof fetch = fetch): Promise<ThreadsMeResult> {
  const url = `${config.THREADS_GRAPH_BASE}/me?fields=id,username&access_token=${encodeURIComponent(accessToken)}`;
  try {
    const r = await fetchJsonWithTimeout(fetchImpl, url, { method: "GET" });
    if (!r.ok || !r.data?.id) {
      return { ok: false, error: scrubAll(String(r.data?.error?.message || `HTTP ${r.status}`), [accessToken]) };
    }
    return { ok: true, id: String(r.data.id), username: typeof r.data.username === "string" ? r.data.username : "" };
  } catch (e: any) {
    return { ok: false, error: scrubAll(String(e?.message || e), [accessToken]) };
  }
}

// ---------------------------------------------------------------------------------
// relay /oauth/start용 신원 - wire 필드명(licenseId/machineHash)과 호출 흐름은 그대로이고,
// licenseId의 출처만 self-host relay client key로 바뀌었습니다. 새 저장 구조는 없습니다.
// key가 없거나 기기 해시를 계산할 수 없으면 null을 돌려주고, 호출부가 기존과 동일하게
// 연결 실패로 처리합니다(대체값을 만들지 않습니다).
// ---------------------------------------------------------------------------------
export function resolveLicenseIdentity(): { licenseId: string; machineHash: string } | null {
  try {
    const clientKey = config.THREADS_RELAY_CLIENT_KEY.trim();
    if (!clientKey) return null;
    const machineHash = computeMachineHash();
    if (!machineHash) return null;
    return { licenseId: clientKey, machineHash };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------
// 세션(프로세스당 1개)
// ---------------------------------------------------------------------------------
let session: OAuthSession | null = null;

function nowOf(deps: ThreadsOAuthDeps): number {
  return (deps.now ?? (() => Date.now()))();
}

function relayBaseOf(deps: ThreadsOAuthDeps): string {
  return String(deps.relayUrl ?? config.THREADS_OAUTH_RELAY_URL ?? "").trim().replace(/\/+$/, "");
}

function clearTimer(s: OAuthSession | null): void {
  if (s && s.timer) {
    clearInterval(s.timer);
    s.timer = null;
  }
}

// 민감값 폐기. 세션 객체를 버리기 전/실패 시 반드시 호출한다.
function wipeSensitive(s: OAuthSession | null): void {
  if (!s) return;
  s.appSecret = null;
  s.pollToken = null;
  s.state = null;
  s.authorizationUrl = null;
}

function finish(s: OAuthSession, status: OAuthSessionStatus, failureCode?: OAuthFailureCode): void {
  clearTimer(s);
  s.status = status;
  if (failureCode) s.failureCode = failureCode;
  wipeSensitive(s);
}

export function getThreadsOAuthStatus(): OAuthPublicStatus {
  if (!session) return { status: "idle", canReopen: false };
  const s = session;
  const alive = s.authorizationUrl !== null && Date.now() < s.expiresAt;
  return {
    status: s.status,
    failureCode: s.failureCode,
    targetUsername: s.targetUsername,
    actualUsername: s.actualUsername,
    connectedUsername: s.connectedUsername,
    expiresAt: new Date(s.expiresAt).toISOString(),
    canReopen: alive && (s.status === "waiting_for_user" || s.status === "polling"),
  };
}

// 새 시도: 이전 미완료 세션은 폐기한다(타이머 정리 + 민감값 제거). 기존 credential은 건드리지 않는다.
export function discardThreadsOAuthSession(): void {
  if (session) {
    clearTimer(session);
    wipeSensitive(session);
  }
  session = null;
}

export interface StartOAuthInput {
  appId: string;
  appSecret: string;
  targetUsername: string;
}

export type StartOAuthResult = { ok: true; status: OAuthPublicStatus } | { ok: false; code: "INVALID_INPUT" | "LICENSE_INVALID" | "RELAY_NOT_CONFIGURED" | "RELAY_UNAVAILABLE" | "BROWSER_OPEN_FAILED"; field?: "appId" | "appSecret" | "targetUsername" };

export async function startThreadsOAuth(input: StartOAuthInput, deps: ThreadsOAuthDeps = {}): Promise<StartOAuthResult> {
  const appId = String(input.appId || "").trim();
  const appSecret = String(input.appSecret || "").trim();
  const targetUsername = normalizeTargetUsername(input.targetUsername);
  if (!isValidThreadsAppId(appId)) return { ok: false, code: "INVALID_INPUT", field: "appId" };
  if (appSecret.length < 16) return { ok: false, code: "INVALID_INPUT", field: "appSecret" };
  if (!targetUsername) return { ok: false, code: "INVALID_INPUT", field: "targetUsername" };

  const relayBase = relayBaseOf(deps);
  if (!/^https:\/\//.test(relayBase)) return { ok: false, code: "RELAY_NOT_CONFIGURED" };

  const identity = (deps.licenseIdentity ?? resolveLicenseIdentity)();
  if (!identity) return { ok: false, code: "LICENSE_INVALID" };

  // 이전 미완료 시도는 여기서 폐기(한 프로세스에 시도 1개).
  discardThreadsOAuthSession();

  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = nowOf(deps);
  const s: OAuthSession = {
    status: "starting",
    createdAt: now,
    expiresAt: now + OAUTH_SESSION_TTL_MS,
    appId,
    appSecret,
    targetUsername,
    state: null,
    pollToken: null,
    authorizationUrl: null,
    timer: null,
    busy: false,
  };
  session = s;

  // 1) relay /oauth/start
  let startRes: RelayStartResponse;
  try {
    const r = await fetchJsonWithTimeout(fetchImpl, relayBase + "/oauth/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ licenseId: identity.licenseId, machineHash: identity.machineHash }),
    });
    if (!r.ok || !r.data?.ok || typeof r.data.state !== "string" || typeof r.data.pollToken !== "string") {
      finish(s, "failed", r.data?.code === "LICENSE_INVALID" ? "LICENSE_INVALID" : "RELAY_UNAVAILABLE");
      return { ok: false, code: r.data?.code === "LICENSE_INVALID" ? "LICENSE_INVALID" : "RELAY_UNAVAILABLE" };
    }
    startRes = r.data as RelayStartResponse;
  } catch {
    finish(s, "failed", "RELAY_UNAVAILABLE");
    return { ok: false, code: "RELAY_UNAVAILABLE" };
  }
  s.state = startRes.state;
  s.pollToken = startRes.pollToken;
  const relayExp = Date.parse(startRes.expiresAt);
  if (Number.isFinite(relayExp)) s.expiresAt = Math.min(s.expiresAt, relayExp);

  // 2) authorization URL(state 포함 - 로그에 절대 출력하지 않는다)
  const u = new URL(THREADS_AUTHORIZE_URL);
  u.searchParams.set("client_id", appId);
  u.searchParams.set("redirect_uri", relayBase + "/oauth/callback");
  u.searchParams.set("scope", THREADS_OAUTH_SCOPE);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("state", s.state);
  s.authorizationUrl = u.toString();

  // 3) 기본 브라우저 열기
  const opened = await (deps.openBrowser ?? openUrlInDefaultBrowser)(s.authorizationUrl);
  if (!opened) {
    // URL은 살아 있으므로 [브라우저 다시 열기]로 복구 가능 - 세션을 실패로 닫지 않는다.
    console.warn("[threads-oauth] 기본 브라우저를 열지 못했습니다. 화면의 [브라우저 다시 열기]로 재시도할 수 있습니다.");
  }
  s.status = "waiting_for_user";

  // 4) polling 시작(타이머 1개)
  if (!deps.disableTimer) {
    s.timer = setInterval(() => {
      void tickThreadsOAuth(deps);
    }, OAUTH_POLL_INTERVAL_MS);
  }
  return { ok: true, status: getThreadsOAuthStatus() };
}

// 살아 있는 세션의 같은 authorization URL을 다시 연다(새 state를 만들지 않는다).
export async function reopenThreadsOAuthBrowser(deps: ThreadsOAuthDeps = {}): Promise<{ ok: boolean }> {
  const s = session;
  if (!s || !s.authorizationUrl || nowOf(deps) >= s.expiresAt) return { ok: false };
  if (s.status !== "waiting_for_user" && s.status !== "polling") return { ok: false };
  const opened = await (deps.openBrowser ?? openUrlInDefaultBrowser)(s.authorizationUrl);
  return { ok: opened };
}

// 한 번의 polling/교환 사이클. 타이머가 부르지만 테스트에서는 직접 호출한다.
// 반환값은 tick 이후의 공개 상태.
export async function tickThreadsOAuth(deps: ThreadsOAuthDeps = {}): Promise<OAuthPublicStatus> {
  const s = session;
  if (!s) return getThreadsOAuthStatus();
  if (s.busy) return getThreadsOAuthStatus();
  if (s.status !== "waiting_for_user" && s.status !== "polling") return getThreadsOAuthStatus();
  const now = nowOf(deps);
  if (now >= s.expiresAt) {
    finish(s, "expired", "EXPIRED");
    return getThreadsOAuthStatus();
  }
  s.busy = true;
  try {
    const fetchImpl = deps.fetchImpl ?? fetch;
    const relayBase = relayBaseOf(deps);
    s.status = "polling";

    // relay /oauth/poll
    let poll: RelayPollResponse;
    try {
      const r = await fetchJsonWithTimeout(fetchImpl, relayBase + "/oauth/poll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: s.state, pollToken: s.pollToken }),
      });
      if (!r.ok || !r.data?.ok) {
        // 일시적 relay 오류는 다음 tick에 재시도(세션 유지). 401/404 류의 구조적 거부만 실패 처리.
        if (r.status === 401 || r.status === 404) finish(s, "failed", "RELAY_UNAVAILABLE");
        return getThreadsOAuthStatus();
      }
      poll = r.data as RelayPollResponse;
    } catch {
      return getThreadsOAuthStatus(); // 네트워크 일시 오류 - 다음 tick
    }

    if (poll.status === "pending") return getThreadsOAuthStatus();
    if (poll.status === "denied") {
      finish(s, "denied", "DENIED");
      return getThreadsOAuthStatus();
    }
    if (poll.status === "expired") {
      finish(s, "expired", "EXPIRED");
      return getThreadsOAuthStatus();
    }

    // ready → code는 지역 변수로만 다룬다(세션에 저장하지 않음)
    let code: string | null = poll.code;
    // state/pollToken은 더 이상 필요 없다(relay 레코드는 이미 소비됨)
    s.state = null;
    s.pollToken = null;
    s.authorizationUrl = null;
    s.status = "exchanging";

    const redirectUri = relayBase + "/oauth/callback";
    const shortRes = await exchangeCodeForShortLivedToken({ appId: s.appId, appSecret: s.appSecret || "", code, redirectUri }, fetchImpl);
    code = null;
    if (!shortRes.ok || !shortRes.accessToken) {
      console.warn("[threads-oauth] code→token 교환 실패: " + (shortRes.error || "unknown"));
      finish(s, "failed", "APP_INFO_INVALID");
      return getThreadsOAuthStatus();
    }

    let longRes = await exchangeForLongLivedToken({ appSecret: s.appSecret || "", shortLivedToken: shortRes.accessToken }, fetchImpl);
    // P0.5B: App Secret은 모든 검증이 끝난 뒤 DPAPI로 보호 저장해야 하므로 여기서 지우지 않는다.
    // 어떤 실패 경로든 finish()가 세션 민감값(secret 포함)을 폐기한다.
    if (!longRes.ok || !longRes.accessToken) {
      console.warn("[threads-oauth] long-lived 교환 실패: " + (longRes.error || "unknown"));
      finish(s, "failed", "APP_INFO_INVALID");
      return getThreadsOAuthStatus();
    }
    let accessToken: string | null = longRes.accessToken;
    const expiresAtIso = new Date(now + (longRes.expiresIn ? longRes.expiresIn * 1000 : 60 * 24 * 3600 * 1000)).toISOString();
    longRes = { ok: true };

    // /me 검증 + username 비교
    s.status = "validating";
    const me = await fetchThreadsMe(accessToken, fetchImpl);
    if (!me.ok || !me.id) {
      console.warn("[threads-oauth] /me 검증 실패: " + (me.error || "unknown"));
      accessToken = null;
      finish(s, "failed", "GENERIC");
      return getThreadsOAuthStatus();
    }
    const actual = me.username || "";
    if (!usernamesMatch(s.targetUsername, actual)) {
      // 승인된 계정이 목표 계정과 다르다 - 저장하지 않고 기존 credential도 건드리지 않는다.
      s.actualUsername = actual;
      accessToken = null;
      finish(s, "failed", "ACCOUNT_MISMATCH");
      return getThreadsOAuthStatus();
    }

    // 모든 검증 통과 - P0.5B: App Secret을 DPAPI(CurrentUser)로 보호한 뒤 단 한 번 저장 + 런타임 반영.
    // 보호에 실패해도(DPAPI 불가 환경 등) 연결 자체는 성공이므로 blob 없이 저장한다 → 다음 재연결 때
    // secret을 다시 입력받는 fallback으로 자연스럽게 이어진다. 평문 secret은 어떤 경우에도 저장하지 않는다.
    let appSecretProtected: string | undefined;
    try {
      appSecretProtected = s.appSecret ? await protectSecret(s.appSecret, deps.dpapi) : undefined;
    } catch {
      appSecretProtected = undefined;
      console.warn("[threads-oauth] 앱 시크릿 보호 저장을 건너뜁니다(이 PC에서 Windows 보안 저장을 사용할 수 없음). 다음 재연결 때 다시 입력이 필요합니다.");
    }
    writeThreadsCredentials(accessToken, me.id, { username: actual, expiresAtIso, appId: s.appId, source: "oauth", appSecretProtected });
    config.THREADS_ACCESS_TOKEN = accessToken;
    config.THREADS_USER_ID = me.id;
    accessToken = null;
    s.connectedUsername = actual;
    finish(s, "success");
    console.log("[threads-oauth] Threads 계정 연결 완료: @" + actual);
    return getThreadsOAuthStatus();
  } catch (e: any) {
    console.warn("[threads-oauth] 연결 처리 중 오류: " + scrubAll(String(e?.message || e), [s.appSecret, s.pollToken, s.state]));
    finish(s, "failed", "GENERIC");
    return getThreadsOAuthStatus();
  } finally {
    s.busy = false;
  }
}

// ---------------------------------------------------------------------------------
// P0.5B: 저장된 앱 연결 정보로 재연결(App ID/username은 비밀 아님, secret은 DPAPI blob에서 복호화)
// ---------------------------------------------------------------------------------
export interface StoredReconnectInfo {
  appId: string | null;
  username: string | null;
  hasStoredAppSecret: boolean;
  source: "manual" | "oauth" | null;
}

// 재연결 폼 prefill용(비밀값 없음). manual 연결은 secret 자체가 없다.
export function getStoredReconnectInfo(): StoredReconnectInfo {
  const saved = readThreadsCredentials();
  if (!saved) return { appId: null, username: null, hasStoredAppSecret: false, source: null };
  return {
    appId: saved.appId ?? null,
    username: saved.username ?? null,
    hasStoredAppSecret: saved.source === "oauth" && !!saved.appSecretProtected,
    source: saved.source ?? "manual",
  };
}

export type ReconnectFailureCode = "SECRET_UNAVAILABLE" | "INVALID_INPUT" | "LICENSE_INVALID" | "RELAY_NOT_CONFIGURED" | "RELAY_UNAVAILABLE" | "BROWSER_OPEN_FAILED";
export type ReconnectResult =
  | { ok: true; status: OAuthPublicStatus }
  | { ok: false; code: ReconnectFailureCode; prefill: { appId: string | null; username: string | null } };

// [Threads 다시 연결하기]: 저장된 appId + username + DPAPI blob이 모두 있고 복호화가 되면 입력 폼 없이
// 바로 OAuth를 시작한다. 하나라도 없거나 복호화에 실패하면(다른 Windows 계정/다른 PC/손상) 기존 연결을
// 건드리지 않고 SECRET_UNAVAILABLE + prefill(appId/username)을 돌려줘 화면이 secret만 다시 받게 한다.
export async function reconnectThreadsOAuth(deps: ThreadsOAuthDeps = {}): Promise<ReconnectResult> {
  const info = getStoredReconnectInfo();
  const prefill = { appId: info.appId, username: info.username };
  if (!info.appId || !info.username || !info.hasStoredAppSecret) return { ok: false, code: "SECRET_UNAVAILABLE", prefill };
  const saved = readThreadsCredentials();
  let appSecret: string | null = null;
  try {
    appSecret = await unprotectSecret(saved?.appSecretProtected || "", deps.dpapi);
  } catch {
    return { ok: false, code: "SECRET_UNAVAILABLE", prefill };
  }
  try {
    const r = await startThreadsOAuth({ appId: info.appId, appSecret, targetUsername: info.username }, deps);
    if (!r.ok) return { ok: false, code: r.code, prefill };
    return { ok: true, status: r.status };
  } finally {
    appSecret = null; // 세션이 자기 복사본을 보관/폐기한다
  }
}

// 테스트 전용: 세션 내부 관찰(민감값 자체는 반환하지 않고 존재 여부만).
export function __inspectThreadsOAuthSessionForTests(): { exists: boolean; hasSecret: boolean; hasState: boolean; hasPollToken: boolean; hasAuthUrl: boolean; hasTimer: boolean } {
  return {
    exists: !!session,
    hasSecret: !!(session && session.appSecret),
    hasState: !!(session && session.state),
    hasPollToken: !!(session && session.pollToken),
    hasAuthUrl: !!(session && session.authorizationUrl),
    hasTimer: !!(session && session.timer),
  };
}

// ---------------------------------------------------------------------------------
// 자동 refresh(scheduler tick에서 호출). 필요할 때만 네트워크를 쓴다.
// ---------------------------------------------------------------------------------
let lastRefreshAttemptAt = 0;

export interface RefreshDecision {
  action: "skip" | "refresh";
  reason: "no_credentials" | "no_expiry" | "too_young" | "not_due" | "cooldown" | "due";
}

export function decideTokenRefresh(now: number = Date.now()): RefreshDecision {
  const saved = readThreadsCredentials();
  if (!saved) return { action: "skip", reason: "no_credentials" };
  if (!saved.expiresAtIso) return { action: "skip", reason: "no_expiry" }; // 수동 연결: 만료 미상 → 건드리지 않음
  const expiresAt = Date.parse(saved.expiresAtIso);
  const savedAt = Date.parse(saved.savedAtIso || "");
  if (!Number.isFinite(expiresAt)) return { action: "skip", reason: "no_expiry" };
  if (Number.isFinite(savedAt) && now - savedAt < REFRESH_MIN_AGE_MS) return { action: "skip", reason: "too_young" };
  if (expiresAt - now > REFRESH_BEFORE_EXPIRY_MS) return { action: "skip", reason: "not_due" };
  if (now - lastRefreshAttemptAt < REFRESH_RETRY_COOLDOWN_MS) return { action: "skip", reason: "cooldown" };
  return { action: "refresh", reason: "due" };
}

// 갱신 성공 시 token+expiresAtIso를 원자적으로 교체한다(writeThreadsCredentials = tmp→rename).
// 실패 시 기존 token을 지우지 않는다 - 실제 만료/검증 실패는 기존 validate 경로가 재연결 UI로 안내한다.
export async function maybeRefreshThreadsToken(deps: { fetchImpl?: typeof fetch; now?: () => number } = {}): Promise<{ attempted: boolean; refreshed: boolean; reason: RefreshDecision["reason"] | "failed" }> {
  const now = (deps.now ?? (() => Date.now()))();
  const decision = decideTokenRefresh(now);
  if (decision.action === "skip") return { attempted: false, refreshed: false, reason: decision.reason };
  lastRefreshAttemptAt = now;
  const saved = readThreadsCredentials();
  if (!saved) return { attempted: false, refreshed: false, reason: "no_credentials" };
  const r = await refreshLongLivedToken(saved.accessToken, deps.fetchImpl ?? fetch);
  if (!r.ok || !r.accessToken) {
    console.warn("[threads-oauth] 토큰 자동 갱신 실패(기존 토큰 유지): " + (r.error || "unknown"));
    return { attempted: true, refreshed: false, reason: "failed" };
  }
  const expiresAtIso = new Date(now + (r.expiresIn ? r.expiresIn * 1000 : 60 * 24 * 3600 * 1000)).toISOString();
  // P0.5B: refresh는 secret을 쓰지 않지만, 저장된 DPAPI blob(appSecretProtected)은 반드시 그대로 이어 써야
  // 한다 - 빠뜨리면 60일마다 갱신될 때 재연결용 secret이 사라진다(DPAPI-16 계약이 잡아낸 결함).
  writeThreadsCredentials(r.accessToken, saved.userId, {
    username: saved.username,
    expiresAtIso,
    appId: saved.appId,
    source: saved.source ?? "oauth",
    appSecretProtected: saved.appSecretProtected,
  });
  config.THREADS_ACCESS_TOKEN = r.accessToken;
  console.log("[threads-oauth] 토큰 자동 갱신 완료 (만료 " + expiresAtIso + ")");
  return { attempted: true, refreshed: true, reason: "due" };
}

export function __resetRefreshCooldownForTests(): void {
  lastRefreshAttemptAt = 0;
}
