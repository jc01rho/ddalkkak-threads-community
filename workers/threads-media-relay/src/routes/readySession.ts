// src/routes/readySession.ts — POST /v1/threads-media/ready
// license 서버는 다시 호출하지 않습니다(session token 서명만 신뢰 - licenseValidator.ts
// 상단 주석 참고). 순서: token 검증 -> actor 기반 rate limit(Phase 12.5.6B.1 - raw IP
// 미사용, signed token 내부 actor hash만 사용) -> item마다 HEAD로 실제 업로드 존재/크기/
// Content-Type 확인 -> 전부 통과해야 GET presigned URL을 발급합니다(CAROUSEL은
// payload.items의 index 순서를 그대로 유지해 순서가 뒤바뀌지 않게 합니다).

import { RelayBucket } from "../r2Bucket.js";
import { R2Signer } from "../r2Signer.js";
import { RelayError } from "../errors.js";
import { checkRateLimit } from "../rateLimit.js";
import { verifySessionToken } from "../sessionToken.js";

export interface ReadySessionDeps {
  hmacSecret: string;
  bucket: RelayBucket;
  signer: R2Signer;
  rateLimiter?: RateLimit;
  now?: () => number;
}

export interface ReadySessionResult {
  ok: true;
  mediaType: string;
  media: { index: number; getUrl: string }[];
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

export async function handleReadySession(body: unknown, deps: ReadySessionDeps): Promise<ReadySessionResult> {
  const token = tokenFromBody(body);
  const nowMs = (deps.now ?? Date.now)();
  const verified = await verifySessionToken(token, deps.hmacSecret, nowMs);
  if (!verified.ok) {
    if (verified.reason === "expired") throw new RelayError("SESSION_EXPIRED", "세션이 만료되었습니다.");
    throw new RelayError("SESSION_INVALID", "유효하지 않은 세션입니다.");
  }
  const payload = verified.payload;

  if (!(await checkRateLimit(deps.rateLimiter, `ready-actor:${payload.actor}`))) {
    throw new RelayError("RATE_LIMITED", "요청이 너무 잦습니다. 잠시 후 다시 시도하세요.");
  }

  const remainingSeconds = Math.max(60, Math.floor(payload.exp - nowMs / 1000));
  const media: { index: number; getUrl: string }[] = [];
  for (const item of payload.items) {
    const info = await deps.bucket.head(item.key);
    if (!info) throw new RelayError("UPLOAD_NOT_FOUND", `업로드가 확인되지 않았습니다(index ${item.index}).`);
    if (info.size !== item.sizeBytes) throw new RelayError("UPLOAD_SIZE_MISMATCH", `업로드 크기가 일치하지 않습니다(index ${item.index}).`);
    if (info.contentType !== item.contentType) {
      throw new RelayError("UPLOAD_CONTENT_TYPE_MISMATCH", `업로드 Content-Type이 일치하지 않습니다(index ${item.index}).`);
    }
    const presigned = await deps.signer.presignGet(item.key, remainingSeconds);
    media.push({ index: item.index, getUrl: presigned.url });
  }

  return { ok: true, mediaType: payload.mediaType, media };
}
