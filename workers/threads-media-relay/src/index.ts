// src/index.ts — 최상위 fetch handler 라우터(요청서: Hono 등 프레임워크 없이 native
// Request/Response만 사용, 정확히 3개 endpoint + GET /health).
//
// 여기서만 하는 일(cross-cutting 관심사, route handler에는 두지 않음):
//   - 경로/메서드 매칭(모르는 경로 404, 잘못된 메서드 405)
//   - rate limiting 2단계(Phase 12.5.6B.1 - 요청서 3절):
//     1) /session pre-validation: license 검증(Apps Script 호출) 이전에, raw IP가 아닌
//        파생 해시(deriveIpRateLimitKey)를 key로 쓰는 burst limiter만 여기 index.ts에 둠
//        (license 검증 전이라 아직 actor를 모름 - IP 기반이 유일한 선택지). raw IP는
//        로그에 남기지 않고, limiter key도 원본이 아닌 해시값만 사용.
//     2) /session post-validation, /ready, /cleanup의 actor 단위 rate limit은 각 route
//        handler 내부에서 처리(license 검증 성공 후 또는 session token 검증 성공 후에만
//        actor를 알 수 있으므로 - deriveActorHash/token.actor 기반, raw IP 미사용).
//   - body 파싱(http.ts) + 실제 binding/secret으로부터 route deps 조립
//   - 모든 오류를 toRelayErrorResponse로 통일, 모든 응답에 Cache-Control: no-store

import { MAX_REQUEST_BODY_BYTES, resolvePresignedUrlTtlSeconds } from "./config.js";
import { toRelayErrorResponse, RelayError } from "./errors.js";
import { jsonResponse, readJsonBody } from "./http.js";
import { ClientKeyLicenseValidator } from "./licenseValidator.js";
import { deriveIpRateLimitKey } from "./logging.js";
import { checkRateLimit } from "./rateLimit.js";
import { R2BucketAdapter } from "./r2Bucket.js";
import { R2Signer } from "./r2Signer.js";
import { handleCleanupSession } from "./routes/cleanupSession.js";
import { handleCreateSession } from "./routes/createSession.js";
import { handleHealth } from "./routes/health.js";
import { handleReadySession } from "./routes/readySession.js";
import { Env } from "./types.js";

function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

// /session 전용 pre-validation burst limiter. raw IP 문자열을 limiter key로 직접 쓰지
// 않고 파생 해시를 씁니다 - 이 해시도 로그에는 남기지 않습니다(limiter 호출에만 사용).
async function withSessionPreValidationRateLimit(env: Env, request: Request): Promise<void> {
  const ipKey = await deriveIpRateLimitKey(clientIp(request));
  const ok = await checkRateLimit(env.SESSION_RATE_LIMITER, `session-pre:${ipKey}`);
  if (!ok) throw new RelayError("RATE_LIMITED", "요청이 너무 잦습니다. 잠시 후 다시 시도하세요.");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/health") {
        if (request.method !== "GET") return methodNotAllowed();
        return jsonResponse(200, handleHealth());
      }

      if (url.pathname === "/v1/threads-media/session") {
        if (request.method !== "POST") return methodNotAllowed();
        await withSessionPreValidationRateLimit(env, request);
        const body = await readJsonBody(request, MAX_REQUEST_BODY_BYTES);
        const ttlSeconds = resolvePresignedUrlTtlSeconds(env.PRESIGNED_URL_TTL_SECONDS);
        const result = await handleCreateSession(body, {
          licenseValidator: new ClientKeyLicenseValidator({ clientKey: env.THREADS_RELAY_CLIENT_KEY }),
          signer: new R2Signer({
            accountId: env.R2_ACCOUNT_ID,
            bucketName: env.R2_BUCKET_NAME,
            accessKeyId: env.R2_ACCESS_KEY_ID,
            secretAccessKey: env.R2_SECRET_ACCESS_KEY,
          }),
          hmacSecret: env.RELAY_SESSION_HMAC_SECRET,
          ttlSeconds,
          rateLimiter: env.SESSION_RATE_LIMITER,
        });
        return jsonResponse(200, result);
      }

      if (url.pathname === "/v1/threads-media/ready") {
        if (request.method !== "POST") return methodNotAllowed();
        const body = await readJsonBody(request, MAX_REQUEST_BODY_BYTES);
        const result = await handleReadySession(body, {
          hmacSecret: env.RELAY_SESSION_HMAC_SECRET,
          bucket: new R2BucketAdapter(env.RELAY_BUCKET),
          signer: new R2Signer({
            accountId: env.R2_ACCOUNT_ID,
            bucketName: env.R2_BUCKET_NAME,
            accessKeyId: env.R2_ACCESS_KEY_ID,
            secretAccessKey: env.R2_SECRET_ACCESS_KEY,
          }),
          rateLimiter: env.SESSION_RATE_LIMITER,
        });
        return jsonResponse(200, result);
      }

      if (url.pathname === "/v1/threads-media/cleanup") {
        if (request.method !== "POST") return methodNotAllowed();
        const body = await readJsonBody(request, MAX_REQUEST_BODY_BYTES);
        const result = await handleCleanupSession(body, {
          hmacSecret: env.RELAY_SESSION_HMAC_SECRET,
          bucket: new R2BucketAdapter(env.RELAY_BUCKET),
          rateLimiter: env.SESSION_RATE_LIMITER,
        });
        return jsonResponse(200, result);
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
