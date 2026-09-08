// src/stateStore.ts
// state → 레코드 저장소 추상화. Worker 메모리는 요청 간 영속이 보장되지 않으므로 외부 저장소가
// 필요합니다. 선택: Cloudflare KV.
//
// 이유(요청서 5절):
//   - 레코드는 수백 바이트, 수명 10분, 사용량은 "구매자가 연결 버튼을 누른 횟수"라 매우 작음
//   - KV expirationTtl이 TTL 폐기를 저장소 수준에서 보장 → 별도 cleanup cron 불필요
//   - 무료 플랜 범위 안, binding 1줄, 코드 수십 줄 - Durable Object보다 구성/유지보수가 작음
//
// 알려진 한계(정직하게): KV는 eventually consistent라, 같은 state로 수십 ms 간격의 동시
// poll이 서로 다른 엣지에서 처리되면 둘 다 ready를 읽을 이론적 창이 있습니다. 이 Worker에서
// 그 창의 실제 위험은 낮습니다 - (1) poll은 pollToken을 가진 로컬 딸깍 한 프로세스만 보내고
// (2) Meta의 authorization code는 어차피 Meta 쪽에서 1회만 교환되며 (3) code만으로는 구매자
// App Secret 없이 아무것도 할 수 없습니다. 사용량이 커지거나 강한 원자성이 필요해지면 이
// 인터페이스를 그대로 두고 Durable Object 구현으로 바꾸면 됩니다(호출부 무변경).

import { STATE_KEY_PREFIX, STATE_TTL_SECONDS } from "./config.js";
import { OAuthStateRecord } from "./types.js";

export interface StateStore {
  get(state: string): Promise<OAuthStateRecord | null>;
  put(state: string, record: OAuthStateRecord): Promise<void>;
  delete(state: string): Promise<void>;
}

export class KvStateStore implements StateStore {
  constructor(private readonly kv: KVNamespace) {}

  async get(state: string): Promise<OAuthStateRecord | null> {
    const raw = await this.kv.get(STATE_KEY_PREFIX + state, "text");
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as OAuthStateRecord;
      if (!parsed || parsed.v !== 1) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  async put(state: string, record: OAuthStateRecord): Promise<void> {
    await this.kv.put(STATE_KEY_PREFIX + state, JSON.stringify(record), { expirationTtl: STATE_TTL_SECONDS });
  }

  async delete(state: string): Promise<void> {
    await this.kv.delete(STATE_KEY_PREFIX + state);
  }
}

// 레코드가 TTL을 넘겼는지(저장소가 아직 지우지 않았더라도) 호출부가 직접 판단할 때 씁니다.
export function isRecordExpired(record: OAuthStateRecord, nowSec = Math.floor(Date.now() / 1000)): boolean {
  return nowSec - record.createdAt >= STATE_TTL_SECONDS;
}
