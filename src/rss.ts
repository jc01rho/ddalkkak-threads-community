// src/rss.ts
// 자료 수집 담당: 공개 RSS 피드 / 사용자가 등록한 공개 웹페이지 URL / 사용자가 붙여넣은 텍스트 / 사용자가 입력한 키워드·주제만 다룹니다.
// X, Threads, Instagram, Facebook 게시물을 스크래핑하거나 자동 수집하지 않습니다.

import crypto from "crypto";
import Parser from "rss-parser";
import * as cheerio from "cheerio";
import { FeedRow, findMaterialIdByDedupeHash, getMaterialById, insertMaterial, updateMaterialContent } from "./database";
import { isValidHttpUrl, safeFetchText } from "./urlSafety";

const parser = new Parser({ timeout: 15000, headers: { "User-Agent": "ddalkkak-threads-factory/1.0" } });

function normalize(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/https?:\/\//g, "")
    .replace(/[^a-z0-9가-힣]/g, "")
    .slice(0, 200);
}

// P1.9: 같은 페이지인데 표기만 다른 URL을 같은 자료로 보기 위한 보수적 정규화.
// 처리 대상은 "명백히 같은 문서를 가리키는" 차이뿐이다:
//   - 앵커(#fragment): 같은 문서 안의 위치일 뿐 다른 페이지가 아니다
//   - 기본 포트(:80/:443): 표기 차이
//   - 널리 쓰이는 추적 파라미터(utm_*, fbclid, gclid 등): 유입 경로 표시일 뿐 내용과 무관
// 그 외 query string은 절대 건드리지 않는다 - ?id=123 처럼 query가 곧 다른 문서인 경우가
// 많기 때문이다. 대소문자/후행 슬래시는 아래 normalize()가 이미 흡수한다.
const TRACKING_PARAM_PATTERN = /^(utm_[a-z_]+|fbclid|gclid|igshid|mc_cid|mc_eid|ref_src|spm)$/i;

// at_medium/at_campaign은 BBC가 자사 RSS 링크에 붙이는 유입 경로 표시라 내용과 무관하다.
// 다만 이름이 일반적이어서 다른 사이트에서는 실제 의미를 가진 query일 수 있으므로(예: 광고
// 도구의 at_campaign) 범용 목록에 넣지 않고 BBC 호스트에서만 제거한다.
const BBC_TRACKING_PARAM_PATTERN = /^(at_medium|at_campaign)$/i;
const BBC_HOSTS = ["bbc.co.uk", "bbc.com"];

function isBbcHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return BBC_HOSTS.some((base) => host === base || host.endsWith("." + base));
}

export function canonicalizeArticleUrl(raw: string): string {
  const trimmed = (raw || "").trim();
  if (!trimmed) return "";
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return trimmed; // URL로 파싱되지 않으면 손대지 않는다(호출부가 별도로 거부한다)
  }
  u.hash = "";
  if ((u.protocol === "http:" && u.port === "80") || (u.protocol === "https:" && u.port === "443")) u.port = "";
  const bbc = isBbcHost(u.hostname);
  const keys = Array.from(u.searchParams.keys());
  for (const k of keys) {
    if (TRACKING_PARAM_PATTERN.test(k)) u.searchParams.delete(k);
    else if (bbc && BBC_TRACKING_PARAM_PATTERN.test(k)) u.searchParams.delete(k);
  }
  return u.toString();
}

// URL(있으면)과 제목을 함께 섞어 해시를 만들어, 같은 URL이거나 제목이 거의 같으면 중복으로 처리합니다.
export function computeDedupeHash(url: string | null | undefined, title: string): string {
  const urlPart = normalize(url || "");
  const titlePart = normalize(title);
  const base = urlPart ? `url:${urlPart}` : `title:${titlePart}`;
  return crypto.createHash("sha256").update(base).digest("hex");
}

export interface CollectSummary {
  collected: number;
  skippedDuplicate: number;
  errors: string[];
}

// 자료원 등록 시 "실제로 읽을 수 있는 RSS/Atom인가"만 확인한다(수집/저장은 하지 않는다).
// 기존 수집 경로와 같은 parser를 그대로 쓰므로, 여기서 통과하면 수집도 같은 방식으로 읽힌다.
export type FeedValidationCode = "INVALID_URL" | "FEED_UNREACHABLE" | "FEED_EMPTY";
export async function fetchFeedForValidation(url: string): Promise<{ ok: true; itemCount: number } | { ok: false; code: FeedValidationCode }> {
  const trimmed = String(url || "").trim();
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(trimmed);
  } catch {
    return { ok: false, code: "INVALID_URL" };
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") return { ok: false, code: "INVALID_URL" };
  try {
    const parsed = await parser.parseURL(trimmed);
    const items = parsed.items || [];
    if (items.length === 0) return { ok: false, code: "FEED_EMPTY" };
    return { ok: true, itemCount: items.length };
  } catch {
    return { ok: false, code: "FEED_UNREACHABLE" };
  }
}

export async function collectFromFeeds(feeds: FeedRow[]): Promise<CollectSummary> {
  const summary: CollectSummary = { collected: 0, skippedDuplicate: 0, errors: [] };
  const enabledFeeds = feeds.filter((f) => f.enabled);

  for (const feed of enabledFeeds) {
    try {
      const parsed = await parser.parseURL(feed.url);
      for (const item of parsed.items || []) {
        const title = (item.title || "").trim();
        if (!title) continue;
        const link = item.link || "";
        const content = (item.contentSnippet || item.content || item.summary || "").toString().slice(0, 2000);
        const publishedAt = item.isoDate || item.pubDate || null;
        const hash = computeDedupeHash(link, title);
        const result = insertMaterial({
          title,
          source_name: feed.name,
          source_url: link,
          source_type: "rss",
          published_at: publishedAt,
          content,
          dedupe_hash: hash,
        });
        if (result.inserted) summary.collected++;
        else summary.skippedDuplicate++;
      }
    } catch (e: any) {
      summary.errors.push(`[${feed.name}] ${e.message || e}`);
    }
  }

  return summary;
}

// ---------------- URL 직접 입력 (상세 상태 포함) ----------------

export type UrlItemStatus =
  | "extracted" // 정상 추출
  | "refreshed" // 기존 자료를 새 본문으로 갱신
  | "invalid_url" // 잘못된 URL
  | "unreachable" // 접근 실패
  | "timeout" // 타임아웃
  | "forbidden" // 접근 거부
  | "login_required" // 로그인 필요
  | "insufficient_content" // 본문 부족
  | "duplicate_input" // 동일 URL 중복(같은 요청 안에서)
  | "duplicate_existing" // 기존 자료와 중복
  | "unsupported_format"; // 지원하지 않는 형식

export const URL_STATUS_LABELS: Record<UrlItemStatus, string> = {
  extracted: "정상 추출",
  refreshed: "갱신됨",
  invalid_url: "잘못된 URL",
  unreachable: "접근 실패",
  timeout: "타임아웃",
  forbidden: "접근 거부",
  login_required: "로그인 필요",
  insufficient_content: "본문 부족",
  duplicate_input: "동일 URL 중복",
  duplicate_existing: "기존 자료와 중복",
  unsupported_format: "지원하지 않는 형식",
};

export interface UrlCollectItemResult {
  url: string;
  status: UrlItemStatus;
  statusLabel: string;
  error?: string;
  materialId?: number;
  title?: string;
}

export const MIN_URL_CONTENT_LEN = 200;
const MAX_STORED_CONTENT_CHARS = 8000; // 원문은 이 정도까지 DB에 보존(Claude 프롬프트에는 별도로 발췌해서 전달)

const UNSUPPORTED_EXTENSIONS = /\.(pdf|jpg|jpeg|png|gif|webp|svg|mp4|mov|avi|mkv|mp3|wav|zip|rar|exe|dmg)(\?|#|$)/i;

export function isYouTubeUrl(u: URL): boolean {
  const h = u.hostname.replace(/^www\./, "");
  return h === "youtube.com" || h === "m.youtube.com" || h === "youtu.be";
}

export interface ExtractedArticle {
  title: string;
  sourceName: string;
  content: string;
  youTubeUnsupported?: boolean;
}

// 본문으로 취급하는 블록 요소. 실제 상세페이지는 핵심 정보가 <p>보다 제목(h1~h4)과
// 목록(li)/표(td,th)에 실려 있는 경우가 많아(딸깍 상세페이지 실측: <p>만 수집 시 회수율 43.9%),
// <p> 전용 수집을 이 목록으로 넓힌다.
const CONTENT_BLOCK_SELECTOR = "h1, h2, h3, h4, p, li, dt, dd, blockquote, td, th";

// HTML을 이미 가져온 뒤의 순수 파싱 로직만 분리했습니다(네트워크 호출 없음).
// fixture HTML만으로 단위 테스트를 할 수 있도록 export 합니다.
export function extractArticleFromHtml(parsed: URL, html: string): ExtractedArticle {
  const $ = cheerio.load(html);
  $("script, style, noscript, iframe, form, .ad, .ads, .advertisement, .cookie, .cookie-banner, .gnb, .lnb").remove();
  // header/nav/footer를 문서 전체에서 지우면 article 내부의 섹션 제목까지 날아갈 수 있어,
  // 사이트 공통 chrome(body 직속)만 제거하고 본문 내부 구조는 보존한다.
  $("body > header, body > nav, body > footer").remove();

  const title = $('meta[property="og:title"]').attr("content")?.trim() || $("title").text().trim() || parsed.toString();

  let sourceName: string;
  try {
    sourceName = parsed.hostname;
  } catch {
    sourceName = "직접 등록한 페이지";
  }

  if (isYouTubeUrl(parsed)) {
    const desc = $('meta[property="og:description"]').attr("content")?.trim() || $('meta[name="description"]').attr("content")?.trim() || "";
    if (!desc || desc.trim().length < 20) {
      return { title, sourceName, content: "", youTubeUnsupported: true };
    }
    return { title, sourceName, content: desc.slice(0, MAX_STORED_CONTENT_CHARS) };
  }

  // 본문 root: main > article > body 순서로 고르되, 고른 영역이 최소 본문 길이에도
  // 못 미치면(장식용 main 등 지나치게 작은 영역) body로 되돌린다.
  let root = $("main").first();
  if (!root.length) root = $("article").first();
  if (!root.length || root.text().replace(/\s+/g, " ").trim().length < MIN_URL_CONTENT_LEN) {
    root = $("body");
  }

  const blocks: string[] = [];
  root.find(CONTENT_BLOCK_SELECTOR).each((_, el) => {
    const node = $(el);
    // li > p, td > p 처럼 블록 안에 블록이 중첩되면 바깥 블록의 text()가 안쪽 내용을 이미
    // 포함하므로, 블록 조상이 있는 요소는 건너뛰어 같은 문장이 두 번 저장되지 않게 한다.
    if (node.parents(CONTENT_BLOCK_SELECTOR).length > 0) return;
    const t = node.text().replace(/\s+/g, " ").trim();
    if (!t) return;
    if (blocks.length > 0 && blocks[blocks.length - 1] === t) return; // 완전히 동일한 인접 블록만 제거
    blocks.push(t);
  });

  // 문단 경계를 남기기 위해 한 칸 join이 아니라 줄바꿈으로 잇는다(Claude 발췌 품질에도 유리).
  let content = blocks.join("\n");
  // 블록 추출이 사실상 실패한 경우에만 root 전체 텍스트로 fallback.
  // (기존 코드는 <p>가 한 개라도 있으면 fallback이 영영 막혔다)
  if (content.trim().length < MIN_URL_CONTENT_LEN) {
    content = root.text().replace(/\s+/g, " ").trim();
  }
  return { title, sourceName, content: content.slice(0, MAX_STORED_CONTENT_CHARS) };
}

export interface UrlCollectOptions {
  // true면 같은 URL의 기존 자료를 "새로 fetch·추출·검증까지 전부 통과한 본문"으로 갱신한다.
  // fetch/추출/최소 길이 검증 중 하나라도 실패하면 이 함수는 그 지점에서 반환하므로
  // 기존 자료는 어떤 경우에도 덮어써지지 않는다.
  refresh?: boolean;
}

export async function collectFromUrlDetailed(rawUrl: string, opts?: UrlCollectOptions): Promise<UrlCollectItemResult> {
  // 앵커/기본 포트/추적 파라미터만 정리한 값을 저장·중복 판정 기준으로 삼는다(P1.9).
  // 실제 fetch도 이 값으로 수행해 저장된 주소와 가져온 주소가 항상 일치하게 한다.
  const url = canonicalizeArticleUrl((rawUrl || "").trim());
  if (!isValidHttpUrl(url)) {
    return { url, status: "invalid_url", statusLabel: URL_STATUS_LABELS.invalid_url, error: "http 또는 https URL만 입력할 수 있습니다." };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { url, status: "invalid_url", statusLabel: URL_STATUS_LABELS.invalid_url, error: "URL 형식이 올바르지 않습니다." };
  }

  if (UNSUPPORTED_EXTENSIONS.test(parsed.pathname)) {
    return {
      url,
      status: "unsupported_format",
      statusLabel: URL_STATUS_LABELS.unsupported_format,
      error: "PDF/이미지/동영상 등의 파일 URL은 v1에서 지원하지 않습니다.",
    };
  }

  const fetchResult = await safeFetchText(url);
  if (!fetchResult.ok) {
    switch (fetchResult.reason) {
      case "timeout":
        return { url, status: "timeout", statusLabel: URL_STATUS_LABELS.timeout, error: fetchResult.message };
      case "blocked_host":
        return { url, status: "forbidden", statusLabel: URL_STATUS_LABELS.forbidden, error: fetchResult.message };
      case "unsupported_content_type":
        return { url, status: "unsupported_format", statusLabel: URL_STATUS_LABELS.unsupported_format, error: fetchResult.message };
      case "response_too_large":
        return { url, status: "unsupported_format", statusLabel: URL_STATUS_LABELS.unsupported_format, error: fetchResult.message };
      case "invalid_url":
        return { url, status: "invalid_url", statusLabel: URL_STATUS_LABELS.invalid_url, error: fetchResult.message };
      case "http_error":
        if (fetchResult.status === 401) return { url, status: "login_required", statusLabel: URL_STATUS_LABELS.login_required, error: fetchResult.message };
        if (fetchResult.status === 403 || fetchResult.status === 429)
          return { url, status: "forbidden", statusLabel: URL_STATUS_LABELS.forbidden, error: fetchResult.message };
        return { url, status: "unreachable", statusLabel: URL_STATUS_LABELS.unreachable, error: fetchResult.message };
      case "too_many_redirects":
      case "network_error":
      default:
        return { url, status: "unreachable", statusLabel: URL_STATUS_LABELS.unreachable, error: fetchResult.message };
    }
  }

  const extracted = extractArticleFromHtml(parsed, fetchResult.text);
  const { title, sourceName, content } = extracted;

  if (extracted.youTubeUnsupported) {
    return {
      url,
      status: "unsupported_format",
      statusLabel: URL_STATUS_LABELS.unsupported_format,
      error: "YouTube 자막 추출은 지원하지 않으며, 제목/설명 정보도 충분히 가져오지 못했습니다.",
    };
  }

  if (content.trim().length < MIN_URL_CONTENT_LEN) {
    return {
      url,
      status: "insufficient_content",
      statusLabel: URL_STATUS_LABELS.insufficient_content,
      error: `추출된 본문이 너무 짧습니다 (${content.trim().length}자, 최소 ${MIN_URL_CONTENT_LEN}자 필요).`,
    };
  }

  const hash = computeDedupeHash(url, title);
  const result = insertMaterial({
    title,
    source_name: sourceName,
    source_url: url,
    source_type: "url",
    published_at: null,
    content,
    dedupe_hash: hash,
  });

  if (!result.inserted) {
    // 여기 도달했다는 것은 새 본문이 fetch·추출·최소 길이 검증을 이미 전부 통과했다는 뜻이다.
    // refresh 요청이면 기존 row를 제자리에서 갱신한다(id/dedupe_hash/source_url은 그대로 -
    // 이 자료를 참조하는 다른 데이터의 연결을 깨지 않기 위해 삭제 후 재등록하지 않는다).
    if (opts?.refresh) {
      const existingId = findMaterialIdByDedupeHash(hash);
      if (existingId !== null && updateMaterialContent(existingId, { title, content })) {
        return { url, status: "refreshed", statusLabel: URL_STATUS_LABELS.refreshed, materialId: existingId, title };
      }
    }
    return { url, status: "duplicate_existing", statusLabel: URL_STATUS_LABELS.duplicate_existing, error: "이미 등록된(중복된) 자료입니다.", title };
  }

  return { url, status: "extracted", statusLabel: URL_STATUS_LABELS.extracted, materialId: result.id, title };
}

// 여러 URL을 처리합니다. 하나가 실패해도 전체 작업은 계속 진행하며, 같은 요청 안에서 완전히 동일한 URL은 첫 건만 처리합니다.
export async function collectFromUrls(urls: string[], opts?: UrlCollectOptions): Promise<UrlCollectItemResult[]> {
  const seen = new Set<string>();
  const results: UrlCollectItemResult[] = [];
  for (const raw of urls) {
    const url = (raw || "").trim();
    if (!url) continue;
    // 같은 요청 안의 중복은 정규화한 주소로 판단한다. 표기만 다른 같은 문서(#앵커, 추적
    // 파라미터)를 두 번 내려받지 않기 위해서다. 정규화가 안 되는 값은 원문 그대로 비교한다.
    const dedupeKey = canonicalizeArticleUrl(url) || url;
    if (seen.has(dedupeKey)) {
      results.push({ url, status: "duplicate_input", statusLabel: URL_STATUS_LABELS.duplicate_input, error: "같은 요청 안에서 동일한 URL이 여러 번 입력되어 한 번만 처리합니다." });
      continue;
    }
    seen.add(dedupeKey);
    try {
      results.push(await collectFromUrlDetailed(url, opts));
    } catch (e: any) {
      results.push({ url, status: "unreachable", statusLabel: URL_STATUS_LABELS.unreachable, error: e?.message || String(e) });
    }
  }
  return results;
}

// 기존 자료함 화면(단일 URL 입력)과의 호환을 위해 유지합니다. 내부적으로 collectFromUrlDetailed를 사용합니다.
export async function collectFromUrl(url: string): Promise<{ success: boolean; error?: string }> {
  const r = await collectFromUrlDetailed(url);
  if (r.status === "extracted") return { success: true };
  return { success: false, error: r.error || r.statusLabel };
}

export function collectFromText(text: string, title?: string, sourceName?: string): { success: boolean; error?: string } {
  const cleanText = (text || "").trim();
  if (!cleanText) return { success: false, error: "본문이 비어 있습니다." };
  const finalTitle = (title || cleanText.slice(0, 40)).trim();
  const hash = computeDedupeHash(null, finalTitle + cleanText.slice(0, 100));
  const result = insertMaterial({
    title: finalTitle,
    source_name: sourceName || "직접 입력",
    source_url: "",
    source_type: "text",
    published_at: null,
    content: cleanText.slice(0, 4000),
    dedupe_hash: hash,
  });
  if (!result.inserted) return { success: false, error: "이미 등록된(중복된) 자료입니다." };
  return { success: true };
}

// ---------------- 키워드·주제 입력 ----------------
// 새 검색 API를 붙이지 않는다. 사용자가 입력한 키워드/주제 자체를 "자료 후보"로 등록해
// 근거 URL 없이도(경험/의견/질문/일반 조언 형태로) 글 생성 재료로 쓸 수 있게 한다.

export interface KeywordMaterialInput {
  keywords: string[]; // 이미 분리/트림/중복제거된 키워드 목록
  excludeKeywords: string[];
  note: string;
  candidateCount: number;
}

export interface KeywordMaterialResult {
  created: any[];
  skippedDuplicate: number;
}

const MAX_KEYWORD_CANDIDATES = 10;

export function buildKeywordMaterials(input: KeywordMaterialInput): KeywordMaterialResult {
  const created: any[] = [];
  let skippedDuplicate = 0;
  const cap = Math.max(1, Math.min(input.candidateCount || 3, MAX_KEYWORD_CANDIDATES));
  const chosen = input.keywords.slice(0, cap);

  for (const kw of chosen) {
    const title = `사용자 주제: ${kw}`;
    const content = input.note
      ? input.note
      : `"${kw}"에 대한 사용자 제공 주제입니다. 근거 URL이 없으므로 경험/의견/질문/일반적인 조언 형태로 작성해야 합니다.`;
    const meta = JSON.stringify({
      keywords: [kw],
      excludeKeywords: input.excludeKeywords,
      note: input.note,
      factBasis: "user_topic",
    });
    const hash = computeDedupeHash(null, `keyword:${kw}:${input.note}`);
    const result = insertMaterial({
      title,
      source_name: "사용자 입력 키워드",
      source_url: "",
      source_type: "keyword",
      published_at: null,
      content,
      dedupe_hash: hash,
      meta_json: meta,
    });
    if (result.inserted && result.id) {
      created.push(getMaterialById(result.id));
    } else {
      skippedDuplicate++;
    }
  }

  return { created, skippedDuplicate };
}
