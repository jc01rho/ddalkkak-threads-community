// src/routes/materials.ts
import { Router } from "express";
import { buildKeywordMaterials, collectFromFeeds, collectFromText, collectFromUrl, collectFromUrls } from "../rss";
import {
  deleteMaterial,
  getMaterialInputPrefs,
  listAllMaterialsForSelection,
  listFeeds,
  listMaterials,
  MaterialInputPrefs,
  setMaterialInputPrefs,
} from "../database";
import { buildDuplicateSuspectIndex, findDuplicateSuspect, MAX_CANDIDATES, MAX_SELECTABLE_FOR_GENERATION, MaterialRow, selectCandidateMaterials } from "../materialSelector";
import { parseKeywordList } from "../keywordInput";

const router = Router();

const MAX_URLS_PER_REQUEST = 20;

router.get("/", (req, res) => {
  const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 100;
  res.json({ materials: listMaterials(limit) });
});

// 자료함 화면에 "전체 수집 수"와 "이번 생성에 사용될 후보 수"를 따로 보여주기 위한 미리보기 API.
// Claude를 호출하지 않고, materialSelector.ts의 선별 로직만 실행해서 결과를 반환합니다.
router.get("/candidates", (_req, res) => {
  // review-list와 같은 주제 기준으로 점수를 매기도록, 사용자가 저장해 둔 키워드(input-prefs)를
  // 그대로 재사용한다(새 설정 구조를 만들지 않음). 키워드가 비어 있으면 기존 기본 동작 그대로다.
  const prefs = getMaterialInputPrefs();
  const allMaterials = listAllMaterialsForSelection() as MaterialRow[];
  const selection = selectCandidateMaterials(allMaterials, {
    includeKeywords: parseKeywordList(prefs.includeKeywords || ""),
    excludeKeywords: parseKeywordList(prefs.excludeKeywords || ""),
  });
  res.json({
    totalCollected: selection.totalCollected,
    candidateCount: selection.candidates.length,
    excludedTooShort: selection.excludedTooShort,
    excludedDuplicate: selection.excludedDuplicate,
    totalCharsUsed: selection.totalCharsUsed,
    candidates: selection.candidates.map((c) => ({
      id: c.material.id,
      title: c.material.title,
      source_name: c.material.source_name,
      score: c.score,
      reason: c.reason,
    })),
  });
});

// "자료 수집" 화면의 자료 후보 검수 목록.
//
// 보여주는 대상: selectCandidateMaterials()가 선정한 후보(최대 MAX_CANDIDATES=20건)뿐입니다.
// materialSelector.ts 4단계 주석이 원래 정의한 그대로입니다 - "후보 검수 화면에 보여줄 후보
// 풀은 최대 20개까지만 선정한다". 예전에는 여기서 allScored(자료함 전체)를 내려보내는 바람에
// 자료가 1,000건을 넘으면 응답이 900KB/6초가 되고 화면에도 카드가 1,000개 넘게 그려졌습니다.
//
// 자료 자체는 하나도 줄지 않습니다. 전체 목록은 자료 보관함(GET /api/materials)이 담당하고,
// 여기서는 totalCollected로 "자료함 전체가 몇 건인지"만 함께 알려 화면이 안내할 수 있게 합니다.
router.get("/review-list", (req, res) => {
  const includeKeywords = parseKeywordList(String(req.query.includeKeywords || ""));
  const excludeKeywords = parseKeywordList(String(req.query.excludeKeywords || ""));

  const allMaterials = listAllMaterialsForSelection() as MaterialRow[];
  const selection = selectCandidateMaterials(allMaterials, { includeKeywords, excludeKeywords });

  const softExclusions = new Set(["duplicate", "source_cap", "max_count"]);

  // 중복 의심 판정에 쓰는 계산(제목 정규화/3-gram, URL/요약 색인)을 이 요청에서 한 번만
  // 만들어 모든 자료가 재사용한다(자료가 많을 때 목록이 수십 초 걸리던 원인 제거, 판정 동일).
  const duplicateIndex = buildDuplicateSuspectIndex(allMaterials);
  const items = selection.candidates
    .map((s) => {
      const dup = findDuplicateSuspect(s.material, allMaterials, duplicateIndex);
      let meta: any = null;
      try {
        meta = (s.material as any).meta_json ? JSON.parse((s.material as any).meta_json) : null;
      } catch {
        meta = null;
      }
      return {
        id: s.material.id,
        title: s.material.title,
        source_name: s.material.source_name,
        source_url: s.material.source_url,
        source_type: s.material.source_type,
        collected_at: s.material.collected_at,
        score: s.score,
        reason: s.reason,
        ok: !s.excludedReason || softExclusions.has(s.excludedReason),
        excludedReason: s.excludedReason || null,
        duplicateSuspect: dup.suspect,
        duplicateSuspectReason: dup.reason || null,
        keywords: meta?.keywords || null,
        note: meta?.note || null,
        contentPreview: (s.material.content || "").slice(0, 200),
      };
    })
    .sort((a, b) => b.score - a.score);

  res.json({
    // 자료함 전체 건수(자료가 줄지 않았음을 화면이 그대로 보여주기 위한 값).
    // selectCandidateMaterials()가 이미 세어 둔 값이라 별도 count 쿼리를 추가하지 않습니다.
    totalCollected: selection.totalCollected,
    items,
    candidateCount: items.length,
    maxSelectable: MAX_SELECTABLE_FOR_GENERATION,
    maxCandidates: MAX_CANDIDATES,
  });
});

// 메인 버튼 1: 오늘 자료 수집 (등록된 RSS 피드 전체를 다시 확인)
router.post("/collect", async (_req, res) => {
  try {
    const feeds = listFeeds();
    const summary = await collectFromFeeds(feeds);
    res.json({ success: true, summary });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message || String(e) });
  }
});

router.post("/url", async (req, res) => {
  const url = String(req.body?.url || "").trim();
  if (!url) return res.status(400).json({ success: false, error: "url이 필요합니다." });
  const result = await collectFromUrl(url);
  res.json(result);
});

// URL 직접 입력(여러 개). 하나가 실패해도 전체 작업은 계속 진행하고, URL별 상태를 그대로 돌려줍니다.
router.post("/urls", async (req, res) => {
  const rawUrls = Array.isArray(req.body?.urls) ? req.body.urls : [];
  const urls = rawUrls
    .map((u: any) => String(u ?? "").trim())
    .filter((u: string) => u.length > 0)
    .slice(0, MAX_URLS_PER_REQUEST);

  if (urls.length === 0) {
    return res.status(400).json({ success: false, error: "URL을 한 줄에 하나씩 하나 이상 입력해주세요." });
  }

  // refresh가 정확히 true일 때만 기존 자료 갱신을 허용한다(없거나 다른 값이면 기존 중복 보호 그대로).
  const refresh = req.body?.refresh === true;
  const results = await collectFromUrls(urls, { refresh });
  res.json({ success: true, results });
});

router.post("/text", (req, res) => {
  const text = String(req.body?.text || "");
  const title = req.body?.title ? String(req.body.title) : undefined;
  const sourceName = req.body?.source_name ? String(req.body.source_name) : undefined;
  const result = collectFromText(text, title, sourceName);
  res.json(result);
});

// 키워드·주제 입력 - 사용자가 입력한 주제 자체를 자료 후보로 등록합니다(새 검색 API 없음).
router.post("/keywords", (req, res) => {
  const keywords = parseKeywordList(String(req.body?.keywords || ""));
  const excludeKeywords = parseKeywordList(String(req.body?.excludeKeywords || ""));
  const note = String(req.body?.note || "").slice(0, 2000);
  const candidateCountRaw = req.body?.candidateCount ? parseInt(String(req.body.candidateCount), 10) : 3;
  const candidateCount = Number.isFinite(candidateCountRaw) ? candidateCountRaw : 3;

  if (keywords.length === 0) {
    return res.status(400).json({ success: false, error: "글감 키워드나 주제를 하나 이상 입력해주세요." });
  }

  const result = buildKeywordMaterials({ keywords, excludeKeywords, note, candidateCount });
  res.json({
    success: true,
    created: result.created,
    createdCount: result.created.length,
    skippedDuplicate: result.skippedDuplicate,
    keywords,
    excludeKeywords,
  });
});

// "① 오늘 자료 수집" 화면 입력값 저장/복원 (Claude/Threads 로그인 정보는 절대 포함하지 않음)
router.get("/input-prefs", (_req, res) => {
  res.json({ prefs: getMaterialInputPrefs() });
});

router.post("/input-prefs", (req, res) => {
  const body = req.body || {};
  const allowedModes = ["auto", "keyword", "url", "mixed"];
  const candidateCountRaw = parseInt(String(body.candidateCount ?? 3), 10);
  const prefs: MaterialInputPrefs = {
    lastMode: allowedModes.includes(body.lastMode) ? body.lastMode : "auto",
    includeKeywords: String(body.includeKeywords || "").slice(0, 2000),
    excludeKeywords: String(body.excludeKeywords || "").slice(0, 2000),
    note: String(body.note || "").slice(0, 2000),
    candidateCount: Number.isFinite(candidateCountRaw) ? Math.max(1, Math.min(candidateCountRaw, 10)) : 3,
    recentUrls: Array.isArray(body.recentUrls) ? body.recentUrls.filter((u: any) => typeof u === "string").slice(0, 20) : [],
  };
  setMaterialInputPrefs(prefs);
  res.json({ success: true, prefs });
});

router.delete("/:id", (req, res) => {
  deleteMaterial(parseInt(req.params.id, 10));
  res.json({ success: true });
});

export default router;
