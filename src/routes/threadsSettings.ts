// src/routes/threadsSettings.ts
// 보안 원칙: 액세스 토큰/App Secret 전체 문자열은 웹 화면/로그/오류 메시지에 절대 노출하지 않습니다.
// 저장 요청의 본문으로 1회 받을 뿐이고, 어떤 응답에도 다시 담아 보내지 않습니다.
// 상태 조회는 언제나 maskToken() 결과(앞 4자·뒤 4자)만 돌려줍니다.
//
// 저장 위치: 원시 토큰은 DB(settings)가 아니라 사용자 프로필 안의 전용 파일에 둡니다
// (src/threadsCredentials.ts 참고).
//
// P0.5(BYO OAuth): 기본 연결 경로는 OAuth(/oauth/start → /oauth/status 폴링)이며, 기존 수동
// 입력(POST /)은 "고급 연결 설정" fallback으로 그대로 유지합니다. 수동 입력도 이제 토큰만으로
// /me를 호출해 사용자 ID/username을 자동 확보합니다(숫자 ID 입력은 선택값).
import { Router } from "express";
import { config, maskToken } from "../env";
import { validateThreadsToken } from "../threads-api";
import { clearThreadsCredentials, readThreadsCredentials, writeThreadsCredentials } from "../threadsCredentials";
import {
  discardThreadsOAuthSession,
  fetchThreadsMe,
  getThreadsOAuthStatus,
  reconnectThreadsOAuth,
  reopenThreadsOAuthBrowser,
  startThreadsOAuth,
} from "../threadsOAuth";

const router = Router();

// 연결 상태 요약(구매자 화면용). 토큰 원문/App Secret은 절대 포함하지 않습니다.
// 릴레이가 https로 설정되어 있을 때만 콜백 주소를 만듭니다(미설정이면 null).
// 서버가 실제로 OAuth에 사용하는 값과 같은 식으로 만들어, 화면과 실제 동작이 갈라지지 않게 합니다.
function oauthCallbackUrl(): string | null {
  const base = String(config.THREADS_OAUTH_RELAY_URL || "").trim().replace(/\/+$/, "");
  if (!/^https:\/\//.test(base)) return null;
  return base + "/oauth/callback";
}

router.get("/", (_req, res) => {
  const saved = readThreadsCredentials();
  res.json({
    hasToken: !!config.THREADS_ACCESS_TOKEN,
    hasUserId: !!config.THREADS_USER_ID,
    maskedToken: maskToken(config.THREADS_ACCESS_TOKEN),
    userId: config.THREADS_USER_ID || null,
    username: saved?.username || null,
    expiresAtIso: saved?.expiresAtIso || null,
    source: saved?.source || (saved ? "manual" : null),
    // P0.5B: 재연결 폼 prefill용(비밀 아님). DPAPI blob 자체나 secret은 절대 내려보내지 않는다.
    appId: saved?.appId || null,
    hasStoredAppSecret: saved?.source === "oauth" && !!saved?.appSecretProtected,
    oauthRelayConfigured: /^https:\/\//.test(config.THREADS_OAUTH_RELAY_URL || ""),
    // 구매자가 Meta의 "리디렉션 콜백 URL" 칸에 그대로 붙여넣어야 하는 공개 주소입니다.
    // 비밀값이 아니며(승인 결과만 잠시 중계), 손으로 옮겨 적다 생기는 오타가 연결 실패의
    // 가장 흔한 원인이라 화면에서 복사할 수 있도록 내려보냅니다.
    oauthCallbackUrl: oauthCallbackUrl(),
    dailyMaxPublish: config.DAILY_MAX_PUBLISH,
    graphBase: config.THREADS_GRAPH_BASE,
  });
});

// ---------------- 고급 연결 설정(수동 fallback) ----------------
// 순서: 먼저 후보값을 검증하고, 검증 성공 시에만 파일 저장 → 런타임 반영. 실패면 아무것도
// 바꾸지 않으므로 이미 정상 연결된 사용자가 오타 한 번으로 연결을 잃지 않습니다.
// P0.5: userId가 비어 있으면 토큰만으로 /me를 호출해 id/username을 자동 확보합니다.
router.post("/", async (req, res) => {
  const accessToken = typeof req.body?.accessToken === "string" ? req.body.accessToken.trim() : "";
  let userId = typeof req.body?.userId === "string" ? req.body.userId.trim() : "";

  if (!accessToken) {
    return res.status(400).json({ saved: false, valid: false, error: "액세스 토큰을 입력해 주세요." });
  }

  let username: string | undefined;
  if (!userId) {
    const me = await fetchThreadsMe(accessToken);
    if (!me.ok || !me.id) {
      return res.status(400).json({ saved: false, valid: false, error: "토큰으로 계정을 확인하지 못했습니다. 토큰을 다시 확인해 주세요." });
    }
    userId = me.id;
    username = me.username;
  }

  // 1) 후보값으로 검증(전역 config는 건드리지 않음 - 임시 교체/복원 방식 금지)
  const result = await validateThreadsToken({ accessToken, userId });
  if (!result.valid) {
    return res.status(400).json({ saved: false, valid: false, error: result.error || "연결 확인에 실패했습니다." });
  }
  if (!username) username = result.username;

  // 2) 성공한 경우에만 저장 → 3) 런타임 즉시 반영
  writeThreadsCredentials(accessToken, userId, { username, source: "manual" });
  config.THREADS_ACCESS_TOKEN = accessToken;
  config.THREADS_USER_ID = userId;

  res.json({ saved: true, valid: true, username, maskedToken: maskToken(accessToken), userId });
});

// 저장된 연결 다시 확인(/me 기반 기존 검증 재사용). 만료/실패면 구매자 문구로만 안내합니다.
router.post("/validate", async (_req, res) => {
  const result = await validateThreadsToken();
  if (!result.valid) {
    return res.json({ valid: false, error: "Threads 연결이 만료되었거나 확인할 수 없습니다. 다시 연결해 주세요." });
  }
  res.json({ valid: true, username: result.username, userId: result.userId });
});

// 계정 연결 해제: 로컬 credential 파일만 삭제합니다. Threads의 실제 계정/게시물은 건드리지 않습니다.
router.post("/disconnect", (_req, res) => {
  discardThreadsOAuthSession();
  clearThreadsCredentials();
  config.THREADS_ACCESS_TOKEN = "";
  config.THREADS_USER_ID = "";
  res.json({ ok: true });
});

// ---------------- BYO OAuth ----------------
// App ID/App Secret/target username은 이 한 요청으로만 받고, 서버 in-memory 세션이 OAuth 완료까지
// 보관한 뒤 폐기합니다. 프런트는 이후 /oauth/status만 조회합니다(secret을 다시 보내지 않음).
router.post("/oauth/start", async (req, res) => {
  const appId = typeof req.body?.appId === "string" ? req.body.appId : "";
  const appSecret = typeof req.body?.appSecret === "string" ? req.body.appSecret : "";
  const targetUsername = typeof req.body?.targetUsername === "string" ? req.body.targetUsername : "";

  const r = await startThreadsOAuth({ appId, appSecret, targetUsername });
  if (!r.ok) {
    const messages: Record<string, string> = {
      INVALID_INPUT: "Threads 앱 ID, 앱 시크릿 코드, 사용자명을 모두 입력해 주세요.",
      LICENSE_INVALID: "Threads 계정 연결을 시작할 수 없습니다. relay 접속 키 설정을 확인해 주세요.",
      RELAY_NOT_CONFIGURED: "Threads 연결 서비스가 설정되지 않았습니다.",
      RELAY_UNAVAILABLE: "Threads 연결 서비스에 접속할 수 없습니다. 잠시 후 다시 시도해 주세요.",
      BROWSER_OPEN_FAILED: "브라우저를 열지 못했습니다. [브라우저 다시 열기]를 눌러 주세요.",
    };
    const status = r.code === "INVALID_INPUT" ? 400 : r.code === "LICENSE_INVALID" ? 403 : 503;
    return res.status(status).json({ ok: false, code: r.code, field: r.field, error: messages[r.code] });
  }
  res.json({ ok: true, status: r.status });
});

// P0.5B: 저장된 App ID/username + DPAPI 보호 secret으로 입력 폼 없이 재연결. 복호화 실패/저장값 없음이면
// 기존 연결을 건드리지 않고 prefill(appId/username)만 돌려줘 화면이 secret만 다시 받게 한다.
router.post("/oauth/reconnect", async (_req, res) => {
  const r = await reconnectThreadsOAuth();
  if (!r.ok) {
    if (r.code === "SECRET_UNAVAILABLE") {
      return res.status(409).json({
        ok: false,
        code: r.code,
        prefill: r.prefill,
        error: "저장된 앱 연결 정보를 사용할 수 없습니다. Threads 앱 시크릿 코드를 다시 입력해 주세요.",
      });
    }
    const messages: Record<string, string> = {
      INVALID_INPUT: "저장된 앱 연결 정보가 올바르지 않습니다. 다시 입력해 주세요.",
      LICENSE_INVALID: "Threads 계정 연결을 시작할 수 없습니다. relay 접속 키 설정을 확인해 주세요.",
      RELAY_NOT_CONFIGURED: "Threads 연결 서비스가 설정되지 않았습니다.",
      RELAY_UNAVAILABLE: "Threads 연결 서비스에 접속할 수 없습니다. 잠시 후 다시 시도해 주세요.",
      BROWSER_OPEN_FAILED: "브라우저를 열지 못했습니다. [브라우저 다시 열기]를 눌러 주세요.",
    };
    const status = r.code === "LICENSE_INVALID" ? 403 : r.code === "INVALID_INPUT" ? 409 : 503;
    return res.status(status).json({ ok: false, code: r.code, prefill: r.prefill, error: messages[r.code] || "Threads 연결을 시작하지 못했습니다." });
  }
  res.json({ ok: true, status: r.status });
});

router.get("/oauth/status", (_req, res) => {
  res.json({ ok: true, status: getThreadsOAuthStatus() });
});

// 살아 있는 세션의 같은 authorization URL을 다시 엽니다(새 state를 만들지 않음).
router.post("/oauth/reopen", async (_req, res) => {
  const r = await reopenThreadsOAuthBrowser();
  if (!r.ok) return res.status(409).json({ ok: false, error: "다시 열 수 있는 연결 요청이 없습니다. 처음부터 다시 연결해 주세요." });
  res.json({ ok: true });
});

// 진행 중 시도를 사용자가 취소. 기존 credential은 건드리지 않습니다.
router.post("/oauth/cancel", (_req, res) => {
  discardThreadsOAuthSession();
  res.json({ ok: true });
});

export default router;
