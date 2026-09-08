// src/errors.ts
// 구조화된 error code. Cloudflare/Apps Script/Meta 원문 오류와 authorization code는 어떤
// 응답에도 포함하지 않습니다 - 이 파일에 정의된 code + 사람이 읽는 message만 노출합니다.

export type RelayErrorCode =
  | "INVALID_REQUEST"
  | "LICENSE_INVALID"
  | "LICENSE_SERVER_UNAVAILABLE"
  | "RATE_LIMITED"
  | "STATE_UNKNOWN"
  | "STATE_EXPIRED"
  | "STATE_ALREADY_USED"
  | "POLL_TOKEN_INVALID"
  | "INTERNAL_ERROR";

const HTTP_STATUS_BY_CODE: Record<RelayErrorCode, number> = {
  INVALID_REQUEST: 400,
  LICENSE_INVALID: 401,
  LICENSE_SERVER_UNAVAILABLE: 503,
  RATE_LIMITED: 429,
  STATE_UNKNOWN: 404,
  STATE_EXPIRED: 410,
  STATE_ALREADY_USED: 409,
  POLL_TOKEN_INVALID: 401,
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

// 예상하지 못한 예외는 항상 INTERNAL_ERROR로 감쌉니다 - 원본 예외 메시지(그 안에 URL이나
// code 조각이 섞여 있을 수 있음)는 절대 client 응답에 포함하지 않습니다.
export function toRelayErrorResponse(e: unknown): Response {
  if (e instanceof RelayError) return relayErrorResponse(e.code, e.message);
  return relayErrorResponse("INTERNAL_ERROR", "일시적인 오류가 발생했습니다.");
}
