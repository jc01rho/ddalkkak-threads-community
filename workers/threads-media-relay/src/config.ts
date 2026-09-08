// src/config.ts
// Worker 전역 상수. env var로 조정 가능한 값과, "제품 범위/보안 상수라 env로 바꾸면 안 되는
// 값"을 분리합니다 - 후자는 여기 고정 상수로만 둡니다(구매자/운영자 실수로 완화되지 않도록).

import { ThreadsMediaType } from "./types.js";

// ---- Meta 공식 media 제한(2026-08 developers.facebook.com/docs/threads/posts 재확인) ----
// "IMAGE: 8 MB maximum, JPEG/PNG" / "VIDEO: 1 GB maximum, 300초, MOV/MP4·H264/HEVC·AAC".
// relay 자체 상한은 이 공식 상한을 절대 넘지 않습니다(이보다 큰 파일은 relay가 받아도 Meta가
// 어차피 거부하므로, relay 저장/대역폭만 낭비하는 값을 허용할 이유가 없음).
export const META_OFFICIAL_MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8MB

// VIDEO는 Meta 공식 상한(1GB)보다 훨씬 보수적인 relay 자체 상한을 둡니다(요청서 14절 -
// 근거를 명시해야 함). 근거: (1) 이 제품이 실제로 생성하는 Product Radar carousel/motion
// 영상은 템플릿 기반 그래픽이라 수백 KB~수 MB 수준으로 매우 작음(Phase 12.5.5A/B 실측 -
// QA용 3~4초 클립도 30KB 남짓). (2) 사용자가 직접 업로드하는 "내 사진·영상 첨부"는 이보다
// 클 수 있으나(휴대폰 촬영 제품 시연 클립 등), 200MB는 5분 길이에서 평균 비트레이트
// 약 5.3Mbps에 해당해 일반적인 1080p H.264 클립을 넉넉히 수용하면서도 Meta 공식 상한
// (1GB)의 1/5 수준으로 relay 저장/egress 남용 노출을 제한합니다.
export const RELAY_MAX_VIDEO_BYTES = 200 * 1024 * 1024; // 200MB

// ---- 이 제품이 실제로 지원하는 media 범위(Meta 공식 CAROUSEL 2~20과 별개 - 제품 자체 범위) ----
export const ALLOWED_MEDIA_TYPES: readonly ThreadsMediaType[] = ["IMAGE", "VIDEO", "CAROUSEL"];

export const ITEM_COUNT_RULES: Record<ThreadsMediaType, { min: number; max: number }> = {
  IMAGE: { min: 1, max: 1 },
  VIDEO: { min: 1, max: 1 },
  CAROUSEL: { min: 2, max: 3 },
};

// ---- MIME allowlist(Threads 공식 지원 포맷 + 이 제품이 다루는 미디어 종류 기준) ----
export const IMAGE_CONTENT_TYPES = new Set(["image/png", "image/jpeg"]);
export const VIDEO_CONTENT_TYPES = new Set(["video/mp4"]);

export function isAllowedContentType(mediaType: ThreadsMediaType, contentType: string): boolean {
  if (mediaType === "VIDEO") return VIDEO_CONTENT_TYPES.has(contentType);
  // IMAGE와 CAROUSEL(현재 이미지 slide만) 둘 다 이미지 allowlist를 씁니다.
  return IMAGE_CONTENT_TYPES.has(contentType);
}

export function maxBytesFor(contentType: string): number {
  return contentType === "video/mp4" ? RELAY_MAX_VIDEO_BYTES : META_OFFICIAL_MAX_IMAGE_BYTES;
}

// ---- TTL ----
export const DEFAULT_PRESIGNED_URL_TTL_SECONDS = 1800; // 30분(요청서 23절 근거: 실측 처리
// 시간(수십 초) + 네트워크 지연/재시도 여유. 5초~1시간 범위만 허용(과도하게 긴 TTL 금지).
export const MIN_PRESIGNED_URL_TTL_SECONDS = 300; // 5분
export const MAX_PRESIGNED_URL_TTL_SECONDS = 3600; // 1시간

export function resolvePresignedUrlTtlSeconds(rawEnvValue: string | undefined): number {
  const n = rawEnvValue ? parseInt(rawEnvValue, 10) : NaN;
  if (!Number.isFinite(n)) return DEFAULT_PRESIGNED_URL_TTL_SECONDS;
  if (n < MIN_PRESIGNED_URL_TTL_SECONDS || n > MAX_PRESIGNED_URL_TTL_SECONDS) return DEFAULT_PRESIGNED_URL_TTL_SECONDS;
  return n;
}

// ---- object key ----
// 날짜 prefix만 포함(개인 식별 정보 없음) - 원본 filename/license id/machine hash는 절대
// 포함하지 않습니다(요청서 16절).
export const OBJECT_KEY_PREFIX = "threads-relay/v1";

// ---- HTTP body 보호(요청서 28절) ----
export const MAX_REQUEST_BODY_BYTES = 16 * 1024; // JSON metadata만 받으므로 충분히 작게 제한
