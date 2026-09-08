// src/productPost.ts
// 상품 레이더에 저장된 상품 1개로 만드는 "일반 상품 소개글"(비제휴).
//
// 쿠파스(제휴) 경로와 완전히 분리되어 있습니다 - affiliatePromo.ts 를 재사용하지 않습니다.
// 제휴가 아니므로:
//   * 쿠팡 파트너스 고지문을 붙이지 않습니다.
//   * affiliate_url 을 만들거나 요구하지 않습니다.
//   * 본문 끝에 붙는 링크는 저장된 상품의 product_url 하나뿐입니다.
//
// 근거가 되는 상품 정보는 전부 product_radar_products 에 이미 저장된 값입니다 - 화면이 보낸
// 값을 쓰지 않습니다(호출부가 productId 로 DB 에서 다시 읽어 넘깁니다).

import { buildPersonaStyleBlock } from "./claude";
import { ProductRadarProduct } from "./productRadar/types";

/** Threads 본문 상한 - 조립 결과가 이 값을 넘지 않도록 Claude 예산을 잡는다. */
const THREADS_BODY_MAX_CHARS = 500;
const POST_COUNT = 6;
const MAX_EXTRA_NOTE_CHARS = 500;

export interface ProductPostInput {
  productId: number;
  productName: string;
  productUrl: string;
  /** 사용자가 덧붙인 관점/말투 메모(선택) */
  extraNote: string;
  /** 프롬프트 근거로 쓸 저장된 사실값 - 없는 값은 넣지 않는다(추측 금지) */
  facts: string[];
}

export interface ProductPostFromClaude {
  title?: string;
  hook?: string;
  body?: string;
  topic?: string;
}

/**
 * 게시될 링크는 저장된 상품 URL 하나로 고정한다.
 * canonicalUrl 이 있으면 그것을, 없으면 sourceUrl 에서 추적 파라미터를 떼고 쓴다
 * (검색 유입 파라미터가 그대로 게시되지 않도록 - 상품 자체는 동일하다).
 */
export function resolveProductPostUrl(product: ProductRadarProduct): string | null {
  const raw = product.canonicalUrl || product.sourceUrl;
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.origin + u.pathname.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/** 저장된 값 중 실제로 있는 것만 사실 목록으로 만든다 - 없는 값은 아예 넣지 않는다. */
export function buildProductFacts(product: ProductRadarProduct): string[] {
  const facts: string[] = [];
  const won = (n: number) => n.toLocaleString("ko-KR") + "원";
  if (product.brand) facts.push(`브랜드: ${product.brand}`);
  if (product.category) facts.push(`카테고리: ${product.category}`);
  if (typeof product.price === "number") facts.push(`판매가: ${won(product.price)}`);
  if (typeof product.originalPrice === "number") facts.push(`정가: ${won(product.originalPrice)}`);
  if (typeof product.conditionalPrice === "number") {
    facts.push(`${product.conditionalPriceLabel || "조건부 가격"}: ${won(product.conditionalPrice)}`);
  }
  if (typeof product.rating === "number") facts.push(`평점: ${product.rating}`);
  if (typeof product.reviewCount === "number") facts.push(`리뷰 수: ${product.reviewCount.toLocaleString("ko-KR")}개`);
  if (typeof product.shippingFee === "number") {
    facts.push(product.shippingFee === 0 ? "배송비: 무료배송" : `배송비: ${won(product.shippingFee)}`);
  }
  if (product.shippingType) facts.push(`배송 방식: ${product.shippingType}`);
  if (product.optionName) facts.push(`옵션: ${product.optionName}`);
  return facts;
}

export type ProductPostValidation = { ok: true; value: ProductPostInput } | { ok: false; error: string };

/** 상품 자체가 글을 만들 수 있는 상태인지 확인한다(상품명 + 링크가 반드시 필요). */
export function validateProductPostInput(product: ProductRadarProduct, extraNoteRaw: unknown): ProductPostValidation {
  if (!product.productName || !product.productName.trim()) {
    return { ok: false, error: "저장된 상품명이 없어 상품글을 만들 수 없습니다." };
  }
  const productUrl = resolveProductPostUrl(product);
  if (!productUrl) {
    return { ok: false, error: "저장된 상품 주소가 없어 상품글을 만들 수 없습니다." };
  }
  const extraNote = typeof extraNoteRaw === "string" ? extraNoteRaw.replace(/<[^>]*>/g, "").trim().slice(0, MAX_EXTRA_NOTE_CHARS) : "";
  return {
    ok: true,
    value: { productId: product.id, productName: product.productName.trim(), productUrl, extraNote, facts: buildProductFacts(product) },
  };
}

/** 링크·고지문이 차지할 자리를 뺀 본문 예산 */
export function computeProductPostBodyBudget(input: ProductPostInput): number {
  const overhead = input.productUrl.length + 2; // 줄바꿈 1쌍
  return Math.max(120, THREADS_BODY_MAX_CHARS - overhead);
}

export function buildProductPostPrompt(input: ProductPostInput, persona: any): string {
  const factsBlock = input.facts.length ? input.facts.map((f) => "  - " + f).join("\n") : "  (저장된 부가 정보 없음)";
  const budget = computeProductPostBodyBudget(input);

  return `당신은 한국어 Threads(스레드)에 올릴 상품 소개 글을 쓰는 카피라이터입니다.
아래 [상품 정보]만 근거로 서로 다른 소개 글을 정확히 ${POST_COUNT}개 작성해 JSON으로만 응답하세요.
설명이나 인사말, 코드블록 표시(\`\`\`) 없이 순수 JSON 객체 하나만 출력합니다.

${buildPersonaStyleBlock(persona, { omit: ["allow_external_links"] })}

[상품 정보 - 이것만 근거로 작성한다. 여기 없는 가격/할인율/재고/판매량/순위/후기/평점은 절대 만들지 않는다]
- 상품명: ${input.productName}
${factsBlock}
${input.extraNote ? `- 추가 관점·말투: ${input.extraNote}` : ""}

[반드시 지킬 것]
1. 본문(body)에 URL, 링크, "링크는 아래", "아래 링크" 같은 표현을 절대 쓰지 마세요.
   링크는 프로그램이 본문 뒤에 자동으로 붙입니다.
2. 제휴/수수료/광고 고지 문구를 쓰지 마세요. 이 글은 제휴 글이 아닙니다.
3. 직접 사용해봤다는 표현("직접 써보니", "제가 써봤는데")을 쓰지 마세요. 사용 경험이 없습니다.
4. 위 [상품 정보]에 없는 사실을 지어내지 마세요.
5. 각 글의 첫 문장은 서로 겹치지 않게 하세요.
6. 각 body 는 ${budget}자 이하로 씁니다.

[출력 형식 - 이 JSON 구조 그대로]
{"posts":[{"title":"짧은 제목","hook":"첫 문장","body":"본문 전체","topic":"주제 한 단어"}]}
posts 배열의 길이는 정확히 ${POST_COUNT} 이어야 합니다.`;
}

const URL_RE = /https?:\/\/[^\s]+/g;
const DISCLOSURE_RE = /쿠팡\s*파트너스|수수료를\s*제공받/;

export type ProductPostsValidation = { ok: true } | { ok: false; error: string };

/** Claude 출력 검증 - 개수/본문/금지사항만 본다(제휴 유형 검사 없음). */
export function validateGeneratedProductPosts(posts: ProductPostFromClaude[]): ProductPostsValidation {
  if (!Array.isArray(posts) || posts.length !== POST_COUNT) {
    return { ok: false, error: `상품 소개 글 ${POST_COUNT}개가 생성되지 않았습니다.` };
  }
  const firstLines = new Set<string>();
  for (const p of posts) {
    const body = (p.body || "").trim();
    if (!body) return { ok: false, error: "본문이 비어 있는 글이 있습니다." };
    if (URL_RE.test(body)) { URL_RE.lastIndex = 0; return { ok: false, error: "본문에 링크가 포함됐습니다. 링크는 프로그램이 붙입니다." }; }
    URL_RE.lastIndex = 0;
    if (DISCLOSURE_RE.test(body)) return { ok: false, error: "제휴 글이 아닌데 제휴 고지 문구가 포함됐습니다." };
    const first = body.split("\n")[0].trim();
    if (firstLines.has(first)) return { ok: false, error: "첫 문장이 겹치는 글이 있습니다." };
    firstLines.add(first);
  }
  return { ok: true };
}

/**
 * 최종 본문 = Claude 본문 + 빈 줄 + 상품 URL.
 * 고지 문구를 붙이지 않습니다(제휴 글이 아님). Claude 가 실수로 URL 을 넣었더라도 그 문자열만
 * 제거한 뒤 정해진 위치에 상품 URL 하나만 붙입니다.
 */
export function composeProductPostBody(claudeBody: string, input: ProductPostInput): string {
  const cleaned = String(claudeBody || "").replace(URL_RE, "").replace(/[ \t]+\n/g, "\n").trim();
  return `${cleaned}\n\n${input.productUrl}`;
}

/** 조립 결과 재확인 - URL 은 상품 URL 하나뿐이고 맨 끝에 있어야 한다(요청서 10절). */
export function validateComposedProductPostBody(body: string, input: ProductPostInput): ProductPostsValidation {
  const urls = body.match(URL_RE) || [];
  if (urls.length !== 1) return { ok: false, error: `본문의 링크가 정확히 1개가 아닙니다(${urls.length}개).` };
  if (urls[0] !== input.productUrl) return { ok: false, error: "본문의 링크가 저장된 상품 주소와 다릅니다." };
  if (!body.trimEnd().endsWith(input.productUrl)) return { ok: false, error: "본문이 상품 링크로 끝나지 않습니다." };
  if (DISCLOSURE_RE.test(body)) return { ok: false, error: "제휴 고지 문구가 포함됐습니다." };
  return { ok: true };
}

export const PRODUCT_POST_COUNT = POST_COUNT;
