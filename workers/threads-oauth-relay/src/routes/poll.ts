// src/routes/poll.ts — POST /oauth/poll { state, pollToken }
// 로컬 딸깍이 수 초 간격으로 호출합니다. 순서: 형식 검증 -> pollToken HMAC 검증(license 게이트의
// 연장) -> token.state === body.state -> 레코드 조회 -> 상태별 응답.
//
// one-time consume: status가 ready면 code를 응답하기 "직전"에 레코드를 삭제합니다. 같은 state로
// 두 번째 poll이 오면 레코드가 없으므로 expired로 응답합니다(replay 불가). denied도 1회 응답 후
// 삭제합니다.

import { RelayError } from "../errors.js";
import { logInfo } from "../logging.js";
import { verifyPollToken } from "../pollToken.js";
import { checkRateLimit } from "../rateLimit.js";
import { isRecordExpired, StateStore } from "../stateStore.js";
import { validatePollRequest } from "../validation.js";

export interface PollDeps {
  store: StateStore;
  hmacSecret: string;
  rateLimiter?: RateLimit;
  nowSec?: () => number;
}

export type PollResult = { status: "pending" } | { status: "ready"; code: string } | { status: "expired" } | { status: "denied" };

export async function handlePoll(body: unknown, deps: PollDeps): Promise<PollResult> {
  const validated = validatePollRequest(body);
  const nowSec = (deps.nowSec ?? (() => Math.floor(Date.now() / 1000)))();

  const verified = await verifyPollToken(validated.pollToken, deps.hmacSecret, nowSec);
  if (!verified.ok) {
    // 만료된 pollToken은 곧 만료된 state이기도 하므로 expired로 안내해 로컬이 새 /start로
    // 넘어가게 합니다. 서명 불일치/형식 오류는 토큰 자체가 우리 것이 아니므로 401.
    if (verified.reason === "expired") return { status: "expired" };
    throw new RelayError("POLL_TOKEN_INVALID", "유효하지 않은 요청입니다.");
  }
  if (verified.payload.state !== validated.state) {
    throw new RelayError("POLL_TOKEN_INVALID", "유효하지 않은 요청입니다.");
  }

  if (!(await checkRateLimit(deps.rateLimiter, `poll-actor:${verified.payload.actor}`))) {
    throw new RelayError("RATE_LIMITED", "요청이 너무 잦습니다. 잠시 후 다시 시도하세요.");
  }

  const record = await deps.store.get(validated.state);
  if (!record) return { status: "expired" };
  if (record.actor !== verified.payload.actor) throw new RelayError("POLL_TOKEN_INVALID", "유효하지 않은 요청입니다.");
  if (isRecordExpired(record, nowSec)) {
    await deps.store.delete(validated.state);
    return { status: "expired" };
  }

  if (record.status === "pending") return { status: "pending" };

  // ready/denied: 1회 소비 후 즉시 삭제.
  await deps.store.delete(validated.state);
  if (record.status === "denied") {
    logInfo("oauth_poll_denied_consumed", { actor: record.actor });
    return { status: "denied" };
  }
  if (!record.code) return { status: "expired" }; // 방어: ready인데 code가 없으면 손상 레코드로 취급
  logInfo("oauth_poll_ready_consumed", { actor: record.actor });
  return { status: "ready", code: record.code };
}
