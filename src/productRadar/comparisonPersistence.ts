// src/productRadar/comparisonPersistence.ts
// 상품 레이더 Phase 9.5: Comparison Snapshot Persistence Foundation.
// docs/designs/product-radar-phase9-comparison-foundation-design.md 16절 대응(물리
// schema 조정 이유는 src/database.ts의 SCHEMA_SQL 주석 참고).
//
// 이 파일은 "저장 계층"입니다 - category classification, identity/variation 추출,
// relation, compatibility 중 어느 것도 다시 계산하지 않습니다. 저장/복원 양쪽 모두
// src/productRadar/comparisonSnapshot.ts의 buildComparisonSnapshot()을 재호출해서
// "형식이 Phase 9.4 invariant를 만족하는가"만 재확인합니다 - buildComparisonSnapshot()
// 자체가 relation/compatibility/category를 전혀 재계산하지 않는 순수 validation +
// canonical immutable shape 함수이므로(comparisonSnapshot.ts 코드 참고), 여기서 다시
// 부르는 것은 "판정 재실행"이 아니라 "저장/복원 경계에서의 형식 재검증"입니다. 이 재사용
// 덕분에 comparisonSnapshot.ts는 이번 Phase에서 한 글자도 수정하지 않았습니다.

import { getDb } from "../database";
import { buildComparisonSnapshot } from "./comparisonSnapshot";
import {
  ComparisonSnapshot,
  ComparisonSnapshotBuildResult,
  ComparisonSnapshotInput,
  ComparisonSnapshotPairResult,
  ComparisonSnapshotProductEvidence,
  ComparisonSnapshotProductRef,
} from "./types";

interface ComparisonSnapshotRow {
  id: number;
  compare_group_id: number;
  revision: number;
  created_at: string;
  info_as_of: string;
  product_refs_json: string;
  product_evidence_json: string;
  pairs_json: string;
}

// insert 트랜잭션 내부에서만 쓰는 sentinel 에러 - 일반 Error를 던지면 better-sqlite3
// transaction()이 자동 롤백해 주는 점을 그대로 활용하고, catch에서 code로 분기한다.
class ComparisonSnapshotPersistenceError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

function mapInsertError(e: unknown): string {
  if (e instanceof ComparisonSnapshotPersistenceError) return e.code;
  const err = e as { code?: string; message?: string };
  const msg = err?.message || "";
  if (err?.code === "SQLITE_CONSTRAINT_PRIMARYKEY" || msg.includes("UNIQUE constraint failed: product_radar_comparison_snapshots.id")) {
    return "duplicate_snapshot_id";
  }
  if (err?.code === "SQLITE_CONSTRAINT_UNIQUE" || msg.includes("idx_prcs_group_revision")) {
    return "duplicate_group_revision";
  }
  if (err?.code === "SQLITE_CONSTRAINT_FOREIGNKEY" || msg.includes("FOREIGN KEY constraint failed")) {
    return "compare_group_not_found";
  }
  return "comparison_snapshot_insert_failed";
}

// 저장해도 되는지 검증한다(설계서 12절/Phase 9.5 지시서 4절): Comparison Snapshot은
// INSERT-only이므로 잘못된 요청이면 절대 저장하지 않는다.
// 1. buildComparisonSnapshot()으로 형식 재검증(Phase 9.4 invariant) - 실패하면 저장하지
//    않는다. 이건 DB 상태를 읽지 않는 순수 validation이라 transaction 밖에서 해도 안전하다.
// 2~4는 전부 DB 상태를 읽고 그 결과에 따라 INSERT 여부를 정하므로 반드시 같은 transaction
// 안에서 원자적으로 실행한다(검수 보정 - 이전에는 2가 transaction 밖에 있어서, ref 확인과
// INSERT 사이에 이론적으로 DB 상태가 바뀔 여지가 있었다):
// 2. 각 productRef의 productSnapshotId가 실제 product_radar_product_snapshots.id로
//    존재하고, 그 행의 product_id가 productRef.productId와 정확히 같은지 확인(설계서
//    8절 "exact reference") - productId가 같다는 이유만으로 통과시키지 않는다.
// 3. 같은 compare_group_id 안에서 revision이 정확히 (현재 최대 revision + 1)인지
//    확인(strict append, 설계서 7절 v1 안전 정책) - 그 외에는 전부 UNIQUE(compare_group_id,
//    revision) 인덱스와 PK가 최후 방어선으로 거부한다.
// 4. INSERT.
export function insertProductRadarComparisonSnapshot(
  snapshot: ComparisonSnapshot | ComparisonSnapshotInput
): ComparisonSnapshotBuildResult {
  const revalidated = buildComparisonSnapshot(snapshot as ComparisonSnapshotInput);
  if (!revalidated.ok || !revalidated.snapshot) {
    return { ok: false, snapshot: null, errors: revalidated.errors };
  }
  const canonical = revalidated.snapshot;
  const db = getDb();

  try {
    const txn = db.transaction((): void => {
      const refCheckStmt = db.prepare("SELECT product_id FROM product_radar_product_snapshots WHERE id = ?");
      for (const ref of canonical.productRefs) {
        const row = refCheckStmt.get(ref.productSnapshotId) as { product_id: number } | undefined;
        if (!row) {
          throw new ComparisonSnapshotPersistenceError("product_snapshot_ref_not_found");
        }
        if (row.product_id !== ref.productId) {
          throw new ComparisonSnapshotPersistenceError("product_snapshot_ref_product_mismatch");
        }
      }

      const maxRevRow = db
        .prepare("SELECT MAX(revision) as maxRev FROM product_radar_comparison_snapshots WHERE compare_group_id = ?")
        .get(canonical.compareGroupId) as { maxRev: number | null };
      const expectedRevision = (maxRevRow.maxRev ?? 0) + 1;
      if (canonical.revision !== expectedRevision) {
        throw new ComparisonSnapshotPersistenceError("invalid_revision_sequence");
      }

      db.prepare(
        `INSERT INTO product_radar_comparison_snapshots
          (id, compare_group_id, revision, created_at, info_as_of, product_refs_json, product_evidence_json, pairs_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        canonical.id,
        canonical.compareGroupId,
        canonical.revision,
        canonical.createdAt,
        canonical.infoAsOf,
        JSON.stringify(canonical.productRefs),
        JSON.stringify(canonical.productEvidence),
        JSON.stringify(canonical.pairs)
      );
    });
    txn();
  } catch (e) {
    return { ok: false, snapshot: null, errors: [mapInsertError(e)] };
  }

  return { ok: true, snapshot: canonical, errors: [] };
}

// Phase 9.7: orchestration(comparisonOrchestration.ts)이 호출하는 전용 insert 경로.
// 위 insertProductRadarComparisonSnapshot()과 다른 점은 딱 하나 - id/revision을 호출자가
// 미리 정해서 넘기지 않는다. Orchestrator가 "MAX(id)+1"/"MAX(revision)+1"을 transaction
// 밖에서 미리 계산해 넘기면 동시 요청 사이에 값이 어긋날 수 있으므로(요청서 2-C절 금지
// 패턴), id는 SQLite의 INTEGER PRIMARY KEY AUTOINCREMENT가 INSERT 시점에 직접 할당하게
// 하고(컬럼 목록에서 id를 아예 뺀다), revision은 기존 함수와 동일하게 같은 transaction
// 안에서 MAX(revision)+1로 확정한다 - 두 값 다 "확정 시점"이 실제 INSERT와 원자적이다.
export interface ComparisonSnapshotOrchestrationInput {
  compareGroupId: number;
  createdAt: string;
  infoAsOf: string;
  productRefs: ComparisonSnapshotProductRef[];
  productEvidence: ComparisonSnapshotProductEvidence[];
  pairs: ComparisonSnapshotPairResult[];
}

export function insertProductRadarComparisonSnapshotForGroup(
  input: ComparisonSnapshotOrchestrationInput
): ComparisonSnapshotBuildResult {
  // id/revision은 아직 모른다(트랜잭션 안에서 확정된다). buildComparisonSnapshot()은
  // 두 필드를 finite number로 요구할 뿐 전역 유일성은 검사하지 않으므로(그건 이 함수의
  // transaction이 담당), 형식 검증 목적의 placeholder(0)를 넣어도 "Phase 9.4 invariant를
  // 만족하는가"는 그대로 정확히 검증된다.
  const placeholderInput: ComparisonSnapshotInput = {
    id: 0,
    compareGroupId: input.compareGroupId,
    revision: 0,
    createdAt: input.createdAt,
    infoAsOf: input.infoAsOf,
    productRefs: input.productRefs,
    productEvidence: input.productEvidence,
    pairs: input.pairs,
  };
  const revalidated = buildComparisonSnapshot(placeholderInput);
  if (!revalidated.ok || !revalidated.snapshot) {
    return { ok: false, snapshot: null, errors: revalidated.errors };
  }
  const canonical = revalidated.snapshot;
  const db = getDb();

  let finalSnapshot: ComparisonSnapshot | null = null;
  try {
    const txn = db.transaction((): void => {
      const refCheckStmt = db.prepare("SELECT product_id FROM product_radar_product_snapshots WHERE id = ?");
      for (const ref of canonical.productRefs) {
        const row = refCheckStmt.get(ref.productSnapshotId) as { product_id: number } | undefined;
        if (!row) {
          throw new ComparisonSnapshotPersistenceError("product_snapshot_ref_not_found");
        }
        if (row.product_id !== ref.productId) {
          throw new ComparisonSnapshotPersistenceError("product_snapshot_ref_product_mismatch");
        }
      }

      const maxRevRow = db
        .prepare("SELECT MAX(revision) as maxRev FROM product_radar_comparison_snapshots WHERE compare_group_id = ?")
        .get(canonical.compareGroupId) as { maxRev: number | null };
      const nextRevision = (maxRevRow.maxRev ?? 0) + 1;

      const insertInfo = db
        .prepare(
          `INSERT INTO product_radar_comparison_snapshots
            (compare_group_id, revision, created_at, info_as_of, product_refs_json, product_evidence_json, pairs_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          canonical.compareGroupId,
          nextRevision,
          canonical.createdAt,
          canonical.infoAsOf,
          JSON.stringify(canonical.productRefs),
          JSON.stringify(canonical.productEvidence),
          JSON.stringify(canonical.pairs)
        );
      const realId = Number(insertInfo.lastInsertRowid);

      finalSnapshot = Object.freeze({ ...canonical, id: realId, revision: nextRevision });
    });
    txn();
  } catch (e) {
    return { ok: false, snapshot: null, errors: [mapInsertError(e)] };
  }

  return { ok: true, snapshot: finalSnapshot!, errors: [] };
}

// DB row -> ComparisonSnapshot. JSON 파싱 실패/형식 붕괴 둘 다 조용히 보정하지 않고
// 거부한다(설계서 12절). buildComparisonSnapshot()이 다시 deep clone + freeze하므로
// 반환값은 DB row/원본 JSON 문자열과 완전히 독립된 새 불변 객체다(읽기 결과 immutability).
function hydrateComparisonSnapshotRow(row: ComparisonSnapshotRow): ComparisonSnapshotBuildResult {
  let productRefs: unknown;
  let productEvidence: unknown;
  let pairs: unknown;
  try {
    productRefs = JSON.parse(row.product_refs_json);
    productEvidence = JSON.parse(row.product_evidence_json);
    pairs = JSON.parse(row.pairs_json);
  } catch {
    return { ok: false, snapshot: null, errors: ["comparison_snapshot_corrupt"] };
  }

  const candidate: ComparisonSnapshotInput = {
    id: row.id,
    compareGroupId: row.compare_group_id,
    revision: row.revision,
    createdAt: row.created_at,
    infoAsOf: row.info_as_of,
    productRefs: productRefs as ComparisonSnapshotInput["productRefs"],
    productEvidence: productEvidence as ComparisonSnapshotInput["productEvidence"],
    pairs: pairs as ComparisonSnapshotInput["pairs"],
  };

  const rebuilt = buildComparisonSnapshot(candidate);
  if (!rebuilt.ok || !rebuilt.snapshot) {
    return { ok: false, snapshot: null, errors: ["comparison_snapshot_corrupt", ...rebuilt.errors] };
  }
  return { ok: true, snapshot: rebuilt.snapshot, errors: [] };
}

export function getProductRadarComparisonSnapshotById(id: number): ComparisonSnapshotBuildResult {
  const db = getDb();
  const row = db.prepare("SELECT * FROM product_radar_comparison_snapshots WHERE id = ?").get(id) as ComparisonSnapshotRow | undefined;
  if (!row) {
    return { ok: false, snapshot: null, errors: ["comparison_snapshot_not_found"] };
  }
  return hydrateComparisonSnapshotRow(row);
}

// list 전용 결과 - insert/get-by-id의 {ok, snapshot, errors}(단일 snapshot)와 달리
// 여러 개를 담아야 해서 snapshots(복수)로 필드명만 다르다. 나머지 관례는 동일하게 맞춘다.
export interface ComparisonSnapshotListResult {
  ok: boolean;
  snapshots: ComparisonSnapshot[] | null;
  errors: string[];
}

// revision 오름차순(deterministic). 검수 보정 - 손상된 행이 하나라도 있으면 "정상인
// 것만 골라서" 반환하지 않는다(그건 손상을 조용히 숨기는 것과 같다). 하나라도 hydration에
// 실패하면 목록 전체를 deterministic failure로 반환한다 - 부분적으로 옳은 목록은 없다.
export function listProductRadarComparisonSnapshotsByCompareGroupId(compareGroupId: number): ComparisonSnapshotListResult {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM product_radar_comparison_snapshots WHERE compare_group_id = ? ORDER BY revision ASC")
    .all(compareGroupId) as ComparisonSnapshotRow[];
  const snapshots: ComparisonSnapshot[] = [];
  for (const row of rows) {
    const hydrated = hydrateComparisonSnapshotRow(row);
    if (!hydrated.ok || !hydrated.snapshot) {
      return { ok: false, snapshots: null, errors: hydrated.errors };
    }
    snapshots.push(hydrated.snapshot);
  }
  return { ok: true, snapshots, errors: [] };
}

// 가장 높은 revision을 SQL로 먼저 확정한 뒤 그 행만 hydrate한다(검수 보정 - 예전에는
// 손상된 최고 revision을 건너뛰고 더 낮은 정상 revision으로 fallback했는데, 이는
// "최신 비교 결과가 손상됐다"는 사실을 숨기는 것과 같다). 그 행이 손상됐으면 더 낮은
// revision을 대신 찾지 않고 corruption 그대로 반환한다.
export function getLatestProductRadarComparisonSnapshot(compareGroupId: number): ComparisonSnapshotBuildResult {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM product_radar_comparison_snapshots WHERE compare_group_id = ? ORDER BY revision DESC LIMIT 1")
    .get(compareGroupId) as ComparisonSnapshotRow | undefined;
  if (!row) {
    return { ok: false, snapshot: null, errors: ["comparison_snapshot_not_found"] };
  }
  return hydrateComparisonSnapshotRow(row);
}
