// src/index.ts — 최상위 fetch 라우터(프레임워크 없이 native Request/Response).
//
// 경로 4개:
//   GET  /health
//   POST /oauth/start     - 로컬 딸깍: license 검증 후 state + pollToken 발급
//   GET  /oauth/callback  - Meta 브라우저 redirect: 등록된 state에 code 저장, 단순 HTML 응답
//   POST /oauth/poll      - 로컬 딸깍: pollToken으로 code 1회 수령
//
// 여기서만 하는 cross-cutting 관심사:
//   - 경로/메서드 매칭(404/405)
//   - license 검증 이전 단계(/start)와 Meta callback(/callback)의 IP 파생 해시 burst limiter
//     (raw IP는 limiter key로도 로그로도 쓰지 않음)
//   - body 파싱, binding으로부터 route deps 조립
//   - 모든 오류를 toRelayErrorResponse로 통일(callback은 HTML), 모든 응답 Cache-Control: no-store
//
// 로그 원칙: 이 파일은 console.* 를 직접 호출하지 않습니다. 요청 URL(= code가 들어 있는
// query)을 어디에도 기록하지 않습니다.

import { MAX_REQUEST_BODY_BYTES } from "./config.js";
import { RelayError, toRelayErrorResponse } from "./errors.js";
import { jsonResponse, readJsonBody } from "./http.js";
import { ClientKeyLicenseValidator } from "./licenseValidator.js";
import { deriveIpRateLimitKey } from "./logging.js";
import { checkRateLimit } from "./rateLimit.js";
import { callbackHtml, handleCallback, htmlResponse } from "./routes/callback.js";
import { handleHealth } from "./routes/health.js";
import { handlePoll } from "./routes/poll.js";
import { handleStart } from "./routes/start.js";
import { KvStateStore } from "./stateStore.js";
import { Env } from "./types.js";

function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

async function withIpRateLimit(env: Env, request: Request, scope: string): Promise<void> {
  const ipKey = await deriveIpRateLimitKey(clientIp(request));
  const ok = await checkRateLimit(env.OAUTH_RATE_LIMITER, `${scope}:${ipKey}`);
  if (!ok) throw new RelayError("RATE_LIMITED", "요청이 너무 잦습니다. 잠시 후 다시 시도하세요.");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Meta callback은 브라우저가 직접 여는 경로라 JSON 오류 대신 HTML을 돌려줍니다.
    // 어떤 실패든 동일한 일반 안내만 보여주고(STATE_UNKNOWN/EXPIRED/ALREADY_USED 구분 노출 안 함),
    // query에 실려 온 code/state/error 문자열은 절대 되비추지 않습니다.
    if (url.pathname === "/oauth/callback") {
      if (request.method !== "GET") return methodNotAllowed();
      try {
        await withIpRateLimit(env, request, "callback-ip");
        const result = await handleCallback(url, { store: new KvStateStore(env.OAUTH_STATE_KV) });
        return htmlResponse(callbackHtml(result.outcome));
      } catch {
        return htmlResponse(callbackHtml("error"), 400);
      }
    }

    try {
      if (url.pathname === "/health") {
        if (request.method !== "GET") return methodNotAllowed();
        return jsonResponse(200, handleHealth());
      }

      if (url.pathname === "/oauth/start") {
        if (request.method !== "POST") return methodNotAllowed();
        await withIpRateLimit(env, request, "start-ip");
        const body = await readJsonBody(request, MAX_REQUEST_BODY_BYTES);
        const result = await handleStart(body, {
          licenseValidator: new ClientKeyLicenseValidator({ clientKey: env.THREADS_RELAY_CLIENT_KEY }),
          store: new KvStateStore(env.OAUTH_STATE_KV),
          hmacSecret: env.OAUTH_POLL_HMAC_SECRET,
          rateLimiter: env.OAUTH_RATE_LIMITER,
        });
        return jsonResponse(200, result);
      }

      if (url.pathname === "/oauth/poll") {
        if (request.method !== "POST") return methodNotAllowed();
        const body = await readJsonBody(request, MAX_REQUEST_BODY_BYTES);
        const result = await handlePoll(body, {
          store: new KvStateStore(env.OAUTH_STATE_KV),
          hmacSecret: env.OAUTH_POLL_HMAC_SECRET,
          rateLimiter: env.OAUTH_RATE_LIMITER,
        });
        return jsonResponse(200, { ok: true, ...result });
      }

      return notFound();
    } catch (e) {
      return toRelayErrorResponse(e);
    }
  },
};

function notFound(): Response {
  return new Response(JSON.stringify({ ok: false, code: "NOT_FOUND", message: "존재하지 않는 경로입니다." }), {
    status: 404,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function methodNotAllowed(): Response {
  return new Response(JSON.stringify({ ok: false, code: "METHOD_NOT_ALLOWED", message: "허용되지 않는 메서드입니다." }), {
    status: 405,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
