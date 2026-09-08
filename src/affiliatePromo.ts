// src/affiliatePromo.ts
// "쿠파스 상품 홍보 모드" 전용 로직 - 입력 검증, 프롬프트 생성, 생성 결과 검증, 최종 본문 조립.
//
// 중요(요청서 기준 제약):
// - 쿠팡 API 연동을 하지 않습니다(이 파일은 오직 사용자가 화면에 직접 입력한 값만 다룹니다).
// - 쿠팡 상품 페이지를 자동 수집하거나 크롤링하지 않습니다.
// - 상품 이미지·영상을 다운로드하지 않습니다.
// - 사용자가 입력한 정보만 근거로 문구를 작성하도록 프롬프트에 명시합니다.

import { PersonaData } from "./database";
import { DraftFromClaude, buildPersonaStyleBlock } from "./claude";

export type UsageStatus = "used" | "not_used";

// 요청서 2)~6) 순서 그대로. 코드는 DB/프론트에서 안정적으로 참조할 수 있는 영문 식별자입니다.
export type PromotionStyle = "empathy" | "curiosity" | "solution" | "persona_fit" | "honest" | "short_punch";

export const PROMOTION_STYLES: PromotionStyle[] = ["empathy", "curiosity", "solution", "persona_fit", "honest", "short_punch"];

export const PROMOTION_STYLE_LABELS: Record<PromotionStyle, string> = {
  empathy: "생활 불편 공감형",
  curiosity: "첫 줄 궁금증형",
  solution: "문제 해결형",
  persona_fit: "이런 사람에게 맞는 상품형",
  honest: "장점과 주의점을 함께 쓰는 솔직형",
  short_punch: "짧은 한 방형",
};

/**
 * 제휴 프로그램. 상품이 어느 제휴 프로그램에서 왔는지에 따라 경제적 이해관계 고지문과
 * 프롬프트에 쓰는 프로그램 이름이 달라진다.
 *
 * 고지문은 각 플랫폼의 공식 문구를 그대로 쓴다 - 임의로 바꾸거나 줄이지 않는다.
 * foreignTerms 는 "다른 프로그램의 이름이 이 글에 새어 들어왔는가"를 막는 금칙어다.
 */
export type AffiliateProgram = "coupang" | "brandconnect";

interface AffiliateProgramSpec {
  /** 프롬프트에서 쓰는 프로그램 이름 */
  label: string;
  /** 공식 경제적 이해관계 고지문(기본값) */
  disclosureText: string;
  /** 이 프로그램 글에 절대 들어오면 안 되는 다른 프로그램의 명칭 */
  foreignTerms: string[];
}

const AFFILIATE_PROGRAMS: Readonly<Record<AffiliateProgram, AffiliateProgramSpec>> = {
  coupang: {
    label: "쿠팡 파트너스",
    disclosureText: "이 포스팅은 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다.",
    foreignTerms: ["네이버 쇼핑 커넥트", "쇼핑 커넥트", "브랜드커넥트"],
  },
  brandconnect: {
    label: "네이버 쇼핑 커넥트",
    disclosureText: "이 포스팅은 네이버 쇼핑 커넥트 활동의 일환으로, 판매 발생 시 수수료를 제공받습니다.",
    foreignTerms: ["쿠팡 파트너스", "쿠팡"],
  },
};

/** 상품 레이더 siteId -> 제휴 프로그램. 모르는 값은 기존 동작 그대로 쿠팡이다. */
export function affiliateProgramForSite(siteId: string | null | undefined): AffiliateProgram {
  return siteId === "brandconnect" ? "brandconnect" : "coupang";
}

export function affiliateProgramLabel(program: AffiliateProgram): string {
  return AFFILIATE_PROGRAMS[program].label;
}

/** 사용자가 고지문을 비워 두었을 때 채워 넣을 공식 기본 문구 */
export function defaultDisclosureText(program: AffiliateProgram): string {
  return AFFILIATE_PROGRAMS[program].disclosureText;
}

/**
 * 이 프로그램 글에 다른 제휴 프로그램의 명칭이 섞였으면 그 단어를 돌려준다(없으면 null).
 * 공백을 지운 뒤 비교해 "쿠팡  파트너스"처럼 띄어쓰기를 바꾼 우회도 잡는다.
 */
export function findForeignProgramTerm(text: string, program: AffiliateProgram): string | null {
  const flat = String(text || "").replace(/\s+/g, "");
  for (const term of AFFILIATE_PROGRAMS[program].foreignTerms) {
    if (flat.includes(term.replace(/\s+/g, ""))) return term;
  }
  return null;
}

// 기존 이름 유지(쿠팡 경로에서 그대로 쓰인다).
export const DEFAULT_DISCLOSURE_TEXT = AFFILIATE_PROGRAMS.coupang.disclosureText;

// Threads(Meta) 텍스트 게시물 공식 글자 수 제한. 기존 앱의 일반 글 생성 프롬프트는 "200~450자를
// 기본으로"라는 권장 문구만 두고 있었을 뿐 코드로 강제하는 상한이 없었으므로, 쿠파스 모드에서는
// 실제 플랫폼 상한을 명시적인 상수로 두고 이를 기준으로 발췌 예산을 계산합니다.
export const THREADS_BODY_MAX_CHARS = 500;

export const MAX_PRODUCT_NAME_CHARS = 200;
export const MAX_AFFILIATE_URL_CHARS = 2000;
export const MAX_FEATURES_CHARS = 4000;
export const MAX_TARGET_AUDIENCE_CHARS = 1000;
export const MAX_CAVEATS_CHARS = 1000;
export const MAX_EXTRA_NOTE_CHARS = 1000;
export const MAX_DISCLOSURE_CHARS = 500;

// "직접 사용하지 않음"을 선택했을 때 절대 쓰면 안 되는 표현(요청서 4번 그대로).
export const NOT_USED_BANNED_PHRASES = [
  "내가 써봤는데",
  "직접 사용해보니",
  "재구매했다",
  "며칠 써보니",
  "우리 집에서 사용 중이다",
  "효과를 직접 확인했다",
];

export interface AffiliateProductInput {
  productName: string;
  affiliateUrl: string;
  features: string;
  targetAudience: string; // 입력 없으면 빈 문자열
  caveats: string;
  usageStatus: UsageStatus;
  extraNote: string;
  disclosureText: string;
}

export interface AffiliateDraftFromClaude extends DraftFromClaude {
  promotion_style?: string;
}

// ---------- 표현 variation(6개 생성 1회당 하나) ----------
//
// persona(사용자가 설정한 말투)는 그대로 두고, 그 위에 아주 얕은 "표현 결"만 얹는다.
// [제휴글 6개 만들기]를 다시 누르면 다음 variation으로 넘어가, 같은 상품이라도 매번
// 똑같은 결로 6개가 나오지 않게 한다. 한 번의 6개 안에서는 같은 variation을 공유하고
// 관점만 6가지로 나뉜다.
//
// 여기서 바꾸는 것은 문장을 여는 방식과 리듬뿐이다 - 반말/경어체 같은 핵심 말투,
// 금지 표현, 사실 근거 규칙은 persona와 아래 원칙이 계속 정한다.
// 주의: variation guide 는 길이에 관여하지 않는다. "짧게", "간결하게" 같은 표현을 쓰면
// 모델이 본문 자체를 줄여 아래 길이 기준(원칙 8)과 충돌한다 - 실제로 그렇게 나왔다.
// 길이는 어느 variation에서든 원칙 8 하나로만 정한다.
export const AFFILIATE_TONE_VARIATIONS = [
  {
    key: "plain",
    label: "담백형",
    guide: [
      "이번 6개는 담백한 결로 쓴다.",
      "확인 가능한 사실을 차분하게 제시하고, 감탄이나 과장 없이 담담하게 끝낸다.",
      "질문을 남발하지 않는다 - 6개 중 질문으로 끝나는 글은 있어도 하나면 충분하다.",
      "담백하다는 것은 문장을 일찍 끊으라는 뜻이 아니다. 불필요한 수식만 덜어내고, 필요한 정보",
      "1~2개와 자연스러운 마무리는 그대로 담는다. 길이는 원칙 8을 그대로 따른다",
      "(일반 5개는 50~90자, 그중 60~70자 중심 / short_punch는 30~60자).",
    ].join("\n"),
  },
  {
    key: "question",
    label: "가벼운 질문형",
    guide: [
      "이번 6개는 독자에게 가볍게 말을 거는 결로 쓴다.",
      "각 글의 중간이나 마지막에 자연스러운 질문 1개 정도를 넣는다. 실제로 쓰는 문장이어야 한다",
      "(예: \"한번 볼래?\", \"이런 거 찾고 있었으면 참고.\"). 억지스러운 질문(예: '궁금하지 않음?'",
      "같은 어색한 조합)은 쓰지 않는다.",
      "질문을 넣는다고 해서 본문 자체를 줄이지 않는다 - 길이는 원칙 8을 그대로 지킨다.",
    ].join("\n"),
  },
  {
    key: "numbers",
    label: "숫자 먼저형",
    guide: [
      "이번 6개는 숫자를 앞세우는 결로 쓴다.",
      "가능한 글은 [상품 정보]에 있는 숫자(수량·평점·후기 수)로 첫 문장을 시작한다.",
      "예: \"후기 2,860개, 평점 4.87.\" / \"한 박스 60환 구성.\" 그 뒤에 설명을 이어 붙인다.",
      "숫자가 충분하지 않은 상품에서는 억지로 만들지 말고 평소대로 쓴다.",
    ].join("\n"),
  },
] as const;

export type AffiliateToneVariation = (typeof AFFILIATE_TONE_VARIATIONS)[number];

/** 순환 인덱스(0,1,2,0,...) -> variation. 범위를 벗어난 값도 안전하게 감싼다. */
export function affiliateToneVariationAt(index: number): AffiliateToneVariation {
  const n = AFFILIATE_TONE_VARIATIONS.length;
  const i = Number.isFinite(index) ? ((Math.trunc(index) % n) + n) % n : 0;
  return AFFILIATE_TONE_VARIATIONS[i];
}

// HTML/스크립트 입력 방어: 자유 텍스트 입력란에서 태그를 전부 제거합니다(다운스트림에서 앱 화면에
// 표시할 때는 기존 escapeHtml()로 한 번 더 방어되지만, 저장/프롬프트 단계에서도 태그를 남기지
// 않도록 서버에서 먼저 제거합니다).
export function stripHtmlTags(s: string): string {
  return s.replace(/<[^>]*>/g, "");
}

export type AffiliateValidationResult = { ok: true; value: AffiliateProductInput } | { ok: false; error: string };

// 입력 검증(요청서 2번). 실패하면 명확한 사유를 돌려주고, 성공하면 정리된 값을 돌려줍니다.
// 제휴 링크는 trim() 외에는 절대 가공하지 않습니다(축약·변경·재생성 금지).
export function validateAffiliateInput(body: any, program: AffiliateProgram = "coupang"): AffiliateValidationResult {
  const productName = typeof body?.productName === "string" ? stripHtmlTags(body.productName).trim() : "";
  if (!productName) return { ok: false, error: "상품명을 입력해주세요." };
  if (productName.length > MAX_PRODUCT_NAME_CHARS) return { ok: false, error: `상품명은 ${MAX_PRODUCT_NAME_CHARS}자 이하로 입력해주세요.` };

  const affiliateUrl = typeof body?.affiliateUrl === "string" ? body.affiliateUrl.trim() : "";
  if (!affiliateUrl) return { ok: false, error: "제휴 링크를 입력해주세요." };
  if (affiliateUrl.length > MAX_AFFILIATE_URL_CHARS) {
    return { ok: false, error: `제휴 링크는 ${MAX_AFFILIATE_URL_CHARS}자 이하로 입력해주세요.` };
  }
  let parsed: URL;
  try {
    parsed = new URL(affiliateUrl);
  } catch {
    return { ok: false, error: "제휴 링크가 올바른 URL 형식이 아닙니다." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "제휴 링크는 http 또는 https로 시작해야 합니다." };
  }

  const features = typeof body?.features === "string" ? stripHtmlTags(body.features).trim() : "";
  if (!features) return { ok: false, error: "상품 특징·장점을 입력해주세요." };
  if (features.length > MAX_FEATURES_CHARS) return { ok: false, error: `상품 특징·장점은 ${MAX_FEATURES_CHARS}자 이하로 입력해주세요.` };

  const targetAudience = typeof body?.targetAudience === "string" ? stripHtmlTags(body.targetAudience).trim() : "";
  if (targetAudience.length > MAX_TARGET_AUDIENCE_CHARS) {
    return { ok: false, error: `추천 대상은 ${MAX_TARGET_AUDIENCE_CHARS}자 이하로 입력해주세요.` };
  }

  const caveats = typeof body?.caveats === "string" ? stripHtmlTags(body.caveats).trim() : "";
  if (caveats.length > MAX_CAVEATS_CHARS) return { ok: false, error: `주의할 점·단점은 ${MAX_CAVEATS_CHARS}자 이하로 입력해주세요.` };

  const usageStatus = body?.usageStatus;
  if (usageStatus !== "used" && usageStatus !== "not_used") {
    return { ok: false, error: "직접 사용 여부를 선택해주세요." };
  }

  const extraNote = typeof body?.extraNote === "string" ? stripHtmlTags(body.extraNote).trim() : "";
  if (extraNote.length > MAX_EXTRA_NOTE_CHARS) return { ok: false, error: `추가 관점·말투는 ${MAX_EXTRA_NOTE_CHARS}자 이하로 입력해주세요.` };

  const disclosureRaw = typeof body?.disclosureText === "string" ? stripHtmlTags(body.disclosureText).trim() : "";
  // 비워 두면 이 상품이 속한 제휴 프로그램의 공식 문구가 기본값이다(사용자가 고친 값은 그대로 존중).
  const disclosureText = disclosureRaw || defaultDisclosureText(program);
  if (disclosureText.length > MAX_DISCLOSURE_CHARS) {
    return { ok: false, error: `고지 문구는 ${MAX_DISCLOSURE_CHARS}자 이하로 입력해주세요.` };
  }
  // 다른 제휴 프로그램의 고지문이 그대로 남아 있으면 생성 자체를 막는다 - 브랜드커넥트 글에
  // "쿠팡 파트너스"가 들어가는 경로를 여기서 완전히 차단한다.
  const foreignInDisclosure = findForeignProgramTerm(disclosureText, program);
  if (foreignInDisclosure) {
    return {
      ok: false,
      error: `이 상품은 ${affiliateProgramLabel(program)} 제휴 상품입니다. 고지 문구에 "${foreignInDisclosure}"을(를) 쓸 수 없습니다.`,
    };
  }

  return {
    ok: true,
    value: { productName, affiliateUrl, features, targetAudience, caveats, usageStatus, extraNote, disclosureText },
  };
}

// body에 제휴 링크 + 고지 문구를 붙이고 남는 예산(글자 수)을 계산합니다. Claude에게는 이 예산
// 안에서만 본문을 쓰도록 지시해, 최종 조립 결과가 THREADS_BODY_MAX_CHARS를 넘지 않게 합니다.
export function computeBodyBudget(input: AffiliateProductInput): number {
  const overhead = input.affiliateUrl.length + input.disclosureText.length + 4; // 줄바꿈 2쌍
  return Math.max(80, THREADS_BODY_MAX_CHARS - overhead);
}

function usageStatusBlock(input: AffiliateProductInput): string {
  if (input.usageStatus === "used") {
    return [
      "- 직접 사용 여부: 직접 사용함",
      "  다만 사용자가 입력하지 않은 구체적인 사용 경험(사용 기간, 상황, 느낀 점 등)은 절대 지어내지 않는다.",
      "  위 [상품 정보]에 실제로 적힌 특징·장점·주의점 범위 안에서만 서술한다.",
    ].join("\n");
  }
  const banned = NOT_USED_BANNED_PHRASES.map((p) => `"${p}"`).join(", ");
  return [
    "- 직접 사용 여부: 직접 사용하지 않음",
    `  절대 쓰면 안 되는 표현: ${banned} (이 표현들과 같은 뜻의 문장도 쓰지 않는다)`,
    "  대신 아래 방식으로 서술한다: 상품 정보에서 눈에 띄는 점 / 이런 조건으로 찾는 사람에게 비교 후보가 될 수 있음 /",
    "  구매 전 상세 정보와 후기를 확인할 필요가 있음 / 이런 용도로 찾는 사람에게 적합할 수 있음",
  ].join("\n");
}

// 쿠파스 상품 홍보 문구 6개(6가지 유형 각 1개)를 요청하는 프롬프트를 만듭니다.
export function buildAffiliatePromoPrompt(
  input: AffiliateProductInput,
  persona: PersonaData,
  program: AffiliateProgram = "coupang",
  variationIndex?: number
): string {
  // variationIndex를 주지 않으면 예전과 완전히 같은 프롬프트가 나온다(기존 호출부·테스트 보호).
  const variation = typeof variationIndex === "number" ? affiliateToneVariationAt(variationIndex) : null;
  const variationBlock = variation ? `\n[이번 회차 표현 결 - ${variation.label}]\n${variation.guide}\n` : "";
  const programLabel = affiliateProgramLabel(program);
  const bodyBudget = computeBodyBudget(input);
  // Threads 제휴글은 짧아야 읽힌다. 링크·고지문 자리를 뺀 예산(bodyBudget)은 상한일 뿐이라,
  // 예전에는 모델이 그 상한(400자대)까지 채워 블로그 리뷰 같은 긴 글이 나왔다. 실제 목표
  // 길이를 따로 정하고, 상한도 그보다 낮은 값으로 다시 조인다.
  const bodyMax = Math.min(100, bodyBudget);
  const featuresBlock = input.features
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => "  - " + s)
    .join("\n");

  const styleList = PROMOTION_STYLES.map((code, i) => `${i + 1}. ${code} (${PROMOTION_STYLE_LABELS[code]})`).join("\n");

  return `당신은 한국어 Threads(스레드)에 올릴 ${programLabel} 상품 홍보 문구를 쓰는 사람입니다.
아래에 주어진 현재 채널 말투 설정 그대로 작성합니다. 다만 확인되지 않은 개인 경험이나
행동은 만들어내지 않습니다.
아래 [상품 정보]만 근거로, 서로 다른 6가지 유형의 홍보 문구를 정확히 6개 작성해 JSON으로만
응답하세요. 설명이나 인사말, 코드블록 표시(\`\`\`) 없이 순수 JSON 객체 하나만 출력합니다.

${buildPersonaStyleBlock(persona, { omit: ["length_preference", "allow_question_ending", "allow_external_links"] })}
${variationBlock}
[상품 정보 - 이것만 근거로 작성한다. 여기 없는 가격/할인율/재고/판매량/순위/후기/평점은 절대 만들지 않는다]
- 상품명: ${input.productName}
- 특징·장점:
${featuresBlock || "  (입력 없음)"}
- 추천 대상: ${input.targetAudience || "(입력 없음 - 특정 대상을 단정하지 말 것)"}
- 주의할 점·단점: ${input.caveats || "(입력 없음)"}
${usageStatusBlock(input)}
- 추가 관점·원하는 말투: ${input.extraNote || "(입력 없음)"}

[반드시 만들어야 할 6가지 유형 - 각각 정확히 1개씩, 아래 코드(promotion_style)를 그대로 사용]
${styleList}
1번 empathy: 가벼운 일상형. 겪은 일을 지어내지 말고, 독자에게 건네는 조건 제시("이런 걸
   찾고 있었다면")나 가벼운 질문으로 시작한 뒤 상품 정보를 붙인다. "찾는 사람이 많다",
   "꾸준히 있다"처럼 다른 사람들의 수요를 단정하는 문장은 쓰지 않는다.
2번 curiosity: 발견형. 상품 정보 중 가장 먼저 눈에 걸리는 항목 하나를 그대로 앞에 놓는다.
   내가 발견한 경위(어디서 봤다, 찾아봤다)를 지어내지 않는다.
3번 solution: 특징 하나 집중형. [상품 정보]의 특징 중 딱 하나만 골라 그것만 말한다.
4번 persona_fit: 비교/선택 고민형. "이런 조건으로 고르는 중이면 후보가 될 수 있다" 식으로 쓴다.
5번 honest: 숫자/후기형. 평점·후기 수·수량처럼 [상품 정보]에 실제로 있는 숫자를 중심에 두고,
   주의할 점이 입력돼 있으면 함께 적는다.
6번 short_punch: 짧은 질문형. 가장 짧게 쓰고, 질문 한 줄로 끝낸다.

[6개 사이의 차이 - 표현만 바꾼 같은 글을 만들지 않는다]
- 첫 문장(hook)이 서로 겹치지 않게 한다. 같은 단어로 시작하는 글이 두 개 있으면 안 된다.
- 문단 구조를 6개가 똑같이 반복하지 않는다(설명 → 특징 나열 → 권유 형태의 반복 금지).
- 마무리 문장도 서로 다르게 쓴다. 같은 결론 문구를 여러 글에 재사용하지 않는다.
- 6개가 각각 다른 정보를 앞세운다 - 모든 글이 같은 특징을 첫머리에 두지 않는다.

[말투 - 위 6가지 유형보다 우선한다]
A. 6개 모두 위 채널 말투 설정의 "말투 설명"을 그대로 따른다. 상품 종류나 홍보 목적 때문에
   말투를 바꾸지 않는다. 블로그 리뷰체, 체험단 후기체, 판매원·상담원 말투로 쓰지 않는다.
B. 말투 설명이 반말이면 6개 전부 반말로, 경어체면 6개 전부 경어체로 끝까지 유지한다.
   한 글 안에서 반말과 경어체를 섞지 않는다.
C. 말투 설명이 반말인데 아래 같은 표현이 나오면 잘못된 것이다:
   "추천드려요", "찾고 계셨다면", "~인데요", "~하시면 좋습니다", "이런 분들에게 추천합니다",
   "참고할 정보는 꽤 있는 편입니다" 같은 경어체 홍보 문장.
D. "[상품 정보]에 없는 말"과 마찬가지로, 말투도 사용자가 정한 것이 기준이다.
E. 말투를 지키되, 사용자가 실제로 했다고 확인되지 않은 개인 경험·행동은 만들어내지 않는다.
   금지 예: "서랍 정리하다가 발견했다", "타임라인 보다가 눈에 띄었다", "궁금해서 더 찾아봤다",
   "내가 먹어봤는데", "써보니", "챙겨 먹고 있다", "직접 비교해봤다" 같은 서술.
   1인칭 말투라도 "무엇을 했다"는 사건을 지어내지 않는다.
F. 대신 [상품 정보]에서 확인되는 사실이나, 독자에게 건네는 조건 제시로 시작한다.
   예: "후기 숫자부터 눈에 들어옴." / "한 박스 60환 구성." / "평점 4.87, 후기 2,860개." /
   "이런 제품 찾고 있었다면 한번 비교해볼 만함."
G-0. 한국어 Threads에서 실제로 쓰는 짧은 문장으로 쓴다. 비유를 길게 풀어 설명하거나, 뜻이
   모호한 수식을 붙이지 않는다(예: "이 개수 하나만으로도 얼마나 채워졌는지 가늠하기 쉬움"처럼
   에둘러 설명하는 문장, "궁금하지 않음?"처럼 어색하게 조립한 질문은 쓰지 않는다).
   소리 내어 읽었을 때 어색하면 더 단순한 문장으로 바꾼다.
G. 개인 경험과 마찬가지로, [상품 정보]에 근거가 없는 시장 반응·인기·수요도 만들어내지 않는다.
   금지 예: "이런 제품 찾는 사람 꾸준히 있음", "요즘 많이 찾음", "인기 있는 제품",
   "사람들이 많이 고름", "요즘 뜨는 제품", "판매량이 늘고 있음" 같은 서술.
   후기 수·평점처럼 [상품 정보]에 실제로 있는 값이 근거일 때만, 그 숫자 자체를 그대로 말한다
   (예: "후기 2,860개" - 이것을 "인기가 많다"로 바꿔 말하지 않는다).
H. 숫자를 크다/작다로 평가하지 않는다. [상품 정보]에 비교 대상이 없으므로 "많은 편", "높은 편"
   같은 상대평가는 근거가 없다. 금지 예: "후기 많음", "많은 편", "평점 높은 편", "인기 많음",
   "반응 좋은 편", "잘 팔리는 제품". 숫자는 숫자 그대로만 쓴다
   (예: "후기 2,860개, 평점 4.87." / "후기가 2,860개 쌓여 있음.").

[글 작성 원칙 - 반드시 준수]
1. 한국어로 작성한다.
2. 6개는 반드시 서로 달라야 하며, 첫 문장(hook)이 서로 겹치지 않게 한다.
3. 같은 표현이나 문장 구조를 반복하지 않는다.
4. "무조건 사세요", "지금 안 사면 후회합니다"처럼 과도하게 구매를 강요하는 표현을 쓰지 않는다.
5. 위 [상품 정보]에 없는 가격, 할인율, 재고, 판매량, 순위, 후기, 평점을 절대 만들어내지 않는다.
6. 해시태그를 과도하게 달지 않는다(0~2개 이내).
7. body에는 상품 링크나 "${programLabel}"/수수료 관련 고지 문구를 절대 포함하지 않는다 - 프로그램이
   최종 게시글의 맨 앞에는 고지 문구를, 맨 뒤에는 링크를 자동으로 덧붙이므로, body에는 상품
   소개 문구만 작성한다.
8. body는 공백 포함 최대 ${bodyMax}자 이내로 작성한다. 길이는 어떤 표현 결에서든 이 원칙
   하나로만 정한다 - 위 표현 결 지시는 길이를 바꾸지 않는다(링크·고지 문구는 별도 자동
   추가되며, 합쳐서 Threads 게시물 길이 제한 ${THREADS_BODY_MAX_CHARS}자를 지키기 위한 예산이다).
8-1. short_punch를 뺀 5개는 50~90자 범위로 쓰고, 그중에서도 60~75자를 중심으로 맞춘다.
   권장 상한은 90자이고 꼭 필요할 때만 ${bodyMax}자까지 간다. 40자 안팎에서 끊지 말고,
   상품 정보에서 고른 핵심 1~2개를 자연스럽게 풀어 이 범위에 들어오게 한다.
8-2. short_punch만 30~60자로 더 짧게 쓴다.
8-3. 억지로 늘리려고 없는 정보를 덧붙이거나 같은 말을 반복하지 않는다(최소 글자 수를
   기계적으로 검사하지는 않는다).
8-4. 한 문장에 정보를 몰아넣지 않고, 문단도 한두 줄로 끊는다.
8-5. 상품명·특징·숫자를 전부 넣으려 하지 않는다. 핵심 정보 1~2개만 골라 끝낸다.
   상품 상세페이지를 다시 요약한 것 같은 설명문을 쓰지 않는다. 넣지 않은 정보는 독자가
   상세페이지에서 확인하면 된다.
8-6. 상품 정보에 없는 효능·증상·신체 상태를 상품과 연결하지 않는다. 피로, 컨디션 저하, 통증,
   질병, 회복, 개선, 치료 같은 말을 끌어와 "이럴 때 이 상품" 식의 인과를 만들지 않는다.
   (예: "오후에 축 처질 때 ○○" 같은 문장 금지) 성분·구성·수량·평점·후기처럼 [상품 정보]에서
   확인 가능한 사실만 쓴다.
9. source_title은 "${input.productName}", source_url은 빈 문자열("")로 채운다(실제 링크는
   프로그램이 별도로 삽입한다).
10. topic 필드에는 해당 글의 promotion_style에 대응하는 한국어 유형명을 그대로 적는다.

[출력 형식 - 이 JSON 스키마를 정확히 따르세요]
{
  "posts": [
    {
      "promotion_style": "6가지 코드 중 하나(empathy/curiosity/solution/persona_fit/honest/short_punch)",
      "title": "관리용 제목(내부 식별용, 짧게)",
      "hook": "첫 문장",
      "body": "Threads 본문(링크·고지 문구 제외, 일반 유형 60~75자 중심·최대 ${bodyMax}자, short_punch 30~60자)",
      "topic": "위 유형에 대응하는 한국어 이름",
      "source_title": "${input.productName}",
      "source_url": "",
      "source_summary": "이 글이 강조한 특징 요약",
      "confidence": "high 또는 medium 또는 low",
      "risk_notes": "주의사항이 있으면 적고, 없으면 빈 문자열"
    }
  ]
}

posts 배열에는 정확히 6개를 담고, promotion_style 6가지 코드가 각각 정확히 한 번씩만 나오게
하세요. JSON 외의 다른 텍스트는 절대 출력하지 마세요.`;
}

export function containsBannedUsagePhrase(text: string): string | null {
  const found = NOT_USED_BANNED_PHRASES.find((phrase) => text.includes(phrase));
  return found || null;
}

export type PostsValidationResult = { ok: true } | { ok: false; error: string };

// Claude 응답을 저장하기 전에 반드시 통과해야 하는 검증(요청서 3·4번). 하나라도 걸리면 배치
// 전체를 실패로 처리합니다(일부만 저장하지 않음 - 실제 저장은 이 검증을 통과한 뒤에만 진행됨).
export function validateGeneratedPosts(posts: AffiliateDraftFromClaude[] | null | undefined, input: AffiliateProductInput): PostsValidationResult {
  if (!Array.isArray(posts) || posts.length !== 6) {
    return { ok: false, error: `Claude가 정확히 6개를 반환하지 않았습니다(받은 개수: ${Array.isArray(posts) ? posts.length : 0}개).` };
  }

  const bodyBudget = computeBodyBudget(input);
  const seenStyles = new Set<string>();
  const seenHooks = new Set<string>();

  for (const p of posts) {
    if (!p || typeof p.body !== "string" || !p.body.trim()) {
      return { ok: false, error: "일부 글의 본문이 비어 있습니다." };
    }
    if (typeof p.hook !== "string" || !p.hook.trim()) {
      return { ok: false, error: "일부 글의 첫 문장(hook)이 비어 있습니다." };
    }

    const style = p.promotion_style as PromotionStyle | undefined;
    if (!style || !PROMOTION_STYLES.includes(style)) {
      return { ok: false, error: `알 수 없는 생성 유형(promotion_style)이 포함되어 있습니다: ${style}` };
    }
    if (seenStyles.has(style)) {
      return { ok: false, error: `생성 유형이 중복되었습니다: ${PROMOTION_STYLE_LABELS[style]}` };
    }
    seenStyles.add(style);

    const hookKey = p.hook.trim().toLowerCase();
    if (seenHooks.has(hookKey)) {
      return { ok: false, error: "첫 줄(hook)이 서로 겹치는 글이 있습니다." };
    }
    seenHooks.add(hookKey);

    if (input.usageStatus === "not_used") {
      const banned = containsBannedUsagePhrase(p.body) || containsBannedUsagePhrase(p.hook);
      if (banned) {
        return { ok: false, error: `"직접 사용하지 않음" 설정인데 금지된 표현이 포함되었습니다: "${banned}"` };
      }
    }

    if (p.body.length > bodyBudget + 50) {
      return { ok: false, error: `본문이 너무 깁니다(${p.body.length}자, 예산 ${bodyBudget}자). Threads 게시물 길이 제한을 넘습니다.` };
    }
  }

  if (seenStyles.size !== PROMOTION_STYLES.length) {
    return { ok: false, error: "6가지 생성 유형이 모두 포함되지 않았습니다." };
  }

  return { ok: true };
}

// 최종 게시 본문 = 고지 문구(맨 앞) + Claude 생성 본문 + 제휴 링크(맨 뒤, 원문 그대로), 각각
// 별도 줄. 고지 문구가 body의 첫 글자부터 시작해야 하므로(공백·빈 줄·제목·이모지·후킹 문구를
// 앞에 절대 두지 않음) 템플릿 리터럴의 맨 앞에 직접 둡니다. disclosureText 자체는
// validateAffiliateInput()에서 이미 trim()되어 있어 앞뒤 공백이 없습니다.
// 제휴 링크는 여기서도 어떤 가공도 하지 않습니다(축약·변경·재생성 금지) - 항상 맨 마지막 줄.
// Claude가 지시를 어기고 body 안에 링크나 고지 문구를 그대로 적어 넣은 경우에 대비해, 중복
// 노출을 막기 위해 body 안의 동일 문자열만 제거한 뒤(링크·고지 문구 값 자체는 바꾸지 않음)
// 정해진 위치에 새로 덧붙입니다.
export function composeAffiliateBody(claudeBody: string, input: AffiliateProductInput): string {
  const withoutInlineExtras = claudeBody
    .split(input.affiliateUrl)
    .join("")
    .split(input.disclosureText)
    .join("")
    .trim();
  return `${input.disclosureText}\n\n${withoutInlineExtras}\n\n${input.affiliateUrl}`;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  for (;;) {
    const found = haystack.indexOf(needle, idx);
    if (found === -1) break;
    count++;
    idx = found + needle.length;
  }
  return count;
}

export type ComposedBodyValidationResult = { ok: true } | { ok: false; error: string };

// composeAffiliateBody()가 만든 최종 본문이 실제로 규칙을 지켰는지 서버가 다시 한번 확인합니다
// (요청서 8번) - 고지 문구로 시작, 제휴 링크로 끝, 둘 다 정확히 1번씩만 포함. 이 검증에 실패하면
// 호출부(routes/affiliate.ts)가 해당 배치 전체를 실패로 처리하고 DB에 저장하지 않습니다.
export function validateComposedBody(body: string, input: AffiliateProductInput, program: AffiliateProgram = "coupang"): ComposedBodyValidationResult {
  if (!body.startsWith(input.disclosureText)) {
    return { ok: false, error: "본문이 고지 문구로 시작하지 않습니다." };
  }
  if (!body.trimEnd().endsWith(input.affiliateUrl)) {
    return { ok: false, error: "본문이 제휴 링크로 끝나지 않습니다." };
  }
  if (countOccurrences(body, input.disclosureText) !== 1) {
    return { ok: false, error: "고지 문구가 본문에 정확히 1번 포함되지 않았습니다." };
  }
  if (countOccurrences(body, input.affiliateUrl) !== 1) {
    return { ok: false, error: "제휴 링크가 본문에 정확히 1번 포함되지 않았습니다." };
  }
  // 마지막 방어선: Claude 가 다른 제휴 프로그램의 이름을 본문에 적어 넣었으면 배치 전체를
  // 실패시킨다(호출부가 DB에 아무것도 저장하지 않는다). 고지문 검증과 별개로, 최종 게시
  // 본문 어디에도 다른 프로그램 명칭이 남지 않게 하는 자리다.
  const foreignInBody = findForeignProgramTerm(body, program);
  if (foreignInBody) {
    return { ok: false, error: `${affiliateProgramLabel(program)} 제휴글에 "${foreignInBody}" 문구가 포함되었습니다.` };
  }
  return { ok: true };
}
