// src/productRadar/threadsCopyClaudeContract.ts
// 상품 레이더 Phase 12.5.2.1: Threads Copy Claude Output Contract(순수 validation only,
// DB/Claude/Express 없음).
//
// 이 파일은 Claude를 호출하지 않는다 - 이미 JSON.parse된 unknown value(outer/inner 파싱은
// threadsCopyClaude.ts 몫)를 받아 "Claude가 { posts: [{hook, body}] } shape를 정확히
// 지켰는가"만 exact-allowlist로 검증한다. lineage/language 확인이나 canonical result 조립은
// 이 파일 책임이 아니다(threadsCopy.ts 몫, 요청서 36절 - pure validation only).

export interface ProductRadarThreadsCopyClaudePost {
  readonly hook: string;
  readonly body: string;
}

export type ProductRadarThreadsCopyClaudeContractResult =
  | { ok: true; posts: readonly ProductRadarThreadsCopyClaudePost[]; errors: readonly [] }
  | { ok: false; posts: null; errors: readonly string[] };

const TOP_LEVEL_ALLOWED_KEYS: ReadonlySet<string> = new Set(["posts"]);
// hook/body 정확히 두 key만 - title/topic/productIds/evidenceFields/provenance/language/
// recommendation/affiliateUrl/url/disclosure/promotionStyle/score/rank/winner 등은 전부
// unknown key로 거부된다(요청서 9절).
const POST_ALLOWED_KEYS: ReadonlySet<string> = new Set(["hook", "body"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function hasOnlyAllowedKeys(obj: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(obj).every((key) => allowed.has(key));
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function reject(): ProductRadarThreadsCopyClaudeContractResult {
  return { ok: false, posts: null, errors: ["threads_copy_claude_output_invalid"] };
}

// posts는 정확히 1개, hook/body 둘 다 string이며 trim 후 non-empty여야 한다(요청서 10절).
// 0개/2개 이상/빈 문자열/공백만/숫자/null/array/object 전부 거부 - partial salvage 없음
// (요청서 10절 마지막 줄).
export function validateProductRadarThreadsCopyClaudeOutput(value: unknown): ProductRadarThreadsCopyClaudeContractResult {
  if (!isPlainObject(value)) return reject();
  if (!hasOnlyAllowedKeys(value, TOP_LEVEL_ALLOWED_KEYS)) return reject();
  if (!Array.isArray(value.posts) || value.posts.length !== 1) return reject();

  const rawPost = value.posts[0];
  if (!isPlainObject(rawPost)) return reject();
  if (!hasOnlyAllowedKeys(rawPost, POST_ALLOWED_KEYS)) return reject();
  if (!isNonEmptyString(rawPost.hook) || !isNonEmptyString(rawPost.body)) return reject();

  return { ok: true, posts: [{ hook: rawPost.hook, body: rawPost.body }], errors: [] };
}
