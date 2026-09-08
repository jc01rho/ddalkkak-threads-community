// src/validation.ts
// 요청 형식 검증. 값의 "형태"만 보고, 의미 검증(license 유효성, state 존재 여부)은 route가
// 합니다. 모든 실패는 INVALID_REQUEST.

import { MAX_AUTH_CODE_CHARS } from "./config.js";
import { RelayError } from "./errors.js";

function requireString(obj: Record<string, unknown>, key: string, maxLen: number): string {
  const v = obj[key];
  if (typeof v !== "string" || v.trim().length === 0) throw new RelayError("INVALID_REQUEST", `${key} 값이 필요합니다.`);
  if (v.length > maxLen) throw new RelayError("INVALID_REQUEST", `${key} 값이 너무 깁니다.`);
  return v.trim();
}

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new RelayError("INVALID_REQUEST", "요청 본문은 JSON 객체여야 합니다.");
  return body as Record<string, unknown>;
}

export interface StartRequest {
  licenseId: string;
  machineHash: string;
}

export function validateStartRequest(body: unknown): StartRequest {
  const obj = asObject(body);
  return { licenseId: requireString(obj, "licenseId", 256), machineHash: requireString(obj, "machineHash", 256) };
}

export interface PollRequest {
  state: string;
  pollToken: string;
}

export function validatePollRequest(body: unknown): PollRequest {
  const obj = asObject(body);
  return { state: requireString(obj, "state", 128), pollToken: requireString(obj, "pollToken", 2048) };
}

// Meta callback query: code/state는 Meta가 붙이는 값이라 신뢰하지 않고 길이만 제한합니다.
// state 문자셋은 우리가 generateState로 만든 base64url만 허용(그 외는 등록된 적이 없으므로
// 저장소 조회 전에 거부 - 무의미한 KV 조회를 막음).
const STATE_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;

export interface CallbackQuery {
  state: string;
  code: string | null; // null = 사용자가 거부/취소(Meta가 error 파라미터를 보냄)
}

export function validateCallbackQuery(url: URL): CallbackQuery {
  const state = url.searchParams.get("state") ?? "";
  if (!STATE_PATTERN.test(state)) throw new RelayError("INVALID_REQUEST", "잘못된 요청입니다.");
  const code = url.searchParams.get("code");
  if (code !== null) {
    if (code.length === 0 || code.length > MAX_AUTH_CODE_CHARS) throw new RelayError("INVALID_REQUEST", "잘못된 요청입니다.");
    return { state, code };
  }
  // Meta는 사용자가 승인을 거부하면 code 대신 error/error_reason/error_description을 보냅니다.
  // 그 문자열을 그대로 저장하거나 화면에 되비추지 않습니다 - "거부됨" 사실만 기록합니다.
  return { state, code: null };
}
