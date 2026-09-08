// src/validation.ts
// POST /session 요청 검증(요청서 12·13·14·15절). 이 파일을 통과해야만 license 검증 단계로
// 넘어갑니다 - 여기서 거부되는 요청은 Apps Script를 호출하지 않습니다(quota 절약이자,
// 형식이 잘못된 요청으로 license 서버를 두드리지 않기 위함).

import { ALLOWED_MEDIA_TYPES, isAllowedContentType, ITEM_COUNT_RULES, maxBytesFor } from "./config.js";
import { RelayError } from "./errors.js";
import { RequestedItem, ThreadsMediaType } from "./types.js";

export interface ValidatedSessionRequest {
  licenseId: string;
  machineHash: string;
  mediaType: ThreadsMediaType;
  items: RequestedItem[];
}

const SESSION_REQUEST_ALLOWED_KEYS = new Set(["licenseId", "machineHash", "mediaType", "items"]);
const ITEM_ALLOWED_KEYS = new Set(["contentType", "sizeBytes"]);

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

export function validateSessionRequest(body: unknown): ValidatedSessionRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new RelayError("INVALID_REQUEST", "요청 본문 형식이 올바르지 않습니다.");
  }
  const record = body as Record<string, unknown>;
  if (!Object.keys(record).every((k) => SESSION_REQUEST_ALLOWED_KEYS.has(k))) {
    throw new RelayError("INVALID_REQUEST", "알 수 없는 필드가 포함되어 있습니다.");
  }
  if (!isNonEmptyString(record.licenseId) || !isNonEmptyString(record.machineHash)) {
    throw new RelayError("INVALID_REQUEST", "licenseId/machineHash가 필요합니다.");
  }
  if (typeof record.mediaType !== "string" || !ALLOWED_MEDIA_TYPES.includes(record.mediaType as ThreadsMediaType)) {
    throw new RelayError("MEDIA_TYPE_UNSUPPORTED", "지원하지 않는 media type입니다.");
  }
  const mediaType = record.mediaType as ThreadsMediaType;

  if (!Array.isArray(record.items)) {
    throw new RelayError("INVALID_REQUEST", "items가 필요합니다.");
  }
  const rule = ITEM_COUNT_RULES[mediaType];
  if (record.items.length < rule.min || record.items.length > rule.max) {
    throw new RelayError("MEDIA_ITEM_COUNT_INVALID", `${mediaType}는 ${rule.min}~${rule.max}개 항목만 허용합니다.`);
  }

  const items: RequestedItem[] = record.items.map((raw) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new RelayError("INVALID_REQUEST", "item 형식이 올바르지 않습니다.");
    }
    const itemRecord = raw as Record<string, unknown>;
    if (!Object.keys(itemRecord).every((k) => ITEM_ALLOWED_KEYS.has(k))) {
      throw new RelayError("INVALID_REQUEST", "item에 알 수 없는 필드가 포함되어 있습니다.");
    }
    const contentType = itemRecord.contentType;
    const sizeBytes = itemRecord.sizeBytes;
    if (typeof contentType !== "string") {
      throw new RelayError("INVALID_REQUEST", "contentType이 필요합니다.");
    }
    if (!isAllowedContentType(mediaType, contentType)) {
      throw new RelayError("MEDIA_CONTENT_TYPE_UNSUPPORTED", `${mediaType}에서 지원하지 않는 형식입니다: ${contentType}`);
    }
    if (typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
      throw new RelayError("INVALID_REQUEST", "sizeBytes가 올바르지 않습니다.");
    }
    const maxBytes = maxBytesFor(contentType);
    if (sizeBytes > maxBytes) {
      throw new RelayError("MEDIA_TOO_LARGE", `허용된 최대 크기(${maxBytes} bytes)를 초과했습니다.`);
    }
    return { contentType, sizeBytes };
  });

  return { licenseId: record.licenseId as string, machineHash: record.machineHash as string, mediaType, items };
}
