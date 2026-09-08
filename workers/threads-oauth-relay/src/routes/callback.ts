// src/routes/callback.ts — GET /oauth/callback?code=...&state=...
// Meta가 사용자의 브라우저를 통해 호출합니다. 여기에는 딸깍 license 헤더를 붙일 수 없으므로,
// 보안 경계는 "등록된 state인가"입니다. state는 /start가 license 검증 후 256-bit로 만든 값이라
// 추측이 불가능하고, 등록되지 않은 state로는 어떤 레코드도 만들어지지 않습니다(저장소에 쓰레기를
// 쌓는 경로 없음).
//
// 이 endpoint는 code를 "받아서 저장"만 합니다. App Secret도, token 교환도, /me 호출도 없습니다.
// 응답은 사용자에게 보여줄 단순 HTML이며 code/state/오류 원문을 절대 되비추지 않습니다.

import { RelayError } from "../errors.js";
import { logInfo } from "../logging.js";
import { isRecordExpired, StateStore } from "../stateStore.js";
import { validateCallbackQuery } from "../validation.js";

export interface CallbackDeps {
  store: StateStore;
  nowSec?: () => number;
}

export type CallbackOutcome = "ready" | "denied";

// 반환값은 순수 data - index.ts가 HTML Response로 감쌉니다. 실패는 RelayError throw.
export async function handleCallback(url: URL, deps: CallbackDeps): Promise<{ outcome: CallbackOutcome }> {
  const query = validateCallbackQuery(url);
  const nowSec = (deps.nowSec ?? (() => Math.floor(Date.now() / 1000)))();

  const record = await deps.store.get(query.state);
  if (!record) throw new RelayError("STATE_UNKNOWN", "알 수 없거나 만료된 요청입니다.");
  if (isRecordExpired(record, nowSec)) {
    await deps.store.delete(query.state);
    throw new RelayError("STATE_EXPIRED", "요청이 만료되었습니다.");
  }
  // 같은 state로 두 번째 callback이 오면(브라우저 새로고침/재전송/재생 시도) 먼저 저장된
  // 값을 절대 덮어쓰지 않습니다 - 첫 callback만 유효합니다.
  if (record.status !== "pending") throw new RelayError("STATE_ALREADY_USED", "이미 처리된 요청입니다.");

  if (query.code === null) {
    await deps.store.put(query.state, { ...record, status: "denied" });
    logInfo("oauth_callback_denied", { actor: record.actor });
    return { outcome: "denied" };
  }

  await deps.store.put(query.state, { ...record, status: "ready", code: query.code });
  // code는 로그에 남기지 않습니다(actor 파생 해시와 상태명만).
  logInfo("oauth_callback_ready", { actor: record.actor });
  return { outcome: "ready" };
}

// 사용자 브라우저에 표시할 HTML. 입력값을 한 글자도 포함하지 않는 고정 문자열만 씁니다.
const HTML_HEAD =
  '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<meta name="referrer" content="no-referrer"><title>딸깍 Threads 공장</title>' +
  "<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Malgun Gothic',sans-serif;background:#f6f7f9;color:#1f2937;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}" +
  ".card{background:#fff;border-radius:12px;padding:32px 28px;max-width:420px;box-shadow:0 4px 20px rgba(0,0,0,.08);text-align:center}h1{font-size:20px;margin:0 0 12px}p{margin:0;line-height:1.6;color:#4b5563}</style></head><body><div class=\"card\">";
const HTML_TAIL = "</div></body></html>";

export function callbackHtml(outcome: CallbackOutcome | "error"): string {
  if (outcome === "ready") {
    return HTML_HEAD + "<h1>Threads 계정 승인이 완료되었습니다.</h1><p>이 창을 닫고 딸깍으로 돌아가 주세요.</p>" + HTML_TAIL;
  }
  if (outcome === "denied") {
    return HTML_HEAD + "<h1>계정 연결이 취소되었습니다.</h1><p>이 창을 닫고 딸깍에서 다시 시도해 주세요.</p>" + HTML_TAIL;
  }
  return HTML_HEAD + "<h1>연결 요청을 확인할 수 없습니다.</h1><p>요청이 만료되었거나 이미 처리되었습니다. 이 창을 닫고 딸깍에서 다시 연결해 주세요.</p>" + HTML_TAIL;
}

export function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
    },
  });
}
