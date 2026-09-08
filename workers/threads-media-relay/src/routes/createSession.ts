// src/routes/createSession.ts — POST /v1/threads-media/session
// 순서: 요청 형식 검증 -> (rate limit 확인) -> license 검증(fail-closed, 1회만 호출) ->
// item별 object key 생성 + presigned PUT 발급 -> HMAC session token 발급.
// license 검증 실패/서버 불가 시 세션을 절대 발급하지 않습니다(요청서 fail-closed 원칙).

import { OBJECT_KEY_PREFIX } from "../config.js";
import { RelayError } from "../errors.js";
import { LicenseValidator } from "../licenseValidator.js";
import { deriveActorHash, logInfo, logWarn } from "../logging.js";
import { checkRateLimit } from "../rateLimit.js";
import { extForContentType, generateObjectKey, R2Signer } from "../r2Signer.js";
import { signSessionToken } from "../sessionToken.js";
import { AllowedContentType, SessionItemPayload, SessionTokenPayload } from "../types.js";
import { validateSessionRequest } from "../validation.js";

// rate limiting은 2단계입니다(Phase 12.5.6B.1): license 검증 이전의 IP 파생 해시 기반
// burst limiter는 index.ts 라우터가 처리합니다(아직 actor를 모르므로 IP 기반이 유일한
// 선택지 - raw IP는 쓰지 않고 파생 해시만 씀). license 검증에 성공해 actor(구매자/기기)를
// 알게 된 뒤에는 이 handler가 deriveActorHash 기반 key로 추가 rate limit을 적용합니다 -
// 같은 공유기/NAT 아래 서로 다른 정상 라이선스가 IP 하나로 묶여 불필요하게 서로의 요청량에
// 영향을 주지 않도록 하기 위함입니다.
export interface CreateSessionDeps {
  licenseValidator: LicenseValidator;
  signer: R2Signer;
  hmacSecret: string;
  ttlSeconds: number;
  rateLimiter?: RateLimit;
}

export interface CreateSessionResult {
  ok: true;
  sessionToken: string;
  expiresAt: string;
  uploads: { index: number; putUrl: string; contentType: AllowedContentType }[];
}

// 반환값은 순수 data(Response 아님) - index.ts 라우터가 jsonResponse(200, result)로 감싸고,
// 테스트는 Response 파싱 없이 이 값을 바로 검증할 수 있습니다. 실패는 전부 RelayError throw.
export async function handleCreateSession(body: unknown, deps: CreateSessionDeps): Promise<CreateSessionResult> {
  const validated = validateSessionRequest(body);

  const licenseResult = await deps.licenseValidator.validate(validated.licenseId, validated.machineHash);
  if (!licenseResult.valid) {
    if (licenseResult.reason === "server_unavailable") {
      logWarn("license_server_unavailable", {});
      throw new RelayError("LICENSE_SERVER_UNAVAILABLE", "license 서버에 연결할 수 없습니다.");
    }
    throw new RelayError("LICENSE_INVALID", "유효하지 않은 license입니다.");
  }

  const actor = await deriveActorHash(validated.licenseId, validated.machineHash);
  if (!(await checkRateLimit(deps.rateLimiter, `session-actor:${actor}`))) {
    throw new RelayError("RATE_LIMITED", "요청이 너무 잦습니다. 잠시 후 다시 시도하세요.");
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const exp = nowSec + deps.ttlSeconds;
  const sid = crypto.randomUUID();

  const items: SessionItemPayload[] = [];
  const uploads: { index: number; putUrl: string; contentType: AllowedContentType }[] = [];
  for (const [index, item] of validated.items.entries()) {
    const contentType = item.contentType as AllowedContentType;
    const key = generateObjectKey(OBJECT_KEY_PREFIX, extForContentType(contentType));
    const presigned = await deps.signer.presignPut(key, contentType, deps.ttlSeconds);
    items.push({ index, key, contentType, sizeBytes: item.sizeBytes });
    uploads.push({ index, putUrl: presigned.url, contentType });
  }

  const payload: SessionTokenPayload = { v: 1, sid, actor, mediaType: validated.mediaType, exp, items };
  const sessionToken = await signSessionToken(payload, deps.hmacSecret);

  logInfo("session_created", { actor, mediaType: validated.mediaType, itemCount: items.length });

  return {
    ok: true,
    sessionToken,
    expiresAt: new Date(exp * 1000).toISOString(),
    uploads,
  };
}
