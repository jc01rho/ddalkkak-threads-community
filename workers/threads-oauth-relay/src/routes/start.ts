// src/routes/start.ts — POST /oauth/start
// 순서: 형식 검증 -> license 검증(fail-closed, Apps Script 1회) -> actor rate limit ->
// state 생성(256-bit) -> pending 레코드 저장(TTL) -> pollToken 발급.
//
// 이 endpoint가 라이선스 게이트의 유일한 지점입니다. 이후 /callback은 "이미 등록된 state"만,
// /poll은 "이 endpoint가 발급한 pollToken"만 받으므로, license 없이 이 Worker를 쓸 수 있는
// 경로가 없습니다.

import { STATE_RANDOM_BYTES, STATE_TTL_SECONDS } from "../config.js";
import { RelayError } from "../errors.js";
import { LicenseValidator } from "../licenseValidator.js";
import { deriveActorHash, logInfo, logWarn } from "../logging.js";
import { generateState, signPollToken } from "../pollToken.js";
import { checkRateLimit } from "../rateLimit.js";
import { StateStore } from "../stateStore.js";
import { PollTokenPayload } from "../types.js";
import { validateStartRequest } from "../validation.js";

export interface StartDeps {
  licenseValidator: LicenseValidator;
  store: StateStore;
  hmacSecret: string;
  rateLimiter?: RateLimit;
  nowSec?: () => number;
}

export interface StartResult {
  ok: true;
  state: string;
  pollToken: string;
  expiresAt: string;
}

export async function handleStart(body: unknown, deps: StartDeps): Promise<StartResult> {
  const validated = validateStartRequest(body);

  const licenseResult = await deps.licenseValidator.validate(validated.licenseId, validated.machineHash);
  if (!licenseResult.valid) {
    if (licenseResult.reason === "server_unavailable") {
      logWarn("license_server_unavailable", {});
      throw new RelayError("LICENSE_SERVER_UNAVAILABLE", "license 서버에 연결할 수 없습니다.");
    }
    throw new RelayError("LICENSE_INVALID", "유효하지 않은 license입니다.");
  }

  const actor = await deriveActorHash(validated.licenseId, validated.machineHash);
  if (!(await checkRateLimit(deps.rateLimiter, `start-actor:${actor}`))) {
    throw new RelayError("RATE_LIMITED", "요청이 너무 잦습니다. 잠시 후 다시 시도하세요.");
  }

  const nowSec = (deps.nowSec ?? (() => Math.floor(Date.now() / 1000)))();
  const state = generateState(STATE_RANDOM_BYTES);
  await deps.store.put(state, { v: 1, status: "pending", actor, createdAt: nowSec });

  const exp = nowSec + STATE_TTL_SECONDS;
  const payload: PollTokenPayload = { v: 1, state, actor, exp };
  const pollToken = await signPollToken(payload, deps.hmacSecret);

  // 로그에는 actor 파생 해시만 - state 원문/pollToken은 남기지 않습니다.
  logInfo("oauth_state_registered", { actor });

  return { ok: true, state, pollToken, expiresAt: new Date(exp * 1000).toISOString() };
}
