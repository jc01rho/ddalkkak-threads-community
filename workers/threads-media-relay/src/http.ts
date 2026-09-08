// src/http.ts
// 요청/응답 공통 헬퍼. body는 JSON metadata만 다루므로(media binary는 절대 Worker를
// 통과하지 않음 - 요청서 28절) 작은 상한(MAX_REQUEST_BODY_BYTES)만 넘으면 파싱 전에 거부합니다.

import { RelayError } from "./errors.js";

export async function readJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  const len = request.headers.get("content-length");
  if (len && Number(len) > maxBytes) {
    throw new RelayError("INVALID_REQUEST", "요청 본문이 너무 큽니다.");
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    throw new RelayError("INVALID_REQUEST", "요청 본문을 읽을 수 없습니다.");
  }
  if (new TextEncoder().encode(text).length > maxBytes) {
    throw new RelayError("INVALID_REQUEST", "요청 본문이 너무 큽니다.");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new RelayError("INVALID_REQUEST", "JSON 파싱에 실패했습니다.");
  }
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
