// src/types.ts
// Worker 전역 타입. Env는 wrangler.jsonc.example의 vars/secrets/bindings와 1:1로 대응합니다.
//
// 이 Worker가 "절대 다루지 않는 것"을 타입 수준에서도 드러냅니다: 아래 어디에도 App Secret,
// access token, Threads user id, username 필드가 없습니다. 있는 것은 state / authorization
// code / 상태값뿐입니다.

export interface Env {
  // ---- secrets(wrangler secret put으로만 등록) ----
  // /oauth/start가 발급하는 pollToken을 서명/검증하는 HMAC 키. media relay의
  // RELAY_SESSION_HMAC_SECRET와 같은 역할이지만 별도 키를 씁니다(Worker 간 토큰 교차 사용 차단).
  OAUTH_POLL_HMAC_SECRET: string;
  // relay를 쓰는 앱이 자신을 증명하는 client key. 요청 본문의 licenseId와 비교합니다.
  // OAUTH_POLL_HMAC_SECRET과는 용도가 다른 별도 값입니다(재사용 금지).
  THREADS_RELAY_CLIENT_KEY: string;

  // ---- bindings ----
  // state → {status, code} 레코드 저장소. TTL(expirationTtl)로 자동 폐기됩니다.
  OAUTH_STATE_KV: KVNamespace;
  OAUTH_RATE_LIMITER?: RateLimit;
}

// KV에 저장되는 레코드. code는 ready 상태에서만 존재하며, poll이 1회 꺼내는 즉시 레코드
// 전체가 삭제됩니다.
export type OAuthStateStatus = "pending" | "ready" | "denied";

export interface OAuthStateRecord {
  v: 1;
  status: OAuthStateStatus;
  // 이 state를 등록한 구매자/기기의 파생 해시(raw license id/machine hash는 저장하지 않음).
  actor: string;
  createdAt: number; // epoch seconds
  code?: string; // status === "ready" 일 때만
}

// /oauth/start가 돌려주는 HMAC-signed 토큰의 payload. state와 짝이 맞아야 poll이 가능합니다.
// state는 Meta redirect를 거치며 사용자의 브라우저 주소창/히스토리에 남을 수 있으므로,
// state만으로는 code를 꺼낼 수 없게 하는 두 번째 열쇠입니다(이 값은 로컬 앱 밖으로 나가지 않음).
export interface PollTokenPayload {
  v: 1;
  state: string;
  actor: string;
  exp: number; // epoch seconds
}
