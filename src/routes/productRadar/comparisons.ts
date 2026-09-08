// src/routes/productRadar/comparisons.ts
// 상품 레이더 Phase 9.6: Comparison Snapshot HTTP API(딸깍 메인 UI 전용, products.ts와
// 동일 성격 - 별도 게이트 없는 same-origin fetch). ProductRadarBrowser 네이티브
// client(browser.ts, 세션 토큰 게이트)와는 완전히 별개이며, 이 파일에는 세션 토큰/
// saveJobId/updateRequestId/pageSessionId 개념이 전혀 들어오지 않는다(요청서 3절/15절).
//
// Phase 9.7: group 생성(POST /groups)과 실행(POST /groups/:id/run)을 추가했다. run은
// "저장 계층의 얇은 HTTP adapter"가 아니라 서버가 직접 category/identity/variation/
// relation/compatibility를 계산하는 orchestration 진입점이다(comparisonOrchestration.ts로
//위임 - 계산 로직은 이 파일에 없음). 그래서 client가 relation/compatibility/evidence/
// snapshotId/revision/createdAt/infoAsOf를 실어 보내는 raw POST /snapshots write
// 경로는 제거했다(설계서 17절 "클라이언트가 계산 결과를 실어 보내는 요청 바디를 받지
// 않는다") - GET 조회 경로들은 그대로 유지한다. insertProductRadarComparisonSnapshot()
// (caller-provided id/revision 버전)도 comparisonPersistence.ts에서 삭제하지 않았다 -
// production route에서만 더 이상 노출하지 않을 뿐이다.

import { Router } from "express";
import { getProductRadarCompareGroup, getProductRadarProduct, insertProductRadarCompareGroup } from "../../database";
import { findProductRadarComparisonCandidates } from "../../productRadar/comparisonCandidates";
import {
  getLatestProductRadarComparisonSnapshot,
  getProductRadarComparisonSnapshotById,
  listProductRadarComparisonSnapshotsByCompareGroupId,
} from "../../productRadar/comparisonPersistence";
import { runProductRadarComparisonGroup } from "../../productRadar/comparisonOrchestration";
import { generateAndPersistRecommendation } from "../../productRadar/recommendationOrchestration";
import {
  getLatestProductRadarRecommendationSnapshotByComparisonSnapshotId,
  getLatestProductRadarRecommendationSnapshotByComparisonSnapshotIdAndLanguage,
  getProductRadarRecommendationSnapshotById,
  listProductRadarRecommendationSnapshotsByComparisonSnapshotId,
} from "../../productRadar/recommendationPersistence";
import { generateAndPersistProductRadarThreadsCopyDraft } from "../../productRadar/threadsCopyOrchestration";
import { ProductRadarCompareType, ProductRadarProduct, RecommendationOutputLanguage } from "../../productRadar/types";

const router = Router();

// "12" 허용, "12abc"/"1.5"/"-1"/"0"/"01" 전부 거부(요청서 9절) - 앞자리 0 없는 순수
// 양의 정수 문자열만 통과시킨다. 거대한 validation 라이브러리 없이 정규식 하나로 충분.
// 정규식 통과만으로는 부족하다 - "9007199254740993"처럼 Number.MAX_SAFE_INTEGER(2^53-1 =
// 9007199254740991)를 넘는 자릿수 문자열은 정규식 형태는 유효해도 Number() 변환 시 부동
// 소수점 정밀도가 깨져 다른 정수로 반올림될 수 있다(예: ...993 -> ...992로 반올림) -
// 요청한 id와 실제로 DB에서 조회하는 id가 달라질 위험. Number.isSafeInteger()로 그 변환이
// 손실 없이 정확한지 반드시 다시 확인하고, 정규식이 이미 보장하지만 방어적으로 값 자체도
// 양수인지 명시적으로 재확인한다.
export function parsePositiveIntParam(raw: string): number | null {
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return n;
}

// stable error code -> HTTP status(요청서 10절 표, 완료 보고에 그대로 정리).
// 여러 code가 동시에 나오면(예: invalid_product_count + missing_pair) 첫 번째 code로
// status를 정한다 - body의 codes 배열에는 전부 그대로 남긴다(문자열 메시지로 뭉개지 않음).
const STATUS_404_CODES = new Set([
  "comparison_snapshot_not_found",
  "compare_group_not_found",
  "product_snapshot_ref_not_found",
  "product_not_found",
  "recommendation_snapshot_not_found",
]);
const STATUS_409_CODES = new Set(["duplicate_snapshot_id", "duplicate_group_revision", "invalid_revision_sequence"]);
// Phase 12.4.3: recommendation POST 추가로 3개 코드가 늘었다 - recommendation_snapshot_insert_failed(
// 기존에 이미 정의돼 있었으나 route에서 노출된 적은 없었음)/duplicate_recommendation_revision(DB
// UNIQUE 제약 race)/recommendation_output_language_invalid(route가 이미 language를
// ko/en으로 검증한 뒤에만 orchestration을 호출하므로 이 경로에서 실제로 발생하면 client
// 잘못이 아니라 내부 논리 불일치를 뜻한다) - 전부 client/Claude 잘못이 아닌 persistence/내부
// 이상 상태이므로 500에 둔다.
// Phase 12.5.2.3.3.3: Threads Copy draft 생성 POST 추가로 5개 code가 늘었다 - 넷(language_unknown/
// lineage_mismatch/input_invalid/display_label_missing)은 threadsCopyClaude.ts/threadsCopy.ts가
// Claude를 호출하기 전에 이미 persisted된 RecommendationSnapshot/ComparisonSnapshot 자체의
// 내부 일관성을 검사해서 나오는 code라 client가 보낸 request와 무관하고("무조건 400 금지"),
// Claude가 만든 output이 나쁜 것도 아니라("upstream이 실패했다"는 502 의미와도 다름) - 이미
// DB에 저장된 데이터끼리 서로 안 맞는다는 뜻이라 recommendation_snapshot_corrupt/
// comparison_snapshot_corrupt와 같은 성격으로 분류한다. draft_persistence_failed는
// insertDraftsAtomic() 실패를 그대로 옮긴 것으로 위 recommendation/comparison insert_failed와
// 동일한 성격이다.
const STATUS_500_CODES = new Set([
  "comparison_snapshot_corrupt",
  "comparison_snapshot_insert_failed",
  "recommendation_snapshot_corrupt",
  "recommendation_snapshot_insert_failed",
  "duplicate_recommendation_revision",
  "recommendation_output_language_invalid",
  "threads_copy_language_unknown",
  "threads_copy_lineage_mismatch",
  "threads_copy_input_invalid",
  "threads_copy_display_label_missing",
  "threads_copy_draft_persistence_failed",
]);
// Phase 12.4.3: recommendation POST body는 snapshotId(path)+language 두 값만 받는다
// (요청서 5·6절) - client가 products/evidence/prompt 등 recommendation 내용을 직접 실어
// 보낼 방법이 구조적으로 없으므로, 아래 코드가 응답에 나타나면 그 원인은 항상 Claude가
// 생성한 output(또는 host가 그 위에서 만든 missingInformation)이지 client 요청이 아니다 -
// "upstream이 생성한 결과가 우리 검증을 통과 못했다"는 502(Bad Gateway) 의미. 근거 없는
// `code.startsWith("recommendation_")` 같은 넓은 매핑은 쓰지 않는다(요청서 12절 명시 금지) -
// recommendation.ts/recommendationClaudeContract.ts/recommendationClaude.ts 세 파일의
// 실제 에러 코드 문자열 리터럴을 전부 확인해 정확한 목록만 담는다.
const STATUS_502_CODES = new Set([
  "claude_recommendation_output_invalid",
  "recommendation_claude_execution_failed",
  "recommendation_claude_transport_invalid",
  "recommendation_claude_output_not_json",
  "recommendation_evidence_field_null",
  "recommendation_evidence_field_unknown",
  "recommendation_evidence_fields_invalid",
  "recommendation_evidence_not_comparable",
  "recommendation_input_invalid",
  "recommendation_missing_information_invalid",
  "recommendation_product_duplicate",
  "recommendation_product_missing",
  "recommendation_product_not_in_snapshot",
  "recommendation_provenance_invalid",
  "recommendation_statement_invalid",
  "recommendation_unknown_field",
  // Phase 12.5.2.3.3.3: 이 네 code는 실제로 runClaudeRawPrompt() 호출 전후에서 CLI
  // invocation/transport/inner JSON parsing/exact-key contract 검증이 실패했을 때만
  // 나온다(threadsCopyClaude.ts) - 진짜 upstream(Claude) 실패이므로 502가 맞다. 위
  // STATUS_500_CODES에 넣은 language_unknown/lineage_mismatch/input_invalid/
  // display_label_missing과 다르게, 이 넷은 Claude 호출 자체가 실행된 뒤에만 발생한다.
  "threads_copy_claude_execution_failed",
  "threads_copy_claude_transport_invalid",
  "threads_copy_claude_output_not_json",
  "threads_copy_claude_output_invalid",
]);

function statusForErrorCode(code: string): number {
  if (STATUS_404_CODES.has(code)) return 404;
  if (STATUS_409_CODES.has(code)) return 409;
  if (STATUS_500_CODES.has(code)) return 500;
  if (STATUS_502_CODES.has(code)) return 502;
  return 400; // buildComparisonSnapshot()의 나머지 invariant 위반 전부(도메인 validation은 route에 복제하지 않음)
}

function sendPersistenceError(res: import("express").Response, errors: string[], fallbackCode: string): void {
  const codes = errors.length > 0 ? errors : [fallbackCode];
  res.status(statusForErrorCode(codes[0])).json({ ok: false, error: { code: codes[0], codes } });
}

// ---- Phase 9.8: Comparison Candidates(읽기 전용 탐색) ----
// query key는 productId 하나만 허용한다(요청서 3절) - relation/score/categoryKey 같은
// 임의 필드가 들어와도 계산 정책에 영향을 줄 수 없어야 한다는 요구를, "허용 키 목록에
// 없으면 값을 보기도 전에 400으로 거부"하는 방식으로 구조적으로 강제한다.
const CANDIDATES_ALLOWED_QUERY_KEYS: ReadonlySet<string> = new Set(["productId"]);

type CandidatesQueryValidation = { ok: true; productId: number } | { ok: false; code: string };

function validateCandidatesQuery(query: Record<string, unknown>): CandidatesQueryValidation {
  for (const key of Object.keys(query)) {
    if (!CANDIDATES_ALLOWED_QUERY_KEYS.has(key)) return { ok: false, code: "invalid_request_query" };
  }
  // req.query.productId는 string(정상) | string[](중복 쿼리) | undefined(누락) 중 하나 -
  // string이 아니면 전부 malformed로 거부한다(요청서 17절 Q항목: 중복 productId도 거부 대상).
  const raw = query.productId;
  if (typeof raw !== "string") return { ok: false, code: "invalid_id_param" };
  const productId = parsePositiveIntParam(raw);
  if (productId === null) return { ok: false, code: "invalid_id_param" };
  return { ok: true, productId };
}

router.get("/candidates", (req, res) => {
  const validation = validateCandidatesQuery(req.query as Record<string, unknown>);
  if (!validation.ok) {
    return res.status(400).json({ ok: false, error: { code: validation.code, codes: [validation.code] } });
  }

  const result = findProductRadarComparisonCandidates(validation.productId);
  if (!result.ok) {
    return sendPersistenceError(res, result.errors, "product_not_found");
  }
  res.status(200).json({ ok: true, baseProductId: result.baseProductId, candidates: result.candidates });
});

// ---- Phase 9.7: Compare Group 생성 ----
// productIds(2~4, 중복 금지, 전부 실존+active)와 compareType(현재 domain type이 허용하는
// 값만 - 임의 기본값을 만들지 않고 required로 받는다)만 받는다. relation/compatibility
// 계산은 여기서 하지 않는다 - group은 "누구를 비교할지"만 기록하고, 실제 계산은
// POST .../run에서 발생한다.
const VALID_COMPARE_TYPES: ReadonlySet<string> = new Set<ProductRadarCompareType>([
  "same_category",
  "alternative_use",
  "same_product_seller",
  "price_shipping",
  "tier",
  "audience",
]);

type GroupCreateValidation =
  | { ok: true; productIds: number[]; compareType: ProductRadarCompareType }
  | { ok: false; code: string };

function validateGroupCreateBody(body: unknown): GroupCreateValidation {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, code: "invalid_request_body" };
  const b = body as { productIds?: unknown; compareType?: unknown };

  if (!Array.isArray(b.productIds)) return { ok: false, code: "invalid_request_body" };
  if (b.productIds.length < 2 || b.productIds.length > 4) return { ok: false, code: "invalid_product_count" };

  const ids: number[] = [];
  for (const raw of b.productIds) {
    if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw <= 0) return { ok: false, code: "invalid_product_id" };
    ids.push(raw);
  }
  if (new Set(ids).size !== ids.length) return { ok: false, code: "duplicate_product_ids" };

  if (typeof b.compareType !== "string" || !VALID_COMPARE_TYPES.has(b.compareType)) {
    return { ok: false, code: "invalid_compare_type" };
  }

  return { ok: true, productIds: [...ids].sort((a, b2) => a - b2), compareType: b.compareType as ProductRadarCompareType };
}

router.post("/groups", (req, res) => {
  const validation = validateGroupCreateBody(req.body);
  if (!validation.ok) {
    return res.status(400).json({ ok: false, error: { code: validation.code, codes: [validation.code] } });
  }

  // 클라이언트가 보낸 productIds를 그대로 신뢰하지 않는다 - 서버가 다시 조회해 실존/active를
  // 확인한다(설계서 17절 신뢰 경계 원칙, browserUpdate.ts의 existingProductId 재검증과 동일).
  const products: ProductRadarProduct[] = [];
  for (const productId of validation.productIds) {
    const product = getProductRadarProduct(productId);
    if (!product) {
      return res.status(404).json({ ok: false, error: { code: "product_not_found", codes: ["product_not_found"] } });
    }
    if (product.status !== "active") {
      return res.status(400).json({ ok: false, error: { code: "product_not_active", codes: ["product_not_active"] } });
    }
    products.push(product);
  }

  const infoAsOf = products.reduce((min, p) => (p.lastCheckedAt < min ? p.lastCheckedAt : min), products[0].lastCheckedAt);
  const { groupId, productIds } = insertProductRadarCompareGroup({
    compareType: validation.compareType,
    productIds: validation.productIds,
    infoAsOf,
  });
  const group = getProductRadarCompareGroup(groupId);
  res.status(201).json({ ok: true, group: { ...group, productIds } });
});

// ---- Phase 9.7: Compare Group 실행 ----
// body는 비어 있어야 한다 - category/identity/variation/relation/compatibility/evidence/
// snapshotId/revision/createdAt/infoAsOf 중 어느 것도 client에서 받지 않는다(설계서
// 17절). runProductRadarComparisonGroup()은 compareGroupId 하나만 받으므로 구조적으로
// body 내용을 읽어 쓸 방법이 없다 - 아래 검사는 그 경계를 명시적으로도 강제한다.
router.post("/groups/:compareGroupId/run", (req, res) => {
  const groupId = parsePositiveIntParam(req.params.compareGroupId);
  if (groupId === null) {
    return res.status(400).json({ ok: false, error: { code: "invalid_id_param", codes: ["invalid_id_param"] } });
  }
  if (req.body && typeof req.body === "object" && Object.keys(req.body).length > 0) {
    return res.status(400).json({ ok: false, error: { code: "invalid_request_body", codes: ["invalid_request_body"] } });
  }

  const result = runProductRadarComparisonGroup(groupId);
  if (!result.ok || !result.snapshot) {
    return sendPersistenceError(res, result.errors, "comparison_snapshot_insert_failed");
  }
  res.status(201).json({ ok: true, snapshot: result.snapshot });
});

// ---- Snapshot 단건 조회 ----
router.get("/snapshots/:snapshotId", (req, res) => {
  const id = parsePositiveIntParam(req.params.snapshotId);
  if (id === null) {
    return res.status(400).json({ ok: false, error: { code: "invalid_id_param", codes: ["invalid_id_param"] } });
  }

  const result = getProductRadarComparisonSnapshotById(id);
  if (!result.ok || !result.snapshot) {
    return sendPersistenceError(res, result.errors, "comparison_snapshot_not_found");
  }
  res.status(200).json({ ok: true, snapshot: result.snapshot });
});

// ---- Group별 revision 목록 ----
// 손상된 revision이 하나라도 있으면 정상 목록만 골라 200으로 반환하지 않는다(요청서 11절 -
// Phase 9.5의 "corrupt snapshot을 조용히 숨기지 않는다" 정책을 HTTP에서도 그대로 유지).
router.get("/groups/:compareGroupId/snapshots", (req, res) => {
  const groupId = parsePositiveIntParam(req.params.compareGroupId);
  if (groupId === null) {
    return res.status(400).json({ ok: false, error: { code: "invalid_id_param", codes: ["invalid_id_param"] } });
  }

  const result = listProductRadarComparisonSnapshotsByCompareGroupId(groupId);
  if (!result.ok || !result.snapshots) {
    return sendPersistenceError(res, result.errors, "comparison_snapshot_corrupt");
  }
  res.status(200).json({ ok: true, snapshots: result.snapshots });
});

// ---- Group 최신 revision ----
// 최고 revision이 손상됐으면 더 낮은 정상 revision으로 대신하지 않는다(요청서 11절, 동일 정책).
router.get("/groups/:compareGroupId/snapshots/latest", (req, res) => {
  const groupId = parsePositiveIntParam(req.params.compareGroupId);
  if (groupId === null) {
    return res.status(400).json({ ok: false, error: { code: "invalid_id_param", codes: ["invalid_id_param"] } });
  }

  const result = getLatestProductRadarComparisonSnapshot(groupId);
  if (!result.ok || !result.snapshot) {
    return sendPersistenceError(res, result.errors, "comparison_snapshot_not_found");
  }
  res.status(200).json({ ok: true, snapshot: result.snapshot });
});

// ---- Phase 10.2: Recommendation Snapshot 읽기 전용 API / Phase 12.4.3: 생성 POST 추가 ----
// GET 세 라우트는 recommendationPersistence.ts가 반환한 canonical/fail-closed 결과를
// 그대로 HTTP 경계에 전달할 뿐이다 - raw SQL, JSON 직접 hydrate, buildRecommendationResult()
// 재호출, corruption fallback 전부 이 파일에 없다(요청서 4절). insertProductRadarRecommendationSnapshot()도
// 이 파일 어디에서도 직접 호출하지 않는다(Phase 10.2 원안 그대로 유지).
//
// Phase 12.4.3: 딱 하나의 POST 라우트만 추가한다(아래) - Phase 10.2의 "client가
// recommendation 내용을 직접 write하지 못하게 한다"는 안전 원칙은 뒤집히지 않는다. 이
// POST의 body는 language 단 하나만 받고(요청서 5·6절), products/evidence/prompt/provenance
// 같은 recommendation 내용은 client가 보낼 방법이 구조적으로 없다 - 실제 내용은 항상
// generateAndPersistRecommendation()이 frozen ComparisonSnapshot + Claude +
// Phase 12.2 validation으로 100% 만들어낸다. route는 orchestration을 호출할 뿐 SQL
// INSERT/revision 계산/prompt 생성/Claude output 파싱을 이 파일에서 복제하지 않는다
// (요청서 30절).

// ---- Recommendation 단건 조회 ----
router.get("/recommendations/:recommendationId", (req, res) => {
  const id = parsePositiveIntParam(req.params.recommendationId);
  if (id === null) {
    return res.status(400).json({ ok: false, error: { code: "invalid_id_param", codes: ["invalid_id_param"] } });
  }

  const result = getProductRadarRecommendationSnapshotById(id);
  if (!result.ok || !result.record) {
    return sendPersistenceError(res, result.errors, "recommendation_snapshot_not_found");
  }
  res.status(200).json({ ok: true, recommendation: result.record });
});

// ---- Snapshot별 Recommendation revision 목록 ----
// "부모 ComparisonSnapshot이 아예 없음"과 "부모는 있지만 Recommendation이 아직 0개"를
// 구분한다(요청서 6절/16절) - 먼저 부모 존재를 확인한 뒤에만 recommendation 목록을
// 조회한다. 손상된 revision이 하나라도 있으면 정상 목록만 골라 200으로 반환하지 않는다
// (comparisonPersistence.ts group/snapshots 라우트와 동일한 fail-closed 정책).
router.get("/snapshots/:snapshotId/recommendations", (req, res) => {
  const snapshotId = parsePositiveIntParam(req.params.snapshotId);
  if (snapshotId === null) {
    return res.status(400).json({ ok: false, error: { code: "invalid_id_param", codes: ["invalid_id_param"] } });
  }

  const parent = getProductRadarComparisonSnapshotById(snapshotId);
  if (!parent.ok || !parent.snapshot) {
    return sendPersistenceError(res, parent.errors, "comparison_snapshot_not_found");
  }

  const result = listProductRadarRecommendationSnapshotsByComparisonSnapshotId(snapshotId);
  if (!result.ok || !result.records) {
    return sendPersistenceError(res, result.errors, "recommendation_snapshot_corrupt");
  }
  res.status(200).json({ ok: true, recommendations: result.records });
});

// ---- Snapshot에 새 Recommendation 생성(Claude) ----
// body는 정확히 { language: "ko" | "en" } 하나만 허용한다(요청서 5절) - 그 외 own key가
// 하나라도 있으면(products/prompt/provenance 등, 요청서 6절) 값을 보기도 전에 400으로
// 거부한다. snapshotId path validation -> body plain-object validation -> exact key
// validation -> language validation까지 전부 통과한 뒤에만
// generateAndPersistRecommendation()을 호출한다(요청서 7절 순서) - 여기서 거부되면
// orchestration/Claude 호출 자체가 없다. 성공 시 메모리 Claude 결과가 아니라 persist된
// RecommendationSnapshotRecord를 그대로 201로 반환한다(요청서 9절). automatic retry 없음 -
// 이 라우트는 orchestration을 정확히 1회만 호출한다(요청서 10절).
const RECOMMENDATION_POST_ALLOWED_BODY_KEYS: ReadonlySet<string> = new Set(["language"]);

router.post("/snapshots/:snapshotId/recommendations", async (req, res) => {
  const snapshotId = parsePositiveIntParam(req.params.snapshotId);
  if (snapshotId === null) {
    return res.status(400).json({ ok: false, error: { code: "invalid_id_param", codes: ["invalid_id_param"] } });
  }

  const body: unknown = req.body;
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return res.status(400).json({ ok: false, error: { code: "invalid_request_body", codes: ["invalid_request_body"] } });
  }
  const bodyRecord = body as Record<string, unknown>;
  if (!Object.keys(bodyRecord).every((key) => RECOMMENDATION_POST_ALLOWED_BODY_KEYS.has(key))) {
    return res.status(400).json({ ok: false, error: { code: "invalid_request_body", codes: ["invalid_request_body"] } });
  }
  const language = bodyRecord.language;
  if (language !== "ko" && language !== "en") {
    return res.status(400).json({ ok: false, error: { code: "recommendation_language_unsupported", codes: ["recommendation_language_unsupported"] } });
  }

  const result = await generateAndPersistRecommendation(snapshotId, language);
  if (!result.ok || !result.record) {
    // 추천 실패는 지금까지 어디에도 기록되지 않아, 실제 구매자 환경에서 실패했을 때 개발자도
    // 원인을 특정할 수 없었다(Fresh Install QA에서 실측). 원인 추적에 꼭 필요한 최소값만 한 줄로
    // 남긴다 - 상품 payload / Claude 원문 / 토큰 / 개인정보는 남기지 않는다.
    console.warn(
      `[product-radar] 추천 생성 실패: snapshotId=${snapshotId} language=${language} codes=${(result.errors || []).join(",") || "(없음)"}`
    );
    return sendPersistenceError(res, result.errors, "recommendation_snapshot_insert_failed");
  }
  res.status(201).json({ ok: true, recommendation: result.record });
});

// ---- Snapshot별 Recommendation 최신 revision(전체 latest 또는 language별 latest) ----
// 부모가 없으면 404 comparison_snapshot_not_found, 부모는 있지만 recommendation이 한
// 건도 없으면(또는 요청한 language의 recommendation이 하나도 없으면) 404
// recommendation_snapshot_not_found - 서로 다른 상태이므로 같은 코드로 뭉개지 않는다.
// 최고 revision이 손상됐으면 더 낮은 정상 revision으로 대신하지 않는다(persistence
// 계층의 fail-closed 결과를 그대로 사용).
//
// ?language 쿼리가 없으면(요청서 15절) 기존 global latest 함수를 한 글자도 다르지 않게
// 그대로 호출한다 - "억지 리팩터 금지" 원칙(요청서 28절)을 그대로 지킨다. ?language=ko|en이
// 있을 때만 Phase 12.4.3에서 추가한 language별 helper로 분기한다 - route가 먼저 global
// latest를 가져와서 language로 걸러내는 방식은 쓰지 않는다(그러면 최신 revision이 다른
// language일 때 그보다 오래된 해당 language 결과를 못 찾는다, 요청서 16절).
const RECOMMENDATION_LATEST_ALLOWED_QUERY_KEYS: ReadonlySet<string> = new Set(["language"]);

type RecommendationLatestQueryValidation = { ok: true; language: RecommendationOutputLanguage | null } | { ok: false; code: string };

function validateRecommendationLatestQuery(query: Record<string, unknown>): RecommendationLatestQueryValidation {
  for (const key of Object.keys(query)) {
    if (!RECOMMENDATION_LATEST_ALLOWED_QUERY_KEYS.has(key)) return { ok: false, code: "invalid_request_query" };
  }
  if (!Object.prototype.hasOwnProperty.call(query, "language")) {
    return { ok: true, language: null };
  }
  // req.query.language는 string(정상) | string[](중복 쿼리 ?language=ko&language=en) |
  // 기타(malformed) 중 하나일 수 있다 - 배열/객체/빈 문자열/미지원 언어 전부 이 두 등호
  // 비교에서 자연스럽게 걸러진다(요청서 17절 - duplicated/array 형태 거부).
  const raw = query.language;
  if (raw !== "ko" && raw !== "en") return { ok: false, code: "recommendation_language_unsupported" };
  return { ok: true, language: raw };
}

router.get("/snapshots/:snapshotId/recommendations/latest", (req, res) => {
  const snapshotId = parsePositiveIntParam(req.params.snapshotId);
  if (snapshotId === null) {
    return res.status(400).json({ ok: false, error: { code: "invalid_id_param", codes: ["invalid_id_param"] } });
  }
  const queryValidation = validateRecommendationLatestQuery(req.query as Record<string, unknown>);
  if (!queryValidation.ok) {
    return res.status(400).json({ ok: false, error: { code: queryValidation.code, codes: [queryValidation.code] } });
  }

  const parent = getProductRadarComparisonSnapshotById(snapshotId);
  if (!parent.ok || !parent.snapshot) {
    return sendPersistenceError(res, parent.errors, "comparison_snapshot_not_found");
  }

  const result =
    queryValidation.language === null
      ? getLatestProductRadarRecommendationSnapshotByComparisonSnapshotId(snapshotId)
      : getLatestProductRadarRecommendationSnapshotByComparisonSnapshotIdAndLanguage(snapshotId, queryValidation.language);
  if (!result.ok || !result.record) {
    return sendPersistenceError(res, result.errors, "recommendation_snapshot_not_found");
  }
  res.status(200).json({ ok: true, recommendation: result.record });
});

// ---- Phase 12.5.2.3.3.3: Recommendation Snapshot 1건 -> Threads Copy Draft 1건 생성 ----
// body는 완전히 비어 있어야 한다(POST /groups/:compareGroupId/run과 동일 정책, 요청서 6절) -
// language/comparisonSnapshotId/hook/body/title/sourceType/usageStatus/affiliateUrl/
// disclosure/productName/generationBatchId 중 어느 것도 client가 보낼 방법이 없다.
// recommendationSnapshotId는 오직 path param에서만 온다. route는
// generateAndPersistProductRadarThreadsCopyDraft(recommendationId) 정확히 하나의 business
// import만 호출한다 - recommendation/comparison persistence 조회, Threads Copy 생성기,
// draft insert를 이 파일이 직접 호출하지 않는다(요청서 9절) - latest recommendation/
// comparison 조회나 language default도 없다(요청서 10절, caller가 지정한 exact
// recommendationSnapshotId가 가리키는 exact parent만 orchestration 내부에서 쓴다).
router.post("/recommendations/:recommendationId/threads-draft", async (req, res) => {
  const recommendationId = parsePositiveIntParam(req.params.recommendationId);
  if (recommendationId === null) {
    return res.status(400).json({ ok: false, error: { code: "invalid_id_param", codes: ["invalid_id_param"] } });
  }
  if (req.body && typeof req.body === "object" && Object.keys(req.body).length > 0) {
    return res.status(400).json({ ok: false, error: { code: "invalid_request_body", codes: ["invalid_request_body"] } });
  }

  const result = await generateAndPersistProductRadarThreadsCopyDraft(recommendationId);
  if (!result.ok) {
    return sendPersistenceError(res, [...result.errors], "threads_copy_draft_persistence_failed");
  }
  res.status(201).json({
    ok: true,
    draft: { id: result.draftId },
    recommendationSnapshotId: result.recommendationSnapshotId,
    comparisonSnapshotId: result.comparisonSnapshotId,
    threadsCopy: result.threadsCopy,
  });
});

// PUT/PATCH/DELETE는 의도적으로 만들지 않는다(요청서 6절) - Comparison Snapshot은
// INSERT-only이므로 HTTP에서도 update/delete/upsert 경로를 제공하지 않는다. 등록되지
// 않은 메서드는 Express 기본 404로 자연히 떨어진다(이 파일에 별도 catch-all을 추가하지
// 않음 - 프로젝트 전역에 그런 핸들러가 없는 기존 관례를 그대로 따름). Recommendation도
// 동일 원칙 - PATCH/DELETE recommendation 경로는 여전히 만들지 않는다(POST는 위에서
// language만 받는 생성 전용 라우트로 Phase 12.4.3에 추가됨 - update/upsert가 아니다).

export default router;
