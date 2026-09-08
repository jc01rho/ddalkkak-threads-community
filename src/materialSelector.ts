// src/materialSelector.ts
// 자료함에 쌓인 자료가 많아졌을 때, "Threads 글 6개 만들기"를 누르면 Claude에게 전체 자료를
// 다 넘기지 않고 아래 기준으로 자동으로 후보를 골라서 넘깁니다.
//
// 선별 기준(요청서 기준):
// 1. 최근 72시간 자료 우선
// 2. URL과 제목이 유사한 중복 자료 제거
// 3. AI/자동화/생산성/온라인 도구/기술 변화 관련 자료 우선 (+ 사용자 지정 키워드 가중치/제외)
// 4. 제목이나 본문이 지나치게 짧은 자료 제외
// 5. 동일 출처는 최대 3개까지만 포함
// 6. 후보 검수 화면에 보여줄 후보 풀(전체 풀)은 최대 20개(selectCandidateMaterials)
// 7. 각 후보에 선정 점수와 선정 이유를 기록
// 8. 글 생성에 실제로 Claude에게 전달되는 자료는 자동 선택/수동 선택 모두 동일하게
//    buildMaterialContext()를 거쳐 "최대 8개 · 자료당 최대 2,000자 발췌 · 전체 최대 15,000자"
//    규칙을 적용받는다. 예산을 넘으면 일부만 잘라서 억지로 맞추지 않고 실패를 돌려준다
//    (호출자가 생성을 중단하고 사용자를 자료 후보 검수 화면으로 안내해야 한다).
//
// selectCandidateMaterials()의 20개 후보 풀 선별과 buildMaterialContext()의 8개/15,000자 예산
// 검증은 서로 다른 단계다: 전자는 "후보 검수 화면에 무엇을 보여줄지"를 정하고, 후자는 "그중 실제로
// Claude에 무엇을, 얼마나 잘라서 보낼지"를 정한다. 예전에는 전자가 원문 길이 기준으로 글자수
// 예산까지 함께 처리해 실제로는 발췌(최대 2,000자) 후 충분히 예산 안에 들어올 자료까지 후보
// 검수 화면에서 미리 제외해버리는 문제가 있었다.

import { extractRelevantExcerpt } from "./excerpt";

export interface MaterialRow {
  id: number;
  title: string;
  source_name: string | null;
  source_url: string | null;
  source_type: string;
  published_at: string | null;
  collected_at: string;
  content: string | null;
}

export interface ScoredMaterial {
  material: MaterialRow;
  score: number;
  reason: string;
  selected: boolean;
  excludedReason?: "too_short" | "duplicate" | "source_cap" | "max_count" | "excluded_keyword";
}

export interface SelectionResult {
  totalCollected: number;
  candidates: ScoredMaterial[]; // 최종 선정된 후보 (Claude에게 실제로 전달되는 것들)
  allScored: ScoredMaterial[]; // 제외된 것 포함, 평가된 전체 목록 (기록/화면 표시용)
  totalCharsUsed: number;
  excludedTooShort: number;
  excludedDuplicate: number;
}

const TOPIC_KEYWORDS = [
  "ai", "인공지능", "챗봇", "챗gpt", "chatgpt", "llm", "생성형",
  "자동화", "automation", "workflow", "워크플로",
  "생산성", "productivity",
  "온라인 도구", "도구", "tool", "앱", "서비스", "saas",
  "기술", "technology", "테크", "스타트업", "혁신",
];

const MIN_TITLE_LEN = 6;
const MIN_CONTENT_LEN = 30;
const MAX_PER_SOURCE = 3;

// 전체 후보 풀(자료함 화면에 보여줄 수 있는 후보)의 최대 개수. 20개 유지.
export const MAX_CANDIDATES = 20;

// Threads 글 생성에 "실제로 선택"할 수 있는 정상 자료 최대 개수.
// 초과하면 자동으로 줄이지 않고, 사용자가 직접 8개 이내로 줄이도록 화면에서 안내한다.
export const MAX_SELECTABLE_FOR_GENERATION = 8;

// 자료 1건당 Claude 프롬프트에 실제로 들어가는 발췌 본문의 최대 글자 수.
export const MAX_MATERIAL_EXCERPT_CHARS = 2000;

// Claude에게 전달하는 전체 자료 텍스트의 기본 예산(글자 수). 필요하면 selectCandidateMaterials(materials, { maxTotalChars })로 조정 가능.
// 예전 30,000자에서 15,000자로 축소(글 6개 생성에 과도했기 때문).
export const DEFAULT_MAX_TOTAL_CHARS = 15000;

const RECENT_HOURS = 72;

// 다른 모듈에서도 재사용할 수 있도록 export 한다.
// 문자열 정규화 전용 순수 함수다.
export function normalizeForSimilarity(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9가-힣]/g, "");
}

// 외부 라이브러리 없이 동작하는 단순 유사도 판정: 완전일치/포함관계/3-gram 자카드 유사도
export function isSimilarTitle(a: string, b: string): boolean {
  const na = normalizeForSimilarity(a);
  const nb = normalizeForSimilarity(b);
  if (!na || !nb) return false;
  if (na === nb) return true;

  const shorter = na.length <= nb.length ? na : nb;
  const longer = na.length <= nb.length ? nb : na;
  if (shorter.length >= 6 && longer.includes(shorter)) return true;

  const grams = (s: string) => {
    const set = new Set<string>();
    for (let i = 0; i < s.length - 2; i++) set.add(s.slice(i, i + 3));
    return set;
  };
  const ga = grams(na);
  const gb = grams(nb);
  if (ga.size === 0 || gb.size === 0) return false;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  const union = ga.size + gb.size - inter;
  const jaccard = union === 0 ? 0 : inter / union;
  return jaccard >= 0.6;
}

// isSimilarTitle과 완전히 같은 판정을, 미리 계산해 둔 값으로 수행하는 내부 헬퍼입니다.
// 후보 선정 2단계는 자료 수가 늘면 비교 횟수가 제곱으로 늘어나는데(자료 1,086건 기준 약
// 36만 회), 기존 isSimilarTitle은 매 비교마다 두 제목을 다시 정규화하고 3-gram Set을 새로
// 만들었습니다. 그래서 자료 수집 화면이 4초 가까이 멈췄습니다(실측).
// 여기서 줄이는 것은 "같은 제목을 몇백 번씩 다시 계산하는 비용"뿐이고, 비교 규칙
// (완전일치 / 6자 이상 포함관계 / 3-gram 자카드 0.6)은 글자 하나까지 그대로입니다.
interface PreparedTitle {
  norm: string;
  grams: Set<string>;
}

function prepareTitle(title: string): PreparedTitle {
  const norm = normalizeForSimilarity(title);
  return { norm, grams: trigramSet(norm) };
}

function isSimilarPreparedTitle(a: PreparedTitle, b: PreparedTitle): boolean {
  if (!a.norm || !b.norm) return false;
  if (a.norm === b.norm) return true;

  const shorter = a.norm.length <= b.norm.length ? a.norm : b.norm;
  const longer = a.norm.length <= b.norm.length ? b.norm : a.norm;
  if (shorter.length >= 6 && longer.includes(shorter)) return true;

  if (a.grams.size === 0 || b.grams.size === 0) return false;
  let inter = 0;
  for (const g of a.grams) if (b.grams.has(g)) inter++;
  const union = a.grams.size + b.grams.size - inter;
  const jaccard = union === 0 ? 0 : inter / union;
  return jaccard >= 0.6;
}

function hoursSince(iso: string | null): number {
  if (!iso) return Infinity;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return Infinity;
  return (Date.now() - t) / (1000 * 60 * 60);
}

export interface SelectionOptions {
  includeKeywords?: string[]; // 사용자 지정 "핵심 키워드" - 포함된 자료에 가점
  excludeKeywords?: string[]; // 사용자 지정 "제외 키워드" - 포함된 자료는 후보에서 제외
}

export function selectCandidateMaterials(allMaterials: MaterialRow[], opts: SelectionOptions = {}): SelectionResult {
  const includeKeywords = (opts.includeKeywords || []).map((k) => k.toLowerCase()).filter(Boolean);
  const excludeKeywords = (opts.excludeKeywords || []).map((k) => k.toLowerCase()).filter(Boolean);

  const totalCollected = allMaterials.length;

  // 1단계: 너무 짧은 자료 / 제외 키워드가 포함된 자료는 바로 제외하고, 나머지는 점수를 매긴다.
  const scored: ScoredMaterial[] = [];
  let excludedTooShort = 0;

  for (const m of allMaterials) {
    const titleLen = (m.title || "").trim().length;
    const contentLen = (m.content || "").trim().length;

    if (titleLen < MIN_TITLE_LEN || contentLen < MIN_CONTENT_LEN) {
      excludedTooShort++;
      scored.push({
        material: m,
        score: 0,
        reason: `제목(${titleLen}자) 또는 본문(${contentLen}자)이 너무 짧아 제외`,
        selected: false,
        excludedReason: "too_short",
      });
      continue;
    }

    const haystack = `${m.title} ${m.content || ""}`.toLowerCase();

    if (excludeKeywords.length > 0) {
      const hitExclude = excludeKeywords.find((k) => haystack.includes(k));
      if (hitExclude) {
        scored.push({
          material: m,
          score: 0,
          reason: `제외 키워드("${hitExclude}") 포함으로 제외`,
          selected: false,
          excludedReason: "excluded_keyword",
        });
        continue;
      }
    }

    const refDate = m.published_at || m.collected_at;
    const hours = hoursSince(refDate);
    let score = 10;
    const reasonParts: string[] = ["기본점수 10"];

    if (hours <= 24) {
      score += 40;
      reasonParts.push("24시간 이내 최신 자료(+40)");
    } else if (hours <= RECENT_HOURS) {
      score += 25;
      reasonParts.push("72시간 이내 자료(+25)");
    } else {
      reasonParts.push("72시간 초과(가산점 없음)");
    }

    // 주제 가점 정책: 사용자가 핵심 키워드를 지정했다면 그것이 주제의 정의다.
    // 이때 고정 TOPIC_KEYWORDS 가점을 함께 주면, 사용자가 주제를 바꿔도 과거
    // AI/자동화 자료가 고정 가점(+30)으로 계속 상단을 차지한다(실사용 QA에서 확인).
    // 그래서 includeKeywords가 1개 이상이면 사용자 키워드만 쓰고, 없을 때만
    // 기존 고정 TOPIC_KEYWORDS 동작을 그대로 유지한다.
    if (includeKeywords.length > 0) {
      const matchedUserKeywords = includeKeywords.filter((k) => haystack.includes(k));
      if (matchedUserKeywords.length > 0) {
        const bonus = Math.min(40, matchedUserKeywords.length * 15);
        score += bonus;
        reasonParts.push(`사용자 키워드(${matchedUserKeywords.slice(0, 3).join(", ")}) 포함(+${bonus})`);
      } else {
        reasonParts.push("사용자 키워드 미포함");
      }
    } else {
      const matchedKeywords = TOPIC_KEYWORDS.filter((k) => haystack.includes(k));
      if (matchedKeywords.length > 0) {
        const bonus = Math.min(30, matchedKeywords.length * 10);
        score += bonus;
        reasonParts.push(`주제 키워드(${matchedKeywords.slice(0, 3).join(", ")}) 포함(+${bonus})`);
      } else {
        reasonParts.push("주제 관련 키워드 없음");
      }
    }

    if (contentLen >= 100 && contentLen <= 3000) {
      score += 10;
      reasonParts.push("본문 길이 적절(+10)");
    }

    scored.push({ material: m, score, reason: reasonParts.join(", "), selected: false });
  }

  // 2단계: 점수가 높은 순으로 정렬한 뒤, 이미 채택한 자료와 URL/제목이 유사하면 제외한다.
  const eligible = scored.filter((s) => !s.excludedReason).sort((a, b) => b.score - a.score);
  const deduped: ScoredMaterial[] = [];
  let excludedDuplicate = 0;

  // 비교 자체는 아래 루프가 기존과 똑같은 순서로 수행합니다. 달라진 것은 제목 정규화/3-gram을
  // 자료마다 한 번만 만들어 재사용한다는 점, 그리고 완전히 같은 URL은 Set으로 즉시 거른다는 점뿐입니다.
  const preparedTitles = new Map<number, PreparedTitle>();
  const titleOf = (m: MaterialRow): PreparedTitle => {
    let p = preparedTitles.get(m.id);
    if (!p) {
      p = prepareTitle(m.title);
      preparedTitles.set(m.id, p);
    }
    return p;
  };
  const keptUrls = new Set<string>();

  for (const cand of eligible) {
    const candTitle = titleOf(cand.material);
    const candUrl = cand.material.source_url || "";
    const isDup =
      (!!candUrl && keptUrls.has(candUrl)) ||
      deduped.some((kept) => isSimilarPreparedTitle(candTitle, titleOf(kept.material)));
    if (isDup) {
      excludedDuplicate++;
      cand.reason += " / 유사 중복으로 제외";
      cand.excludedReason = "duplicate";
      continue;
    }
    if (candUrl) keptUrls.add(candUrl);
    deduped.push(cand);
  }

  // 3단계: 동일 출처는 최대 3개까지만.
  const perSourceCount: Record<string, number> = {};
  const afterSourceCap: ScoredMaterial[] = [];
  for (const cand of deduped) {
    const key = cand.material.source_name || "(출처 미상)";
    perSourceCount[key] = perSourceCount[key] || 0;
    if (perSourceCount[key] >= MAX_PER_SOURCE) {
      cand.reason += ` / 동일 출처(${key}) 상위 ${MAX_PER_SOURCE}개 초과로 제외`;
      cand.excludedReason = "source_cap";
      continue;
    }
    perSourceCount[key]++;
    afterSourceCap.push(cand);
  }

  // 4단계: 후보 검수 화면에 보여줄 후보 풀은 최대 20개까지만 선정한다.
  // 원문 글자수 기준 예산 컷은 여기서 하지 않는다(실제 Claude 전달 여부/글자수 예산 검증은
  // buildMaterialContext()가 발췌 결과를 기준으로 별도로 수행한다).
  const finalCandidates: ScoredMaterial[] = [];
  for (const cand of afterSourceCap) {
    if (finalCandidates.length >= MAX_CANDIDATES) {
      cand.reason += ` / 최대 후보 수(${MAX_CANDIDATES}개) 초과로 제외`;
      cand.excludedReason = "max_count";
      continue;
    }
    cand.selected = true;
    cand.reason += " / 후보로 선정";
    finalCandidates.push(cand);
  }

  const totalCharsUsed = finalCandidates.reduce(
    (sum, c) => sum + c.material.title.length + (c.material.content || "").length + (c.material.source_name || "").length,
    0
  );

  return {
    totalCollected,
    candidates: finalCandidates,
    allScored: scored,
    totalCharsUsed,
    excludedTooShort,
    excludedDuplicate,
  };
}

// ---------------------------------------------------------------------------
// buildMaterialContext: 실제로 Claude에게 보낼 자료 묶음을 확정하는 공용 함수.
// "① 자료 후보 검수 화면에서 사용자가 직접 고른 자료"(수동 선택)와 "② 자동 선택"이 반드시 이
// 함수를 거쳐서 아래 규칙을 동일하게 적용받는다:
//   1) 최대 maxSelectable(기본 MAX_SELECTABLE_FOR_GENERATION=8)개까지만
//   2) 자료 1건당 발췌는 최대 maxExcerptChars(기본 MAX_MATERIAL_EXCERPT_CHARS=2,000)자까지만
//   3) 전체 발췌 합계가 maxTotalChars(기본 DEFAULT_MAX_TOTAL_CHARS=15,000)자를 넘으면, 일부만
//      잘라서 억지로 맞추지 않고 ok:false를 돌려준다. 호출자는 이 경우 Claude를 호출하지 말고
//      생성을 중단한 뒤, 사용자를 자료 후보 검수 화면으로 안내해야 한다.
// ---------------------------------------------------------------------------

export interface MaterialContextItem {
  material: MaterialRow;
  excerpt: string;
  charsUsed: number;
}

interface MaterialContextBase {
  materialCount: number;
  totalChars: number;
  maxSelectable: number;
  maxTotalChars: number;
}

export type MaterialContextResult =
  | (MaterialContextBase & { ok: true; items: MaterialContextItem[] })
  | (MaterialContextBase & { ok: false; error: string });

export interface BuildMaterialContextOptions {
  maxSelectable?: number; // 기본 MAX_SELECTABLE_FOR_GENERATION
  maxTotalChars?: number; // 기본 DEFAULT_MAX_TOTAL_CHARS
  maxExcerptChars?: number; // 기본 MAX_MATERIAL_EXCERPT_CHARS
  getExcerptOptions?: (material: MaterialRow) => { keywords?: string[]; note?: string };
}

export function buildMaterialContext(candidates: MaterialRow[], opts: BuildMaterialContextOptions = {}): MaterialContextResult {
  const maxSelectable = opts.maxSelectable ?? MAX_SELECTABLE_FOR_GENERATION;
  const maxTotalChars = opts.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS;
  const maxExcerptChars = opts.maxExcerptChars ?? MAX_MATERIAL_EXCERPT_CHARS;

  if (candidates.length > maxSelectable) {
    return {
      ok: false,
      error: `자료가 ${candidates.length}개 선택되었습니다. 자료가 너무 많으면 글의 초점이 흐려지므로, 자료를 ${maxSelectable}개 이하로 줄여서 다시 선택해주세요.`,
      materialCount: candidates.length,
      totalChars: 0,
      maxSelectable,
      maxTotalChars,
    };
  }

  const items: MaterialContextItem[] = candidates.map((material) => {
    const excerptOpts = opts.getExcerptOptions ? opts.getExcerptOptions(material) : {};
    const excerpt = extractRelevantExcerpt(material.content || "", {
      title: material.title,
      keywords: excerptOpts.keywords,
      note: excerptOpts.note,
      maxChars: maxExcerptChars,
    });
    const charsUsed = material.title.length + excerpt.length + (material.source_name || "").length;
    return { material, excerpt, charsUsed };
  });

  const totalChars = items.reduce((sum, it) => sum + it.charsUsed, 0);

  if (totalChars > maxTotalChars) {
    return {
      ok: false,
      error: `선택한 자료를 Claude에 전달할 글자 수가 약 ${totalChars.toLocaleString()}자로 예산(${maxTotalChars.toLocaleString()}자)을 초과합니다. 일부 자료만 잘라서 전달하지 않고 생성을 중단했습니다. 자료 후보 검수 화면에서 자료를 더 줄이거나 짧은 자료로 바꿔서 다시 선택해주세요.`,
      materialCount: items.length,
      totalChars,
      maxSelectable,
      maxTotalChars,
    };
  }

  return {
    ok: true,
    items,
    materialCount: items.length,
    totalChars,
    maxSelectable,
    maxTotalChars,
  };
}

export interface DuplicateSuspectResult {
  suspect: boolean;
  reason?: string;
}

// export: 상품 레이더 Phase 5(src/productRadar/browserSave.ts)가 canonical URL 정규화에
// 그대로 재사용합니다 - 같은 로직을 중복 구현하지 않기 위함(동작 변경 없음, 가시성만 export로).
export function normalizeUrlLoose(url: string | null | undefined): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    const params = new URLSearchParams(u.search);
    ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid"].forEach((p) => params.delete(p));
    const search = params.toString();
    const pathname = u.pathname.replace(/\/+$/, "");
    return `${u.hostname.toLowerCase()}${pathname}${search ? "?" + search : ""}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

// 우선순위: 1) URL 완전 일치 2) 정규화 URL 일치 3) 콘텐츠 해시 일치 4) 제목 유사도
// (요약 유사도는 별도 요약 필드가 없는 v1에서는 본문 앞부분으로 대체 비교한다)
// P1.9 성능: 자료 후보 검수 목록은 자료 1건마다 findDuplicateSuspect()를 호출하는데, 그
// 안에서 제목 정규화와 3-gram Set을 매번 새로 만들고 있었다. 자료가 1,000건을 넘자 화면이
// 30초 넘게 비어 보였다(실측 33.6초). 판정 기준은 그대로 두고 "같은 계산을 반복하지 않도록"
// 미리 한 번만 만들어 재사용한다 - 인덱스를 넘기지 않으면 예전과 완전히 동일하게 동작한다.
export interface DuplicateSuspectIndex {
  readonly byUrl: Map<string, number[]>;
  readonly byLooseUrl: Map<string, number[]>;
  readonly bySummary: Map<string, number[]>;
  readonly titleNorm: Map<number, string>;
  readonly titleGrams: Map<number, Set<string>>;
  readonly byTitleNorm: Map<string, number[]>;
  readonly materials: readonly MaterialRow[];
}

function trigramSet(s: string): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i < s.length - 2; i++) set.add(s.slice(i, i + 3));
  return set;
}

function pushTo(map: Map<string, number[]>, key: string, id: number): void {
  if (!key) return;
  const list = map.get(key);
  if (list) list.push(id);
  else map.set(key, [id]);
}

export function buildDuplicateSuspectIndex(materials: readonly MaterialRow[]): DuplicateSuspectIndex {
  const byUrl = new Map<string, number[]>();
  const byLooseUrl = new Map<string, number[]>();
  const bySummary = new Map<string, number[]>();
  const titleNorm = new Map<number, string>();
  const titleGrams = new Map<number, Set<string>>();
  const byTitleNorm = new Map<string, number[]>();
  for (const m of materials) {
    if (m.source_url) pushTo(byUrl, m.source_url, m.id);
    pushTo(byLooseUrl, normalizeUrlLoose(m.source_url), m.id);
    const summary = (m.content || "").slice(0, 200);
    if (summary.length >= 40) pushTo(bySummary, normalizeForSimilarity(summary), m.id);
    const nt = normalizeForSimilarity(m.title);
    titleNorm.set(m.id, nt);
    titleGrams.set(m.id, trigramSet(nt));
    pushTo(byTitleNorm, nt, m.id);
  }
  return { byUrl, byLooseUrl, bySummary, titleNorm, titleGrams, byTitleNorm, materials };
}

// 인덱스를 쓰는 빠른 경로. 비교 기준과 사유 우선순위는 인덱스 없는 경로와 정확히 같다.
function findDuplicateSuspectIndexed(target: MaterialRow, index: DuplicateSuspectIndex): DuplicateSuspectResult {
  const others = (list: number[] | undefined): boolean => !!list && list.some((id) => id !== target.id);

  if (target.source_url && others(index.byUrl.get(target.source_url))) {
    return { suspect: true, reason: "동일한 URL의 자료가 이미 있습니다." };
  }
  const targetNorm = normalizeUrlLoose(target.source_url);
  if (targetNorm && others(index.byLooseUrl.get(targetNorm))) {
    return { suspect: true, reason: "추적 파라미터만 다른 동일한 URL의 자료가 있습니다." };
  }

  const na = index.titleNorm.get(target.id) ?? normalizeForSimilarity(target.title);
  if (na) {
    if (others(index.byTitleNorm.get(na))) {
      return { suspect: true, reason: "제목이 유사한 자료가 이미 있습니다." };
    }
    const ga = index.titleGrams.get(target.id) ?? trigramSet(na);
    for (const o of index.materials) {
      if (o.id === target.id) continue;
      const nb = index.titleNorm.get(o.id);
      if (!nb || na === nb) continue; // 완전 일치는 위에서 이미 처리
      const shorter = na.length <= nb.length ? na : nb;
      const longer = na.length <= nb.length ? nb : na;
      if (shorter.length >= 6 && longer.includes(shorter)) {
        return { suspect: true, reason: "제목이 유사한 자료가 이미 있습니다." };
      }
      const gb = index.titleGrams.get(o.id);
      if (!gb || ga.size === 0 || gb.size === 0) continue;
      let inter = 0;
      for (const g of ga) if (gb.has(g)) inter++;
      const union = ga.size + gb.size - inter;
      if (union > 0 && inter / union >= 0.6) {
        return { suspect: true, reason: "제목이 유사한 자료가 이미 있습니다." };
      }
    }
  }

  const targetSummary = (target.content || "").slice(0, 200);
  if (targetSummary.length >= 40 && others(index.bySummary.get(normalizeForSimilarity(targetSummary)))) {
    return { suspect: true, reason: "본문 요약이 동일한 자료가 이미 있습니다." };
  }
  return { suspect: false };
}

export function findDuplicateSuspect(target: MaterialRow, others: MaterialRow[], index?: DuplicateSuspectIndex): DuplicateSuspectResult {
  if (index) return findDuplicateSuspectIndexed(target, index);
  for (const o of others) {
    if (o.id === target.id) continue;
    if (target.source_url && o.source_url && target.source_url === o.source_url) {
      return { suspect: true, reason: "동일한 URL의 자료가 이미 있습니다." };
    }
  }
  const targetNorm = normalizeUrlLoose(target.source_url);
  if (targetNorm) {
    for (const o of others) {
      if (o.id === target.id) continue;
      if (normalizeUrlLoose(o.source_url) === targetNorm) {
        return { suspect: true, reason: "추적 파라미터만 다른 동일한 URL의 자료가 있습니다." };
      }
    }
  }
  for (const o of others) {
    if (o.id === target.id) continue;
    if (isSimilarTitle(target.title, o.title)) {
      return { suspect: true, reason: "제목이 유사한 자료가 이미 있습니다." };
    }
  }
  const targetSummary = (target.content || "").slice(0, 200);
  if (targetSummary.length >= 40) {
    for (const o of others) {
      if (o.id === target.id) continue;
      const oSummary = (o.content || "").slice(0, 200);
      if (oSummary.length >= 40 && normalizeForSimilarity(targetSummary) === normalizeForSimilarity(oSummary)) {
        return { suspect: true, reason: "본문 요약이 동일한 자료가 이미 있습니다." };
      }
    }
  }
  return { suspect: false };
}
