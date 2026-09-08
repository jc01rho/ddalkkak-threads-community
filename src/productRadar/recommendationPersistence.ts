// src/productRadar/recommendationPersistence.ts
// 상품 레이더 Phase 10.1: Recommendation Snapshot Persistence.
// RecommendationResult(recommendation.ts, Phase 9.9)를 특정 immutable ComparisonSnapshot과
// 연결해 INSERT-only로 저장/조회한다. src/productRadar/comparisonPersistence.ts와 완전히
// 같은 원칙 - 이 파일은 "저장 계층"일 뿐, strengths/cautions/missingInformation을
// 스스로 만들지 않는다(그건 recommendation.ts의 buildRecommendationResult()도 하지 않는
// 일이고, 이 파일은 그 함수를 재사용만 한다). generator가 아니다.
//
// 저장/복원 양쪽 모두 buildRecommendationResult(snapshot, payload)를 다시 통과시킨다 -
// "판정 재실행"이 아니라 "저장/복원 경계에서의 형식 재검증"이다(comparisonPersistence.ts와
// 동일 논리). 이 재사용 덕분에 recommendation.ts는 이번 Phase에서 한 글자도 수정하지 않았다.
//
// insert는 이미 완성된 RecommendationResult(=compareGroupId/comparisonRevision/infoAsOf가
// 이미 박혀 있는 객체)를 받지 않는다 - comparisonSnapshotId와 caller의 원본 판단
// {products, missingInformation}만 받아 buildRecommendationResult()에 그대로 넘긴다.
// metadata는 항상 snapshot에서 새로 파생되므로, caller가 compareGroupId/comparisonRevision/
// infoAsOf를 조작해 넣을 경로 자체가 애초에 없다(완료 보고 8절).
//
// Phase 12.4.1: outputLanguage(저장 메타데이터) 추가. RecommendationResult의 필드가
// 아니다 - recommendation.ts는 한 글자도 건드리지 않는다(comparison_engine/manual_override
// 등 언어 개념이 없는 provenance까지 강제로 갖게 만들 근거가 없음, 완료 보고 7절). 대신
// 이 파일의 저장 계층(RecommendationSnapshotRecord)에만 존재한다. 이 파일은 Claude를
// 몰라야 하므로(요청서 17절) recommendationClaude.ts를 import하지 않는다 - neutral
// 위치(types.ts)에서만 타입을 가져온다.

import { getDb, nowIso } from "../database";
import { getProductRadarComparisonSnapshotById } from "./comparisonPersistence";
import { buildRecommendationResult, RecommendationResult } from "./recommendation";
import { RecommendationOutputLanguage } from "./types";

interface RecommendationSnapshotRow {
  id: number;
  comparison_snapshot_id: number;
  revision: number;
  created_at: string;
  products_json: string;
  missing_information_json: string;
  output_language: string | null;
}

// insert 인자로 들어온 값과 DB에서 막 읽은 값 둘 다 이 함수 하나로 검증한다(같은 의미의
// 값을 두 별도 규칙으로 검증하지 않는다) - null(의도적인 non-language/legacy-compatible
// metadata)과 "ko"/"en"만 허용한다. undefined는 여기서 자동으로 거부된다(=== null도
// === "ko"도 === "en"도 아니므로) - 새 caller가 인자를 빼먹는 프로그래밍 실수와, 의도적으로
// null을 넘기는 것을 구분해야 한다는 요청서 8절 요구를 이 한 줄로 충족한다.
function isValidStoredLanguage(v: unknown): v is RecommendationOutputLanguage | null {
  return v === null || v === "ko" || v === "en";
}

// recommendation revision과 RecommendationResult.comparisonRevision(비교 스냅샷 자체의
// revision)을 같은 이름으로 섞지 않는다 - recommendationRevision으로 명시적으로 구분한다.
// 이 레코드 자체가 최상위 freeze 대상이다 - recommendation 필드는 buildRecommendationResult()가
// 이미 deep freeze했으므로, 이 wrapper만 얼리면 전체가 deep immutable이 된다(중첩 필드를
// 다시 freeze할 필요 없음 - 새로 추가한 가변 구조가 없기 때문).
export interface RecommendationSnapshotRecord {
  readonly id: number;
  readonly comparisonSnapshotId: number;
  readonly recommendationRevision: number;
  readonly createdAt: string;
  readonly outputLanguage: RecommendationOutputLanguage | null;
  readonly recommendation: RecommendationResult;
}

export interface RecommendationSnapshotBuildResult {
  ok: boolean;
  record: RecommendationSnapshotRecord | null;
  errors: string[];
}

export interface RecommendationSnapshotListResult {
  ok: boolean;
  records: RecommendationSnapshotRecord[] | null;
  errors: string[];
}

// insert transaction 내부에서만 쓰는 sentinel 에러 - comparisonPersistence.ts와 동일하게
// 일반 Error를 던져 better-sqlite3 transaction()의 자동 롤백을 그대로 활용한다. codes를
// 배열로 들고 다녀 buildRecommendationResult()가 반환하는 여러 개의 stable error code를
// 하나로 뭉개지 않는다.
class RecommendationSnapshotPersistenceError extends Error {
  codes: string[];
  constructor(codes: string[]) {
    super(codes[0] || "recommendation_snapshot_insert_failed");
    this.codes = codes;
  }
}

function mapInsertErrors(e: unknown): string[] {
  if (e instanceof RecommendationSnapshotPersistenceError) return e.codes;
  const err = e as { code?: string; message?: string };
  const msg = err?.message || "";
  if (err?.code === "SQLITE_CONSTRAINT_UNIQUE" || msg.includes("idx_prrs_snapshot_revision")) {
    return ["duplicate_recommendation_revision"];
  }
  if (err?.code === "SQLITE_CONSTRAINT_FOREIGNKEY" || msg.includes("FOREIGN KEY constraint failed")) {
    return ["comparison_snapshot_not_found"];
  }
  return ["recommendation_snapshot_insert_failed"];
}

// 저장 절차(comparisonPersistence.ts insertProductRadarComparisonSnapshotForGroup()과 동일
// 구조 - MAX(revision)+1 계산과 INSERT를 같은 transaction 안에서 원자적으로 처리한다):
// 1. comparisonSnapshotId 형식 확인(양의 안전 정수) - 아니면 즉시 거부.
// 1-2. outputLanguage 형식 확인(null | "ko" | "en"만 허용, undefined 포함 그 외 전부 거부) -
//    Phase 12.4.1 추가. 암묵적 default 없음 - caller가 명시적으로 null을 넘기지 않으면
//    거부된다(요청서 7절 "암묵적 default 금지").
// 2. transaction 내부에서 부모 ComparisonSnapshot을 다시 조회한다(TOCTOU 고려 - 존재
//    확인이 실제 INSERT와 같은 원자적 단위 안에 있어야 한다는 comparisonPersistence.ts의
//    선례를 그대로 따른다). 없으면 거부 - FK도 최종 방어선으로 남아 있지만 그보다 먼저
//    의미 있는 에러 코드를 준다.
// 3. buildRecommendationResult(snapshot, input)로 caller의 원본 판단을 재검증 -
//    compareGroupId/comparisonRevision/infoAsOf는 여기서 snapshot으로부터 다시 계산되므로
//    caller가 그 값을 조작해 넣을 방법이 없다(입력 shape 자체에 그 필드가 없음). outputLanguage는
//    이 재검증에 전혀 관여하지 않는다 - recommendation.ts는 language 개념을 모른다.
// 4. 같은 comparison_snapshot_id 안에서 MAX(revision)+1을 transaction 안에서 확정.
//    outputLanguage와 무관하게 하나의 카운터를 공유한다(language별 revision 분리 없음,
//    요청서 13절).
// 5. INSERT. id는 caller가 제공하지 않고 AUTOINCREMENT + lastInsertRowid를 쓴다.
//    createdAt도 caller 제공을 받지 않고 여기서 서버 시각으로 만든다.
export function insertProductRadarRecommendationSnapshot(
  comparisonSnapshotId: number,
  outputLanguage: RecommendationOutputLanguage | null,
  input: unknown
): RecommendationSnapshotBuildResult {
  if (!Number.isSafeInteger(comparisonSnapshotId) || comparisonSnapshotId <= 0) {
    return { ok: false, record: null, errors: ["comparison_snapshot_not_found"] };
  }
  if (!isValidStoredLanguage(outputLanguage)) {
    return { ok: false, record: null, errors: ["recommendation_output_language_invalid"] };
  }

  const db = getDb();
  const createdAt = nowIso();
  let record: RecommendationSnapshotRecord | null = null;

  try {
    const txn = db.transaction((): void => {
      const snapshotResult = getProductRadarComparisonSnapshotById(comparisonSnapshotId);
      if (!snapshotResult.ok || !snapshotResult.snapshot) {
        throw new RecommendationSnapshotPersistenceError(["comparison_snapshot_not_found"]);
      }

      const built = buildRecommendationResult(snapshotResult.snapshot, input);
      if (!built.ok || !built.recommendation) {
        throw new RecommendationSnapshotPersistenceError(built.errors);
      }
      const canonical = built.recommendation;

      const maxRevRow = db
        .prepare("SELECT MAX(revision) as maxRev FROM product_radar_recommendation_snapshots WHERE comparison_snapshot_id = ?")
        .get(comparisonSnapshotId) as { maxRev: number | null };
      const nextRevision = (maxRevRow.maxRev ?? 0) + 1;

      const insertInfo = db
        .prepare(
          `INSERT INTO product_radar_recommendation_snapshots
            (comparison_snapshot_id, revision, created_at, products_json, missing_information_json, output_language)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          comparisonSnapshotId,
          nextRevision,
          createdAt,
          JSON.stringify(canonical.products),
          JSON.stringify(canonical.missingInformation),
          outputLanguage
        );

      record = Object.freeze({
        id: Number(insertInfo.lastInsertRowid),
        comparisonSnapshotId,
        recommendationRevision: nextRevision,
        createdAt,
        outputLanguage,
        recommendation: canonical,
      });
    });
    txn();
  } catch (e) {
    return { ok: false, record: null, errors: mapInsertErrors(e) };
  }

  return { ok: true, record: record!, errors: [] };
}

// DB row -> RecommendationSnapshotRecord. JSON.parse만 해서 그대로 반환하지 않는다 -
// 부모 ComparisonSnapshot을 다시 조회하고, buildRecommendationResult()로 domain invariant를
// 재검증한 canonical 값만 반환한다(comparisonPersistence.ts hydrateComparisonSnapshotRow()와
// 동일 원칙). corrupt를 조용히 넘기지 않는다: JSON 파싱 실패, 부모 snapshot 없음/손상,
// products/missingInformation shape 위반, snapshot membership 위반, invalid provenance,
// output_language 컬럼 값이 null/"ko"/"en" 중 하나가 아님(Phase 12.4.1 추가) 등
// buildRecommendationResult()/isValidStoredLanguage()가 잡아내는 모든 invariant 위반이
// 전부 이 경로로 거부된다. 컬럼 값이 SQL NULL이면(better-sqlite3가 JS null로 돌려준다)
// legacy row로 인정해 outputLanguage: null을 그대로 반환한다 - row를 rewrite하지 않는다.
function hydrateRecommendationSnapshotRow(row: RecommendationSnapshotRow): RecommendationSnapshotBuildResult {
  let products: unknown;
  let missingInformation: unknown;
  try {
    products = JSON.parse(row.products_json);
    missingInformation = JSON.parse(row.missing_information_json);
  } catch {
    return { ok: false, record: null, errors: ["recommendation_snapshot_corrupt"] };
  }

  if (!isValidStoredLanguage(row.output_language)) {
    return { ok: false, record: null, errors: ["recommendation_snapshot_corrupt", "recommendation_output_language_invalid"] };
  }
  const outputLanguage = row.output_language;

  const snapshotResult = getProductRadarComparisonSnapshotById(row.comparison_snapshot_id);
  if (!snapshotResult.ok || !snapshotResult.snapshot) {
    return { ok: false, record: null, errors: ["recommendation_snapshot_corrupt", "comparison_snapshot_not_found"] };
  }

  const rebuilt = buildRecommendationResult(snapshotResult.snapshot, { products, missingInformation });
  if (!rebuilt.ok || !rebuilt.recommendation) {
    return { ok: false, record: null, errors: ["recommendation_snapshot_corrupt", ...rebuilt.errors] };
  }

  const record: RecommendationSnapshotRecord = Object.freeze({
    id: row.id,
    comparisonSnapshotId: row.comparison_snapshot_id,
    recommendationRevision: row.revision,
    createdAt: row.created_at,
    outputLanguage,
    recommendation: rebuilt.recommendation,
  });
  return { ok: true, record, errors: [] };
}

export function getProductRadarRecommendationSnapshotById(id: number): RecommendationSnapshotBuildResult {
  const db = getDb();
  const row = db.prepare("SELECT * FROM product_radar_recommendation_snapshots WHERE id = ?").get(id) as RecommendationSnapshotRow | undefined;
  if (!row) {
    return { ok: false, record: null, errors: ["recommendation_snapshot_not_found"] };
  }
  return hydrateRecommendationSnapshotRow(row);
}

// revision 오름차순(deterministic). 손상된 행이 하나라도 있으면 정상인 것만 골라 반환하지
// 않는다 - comparisonPersistence.ts listProductRadarComparisonSnapshotsByCompareGroupId()와
// 동일하게, 부분적으로 옳은 목록은 없다는 fail-closed 정책을 그대로 적용한다.
export function listProductRadarRecommendationSnapshotsByComparisonSnapshotId(comparisonSnapshotId: number): RecommendationSnapshotListResult {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM product_radar_recommendation_snapshots WHERE comparison_snapshot_id = ? ORDER BY revision ASC")
    .all(comparisonSnapshotId) as RecommendationSnapshotRow[];
  const records: RecommendationSnapshotRecord[] = [];
  for (const row of rows) {
    const hydrated = hydrateRecommendationSnapshotRow(row);
    if (!hydrated.ok || !hydrated.record) {
      return { ok: false, records: null, errors: hydrated.errors };
    }
    records.push(hydrated.record);
  }
  return { ok: true, records, errors: [] };
}

// 가장 높은 revision을 SQL로 먼저 확정한 뒤 그 행만 hydrate한다 - 손상됐으면 더 낮은
// revision으로 fallback하지 않는다(comparisonPersistence.ts
// getLatestProductRadarComparisonSnapshot()와 동일한 검수 보정 원칙 - "최신 결과가
// 손상됐다"는 사실을 숨기지 않는다).
export function getLatestProductRadarRecommendationSnapshotByComparisonSnapshotId(
  comparisonSnapshotId: number
): RecommendationSnapshotBuildResult {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM product_radar_recommendation_snapshots WHERE comparison_snapshot_id = ? ORDER BY revision DESC LIMIT 1")
    .get(comparisonSnapshotId) as RecommendationSnapshotRow | undefined;
  if (!row) {
    return { ok: false, record: null, errors: ["recommendation_snapshot_not_found"] };
  }
  return hydrateRecommendationSnapshotRow(row);
}

// 상품 레이더 Phase 12.4.3: language별 최신 revision. 기존 global latest(위 함수)를 가져온
// 뒤 route가 language로 필터하면 안 된다(요청서 16절) - 그러면 최신 revision이 다른
// language라 필터에 걸릴 때, 그보다 오래된 revision에 이미 존재하는 해당 language 결과를
// 절대 찾지 못한다. 그래서 SQL WHERE 절 자체에 output_language를 넣어 "그 language
// 안에서" DESC LIMIT 1을 구한다. 기존 global latest 함수는 이 함수 추가로 전혀 수정하지
// 않는다(signature/behavior 그대로) - 새 컬럼도, 새 index도 추가하지 않는다(v1 revision
// 수가 적어 단순 WHERE filter로 충분, 요청서 23절).
//
// legacy row(output_language IS NULL)는 이 WHERE 절에 절대 걸리지 않는다 - NULL의 언어를
// 추측하지 않는다(요청서 19절). 손상된 행이 있으면(같은 language 안에서 최신이든 아니든)
// 여전히 fail-closed다 - 다른 language의 corrupt row는 이 SQL의 WHERE 절 자체가 걸러내
// 애초에 영향을 주지 못한다(요청서 22절 - SQL filter가 그 분리를 구조적으로 보장).
export function getLatestProductRadarRecommendationSnapshotByComparisonSnapshotIdAndLanguage(
  comparisonSnapshotId: number,
  outputLanguage: RecommendationOutputLanguage
): RecommendationSnapshotBuildResult {
  if (!isValidStoredLanguage(outputLanguage) || outputLanguage === null) {
    return { ok: false, record: null, errors: ["recommendation_output_language_invalid"] };
  }
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM product_radar_recommendation_snapshots WHERE comparison_snapshot_id = ? AND output_language = ? ORDER BY revision DESC LIMIT 1")
    .get(comparisonSnapshotId, outputLanguage) as RecommendationSnapshotRow | undefined;
  if (!row) {
    return { ok: false, record: null, errors: ["recommendation_snapshot_not_found"] };
  }
  return hydrateRecommendationSnapshotRow(row);
}
