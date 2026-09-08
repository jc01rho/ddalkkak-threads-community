// src/productRadar/recommendationClaudeContract.ts
// 상품 레이더 Phase 12.2: Claude Output Contract + Evidence Trace Validator(순수 domain,
// DB/Claude 없음).
//
// 이 파일은 Claude를 호출하지 않는다 - 이미 JSON.parse된 unknown object(Claude가 실제로
// 뭐라고 답했는지는 Phase 12.3의 CLI invocation/parser 몫)를 받아, "Claude가 이 shape를
// 정확히 지켰는가"만 strict하게 검증하고, 통과하면 host가 provenance를 강제 주입하고
// missingInformation을 결정론적으로 만들어 기존 buildRecommendationResult()에 그대로
// 넘긴다. evidence path의 실존/null/comparability 검증은 여기서 다시 하지 않는다 -
// buildRecommendationResult()가 이미 그 책임을 진다(recommendation.ts 참고, 로직 중복
// 없음).
//
// 순수 domain layer다 - database.ts/comparisonPersistence.ts/recommendationPersistence.ts를
// import하지 않는다(live product 재조회 금지). Express/Claude CLI/network/filesystem
// 의존성도 없다. JSON.parse, outer {type,result} envelope decoding, markdown fence
// stripping 같은 Claude CLI raw output 파싱은 Phase 12.3 몫이다 - 이 파일의 입력은 항상
// 이미 parse된 JS object(또는 malformed하면 다른 타입)다.

import { ComparisonSnapshot } from "./types";
import { buildRecommendationEvidencePayload } from "./recommendationEvidence";
import { buildRecommendationResult, RecommendationBuildResult, RecommendationMissingInformation } from "./recommendation";

const CLAUDE_TOP_LEVEL_ALLOWED_KEYS: ReadonlySet<string> = new Set(["products"]);
const CLAUDE_PRODUCT_ALLOWED_KEYS: ReadonlySet<string> = new Set(["productId", "strengths", "cautions"]);
// provenance는 의도적으로 여기 없다(요청서 23절) - Claude가 provenance를 출력하면 그
// 자체로 unknown-key 위반이 되어 거부된다. Claude가 comparison_engine/manual_override/
// claude_inference 중 무엇을 자칭하든 이 계약을 통과할 방법이 구조적으로 없다.
const CLAUDE_STATEMENT_ALLOWED_KEYS: ReadonlySet<string> = new Set(["text", "evidenceFields"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function hasOwn(obj: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function hasOnlyAllowedKeys(obj: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(obj).every((key) => allowed.has(key));
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function isPositiveSafeInteger(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
}

interface ClaudeStatementShape {
  readonly text: string;
  readonly evidenceFields: readonly string[];
}

type ClaudeStatementCheck = { ok: true; statement: ClaudeStatementShape } | { ok: false; codes: string[] };

// evidenceFields path의 실존/null/comparability는 여기서 검사하지 않는다(recommendation.ts의
// checkStatement/checkEvidenceFields가 buildRecommendationResult() 호출 시 이미 한다) -
// 여기서는 Claude 전용 계약 두 가지만 강제한다: provenance key가 없어야 한다는 것(이미
// CLAUDE_STATEMENT_ALLOWED_KEYS로 구조적으로 보장), evidenceFields가 최소 1개 이상이어야
// 한다는 것(요청서 24절 - generic builder의 legacy [] 허용 정책과 다른, Claude 전용
// strictness). path 문자열 자체의 형식(빈 문자열/공백/타입)은 최소한만 여기서 걸러낸다 -
// 자세한 검증은 어차피 다음 단계에서 다시 한다.
function checkClaudeStatement(raw: unknown): ClaudeStatementCheck {
  if (!isPlainObject(raw)) return { ok: false, codes: ["claude_recommendation_output_invalid"] };
  const codes: string[] = [];
  if (!hasOnlyAllowedKeys(raw, CLAUDE_STATEMENT_ALLOWED_KEYS)) codes.push("claude_recommendation_output_invalid");
  if (!hasOwn(raw, "text") || !isNonEmptyString(raw.text)) codes.push("claude_recommendation_output_invalid");

  if (!hasOwn(raw, "evidenceFields")) {
    codes.push("claude_recommendation_output_invalid");
  } else {
    const rawEvidenceFields = raw.evidenceFields;
    if (!Array.isArray(rawEvidenceFields) || rawEvidenceFields.length === 0) {
      codes.push("claude_recommendation_output_invalid");
    } else if (!rawEvidenceFields.every((v) => typeof v === "string" && v.length > 0)) {
      codes.push("claude_recommendation_output_invalid");
    }
  }

  if (codes.length > 0) return { ok: false, codes: Array.from(new Set(codes)) };
  return {
    ok: true,
    statement: { text: (raw.text as string).trim(), evidenceFields: raw.evidenceFields as string[] },
  };
}

interface ClaudeProductShape {
  readonly productId: number;
  readonly strengths: readonly ClaudeStatementShape[];
  readonly cautions: readonly ClaudeStatementShape[];
}

type ClaudeProductCheck = { ok: true; product: ClaudeProductShape } | { ok: false; codes: string[] };

function checkClaudeStatementArray(raw: unknown): { ok: true; statements: ClaudeStatementShape[] } | { ok: false; codes: string[] } {
  if (!Array.isArray(raw)) return { ok: false, codes: ["claude_recommendation_output_invalid"] };
  const codes: string[] = [];
  const statements: ClaudeStatementShape[] = [];
  for (const item of raw) {
    const checked = checkClaudeStatement(item);
    if (checked.ok) statements.push(checked.statement);
    else codes.push(...checked.codes);
  }
  if (codes.length > 0) return { ok: false, codes: Array.from(new Set(codes)) };
  return { ok: true, statements };
}

function checkClaudeProduct(raw: unknown): ClaudeProductCheck {
  if (!isPlainObject(raw)) return { ok: false, codes: ["claude_recommendation_output_invalid"] };
  const codes: string[] = [];
  if (!hasOnlyAllowedKeys(raw, CLAUDE_PRODUCT_ALLOWED_KEYS)) codes.push("claude_recommendation_output_invalid");
  if (!hasOwn(raw, "productId") || !isPositiveSafeInteger(raw.productId)) codes.push("claude_recommendation_output_invalid");

  const strengthsChecked = hasOwn(raw, "strengths") ? checkClaudeStatementArray(raw.strengths) : ({ ok: false, codes: ["claude_recommendation_output_invalid"] } as const);
  if (!strengthsChecked.ok) codes.push(...strengthsChecked.codes);
  const cautionsChecked = hasOwn(raw, "cautions") ? checkClaudeStatementArray(raw.cautions) : ({ ok: false, codes: ["claude_recommendation_output_invalid"] } as const);
  if (!cautionsChecked.ok) codes.push(...cautionsChecked.codes);

  if (codes.length > 0 || !strengthsChecked.ok || !cautionsChecked.ok) {
    return { ok: false, codes: Array.from(new Set(codes)) };
  }
  return {
    ok: true,
    product: { productId: raw.productId as number, strengths: strengthsChecked.statements, cautions: cautionsChecked.statements },
  };
}

type ClaudeOutputShapeCheck = { ok: true; products: ClaudeProductShape[] } | { ok: false; codes: string[] };

// Claude raw output의 exact contract만 검사한다(요청서 20~24절) - productId 집합이
// snapshot과 일치하는지, evidence path가 유효한지는 이후 buildRecommendationResult()가
// 담당한다. 여기서 통과 못하면 부분 salvage 없이 전체 실패한다(요청서 35절).
function checkClaudeOutputShape(raw: unknown): ClaudeOutputShapeCheck {
  if (!isPlainObject(raw)) return { ok: false, codes: ["claude_recommendation_output_invalid"] };
  const codes: string[] = [];
  if (!hasOnlyAllowedKeys(raw, CLAUDE_TOP_LEVEL_ALLOWED_KEYS)) codes.push("claude_recommendation_output_invalid");
  if (!hasOwn(raw, "products") || !Array.isArray(raw.products)) codes.push("claude_recommendation_output_invalid");
  if (codes.length > 0) return { ok: false, codes: Array.from(new Set(codes)) };

  const products: ClaudeProductShape[] = [];
  for (const item of raw.products as unknown[]) {
    const checked = checkClaudeProduct(item);
    if (checked.ok) products.push(checked.product);
    else codes.push(...checked.codes);
  }
  if (codes.length > 0) return { ok: false, codes: Array.from(new Set(codes)) };
  return { ok: true, products };
}

const MISSING_COMPARISON_FIELDS: readonly ("price" | "originalPrice" | "shippingFee")[] = ["price", "originalPrice", "shippingFee"];
const MISSING_INFORMATION_REASON = "not_available_in_snapshot";

// Claude는 missingInformation을 출력하지 않는다(요청서 27절) - snapshot/payload에서
// 결정론적으로 판정 가능한 comparisonFields(price/originalPrice/shippingFee)만
// 대상으로 host가 만든다. normalizedMeasurements/categoryKey/optionName의 부재는
// "이 상품군에 해당 dimension이 아예 적용되지 않을 수 있다"는 모호함이 있어 자동
// missingInformation으로 만들지 않는다(요청서 27절 명시). 0은 missing이 아니다 - null인
// field만 대상. product/field 순서는 payload의 canonical product 순서 + price ->
// originalPrice -> shippingFee 고정 순서(요청서 28절) - buildRecommendationResult()가
// 최종적으로 다시 (productId, field, reason) 오름차순으로 재정렬하므로 여기서의 순서
// 자체가 최종 순서를 좌우하지는 않지만, 생성 시점부터 결정론적이어야 한다는 원칙은
// 유지한다.
function buildDeterministicMissingInformation(comparisonSnapshot: ComparisonSnapshot): RecommendationMissingInformation[] {
  const payload = buildRecommendationEvidencePayload(comparisonSnapshot);
  const missing: RecommendationMissingInformation[] = [];
  for (const product of payload.products) {
    for (const field of MISSING_COMPARISON_FIELDS) {
      const value = product.comparisonFields === null ? null : product.comparisonFields[field];
      if (value === null) {
        missing.push({ productId: product.productId, field, reason: MISSING_INFORMATION_REASON });
      }
    }
  }
  return missing;
}

// 흐름(요청서 29절 그대로):
// ComparisonSnapshot -> Claude raw output exact validation -> host provenance
// 주입(claude_inference 고정) -> deterministic missingInformation 생성 ->
// buildRecommendationResult(snapshot, input) -> canonical RecommendationResult.
//
// DB 없음. Claude 호출 없음. parser 없음(입력은 이미 parse된 unknown object라고 가정).
// 이 함수 자체는 evidence path 검증을 하지 않는다 - buildRecommendationResult()에
// 위임해 로직을 중복하지 않는다(요청서 30절).
export function buildRecommendationFromClaudeOutput(comparisonSnapshot: ComparisonSnapshot | null | undefined, rawClaudeOutput: unknown): RecommendationBuildResult {
  const shapeChecked = checkClaudeOutputShape(rawClaudeOutput);
  if (!shapeChecked.ok) {
    return { ok: false, recommendation: null, errors: shapeChecked.codes };
  }

  const products = shapeChecked.products.map((product) => ({
    productId: product.productId,
    strengths: product.strengths.map((s) => ({ text: s.text, provenance: "claude_inference" as const, evidenceFields: s.evidenceFields })),
    cautions: product.cautions.map((s) => ({ text: s.text, provenance: "claude_inference" as const, evidenceFields: s.evidenceFields })),
  }));

  if (!comparisonSnapshot) {
    return { ok: false, recommendation: null, errors: ["recommendation_input_invalid"] };
  }
  const missingInformation = buildDeterministicMissingInformation(comparisonSnapshot);

  return buildRecommendationResult(comparisonSnapshot, { products, missingInformation });
}
