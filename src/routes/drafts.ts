// src/routes/drafts.ts
import { Router } from "express";
import fs from "fs";
import path from "path";
import { buildGenerationPrompt, generateDraftsWithClaude, FactBasis, MaterialForPrompt, CLAUDE_BUYER_FAILURE_MESSAGE } from "../claude";
import {
  cancelSchedule,
  confirmBatchScheduleAtomic,
  DraftStatus,
  getCurrentPersona,
  getDraft,
  getMaterialById,
  getScheduleRoutine,
  hasPublishLogForDraft,
  insertCandidateLog,
  insertClaudeFailure,
  insertDraft,
  insertDraftsAtomic,
  getMaterialInputPrefs,
  listAllMaterialsForSelection,
  listDrafts,
  listOccupiedScheduleSlots,
  rescheduleDraft,
  saveNewPersonaVersion,
  scheduleDraft,
  setDraftAllowPublishWithoutAffiliateLink,
  setDraftStatus,
  updateDraftBody,
  findPurgeableDrafts,
  purgeDrafts,
  updateDraftContent,
  DRAFT_EDITABLE_STATUSES,
  deleteDraftsByIds,
  insertManualDraft,
  peekNextManualSequence,
  PersonaData,
} from "../database";
import { config } from "../env";
import {
  getProductRadarLibraryAssetById,
  listProductRadarLibraryAssetFilesByAssetId,
  parseProductRadarLibraryAssetKey,
} from "../productRadar/libraryPersistence";
import { extractRelevantExcerpt } from "../excerpt";
import { parseKeywordList } from "../keywordInput";
import {
  buildMaterialContext,
  MAX_MATERIAL_EXCERPT_CHARS,
  MAX_SELECTABLE_FOR_GENERATION,
  MaterialRow,
  SelectionResult,
  selectCandidateMaterials,
} from "../materialSelector";
import { MIN_SCHEDULE_LEAD_MS, planBatchSchedule } from "../scheduleRoutine";
import { seoulLocalToUtcIso } from "../time";
import { DraftMediaPointerRow, resolveDraftMediaDetail, resolveDraftMediaSummaries } from "../productRadar/draftMediaReview";

const router = Router();

const DEFAULT_PERSONA_PATH = path.join(__dirname, "..", "..", "data", "default-persona.json");

// affiliate.ts(쿠파스 상품 홍보 모드)도 동일한 persona/실패 로그 저장 로직을 재사용합니다.
export function ensurePersona(): { version: number; data: PersonaData } {
  let current = getCurrentPersona();
  if (!current) {
    const defaults = JSON.parse(fs.readFileSync(DEFAULT_PERSONA_PATH, "utf-8"));
    current = saveNewPersonaVersion(defaults);
  }
  return { version: current.version, data: current.data };
}

function parseMaterialMeta(material: any): any {
  try {
    return material?.meta_json ? JSON.parse(material.meta_json) : null;
  } catch {
    return null;
  }
}

// 자료(material) 원문은 DB에 그대로 두고, Claude 프롬프트에는 제목/키워드/사용자 관점과 관련성이
// 높은 부분만 최대 MAX_MATERIAL_EXCERPT_CHARS자로 발췌해서 전달합니다.
// excerptOverride가 있으면(= buildMaterialContext가 이미 계산한 발췌) 다시 계산하지 않고 그대로
// 사용합니다 - 실제로 전달되는 글자 수(예산 검증에 쓰인 값)와 Claude에 보내는 값이 항상 같도록 하기 위함.
function toPromptMaterial(material: any, excerptOverride?: string): MaterialForPrompt {
  const meta = parseMaterialMeta(material);
  const keywords: string[] | undefined = meta?.keywords && meta.keywords.length > 0 ? meta.keywords : undefined;
  const note: string | undefined = meta?.note || undefined;
  const factBasis: FactBasis = meta?.factBasis || (material.source_url ? "source_backed" : material.source_type === "keyword" ? "user_topic" : "source_backed");

  const excerpt =
    excerptOverride !== undefined
      ? excerptOverride
      : extractRelevantExcerpt(material.content || "", {
          title: material.title,
          keywords,
          note,
          maxChars: MAX_MATERIAL_EXCERPT_CHARS,
        });

  return {
    title: material.title,
    source_name: material.source_name,
    source_url: material.source_url,
    content: excerpt,
    sourceType: material.source_type,
    userKeywords: keywords || null,
    note: note || null,
    factBasis,
  };
}

export function saveFailureLog(rawResponse: string | undefined, errorMessage: string) {
  const logsDir = config.LOG_DIR;
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
  const file = path.join(logsDir, `claude-failure-${Date.now()}.txt`);
  fs.writeFileSync(file, `[${new Date().toISOString()}]\n오류: ${errorMessage}\n\n원문 응답:\n${rawResponse || "(없음)"}`, "utf-8");
  insertClaudeFailure(rawResponse || "", errorMessage);
  return file;
}

// 메인 버튼 2: Threads 글 6개 만들기
// "① 오늘 자료 수집" 화면의 후보 검수에서 사용자가 직접 자료를 골랐다면 materialIds를 그대로
// 받아 자동 선별을 건너뛰고 정확히 그 자료만 사용합니다(수동 선택). materialIds가 없으면
// materialSelector.ts의 점수 기준으로 자동 선별합니다(자동 선택, 최대 20개 후보 풀 중 점수 상위
// MAX_SELECTABLE_FOR_GENERATION개). 두 경로 모두 이후에는 동일한 buildMaterialContext()를 거쳐
// "최대 8개 · 자료당 최대 2,000자 발췌 · 전체 최대 15,000자" 규칙을 똑같이 적용받습니다. 예산을
// 넘으면 일부만 잘라 전달하지 않고 여기서 생성을 중단합니다(overBudget: true로 화면에 안내).
router.post("/generate", async (req, res) => {
  const count = req.body?.count ? parseInt(String(req.body.count), 10) : 6;
  const persona = ensurePersona();
  const batchId = `batch-${Date.now()}`;

  let poolSelection: SelectionResult;
  let candidateMaterials: MaterialRow[];

  if (Array.isArray(req.body?.materialIds)) {
    const materialIds: number[] = req.body.materialIds
      .map((x: any) => parseInt(String(x), 10))
      .filter((n: number) => Number.isFinite(n));

    if (materialIds.length === 0) {
      return res.status(400).json({ success: false, error: "글 생성에 사용할 자료를 1개 이상 선택해주세요." });
    }
    if (materialIds.length > MAX_SELECTABLE_FOR_GENERATION) {
      return res.status(400).json({
        success: false,
        error: `선택한 자료가 ${materialIds.length}개입니다. 자료가 너무 많으면 글의 초점이 흐려지므로, 자료를 ${MAX_SELECTABLE_FOR_GENERATION}개 이하로 직접 줄여서 다시 선택해주세요.`,
      });
    }

    const chosen = materialIds.map((id) => getMaterialById(id)).filter(Boolean) as MaterialRow[];
    if (chosen.length === 0) {
      return res.status(400).json({ success: false, error: "선택한 자료를 찾을 수 없습니다. 자료 목록을 새로고침한 뒤 다시 시도해주세요." });
    }

    candidateMaterials = chosen;
    const scored = chosen.map((m) => ({ material: m, score: 100, reason: "사용자가 후보 검수 화면에서 직접 선택한 자료", selected: true }));
    poolSelection = {
      totalCollected: chosen.length,
      candidates: scored,
      allScored: scored,
      totalCharsUsed: 0, // buildMaterialContext가 실제 발췌 기준 글자 수를 다시 계산하므로 여기서는 사용하지 않음
      excludedTooShort: 0,
      excludedDuplicate: 0,
    };
  } else {
    // 자동 선택: 후보 검수 목록용 풀(최대 20개)에서 점수 상위 MAX_SELECTABLE_FOR_GENERATION개만
    // 실제 생성 후보로 넘긴다. 나머지 검증(예산 초과 시 중단 등)은 buildMaterialContext가 수동
    // 선택과 동일하게 처리한다.
    // 후보 검수 화면(review-list)·자료함 요약(candidates)과 같은 주제 기준을 쓰도록,
    // 저장된 사용자 키워드(input-prefs)를 동일하게 반영한다.
    const prefs = getMaterialInputPrefs();
    const allMaterials = listAllMaterialsForSelection() as MaterialRow[];
    const selection = selectCandidateMaterials(allMaterials, {
      includeKeywords: parseKeywordList(prefs.includeKeywords || ""),
      excludeKeywords: parseKeywordList(prefs.excludeKeywords || ""),
    });
    poolSelection = selection;
    candidateMaterials = selection.candidates.slice(0, MAX_SELECTABLE_FOR_GENERATION).map((c) => c.material);
  }

  insertCandidateLog(
    batchId,
    poolSelection.allScored.map((s, idx) => ({
      material_id: s.material.id,
      rank: idx + 1,
      score: s.score,
      reason: s.reason,
      selected: s.selected,
    }))
  );

  if (candidateMaterials.length === 0) {
    return res.status(400).json({
      success: false,
      error: "글 생성에 사용할 후보 자료가 없습니다. 자료함에서 자료를 더 수집하거나 등록해주세요.",
      totalCollected: poolSelection.totalCollected,
      candidateCount: 0,
    });
  }

  const context = buildMaterialContext(candidateMaterials, {
    getExcerptOptions: (material: any) => {
      const meta = parseMaterialMeta(material);
      return {
        keywords: meta?.keywords && meta.keywords.length > 0 ? meta.keywords : undefined,
        note: meta?.note || undefined,
      };
    },
  });

  if (!context.ok) {
    return res.status(400).json({
      success: false,
      error: context.error,
      overBudget: true,
      totalCollected: poolSelection.totalCollected,
      candidateCount: context.materialCount,
      estimatedChars: context.totalChars,
      maxTotalChars: context.maxTotalChars,
    });
  }

  const materials = context.items.map((item) => toPromptMaterial(item.material, item.excerpt));

  const result = await generateDraftsWithClaude(materials, persona.data, count);

  if (!result.success || !result.posts) {
    // 로그에는 구매자 문구가 아니라 실제 원인이 남아야 한다(rawResponse에 CLI JSON 전문 포함).
    saveFailureLog(result.rawResponse, JSON.stringify(result.diagnostics || {}) || "알 수 없는 오류");
    return res.status(502).json({
      success: false,
      error: CLAUDE_BUYER_FAILURE_MESSAGE,
      canRetry: true,
      totalCollected: poolSelection.totalCollected,
      candidateCount: context.materialCount,
    });
  }

  // Claude가 응답에 채운 source_url을, 후보로 넘긴 실제 자료(material)와 매칭해서
  // 초안이 "어떤 자료를 참고했는지" 명확히 추적할 수 있게 합니다.
  const urlToMaterialId = new Map<string, number>();
  for (const item of context.items) {
    if (item.material.source_url) urlToMaterialId.set(item.material.source_url, item.material.id);
  }

  // 저장은 "전부 아니면 전무"다. 예전에는 본문이 빈 글을 조용히 건너뛰고 나머지만 저장해서
  // 6개를 요청했는데 3개만 들어오는 상태가 만들어질 수 있었고, 저장 도중 오류가 나도 이미
  // 들어간 행이 남았다. 이제 먼저 전부 검사하고, 통과한 경우에만 한 트랜잭션으로 저장한다.
  const invalidCount = result.posts.filter((post) => !post || !post.body || !String(post.body).trim()).length;
  if (invalidCount > 0 || result.posts.length === 0) {
    saveFailureLog(result.rawResponse, `본문이 비어 있는 글 ${invalidCount}건이 포함되어 저장하지 않았습니다.`);
    return res.status(502).json({
      success: false,
      error: CLAUDE_BUYER_FAILURE_MESSAGE,
      canRetry: true,
      totalCollected: poolSelection.totalCollected,
      candidateCount: context.materialCount,
    });
  }

  let insertedIds: number[] = [];
  try {
    insertedIds = insertDraftsAtomic(
      result.posts.map((post) => ({
        title: post.title,
        hook: post.hook,
        body: post.body,
        topic: post.topic,
        source_title: post.source_title,
        source_url: post.source_url,
        source_summary: post.source_summary,
        confidence: post.confidence,
        risk_notes: post.risk_notes,
        persona_version: persona.version,
        source_material_id: post.source_url ? urlToMaterialId.get(post.source_url) ?? null : null,
        generation_batch_id: batchId,
      }))
    );
  } catch (e: any) {
    // 트랜잭션이 통째로 롤백된 상태다 - 초안은 0건 남는다.
    return res.status(500).json({
      success: false,
      error: `초안을 DB에 저장하는 중 오류가 발생했습니다: ${e?.message || String(e)}`,
      canRetry: true,
      totalCollected: poolSelection.totalCollected,
      candidateCount: context.materialCount,
    });
  }

  res.json({
    success: true,
    draftIds: insertedIds,
    count: insertedIds.length,
    totalCollected: poolSelection.totalCollected,
    candidateCount: context.materialCount,
    excludedTooShort: poolSelection.excludedTooShort,
    excludedDuplicate: poolSelection.excludedDuplicate,
    totalCharsUsed: context.totalChars,
    batchId,
  });
});

// ---------------------------------------------------------------------------
// "예약 루틴 저장 + 승인 글 일괄 자동배치" (일반 글/쿠파스 글 모두 대상, status='approved'만)
// ---------------------------------------------------------------------------

function parseDraftIdsFromBody(body: any): number[] {
  if (!Array.isArray(body?.draftIds)) return [];
  return body.draftIds.map((x: any) => parseInt(String(x), 10)).filter((n: number) => Number.isFinite(n));
}

// 미리보기·확정 둘 다 같은 검증을 씁니다 - 요청 시점에 다시 조회해서 "지금 이 순간" 전부
// approved 상태인지 확인합니다(화면이 오래돼서 이미 예약/거절된 글이 섞여 있을 수 있음).
function validateApprovedDraftIds(draftIds: number[]): { ok: true } | { ok: false; error: string } {
  if (draftIds.length === 0) {
    return { ok: false, error: "예약할 글을 1개 이상 선택해주세요." };
  }
  const invalid: number[] = [];
  for (const id of draftIds) {
    const d = getDraft(id);
    if (!d || d.status !== "approved") invalid.push(id);
  }
  if (invalid.length > 0) {
    return { ok: false, error: `승인(approved) 상태가 아니거나 존재하지 않는 글이 있습니다: #${invalid.join(", #")}` };
  }
  return { ok: true };
}

// 일괄 배치에도 개별 예약과 같은 기준을 적용합니다 - 링크가 빠진 제휴 홍보글이 섞여 있으면
// 어떤 글이 그런지 알려주고 확인을 받습니다(차단이 아니라 확인). 승인하면 그대로 진행합니다.
function affiliateLinkWarningsForBatch(draftIds: number[]): { ids: number[]; message: string } | null {
  const flagged = draftIds.filter((id) => affiliateLinkWarning(getDraft(id)) !== null);
  if (flagged.length === 0) return null;
  return {
    ids: flagged,
    message: `제휴링크가 본문에 없는 글이 ${flagged.length}개 있습니다(#${flagged.join(", #")}). 그래도 예약하시겠습니까?`,
  };
}

function withDraftLabels(assignments: ReturnType<typeof planBatchSchedule>) {
  return assignments.map((a) => {
    const d = getDraft(a.draftId);
    return { ...a, title: d?.title || "", topic: d?.topic || "" };
  });
}

// 미리보기: DB를 전혀 변경하지 않습니다(요청서 3번). 선택된 글이 전부 approved인지 확인한 뒤,
// 현재 예약 루틴과 현재 DB의 점유 슬롯을 기준으로 배치 계획만 계산해서 돌려줍니다.
router.post("/batch-schedule/preview", (req, res) => {
  const draftIds = parseDraftIdsFromBody(req.body);
  const check = validateApprovedDraftIds(draftIds);
  if (!check.ok) return res.status(400).json({ success: false, error: check.error });

  const routine = getScheduleRoutine();
  const occupied = listOccupiedScheduleSlots();
  try {
    const assignments = planBatchSchedule({ routine, selectedDraftIds: draftIds, occupiedTimestamps: occupied });
    res.json({ success: true, assignments: withDraftLabels(assignments), routine });
  } catch (e: any) {
    res.status(400).json({ success: false, error: e?.message || "자동배치 계획을 세우지 못했습니다." });
  }
});

// 확정: 클라이언트가 보낸 시간표(있더라도)를 신뢰하지 않고, draftIds만 받아 서버가 지금 이 순간
// 기준으로 배치 계획을 다시 계산합니다(요청서 4번 - "다시 계산하거나 검증"). 그 뒤 하나의
// 트랜잭션으로 확정하며, 하나라도 실패하면 전체가 롤백됩니다(부분 예약 금지).
router.post("/batch-schedule/confirm", (req, res) => {
  const draftIds = parseDraftIdsFromBody(req.body);
  const check = validateApprovedDraftIds(draftIds);
  if (!check.ok) return res.status(400).json({ success: false, error: check.error });

  const routine = getScheduleRoutine();
  const occupied = listOccupiedScheduleSlots();

  let assignments;
  try {
    assignments = planBatchSchedule({ routine, selectedDraftIds: draftIds, occupiedTimestamps: occupied });
  } catch (e: any) {
    return res.status(400).json({ success: false, error: e?.message || "자동배치 계획을 세우지 못했습니다." });
  }

  // 안전망: planBatchSchedule 자체가 이미 최소 여유 시간을 두고 슬롯을 고르지만, 확정 직전에
  // 한 번 더 명시적으로 확인합니다(요청서 4번 - 과거/2분 이내 시간 저장 금지).
  const now = Date.now();
  const tooSoon = assignments.find((a) => new Date(a.scheduledAtUtcIso).getTime() < now + MIN_SCHEDULE_LEAD_MS);
  if (tooSoon) {
    return res.status(400).json({ success: false, error: "일부 배치 시간이 현재 시각과 너무 가깝습니다. 다시 시도해주세요." });
  }

  const batchWarning = affiliateLinkWarningsForBatch(draftIds);
  if (batchWarning && !hasExplicitLinklessApproval(req.body)) {
    return res.status(409).json({ success: false, error: batchWarning.message, needsConfirm: true, confirmCode: "batch_missing_affiliate_link", draftIds: batchWarning.ids });
  }
  if (batchWarning) {
    for (const id of batchWarning.ids) setDraftAllowPublishWithoutAffiliateLink(id, true);
  }

  try {
    confirmBatchScheduleAtomic(assignments.map((a) => ({ draftId: a.draftId, scheduledAtUtcIso: a.scheduledAtUtcIso })));
  } catch (e: any) {
    return res.status(409).json({
      success: false,
      error: e?.message || "일괄 예약 중 문제가 발생해 전체가 취소되었습니다. 새로고침 후 다시 시도해주세요.",
    });
  }

  res.json({ success: true, scheduled: assignments.length, assignments: withDraftLabels(assignments) });
});

// Phase 12.5.3.8(요청서 4절): draft 목록에 가벼운 media summary를 함께 실어 보낸다 - draft마다
// job/asset을 개별 조회하는 N+1을 피하려고 resolveDraftMediaSummaries()가 job/asset을 각각
// IN절 1회로 배치 조회한다. 기존 필드는 전혀 건드리지 않고 prMediaSummary 하나만 추가한다
// (하위호환 - 이 필드를 모르는 기존 클라이언트/테스트는 그대로 동작한다).
// ---- POST /manual - 직접 글 작성(외부에서 쓴 글 붙여넣기) ----
// 이미 완성된 글을 그대로 초안함에 넣는 경로다. AI 가공을 전혀 거치지 않고 본문을 원문
// 그대로 저장한다(Claude 호출 없음).
//
// 미디어는 새 업로드 엔진을 만들지 않고 기존 미디어 보관함 업로드
// (POST /api/product-radar/library/assets/upload)가 돌려준 assetKey("upload:<id>")를
// 그대로 받아 drafts.product_radar_library_asset_id에 넣는다. 그 컬럼은 발행 시점에
// threadsMediaAttachment.resolveDraftPublishMedia()가 IMAGE/VIDEO/CAROUSEL로 판정하는
// 기존 3경로 중 하나이며 source_type을 보지 않으므로, 수동 초안도 기존 발행 계약을
// 그대로 통과한다(새 media schema 없음).
//
// 저장 후 상태는 다른 초안과 동일한 'draft'다 - 승인/예약/발행은 전부 기존 흐름을 쓴다.
// 본문에서 카드용 제목만 뽑아낸다 - 본문 자체는 절대 바꾸지 않는다.
// 첫 줄이 비어 있으면 다음 유효 줄을 쓰고, 유효 줄이 하나도 없으면 빈 문자열을 돌려준다
// (그 경우 기존 초안과 동일하게 "(제목 없음)"으로 표시될 뿐 저장은 실패하지 않는다).
const MANUAL_DRAFT_TITLE_MAX_CHARS = 40; // rss.ts collectFromText()의 본문 파생 제목 관례와 동일
export function deriveManualDraftTitle(body: string): string {
  try {
    const firstMeaningfulLine = String(body ?? "")
      .split(/\r?\n/)
      .map((line) => line.replace(/<[^>]*>/g, "").trim())
      .find((line) => line.length > 0);
    if (!firstMeaningfulLine) return "";
    return firstMeaningfulLine.length > MANUAL_DRAFT_TITLE_MAX_CHARS
      ? firstMeaningfulLine.slice(0, MANUAL_DRAFT_TITLE_MAX_CHARS) + "…"
      : firstMeaningfulLine;
  } catch {
    // 제목 생성 실패가 초안 저장을 막지 않는다.
    return "";
  }
}

const MANUAL_DRAFT_ALLOWED_BODY_KEYS: ReadonlySet<string> = new Set(["body", "title", "assetKey"]);
const MANUAL_DRAFT_MAX_BODY_CHARS = 20000;

router.post("/manual", (req, res) => {
  const raw: unknown = req.body;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return res.status(400).json({ ok: false, error: { code: "invalid_request_body" } });
  }
  const bodyRecord = raw as Record<string, unknown>;
  if (!Object.keys(bodyRecord).every((k) => MANUAL_DRAFT_ALLOWED_BODY_KEYS.has(k))) {
    return res.status(400).json({ ok: false, error: { code: "invalid_request_body" } });
  }

  // 본문: 붙여넣은 원문을 그대로 보존한다(줄바꿈/공백 포함). 앞뒤 공백만 잘라 "빈 글"을 판정한다.
  const rawBody = bodyRecord.body;
  if (typeof rawBody !== "string") {
    return res.status(400).json({ ok: false, error: { code: "invalid_body" } });
  }
  const bodyText = rawBody.trim();
  if (bodyText.length === 0) {
    return res.status(400).json({ ok: false, error: { code: "empty_body" } });
  }
  if (rawBody.length > MANUAL_DRAFT_MAX_BODY_CHARS) {
    return res.status(400).json({ ok: false, error: { code: "body_too_long" } });
  }

  const rawTitle = bodyRecord.title;
  if (rawTitle !== undefined && typeof rawTitle !== "string") {
    return res.status(400).json({ ok: false, error: { code: "invalid_title" } });
  }
  const explicitTitle = typeof rawTitle === "string" ? rawTitle.replace(/<[^>]*>/g, "").trim().slice(0, 200) : "";
  // 제목을 직접 넘기지 않으면 본문 첫 유효 줄로 카드용 제목만 만든다(본문 원문은 그대로 저장).
  // 길이는 기존 rss.ts collectFromText()의 본문 파생 제목 관례(40자)를 따른다. AI 호출 없음.
  const title = explicitTitle || deriveManualDraftTitle(rawBody);

  // 미디어(선택): 업로드 asset만 허용한다. "job:"(Product Radar 생성 미디어)은 특정 추천
  // lineage에 묶여 있어 수동 초안이 가져다 쓸 대상이 아니므로 거부한다.
  let libraryAssetId: number | null = null;
  if (bodyRecord.assetKey !== undefined && bodyRecord.assetKey !== null && bodyRecord.assetKey !== "") {
    const parsed = parseProductRadarLibraryAssetKey(bodyRecord.assetKey);
    if (!parsed || parsed.origin !== "user_upload") {
      return res.status(400).json({ ok: false, error: { code: "invalid_asset_key" } });
    }
    const asset = getProductRadarLibraryAssetById(parsed.id);
    if (!asset) {
      return res.status(404).json({ ok: false, error: { code: "asset_not_found" } });
    }
    if (listProductRadarLibraryAssetFilesByAssetId(parsed.id).length === 0) {
      return res.status(400).json({ ok: false, error: { code: "asset_file_missing" } });
    }
    libraryAssetId = parsed.id;
  }

  // 순번 채번 + INSERT를 한 transaction으로 처리한다(중복 번호 방지). 번호는 본문/제목에
  // 절대 삽입하지 않는다 - drafts.manual_sequence 컬럼에만 들어가는 표시용 메타데이터다.
  const { id, manualSequence } = insertManualDraft({
    title,
    hook: "",
    body: rawBody,
    topic: "",
    product_radar_library_asset_id: libraryAssetId,
  });

  res.status(201).json({ ok: true, draftId: id, manualSequence, draft: getDraft(id) });
});

// 직접 글 작성 모달이 "다음은 몇 번째 글인지" 표시하기 위한 조회. 채번하지 않는 읽기 전용
// endpoint라 여러 번 불러도 값이 늘어나지 않는다(클라이언트가 +1로 추측하지 않게 하기 위함).
router.get("/manual/next-sequence", (_req, res) => {
  res.json({ ok: true, next: peekNextManualSequence() });
});

router.get("/", (req, res) => {
  const status = req.query.status as DraftStatus | undefined;
  const drafts = listDrafts(status) as DraftMediaPointerRow[];
  const summaries = resolveDraftMediaSummaries(drafts);
  res.json({ drafts: drafts.map((d) => ({ ...d, prMediaSummary: summaries.get(d.id) })) });
});

// 초안함 비우기 - 미리보기(삭제/보호 개수만 확인, 실제 삭제 없음).
// 확인창에 정확한 개수를 보여주기 위해 사용한다.
router.get("/purge/preview", (_req, res) => {
  const { deletable, protectedIds, total } = findPurgeableDrafts();
  res.json({ deletable: deletable.length, protected: protectedIds.length, total });
});

// 초안함 비우기 - 안전하게 삭제 가능한 초안만 정리한다.
// publish_log / product_radar_media_jobs 등 기존 이력은 그대로 보존한다.
router.post("/purge", (_req, res) => {
  const { deleted, kept } = purgeDrafts();
  // 실제 구매자 환경에서 "초안이 왜 줄었는지"를 나중에 확인할 수 있게 개수만 남긴다.
  // 초안 본문 / 제목 / 개인정보 / 토큰은 절대 남기지 않는다.
  console.log(`[drafts] 초안함 비우기: deleted=${deleted} protected=${kept}`);
  res.json({ success: true, deleted, kept });
});

// 선택 삭제 - 사용자가 고른 초안만 지운다. 삭제 정책/함수는 "초안함 비우기"와 동일한
// findPurgeableDrafts()를 그대로 재사용하므로, 예약됨/발행 이력이 있는 초안은 여기서도
// 똑같이 보호된다(요청한 id라도 지우지 않고 blocked로 돌려준다).
router.post("/delete-selected", (req, res) => {
  const raw = req.body?.ids;
  if (!Array.isArray(raw) || raw.length === 0) {
    return res.status(400).json({ ok: false, error: { code: "invalid_ids" } });
  }
  if (raw.length > 500) {
    return res.status(400).json({ ok: false, error: { code: "too_many_ids" } });
  }
  const ids: number[] = [];
  for (const v of raw) {
    const n = typeof v === "number" ? v : parseInt(String(v), 10);
    if (!Number.isInteger(n) || n <= 0) {
      return res.status(400).json({ ok: false, error: { code: "invalid_ids" } });
    }
    ids.push(n);
  }
  const { deleted, blocked, notFound } = deleteDraftsByIds(ids);
  // 비우기와 같은 원칙: 개수만 남기고 본문/제목/개인정보는 절대 로그에 남기지 않는다.
  console.log(`[drafts] 선택 삭제: deleted=${deleted.length} blocked=${blocked.length} notFound=${notFound.length}`);
  res.json({ ok: true, deleted: deleted.length, blocked, notFound, deletedIds: deleted });
});

router.get("/:id", (req, res) => {
  const draft = getDraft(parseInt(req.params.id, 10));
  if (!draft) return res.status(404).json({ error: "not found" });
  res.json({ draft });
});

// Phase 12.5.3.8(요청서 3·6절): 승인 전 최종 검토 화면이 "크게 보기"를 위해 파일 배열
// 전체(2~3개)를 조회하는 상세 read-only endpoint. 목록의 가벼운 summary와 달리 여기서만
// files 전체를 내려준다(요청서 4절 "상세 files는 초안 상세를 열 때만"). attachment를
// 절대 바꾸지 않는다 - 순수 조회다.
router.get("/:id/media", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ ok: false, error: { code: "invalid_id_param" } });
  }
  const draft = getDraft(id) as DraftMediaPointerRow | undefined;
  if (!draft) return res.status(404).json({ ok: false, error: { code: "draft_not_found" } });
  const result = resolveDraftMediaDetail(draft);
  res.status(200).json(result);
});

// 초안 수정 - 본문과 첨부 미디어를 함께 바꾼다.
//
// assetKey를 아예 보내지 않으면 미디어는 손대지 않는다(기존 호출부 그대로 동작).
// assetKey: null 이면 첨부를 떼어낸다(파일은 미디어 보관함에 남는다 - 삭제하지 않는다).
// assetKey: "upload:<id>" 이면 그 업로드 asset으로 교체한다.
//
// 예약된 글도 수정 대상에 포함한다: 발행 시점에 스케줄러가
// listDueScheduledDrafts()로 draft 행을 다시 읽어 draft.body와
// resolveDraftPublishMedia(draft)로 그때의 최신 값을 쓰기 때문이다(예약 시 snapshot을
// 뜨지 않는다). 발행이 이미 시작된 글(status='publishing')은 updateDraftContent()의
// 원자 조건절이 막는다 - 예약 시각(scheduled_at)은 건드리지 않으므로 그대로 유지된다.
router.patch("/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  const draft = getDraft(id);
  if (!draft) return res.status(404).json({ error: "not found" });
  if (!(DRAFT_EDITABLE_STATUSES as readonly string[]).includes(draft.status)) {
    return res.status(400).json({ error: "이미 발행되었거나 발행 중인 글은 수정할 수 없습니다." });
  }

  // 미디어(선택): 직접 글 작성과 동일하게 업로드 asset만 허용한다.
  let media: { libraryAssetId: number | null } | undefined;
  if (Object.prototype.hasOwnProperty.call(req.body ?? {}, "assetKey")) {
    const rawKey = req.body.assetKey;
    if (rawKey === null || rawKey === "") {
      media = { libraryAssetId: null };
    } else {
      const parsed = parseProductRadarLibraryAssetKey(rawKey);
      if (!parsed || parsed.origin !== "user_upload") {
        return res.status(400).json({ error: "첨부할 수 있는 미디어가 아닙니다." });
      }
      const asset = getProductRadarLibraryAssetById(parsed.id);
      if (!asset) return res.status(404).json({ error: "첨부하려는 미디어를 찾을 수 없습니다." });
      if (listProductRadarLibraryAssetFilesByAssetId(parsed.id).length === 0) {
        return res.status(400).json({ error: "첨부하려는 미디어 파일이 없습니다." });
      }
      media = { libraryAssetId: parsed.id };
    }
  }

  const ok = updateDraftContent(id, {
    body: String(req.body?.body ?? draft.body),
    title: req.body?.title !== undefined ? String(req.body.title) : undefined,
    media,
  });
  if (!ok) {
    // 원자 조건절이 막은 경우 = 저장을 누르는 사이에 발행이 시작됐다는 뜻이다.
    // 본문/미디어 어느 쪽도 바뀌지 않았으므로 불완전 상태가 남지 않는다.
    return res.status(409).json({ error: "글이 방금 발행 처리에 들어가 수정하지 못했습니다. 화면을 새로 고쳐 확인해 주세요." });
  }
  res.json({ success: true, draft: getDraft(id) });
});

// 승인
router.post("/:id/approve", (req, res) => {
  const id = parseInt(req.params.id, 10);
  const draft = getDraft(id);
  if (!draft) return res.status(404).json({ error: "not found" });
  if (draft.status !== "draft") return res.status(400).json({ error: "draft 상태에서만 승인할 수 있습니다." });
  setDraftStatus(id, "approved");
  res.json({ success: true, draft: getDraft(id) });
});

// 거절
router.post("/:id/reject", (req, res) => {
  const id = parseInt(req.params.id, 10);
  const draft = getDraft(id);
  if (!draft) return res.status(404).json({ error: "not found" });
  setDraftStatus(id, "rejected");
  res.json({ success: true, draft: getDraft(id) });
});

// 다시 생성 (해당 초안 1개만 새로 생성해서 교체)
router.post("/:id/regenerate", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const draft = getDraft(id);
  if (!draft) return res.status(404).json({ error: "not found" });
  if (draft.status !== "draft") return res.status(400).json({ error: "draft 상태에서만 다시 생성할 수 있습니다." });
  // 쿠파스 상품 홍보 글은 6개가 "서로 다른 6가지 유형"을 이루는 하나의 배치라서, 1개만 따로
  // 다시 생성하면 유형 중복/첫 줄 겹침 검증이 깨집니다. 새 배치를 다시 만들도록 안내합니다.
  if (draft.source_type === "affiliate_product") {
    return res.status(400).json({
      error: "제휴글은 6개가 한 세트라서 1개만 다시 생성할 수 없습니다. \"제휴글 6개 만들기\"에서 새로 생성해주세요.",
    });
  }

  const persona = ensurePersona();
  let materials: MaterialForPrompt[];
  if (draft.source_url) {
    materials = [
      toPromptMaterial({ title: draft.source_title, source_name: "", source_url: draft.source_url, content: draft.source_summary, source_type: "url" }),
    ];
  } else {
    // 자동 선택 경로와 동일하게 저장된 사용자 키워드(input-prefs) 기준으로 후보를 뽑는다.
    const prefs = getMaterialInputPrefs();
    const allMaterials = listAllMaterialsForSelection() as MaterialRow[];
    const selection = selectCandidateMaterials(allMaterials, {
      includeKeywords: parseKeywordList(prefs.includeKeywords || ""),
      excludeKeywords: parseKeywordList(prefs.excludeKeywords || ""),
    });
    materials = selection.candidates.slice(0, MAX_SELECTABLE_FOR_GENERATION).map((c) => toPromptMaterial(c.material));
  }

  const result = await generateDraftsWithClaude(materials, persona.data, 1);
  if (!result.success || !result.posts || result.posts.length === 0) {
    saveFailureLog(result.rawResponse, JSON.stringify(result.diagnostics || {}) || "알 수 없는 오류");
    return res.status(502).json({ success: false, error: CLAUDE_BUYER_FAILURE_MESSAGE, canRetry: true });
  }
  const post = result.posts[0];
  updateDraftBody(id, post.body, post.title);
  res.json({ success: true, draft: getDraft(id) });
});

// 예약 시간 선택 (approved 상태만 가능)
router.post("/:id/schedule", (req, res) => {
  const id = parseInt(req.params.id, 10);
  const draft = getDraft(id);
  if (!draft) return res.status(404).json({ error: "not found" });
  if (draft.status !== "approved") return res.status(400).json({ error: "approved 상태만 예약할 수 있습니다." });

  const approval = resolveAffiliateLinkApproval(draft, req.body);
  if (!approval.ok) return res.status(409).json(approval.payload);

  const scheduledAtRaw = String(req.body?.scheduled_at || "");
  if (!scheduledAtRaw) return res.status(400).json({ error: "올바른 예약 시간이 필요합니다." });
  let scheduledAtUtcIso: string;
  try {
    // 화면(datetime-local)에서 넘어온 시간은 "Asia/Seoul 기준 시각"으로 명시적으로 해석합니다.
    // (서버가 실행되는 PC의 시스템 시간대에 의존하지 않습니다)
    scheduledAtUtcIso = seoulLocalToUtcIso(scheduledAtRaw);
  } catch {
    return res.status(400).json({ error: "올바른 예약 시간이 필요합니다." });
  }
  // 승인 상태를 예약과 같은 행에 남긴다 - 스케줄러가 발행 직전에 이 값을 다시 읽는다.
  setDraftAllowPublishWithoutAffiliateLink(id, approval.approvedLinkless);
  scheduleDraft(id, scheduledAtUtcIso);
  res.json({ success: true, draft: getDraft(id) });
});

// 예약 취소/시간 변경은 scheduled 상태이면서 아직 publish_log가 없는 글에만 허용합니다.
// (스케줄러가 이미 처리를 시작했거나 끝낸 글은 절대 되돌리지 않기 위한 공통 검사)
const MIN_RESCHEDULE_LEAD_MS = 2 * 60 * 1000; // 스케줄러가 1분마다 확인하므로 최소 2분 여유를 둡니다.

// 제휴 홍보글을 예약할 때 "발행 본문에 제휴링크가 실제로 들어 있는지" 확인합니다.
// 발행 payload는 draft.body 하나만 쓰므로(threadsPublishDispatcher), 본문에 링크가 없으면
// 링크 없는 홍보글이 그대로 게시됩니다.
//
// 이건 차단이 아니라 **경고**입니다 - 호출부가 사용자에게 확인창을 띄우고, 사용자가
// "링크 없이 예약"을 직접 고르면 그대로 진행합니다. 다만 아무 경고 없이 지나가지는 않습니다.
// source_type이 'affiliate_product'인 글에만 적용합니다 - 일반 글/직접 작성 글/상품 레이더
// 초안은 전혀 영향받지 않습니다.
export type AffiliateLinkWarning = { code: "no_affiliate_url" | "link_missing_from_body"; message: string };

export function affiliateLinkWarning(draft: any): AffiliateLinkWarning | null {
  if (!draft || draft.source_type !== "affiliate_product") return null;
  const url = typeof draft.affiliate_url === "string" ? draft.affiliate_url.trim() : "";
  if (!url) {
    return { code: "no_affiliate_url", message: "이 게시물에는 제휴링크가 없습니다. 그래도 예약하시겠습니까?" };
  }
  if (!String(draft.body ?? "").includes(url)) {
    return { code: "link_missing_from_body", message: "저장된 제휴링크가 본문에서 빠져 있습니다. 그래도 링크 없이 예약하시겠습니까?" };
  }
  return null;
}

// 요청 본문의 명시적 승인 플래그. 화면이 확인창에서 "링크 없이 예약"을 눌렀을 때만 붙습니다.
function hasExplicitLinklessApproval(body: any): boolean {
  return body?.allowWithoutAffiliateLink === true;
}

// 경고가 있는데 승인이 없으면 확인창을 띄우라고 화면에 알려줍니다(needsConfirm).
// 승인이 있으면 그 사실을 예약 데이터에 남기고 통과시킵니다 - 스케줄러 최종 guard가
// 이 값을 다시 읽으므로, 재시작 후에도 승인이 유지됩니다.
function resolveAffiliateLinkApproval(
  draft: any,
  body: any
): { ok: true; approvedLinkless: boolean } | { ok: false; payload: Record<string, unknown> } {
  const warning = affiliateLinkWarning(draft);
  if (!warning) return { ok: true, approvedLinkless: false };
  if (!hasExplicitLinklessApproval(body)) {
    return { ok: false, payload: { error: warning.message, needsConfirm: true, confirmCode: warning.code } };
  }
  return { ok: true, approvedLinkless: true };
}

function scheduleGuardError(draft: any): string | null {
  if (draft.status !== "scheduled") {
    return `예약(scheduled) 상태의 글만 가능합니다. (현재 상태: ${draft.status})`;
  }
  if (hasPublishLogForDraft(draft.id)) {
    return "이미 발행 처리가 시작된 글은 예약을 취소하거나 변경할 수 없습니다.";
  }
  return null;
}

// 예약 취소 (scheduled -> approved로 되돌리고 scheduled_at을 비웁니다. 본문/출처/생성 정보는 그대로 보존됩니다)
router.post("/:id/cancel-schedule", (req, res) => {
  const id = parseInt(req.params.id, 10);
  const draft = getDraft(id);
  if (!draft) return res.status(404).json({ error: "not found" });

  const guardError = scheduleGuardError(draft);
  if (guardError) return res.status(400).json({ error: guardError });

  const ok = cancelSchedule(id);
  if (!ok) {
    return res
      .status(409)
      .json({ error: "예약 취소에 실패했습니다. 이미 스케줄러가 처리를 시작했거나 상태가 바뀐 것 같습니다. 새로고침 후 다시 확인해주세요." });
  }
  res.json({ success: true, draft: getDraft(id) });
});

// 예약 시간 변경 (기존 예약을 취소하지 않고 scheduled_at만 새 값으로 직접 변경, status는 scheduled 유지)
router.patch("/:id/reschedule", (req, res) => {
  const id = parseInt(req.params.id, 10);
  const draft = getDraft(id);
  if (!draft) return res.status(404).json({ error: "not found" });

  const guardError = scheduleGuardError(draft);
  if (guardError) return res.status(400).json({ error: guardError });

  const approval = resolveAffiliateLinkApproval(draft, req.body);
  if (!approval.ok) return res.status(409).json(approval.payload);

  const scheduledAtRaw = String(req.body?.scheduled_at || "");
  if (!scheduledAtRaw) return res.status(400).json({ error: "올바른 예약 시간이 필요합니다." });

  let scheduledAtUtcIso: string;
  try {
    // 화면 입력은 approved 최초 예약과 동일하게 Asia/Seoul 기준으로 해석해 UTC로 저장합니다.
    scheduledAtUtcIso = seoulLocalToUtcIso(scheduledAtRaw);
  } catch {
    return res.status(400).json({ error: "올바른 예약 시간이 필요합니다." });
  }

  const leadMs = new Date(scheduledAtUtcIso).getTime() - Date.now();
  if (leadMs < MIN_RESCHEDULE_LEAD_MS) {
    return res.status(400).json({
      error: `예약 시간은 현재 시각보다 최소 ${MIN_RESCHEDULE_LEAD_MS / 60000}분 이후여야 합니다. 과거이거나 너무 임박한 시각은 선택할 수 없습니다.`,
    });
  }

  setDraftAllowPublishWithoutAffiliateLink(id, approval.approvedLinkless);
  const ok = rescheduleDraft(id, scheduledAtUtcIso);
  if (!ok) {
    return res
      .status(409)
      .json({ error: "예약 시간 변경에 실패했습니다. 이미 스케줄러가 처리를 시작했거나 상태가 바뀐 것 같습니다. 새로고침 후 다시 확인해주세요." });
  }
  res.json({ success: true, draft: getDraft(id) });
});

export default router;
