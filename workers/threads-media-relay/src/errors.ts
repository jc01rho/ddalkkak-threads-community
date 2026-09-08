// src/errors.ts
// 구조화된 error code(요청서 29절). Cloudflare/R2/AWS/Apps Script 원문 오류 메시지를 client에
// 그대로 전달하지 않습니다 - 이 파일에 정의된 code + 사람이 읽는 message만 노출합니다.

export type RelayErrorCode =
  | "INVALID_REQUEST"
  | "LICENSE_INVALID"
  | "LICENSE_SERVER_UNAVAILABLE"
  | "RATE_LIMITED"
  | "MEDIA_TYPE_UNSUPPORTED"
  | "MEDIA_ITEM_COUNT_INVALID"
  | "MEDIA_CONTENT_TYPE_UNSUPPORTED"
  | "MEDIA_TOO_LARGE"
  | "SESSION_INVALID"
  | "SESSION_EXPIRED"
  | "UPLOAD_NOT_FOUND"
  | "UPLOAD_SIZE_MISMATCH"
  | "UPLOAD_CONTENT_TYPE_MISMATCH"
  | "RELAY_CONFIGURATION_ERROR"
  | "INTERNAL_ERROR";

const HTTP_STATUS_BY_CODE: Record<RelayErrorCode, number> = {
  INVALID_REQUEST: 400,
  LICENSE_INVALID: 401,
  LICENSE_SERVER_UNAVAILABLE: 503,
  RATE_LIMITED: 429,
  MEDIA_TYPE_UNSUPPORTED: 400,
  MEDIA_ITEM_COUNT_INVALID: 400,
  MEDIA_CONTENT_TYPE_UNSUPPORTED: 400,
  MEDIA_TOO_LARGE: 400,
  SESSION_INVALID: 401,
  SESSION_EXPIRED: 401,
  UPLOAD_NOT_FOUND: 404,
  UPLOAD_SIZE_MISMATCH: 409,
  UPLOAD_CONTENT_TYPE_MISMATCH: 409,
  RELAY_CONFIGURATION_ERROR: 502,
  INTERNAL_ERROR: 500,
};

export class RelayError extends Error {
  readonly code: RelayErrorCode;
  constructor(code: RelayErrorCode, message: string) {
    super(message);
    this.name = "RelayError";
    this.code = code;
  }
}

export function relayErrorResponse(code: RelayErrorCode, message: string): Response {
  return new Response(JSON.stringify({ ok: false, code, message }), {
    status: HTTP_STATUS_BY_CODE[code],
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

// 예상하지 못한 예외(버그 포함)를 항상 INTERNAL_ERROR로 안전하게 감싸 client에 노출합니다 -
// 원본 예외 메시지는 절대 client 응답에 포함하지 않습니다(서버 로그에만 남깁니다, 그마저도
// logging.ts의 sanitize 규칙을 따름).
export function toRelayErrorResponse(e: unknown): Response {
  if (e instanceof RelayError) return relayErrorResponse(e.code, e.message);
  return relayErrorResponse("INTERNAL_ERROR", "일시적인 오류가 발생했습니다.");
}
