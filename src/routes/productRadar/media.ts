// src/routes/productRadar/media.ts
// 상품 레이더 Phase 12.5.3.3: 기존 Threads draft에 특정 상품의 single-card PNG를 생성하고
// media job을 exact draft에 연결하는 API + 그 PNG를 안전하게 서빙하는 GET route.
// products.ts/comparisons.ts와 동일하게 메인 UI 전용(이 파일에 별도 인증 로직 없음).
//
// body는 정확히 { productId } 하나만 허용한다(요청서 11·15절) -
// recommendationSnapshotId/comparisonSnapshotId/representativeImageUrl/displayLabel/price/
// strength/language/templateId/templateVersion/filename/mediaJobId/sourceUrl/affiliateUrl/
// disclosure 중 어느 것도 client가 보낼 방법이 없다 - 전부 persisted lineage(draft ->
// recommendation -> comparison)에서 파생한다. 실제 흐름/자격 검증/attach 로직은 전부
// mediaDraftAttachment.ts에 있다 - 이 파일은 그것을 호출할 뿐이다(요청서 9절, database.ts에
// logic을 몰아넣지 않는 것과 동일한 원칙으로 route에도 몰아넣지 않는다).
//
// GET /media/:filename은 affiliate.ts의 GET /media/:filename과 동일한 안전 패턴
// (isSafeMediaFilename/resolveMediaPath, 둘 다 mediaUpload.ts 재사용)을 쓰되 별도
// Product Radar 전용 경로에 둔다 - affiliate 전용 네이밍을 그대로 재사용하지 않는다
// (요청서 13절, semantic 충돌 방지). affiliate.ts route는 이 파일에서 전혀 건드리지 않는다
// (regression 없음).

import { Router } from "express";
import { isSafeMediaFilename, resolveMediaPath } from "../../mediaUpload";
import {
  attachProductRadarMediaJobToDraft,
  generateAndAttachProductRadarSingleCardToDraft,
  generateProductRadarCarouselBatchForDraft,
  generateProductRadarSingleCardCandidateForDraft,
  getProductRadarCurrentMediaAttachmentForDraft,
} from "../../productRadar/mediaDraftAttachment";
import { ProductRadarSingleCardComposition } from "../../productRadar/mediaCardRenderer";
import { ProductRadarCarouselCandidateSet } from "../../productRadar/mediaCarouselOrchestration";
import { generateProductRadarMotionBatchForDraft } from "../../productRadar/mediaDraftAttachment";
import { ProductRadarMotionOutputType } from "../../productRadar/motionOrchestration";
import { parsePositiveIntParam } from "./comparisons";

const router = Router();

// stable error code -> HTTP status. comparisons.ts와 동일한 분류 원칙을 그대로 따른다
// (요청서 14절) - recommendation/comparison 관련 코드는 comparisons.ts가 이미 확정한
// not_found=404/corrupt=500 분류를 그대로 재사용한다(새 분류 발명 없음).
const STATUS_404_CODES = new Set([
  "recommendation_snapshot_not_found",
  "comparison_snapshot_not_found",
  "product_radar_media_draft_not_found",
  "product_radar_media_product_not_in_comparison",
  "product_radar_media_product_not_in_recommendation",
  // Phase 12.5.3.5: candidate attach 전용 - 존재하지 않는 mediaJobId, 또는 다른
  // draft/recommendation lineage의 mediaJobId(둘 다 client 관점에서는 "찾을 수 없음"과
  // 동일하게 취급 - 다른 draft에 그런 job이 있는지조차 노출하지 않는다).
  "product_radar_media_job_not_found",
  "product_radar_media_job_lineage_mismatch",
]);
const STATUS_409_CODES = new Set([
  "product_radar_media_attachment_stale",
  "product_radar_media_busy", // Phase 12.5.3.9: 동일 draft+source+outputType batch가 이미 진행 중(in-process lock)
]);
// 내부 데이터 불일치/렌더·저장 실패 - client 잘못도, upstream(원격 이미지 서버) 잘못도
// 아니다(comparisons.ts의 threads_copy_display_label_missing=500과 동일한 분류 원칙).
const STATUS_500_CODES = new Set([
  "recommendation_snapshot_corrupt",
  "comparison_snapshot_corrupt",
  "template_data_missing",
  "product_data_missing",
  "image_missing",
  "card_render_failed",
  "carousel_render_failed", // Phase 12.5.3.7: dedupe 다운로드/검증을 이미 통과한 뒤 로컬 렌더링만 실패한 내부 불일치
  "local_save_failed",
  "product_radar_media_attachment_failed",
  "product_radar_media_job_file_missing", // Phase 12.5.3.5: rendered인데 card 파일이 없는 내부 불일치
  "video_render_failed", // Phase 12.5.3.9: FFmpeg 인코딩 실패
  "animation_render_failed", // Phase 12.5.3.9: GIF 인코딩 실패
  "ffmpeg_unavailable", // Phase 12.5.3.9: h264_mf encoder preflight 실패(환경 문제, client 잘못 아님)
  "source_media_missing", // Phase 12.5.3.9: rendered source job인데 원본 PNG가 디스크에 없는 내부 불일치
]);
// 원격 이미지 다운로드/검증 실패 - "upstream이 생성/제공한 결과가 우리 검증을 통과 못했다"는
// 502 의미(comparisons.ts의 claude_recommendation_output_invalid=502와 동일한 분류 원칙).
const STATUS_502_CODES = new Set(["image_download_failed", "image_invalid"]);

function statusForErrorCode(code: string): number {
  if (STATUS_404_CODES.has(code)) return 404;
  if (STATUS_409_CODES.has(code)) return 409;
  if (STATUS_500_CODES.has(code)) return 500;
  if (STATUS_502_CODES.has(code)) return 502;
  return 400; // product_radar_media_draft_invalid 등 나머지 전부
}

function sendMediaError(res: import("express").Response, errors: readonly string[]): void {
  const codes = errors.length > 0 ? errors : ["product_radar_media_attachment_failed"];
  res.status(statusForErrorCode(codes[0])).json({ ok: false, error: { code: codes[0], codes } });
}

// ---- Phase 12.5.3.3: draft -> single-card 생성 + attach ----
// body는 정확히 { productId: number } 하나만 허용한다 - unknown key는 값을 보기도 전에
// 400으로 거부한다(요청서 11절).
const SINGLE_CARD_ALLOWED_BODY_KEYS: ReadonlySet<string> = new Set(["productId"]);

router.post("/drafts/:draftId/media/single-card", async (req, res) => {
  const draftId = parsePositiveIntParam(req.params.draftId);
  if (draftId === null) {
    return res.status(400).json({ ok: false, error: { code: "invalid_id_param", codes: ["invalid_id_param"] } });
  }

  const body: unknown = req.body;
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return res.status(400).json({ ok: false, error: { code: "invalid_request_body", codes: ["invalid_request_body"] } });
  }
  const bodyRecord = body as Record<string, unknown>;
  if (!Object.keys(bodyRecord).every((key) => SINGLE_CARD_ALLOWED_BODY_KEYS.has(key))) {
    return res.status(400).json({ ok: false, error: { code: "invalid_request_body", codes: ["invalid_request_body"] } });
  }
  const rawProductId = bodyRecord.productId;
  if (typeof rawProductId !== "number" || !Number.isSafeInteger(rawProductId) || rawProductId <= 0) {
    return res.status(400).json({ ok: false, error: { code: "invalid_product_id", codes: ["invalid_product_id"] } });
  }

  const result = await generateAndAttachProductRadarSingleCardToDraft(draftId, rawProductId);
  if (!result.ok) {
    return sendMediaError(res, result.errors);
  }
  res.status(201).json({
    ok: true,
    draftId: result.draftId,
    recommendationSnapshotId: result.recommendationSnapshotId,
    comparisonSnapshotId: result.comparisonSnapshotId,
    productId: result.productId,
    mediaJobId: result.mediaJobId,
    file: result.file,
  });
});

// ==================================================================================
// Phase 12.5.3.5: candidate 생성 - draft attachment는 절대 바꾸지 않는다(요청서 2·8절).
// body는 정확히 { productId, composition } 둘만 허용한다 - 내부 template_id/version을
// client가 직접 넘길 방법이 없다(요청서 6·7절, composition은 공개 enum, template_id는
// generateProductRadarSingleCardCandidateForDraft() 내부에서만 매핑된다).
// ==================================================================================
const ALLOWED_COMPOSITIONS: ReadonlySet<string> = new Set(["product_focus", "price_focus", "recommendation_focus"]);
const CANDIDATE_ALLOWED_BODY_KEYS: ReadonlySet<string> = new Set(["productId", "composition"]);

function isProductRadarSingleCardComposition(value: unknown): value is ProductRadarSingleCardComposition {
  return typeof value === "string" && ALLOWED_COMPOSITIONS.has(value);
}

router.post("/drafts/:draftId/media/single-card/candidate", async (req, res) => {
  const draftId = parsePositiveIntParam(req.params.draftId);
  if (draftId === null) {
    return res.status(400).json({ ok: false, error: { code: "invalid_id_param", codes: ["invalid_id_param"] } });
  }

  const body: unknown = req.body;
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return res.status(400).json({ ok: false, error: { code: "invalid_request_body", codes: ["invalid_request_body"] } });
  }
  const bodyRecord = body as Record<string, unknown>;
  if (!Object.keys(bodyRecord).every((key) => CANDIDATE_ALLOWED_BODY_KEYS.has(key))) {
    return res.status(400).json({ ok: false, error: { code: "invalid_request_body", codes: ["invalid_request_body"] } });
  }
  const rawProductId = bodyRecord.productId;
  if (typeof rawProductId !== "number" || !Number.isSafeInteger(rawProductId) || rawProductId <= 0) {
    return res.status(400).json({ ok: false, error: { code: "invalid_product_id", codes: ["invalid_product_id"] } });
  }
  if (!isProductRadarSingleCardComposition(bodyRecord.composition)) {
    return res.status(400).json({ ok: false, error: { code: "invalid_composition", codes: ["invalid_composition"] } });
  }
  const composition = bodyRecord.composition;

  const result = await generateProductRadarSingleCardCandidateForDraft(draftId, rawProductId, composition);
  if (!result.ok) {
    return sendMediaError(res, result.errors);
  }
  res.status(201).json({
    ok: true,
    draftId,
    recommendationSnapshotId: result.recommendationSnapshotId,
    comparisonSnapshotId: result.comparisonSnapshotId,
    productId: result.productId,
    composition,
    mediaJobId: result.mediaJobId,
    file: result.file,
  });
});

// ==================================================================================
// Phase 12.5.3.7: 캐러셀 batch candidate 생성 - draft attachment는 절대 바꾸지 않는다
// (요청서 17절, single-card candidate와 동일 계약). body는 정확히 { candidateSet }
// 하나만 허용하고 값은 "primary"|"secondary"뿐이다(요청서 7절 public contract -
// composition/variant/templateId는 client가 볼 방법이 없다). 성공 시 candidates 배열
// (정확히 6개, 각 2~3 files)을 201로 반환한다(요청서 18절).
// ==================================================================================
const ALLOWED_CANDIDATE_SETS: ReadonlySet<string> = new Set(["primary", "secondary"]);
const CAROUSEL_CANDIDATES_ALLOWED_BODY_KEYS: ReadonlySet<string> = new Set(["candidateSet"]);

function isProductRadarCarouselCandidateSet(value: unknown): value is ProductRadarCarouselCandidateSet {
  return typeof value === "string" && ALLOWED_CANDIDATE_SETS.has(value);
}

router.post("/drafts/:draftId/media/carousel/candidates", async (req, res) => {
  const draftId = parsePositiveIntParam(req.params.draftId);
  if (draftId === null) {
    return res.status(400).json({ ok: false, error: { code: "invalid_id_param", codes: ["invalid_id_param"] } });
  }

  const body: unknown = req.body;
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return res.status(400).json({ ok: false, error: { code: "invalid_request_body", codes: ["invalid_request_body"] } });
  }
  const bodyRecord = body as Record<string, unknown>;
  if (!Object.keys(bodyRecord).every((key) => CAROUSEL_CANDIDATES_ALLOWED_BODY_KEYS.has(key))) {
    return res.status(400).json({ ok: false, error: { code: "invalid_request_body", codes: ["invalid_request_body"] } });
  }
  if (!isProductRadarCarouselCandidateSet(bodyRecord.candidateSet)) {
    return res.status(400).json({ ok: false, error: { code: "invalid_candidate_set", codes: ["invalid_candidate_set"] } });
  }
  const candidateSet = bodyRecord.candidateSet;

  const result = await generateProductRadarCarouselBatchForDraft(draftId, candidateSet);
  if (!result.ok) {
    return sendMediaError(res, result.errors);
  }
  res.status(201).json({
    ok: true,
    draftId,
    recommendationSnapshotId: result.recommendationSnapshotId,
    comparisonSnapshotId: result.comparisonSnapshotId,
    candidateSet: result.candidateSet,
    candidates: result.candidates,
  });
});

// ==================================================================================
// Phase 12.5.3.5: candidate 확정("이 이미지 사용") - body는 정확히 { mediaJobId } 하나만
// 허용한다. lineage/status/type 검증은 전부 attachProductRadarMediaJobToDraft()가 한다
// (요청서 9절) - 이 route는 그 결과를 status로 옮기기만 한다.
// ==================================================================================
const ATTACH_ALLOWED_BODY_KEYS: ReadonlySet<string> = new Set(["mediaJobId"]);

router.post("/drafts/:draftId/media/attach", (req, res) => {
  const draftId = parsePositiveIntParam(req.params.draftId);
  if (draftId === null) {
    return res.status(400).json({ ok: false, error: { code: "invalid_id_param", codes: ["invalid_id_param"] } });
  }

  const body: unknown = req.body;
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return res.status(400).json({ ok: false, error: { code: "invalid_request_body", codes: ["invalid_request_body"] } });
  }
  const bodyRecord = body as Record<string, unknown>;
  if (!Object.keys(bodyRecord).every((key) => ATTACH_ALLOWED_BODY_KEYS.has(key))) {
    return res.status(400).json({ ok: false, error: { code: "invalid_request_body", codes: ["invalid_request_body"] } });
  }
  const rawMediaJobId = bodyRecord.mediaJobId;
  if (typeof rawMediaJobId !== "number" || !Number.isSafeInteger(rawMediaJobId) || rawMediaJobId <= 0) {
    return res.status(400).json({ ok: false, error: { code: "invalid_media_job_id", codes: ["invalid_media_job_id"] } });
  }

  const result = attachProductRadarMediaJobToDraft(draftId, rawMediaJobId);
  if (!result.ok) {
    return sendMediaError(res, result.errors);
  }
  res.status(200).json({
    ok: true,
    draftId: result.draftId,
    recommendationSnapshotId: result.recommendationSnapshotId,
    comparisonSnapshotId: result.comparisonSnapshotId,
    productId: result.productId,
    mediaJobId: result.mediaJobId,
    mediaType: result.mediaType,
    file: result.file,
    files: result.files,
  });
});

// ==================================================================================
// Phase 12.5.3.5(요청서 19절): 현재 draft에 attach된 media를 조회 - reload 후에도 현재
// attachment preview를 복원할 수 있게 한다. 없으면 404가 아니라 200 + attached:false(정상
// 상태 - "아직 아무 이미지도 안 붙임"은 오류가 아니다).
// ==================================================================================
router.get("/drafts/:draftId/media/current", (req, res) => {
  const draftId = parsePositiveIntParam(req.params.draftId);
  if (draftId === null) {
    return res.status(400).json({ ok: false, error: { code: "invalid_id_param", codes: ["invalid_id_param"] } });
  }
  const result = getProductRadarCurrentMediaAttachmentForDraft(draftId);
  if (!result.ok) {
    return sendMediaError(res, result.errors);
  }
  if (!result.attached) {
    return res.status(200).json({ ok: true, attached: false });
  }
  res.status(200).json({
    ok: true,
    attached: true,
    draftId: result.draftId,
    mediaJobId: result.mediaJobId,
    productId: result.productId,
    mediaType: result.mediaType,
    file: result.file,
    files: result.files,
  });
});

// ==================================================================================
// Phase 12.5.3.9: 짧은 영상/GIF candidate 생성. body는 정확히 { sourceMediaJobId, outputType }
// 둘만 허용한다 - duration/fps/codec/width/height/transition/templateId/
// recommendationSnapshotId/comparisonSnapshotId/source filename/filesystem path 중 어느 것도
// client가 보낼 방법이 없다(요청서 15절) - server가 전부 결정한다.
// ==================================================================================
const ALLOWED_MOTION_OUTPUT_TYPES: ReadonlySet<string> = new Set(["video", "animation"]);
const MOTION_CANDIDATES_ALLOWED_BODY_KEYS: ReadonlySet<string> = new Set(["sourceMediaJobId", "outputType"]);

function isProductRadarMotionOutputType(value: unknown): value is ProductRadarMotionOutputType {
  return typeof value === "string" && ALLOWED_MOTION_OUTPUT_TYPES.has(value);
}

router.post("/drafts/:draftId/media/motion/candidates", async (req, res) => {
  const draftId = parsePositiveIntParam(req.params.draftId);
  if (draftId === null) {
    return res.status(400).json({ ok: false, error: { code: "invalid_id_param", codes: ["invalid_id_param"] } });
  }

  const body: unknown = req.body;
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return res.status(400).json({ ok: false, error: { code: "invalid_request_body", codes: ["invalid_request_body"] } });
  }
  const bodyRecord = body as Record<string, unknown>;
  if (!Object.keys(bodyRecord).every((key) => MOTION_CANDIDATES_ALLOWED_BODY_KEYS.has(key))) {
    return res.status(400).json({ ok: false, error: { code: "invalid_request_body", codes: ["invalid_request_body"] } });
  }
  const rawSourceMediaJobId = bodyRecord.sourceMediaJobId;
  if (typeof rawSourceMediaJobId !== "number" || !Number.isSafeInteger(rawSourceMediaJobId) || rawSourceMediaJobId <= 0) {
    return res.status(400).json({ ok: false, error: { code: "invalid_source_media_job_id", codes: ["invalid_source_media_job_id"] } });
  }
  if (!isProductRadarMotionOutputType(bodyRecord.outputType)) {
    return res.status(400).json({ ok: false, error: { code: "invalid_output_type", codes: ["invalid_output_type"] } });
  }
  const outputType = bodyRecord.outputType;

  const result = await generateProductRadarMotionBatchForDraft(draftId, rawSourceMediaJobId, outputType);
  if (!result.ok) {
    return sendMediaError(res, result.errors);
  }
  res.status(201).json({
    ok: true,
    draftId,
    recommendationSnapshotId: result.recommendationSnapshotId,
    comparisonSnapshotId: result.comparisonSnapshotId,
    sourceMediaJobId: result.sourceMediaJobId,
    outputType: result.outputType,
    candidates: result.candidates,
  });
});

// ---- Product Radar 전용 안전 미디어 서빙 ----
// affiliate.ts의 GET /media/:filename과 완전히 동일한 안전 검증(isSafeMediaFilename +
// resolveMediaPath)을 재사용한다 - filename은 UUID+허용 확장자 패턴만 통과하고, 업로드
// 폴더를 벗어나는 경로는 resolveMediaPath()가 이미 구조적으로 차단한다(path traversal
// 불가능). DB에 실제로 attach된 파일인지는 확인하지 않는다 - affiliate.ts와 동일한 신뢰
// 모델("안전한 이름의 파일이면 서빙")을 그대로 따른다(요청서 13절, 새 검증 로직 발명 없음).
router.get("/media/:filename", (req, res) => {
  const filename = req.params.filename;
  if (!isSafeMediaFilename(filename)) {
    return res.status(400).json({ error: "올바르지 않은 파일 식별자입니다." });
  }
  const fullPath = resolveMediaPath(filename);
  if (!fullPath) {
    return res.status(400).json({ error: "올바르지 않은 파일 식별자입니다." });
  }
  res.sendFile(fullPath, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: "파일을 찾을 수 없습니다." });
  });
});

export default router;
