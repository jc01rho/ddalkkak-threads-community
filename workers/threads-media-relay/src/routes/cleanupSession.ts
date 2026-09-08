// src/routes/cleanupSession.ts — POST /v1/threads-media/cleanup
// 설계 결정(요청서 26절 - 결정과 이유 보고 대상): 만료된 session token은 cleanup에서도
// 그대로 거부합니다(SESSION_EXPIRED). "만료됐어도 정리는 허용"하는 예외 경로를 따로 두면
// verifySessionToken의 검증 모드가 strict/lenient로 갈라져 코드가 복잡해지고, "만료된 토큰도
// 결국 통과한다"는 약한 지점이 생깁니다. 정상 흐름(publish 직후 즉시 cleanup 호출)에서는
// 토큰이 만료 전이므로 문제가 없고, 드물게 놓친 orphan object는 R2 lifecycle 규칙(1일
// 단위 - 요청서/design doc에 이미 명시된 backstop)이 최종적으로 정리합니다.
// delete는 이미 없는 key에 대해서도 에러 없이 성공 처리됩니다(idempotent) - 같은 cleanup을
// 중복 호출해도 안전합니다.
// rate limit(Phase 12.5.6B.1): raw IP 미사용, signed token 내부 actor hash 기반.

import { RelayError } from "../errors.js";
import { RelayBucket } from "../r2Bucket.js";
import { checkRateLimit } from "../rateLimit.js";
import { verifySessionToken } from "../sessionToken.js";

export interface CleanupSessionDeps {
  hmacSecret: string;
  bucket: RelayBucket;
  rateLimiter?: RateLimit;
  now?: () => number;
}

export interface CleanupSessionResult {
  ok: true;
  deletedCount: number;
}

function tokenFromBody(body: unknown): string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new RelayError("INVALID_REQUEST", "요청 본문 형식이 올바르지 않습니다.");
  }
  const record = body as Record<string, unknown>;
  if (!Object.keys(record).every((k) => k === "sessionToken") || typeof record.sessionToken !== "string" || !record.sessionToken) {
    throw new RelayError("INVALID_REQUEST", "sessionToken이 필요합니다.");
  }
  return record.sessionToken;
}

export async function handleCleanupSession(body: unknown, deps: CleanupSessionDeps): Promise<CleanupSessionResult> {
  const token = tokenFromBody(body);
  const nowMs = (deps.now ?? Date.now)();
  const verified = await verifySessionToken(token, deps.hmacSecret, nowMs);
  if (!verified.ok) {
    if (verified.reason === "expired") throw new RelayError("SESSION_EXPIRED", "세션이 만료되었습니다.");
    throw new RelayError("SESSION_INVALID", "유효하지 않은 세션입니다.");
  }
  if (!(await checkRateLimit(deps.rateLimiter, `cleanup-actor:${verified.payload.actor}`))) {
    throw new RelayError("RATE_LIMITED", "요청이 너무 잦습니다. 잠시 후 다시 시도하세요.");
  }

  // client가 임의 key를 지정할 수 없습니다 - 오직 서명된 token 내부 item 목록의 key만 삭제합니다.
  const keys = verified.payload.items.map((i) => i.key);
  const deletedCount = await deps.bucket.delete(keys);
  return { ok: true, deletedCount };
}
