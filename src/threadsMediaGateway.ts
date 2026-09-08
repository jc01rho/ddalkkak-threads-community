// src/threadsMediaGateway.ts
// Phase 12.5.4 correction(보안 감사 후 추가): Meta에게 로컬 미디어 파일의 "실제 서버 파일명"을
// 그대로 노출하지 않고, 짧은 시간만 유효한 opaque token 1개 <-> 파일 1개 매핑만 외부에
// 공개합니다. 이 매핑은 이 프로세스 메모리에만 존재합니다(서버 재시작 시 전부 무효화되는
// 것이 정확히 원하는 동작입니다 - 디스크/DB에 영속화하지 않습니다).
//
// 왜 필요한가(완료 보고의 보안 감사 참고): THREADS_MEDIA_PUBLIC_BASE_URL을 딸깍 메인
// 서버(server.ts, 대시보드/드래프트/예약/설정 등 전체 /api가 있는 포트)에 그대로 터널을 걸면,
// 그 터널이 열려있는 동안 메인 서버의 모든 경로가 함께 외부에 노출됩니다(요청 자체에 별도
// 클라이언트 인증이 없는 구조이기 때문). 이 파일이 만드는 token은
// threadsMediaListener.ts(별도 포트, 이 경로 하나만 서빙)와
// 짝을 이뤄 "Meta가 필요한 미디어 파일 1개만, 짧은 시간, 이 경로로만" 노출되게 만듭니다.
//
// 설계:
// - token은 crypto.randomBytes(32)의 hex 문자열(256비트 난수)입니다. 파일명을 인코딩하거나
//   파생시키지 않습니다 - token만 봐서는 어떤 파일인지, 심지어 파일명의 존재 여부조차 알 수
//   없습니다(파일명 노출/추측을 원천 차단).
// - token -> filename은 1:1이며 절대 재매핑되지 않습니다. 한 번 발급된 token은 다른 파일에
//   재사용될 수 없습니다.
// - expiresAt이 지나면 만료로 취급합니다(410). 이미 발급된 token은 만료 전까지 여러 번 재사용
//   가능합니다(단발성이 아닙니다) - Meta가 영상 처리 중 같은 URL을 재요청하거나 Range 요청으로
//   여러 번 가져갈 수 있기 때문입니다.
// ponytail: 만료분 청소는 매 issue 호출 시점에만 훑습니다(별도 setInterval 타이머 없음) -
// 개인용 로컬 앱이 발행하는 미디어 개수 규모에서는 이 정도로 충분합니다. 장수명 프로세스에서
// 미사용 token이 실제로 메모리 문제가 될 만큼 쌓이면 주기적 타이머로 교체하세요.

import crypto from "crypto";
import { config } from "./env";

interface ThreadsMediaTokenRecord {
  filename: string;
  expiresAt: number; // epoch ms
}

const tokens = new Map<string, ThreadsMediaTokenRecord>();

function sweepExpired(now: number): void {
  for (const [token, record] of tokens) {
    if (record.expiresAt <= now) tokens.delete(token);
  }
}

// filename은 반드시 호출자(threadsMediaUrlProvider.ts)가 이미 안전성을 확인한 값이어야
// 합니다 - 이 함수는 그 값을 그대로 token에 묶어 저장할 뿐, 별도로 재검증하지 않습니다
// (검증 책임은 항상 호출자 쪽에 둔다는 이 저장소의 기존 원칙과 동일).
export function issueThreadsMediaToken(filename: string): string {
  const now = Date.now();
  sweepExpired(now);
  const token = crypto.randomBytes(32).toString("hex");
  tokens.set(token, { filename, expiresAt: now + config.THREADS_MEDIA_TOKEN_TTL_MS });
  return token;
}

export type ThreadsMediaTokenLookupResult = { ok: true; filename: string } | { ok: false; reason: "not_found" | "expired" };

export function resolveThreadsMediaToken(token: string): ThreadsMediaTokenLookupResult {
  const record = tokens.get(token);
  if (!record) return { ok: false, reason: "not_found" };
  if (record.expiresAt <= Date.now()) {
    tokens.delete(token);
    return { ok: false, reason: "expired" };
  }
  return { ok: true, filename: record.filename };
}

// 테스트 전용: "서버 재시작 시 전부 무효화"와 동일한 상태를 프로세스 재시작 없이 재현합니다.
// 운영 코드 경로에서는 절대 호출되지 않습니다(테스트 파일에서만 import해서 씁니다).
export function clearThreadsMediaTokensForTesting(): void {
  tokens.clear();
}
