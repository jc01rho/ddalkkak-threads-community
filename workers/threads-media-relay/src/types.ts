// src/types.ts
// Worker 전역에서 쓰는 타입 정의. Env는 wrangler.jsonc.example의 vars/secrets/bindings와
// 정확히 대응합니다(실제 값은 이번 Phase에서 어디에도 존재하지 않습니다 - 전부 placeholder).

export interface Env {
  // ---- 일반 vars(비밀 아님) ----
  R2_ACCOUNT_ID: string;
  R2_BUCKET_NAME: string;
  PRESIGNED_URL_TTL_SECONDS: string;

  // ---- secrets(wrangler secret put으로만 등록, vars에 평문으로 적지 않음) ----
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  RELAY_SESSION_HMAC_SECRET: string;
  // relay를 쓰는 앱이 자신을 증명하는 client key. 요청 본문의 licenseId와 비교합니다.
  // RELAY_SESSION_HMAC_SECRET과는 용도가 다른 별도 값입니다(재사용 금지).
  THREADS_RELAY_CLIENT_KEY: string;

  // ---- bindings ----
  RELAY_BUCKET: R2Bucket;
  SESSION_RATE_LIMITER?: RateLimit;
}

export type ThreadsMediaType = "IMAGE" | "VIDEO" | "CAROUSEL";

// 이 앱이 실제로 생성/업로드하는 미디어 종류만 다룹니다(Threads 공식 지원 포맷과 다시 한 번
// 구분 - 예: WEBP/GIF는 Meta도 own-media로 지원하지 않거나 이 제품이 다루지 않아 목록에
// 없습니다).
export type AllowedContentType = "image/png" | "image/jpeg" | "video/mp4";

export interface RequestedItem {
  contentType: string;
  sizeBytes: number;
}

export interface SessionItemPayload {
  index: number;
  key: string;
  contentType: AllowedContentType;
  sizeBytes: number;
}

// HMAC-signed stateless session token payload. raw license id/machine hash는 절대
// 포함하지 않습니다(요청서 17절) - actor는 derived hash만.
export interface SessionTokenPayload {
  v: 1;
  sid: string;
  actor: string;
  mediaType: ThreadsMediaType;
  exp: number;
  items: SessionItemPayload[];
}
