// src/productRadar/productSnapshotProvenance.ts
// 상품 레이더 Phase 12.5.2.3.1: ProductSnapshot capture-event provenance URL(sourceUrl/
// canonicalUrl) 순수 domain validation. database.ts(저장소 계층)는 snapshot_json에서 원문
// 값을 그대로 꺼낼 뿐 판정하지 않는다(displayLabel과 동일한 계층 분리 원칙 -
// getLatestProductRadarProductSnapshot() 참고) - legacy-missing vs corrupt 구분은 이 파일이
// 유일하게 담당한다. DB/Express/Claude 의존성 없음 - 기존 src/urlSafety.ts의
// isValidHttpUrl()만 재사용하고(URL 파서/검증기를 새로 복붙하지 않는다), 재정규화는 하지
// 않는다(browserSave.ts/browserUpdate.ts가 이미 검증/정규화를 마친 값을 그대로 freeze한
// 것이므로 여기서 다시 고치면 "raw preservation" 원칙이 깨진다).
//
// 이번 Phase에는 아직 이 값을 소비하는 ComparisonSnapshot/Threads Copy 경로가 없다 -
// checkFrozenProductSnapshotUrl()은 "필요한 consumer가 생겼을 때 반드시 거쳐야 하는 경계"로
// 지금 확정해 둔다(요청서 17절).

import { isValidHttpUrl } from "../urlSafety";

export type FrozenProductSnapshotUrlCheck =
  | { readonly ok: true; readonly value: string | null }
  | { readonly ok: false };

// undefined(key 자체 없음, legacy snapshot) / null(명시적으로 값이 없었음) -> ok/null, 둘 다
// corrupt가 아니라 정상 결측으로 취급한다. string이고 기존 isValidHttpUrl() 계약(http/https
// scheme + 파싱 가능)을 만족하면 원문 그대로 ok/value로 반환한다 - 여기서 재정규화하지
// 않는다. 그 외(non-string, 또는 string이지만 scheme이 http/https가 아니거나 파싱 자체가
// 안 되는 경우 - 예: "javascript:...", "not a url")는 legacy가 아니라 corrupt이므로 거부한다.
export function checkFrozenProductSnapshotUrl(raw: unknown): FrozenProductSnapshotUrlCheck {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false };
  if (!isValidHttpUrl(raw)) return { ok: false };
  return { ok: true, value: raw };
}
