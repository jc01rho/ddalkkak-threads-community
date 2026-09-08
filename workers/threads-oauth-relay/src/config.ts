// src/config.ts
// 보안/제품 범위 상수. env로 완화할 수 없도록 전부 고정값입니다.

// state 레코드 수명. OAuth 승인은 보통 수십 초 안에 끝나고, Meta의 authorization code 자체도
// 1시간만 유효합니다. 10분이면 느린 로그인/2단계 인증을 넉넉히 덮으면서도 버려진 state가
// 저장소에 오래 남지 않습니다. KV expirationTtl 최소값(60초)보다 충분히 큽니다.
export const STATE_TTL_SECONDS = 600;

// state 원문 길이(바이트). 32바이트 = 256-bit entropy(요청서 3절 권장치).
export const STATE_RANDOM_BYTES = 32;

// Meta가 callback에 실어 보내는 authorization code의 보수적 상한. 실제 code는 수백 자
// 수준이지만, 비정상적으로 긴 값으로 KV 레코드를 부풀리는 시도를 차단합니다.
export const MAX_AUTH_CODE_CHARS = 2048;

// /oauth/start, /oauth/poll의 JSON body 상한(metadata만 받으므로 작게).
export const MAX_REQUEST_BODY_BYTES = 8 * 1024;

// KV key prefix. 레코드 key에는 state 원문 외 어떤 식별 정보도 들어가지 않습니다.
export const STATE_KEY_PREFIX = "oauth:state:";
