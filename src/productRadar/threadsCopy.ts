// src/productRadar/threadsCopy.ts
// 상품 레이더 Phase 12.5.2.1: Threads Copy Foundation - pure domain(순수, DB/Claude/Express 없음).
//
// 이 파일은 recommendationPersistence.ts/comparisonPersistence.ts/database.ts를 import하지
// 않는다(요청서 36절 - DB 계층 완전 독립). RecommendationSnapshotRecord 타입은
// recommendationPersistence.ts 안에서만 정의되어 있어 그 타입을 그대로 import하면 DB
// 계층에 결합되므로, 이 파일이 실제로 필요로 하는 필드만 구조적으로(structural typing)
// ProductRadarThreadsCopyRecommendationInput으로 다시 정의한다 - 실제
// RecommendationSnapshotRecord 값(더 많은 필드를 가진 상위 집합)을 그대로 넘겨도 TypeScript
// 구조적 타이핑에 의해 항상 호환된다. live product 재조회 없음 - factual source는 오직
// caller가 이미 로드해서 넘긴 frozen ComparisonSnapshot 하나뿐이다.
//
// Claude 호출도 여기 없다(invocation은 threadsCopyClaude.ts 몫). Claude 출력 shape 검증도
// 여기 없다(threadsCopyClaudeContract.ts 몫) - 이 파일은 (1) lineage 일관성 판정,
// (2) authoritative factual payload 조립, (3) 이미 검증된 posts로 canonical result 조립까지만
// 담당한다.

import { ComparisonSnapshot, NormalizedMeasurements, RecommendationOutputLanguage } from "./types";
import { FactualComparisonEvidence } from "./comparisonEvidence";
import { buildRecommendationEvidencePayload, RecommendationUnitPrices } from "./recommendationEvidence";
// 최종 audit(evidence reference integrity): path 문법 파서 + O(1) null-index 빌더를
// recommendation.ts에서 그대로 재사용한다(behavior 변경 없이 export만 추가됨) -
// cross-product comparability gate는 가져오지 않는다(요청서 7절, threadsCopy.ts 하단
// isValidStatementEvidenceFields() 주석 참고).
import { buildEvidencePathIndex, parseEvidencePath } from "./recommendation";

// ---- recommendationPersistence.ts를 import하지 않기 위한 구조적 입력 타입 ----

export interface ProductRadarThreadsCopyRecommendationInput {
  readonly id: number;
  readonly comparisonSnapshotId: number;
  readonly outputLanguage: RecommendationOutputLanguage | null;
  readonly recommendation: {
    readonly comparisonSnapshotId: number;
    readonly compareGroupId: number;
    readonly comparisonRevision: number;
    readonly infoAsOf: string;
    readonly products: readonly {
      readonly productId: number;
      readonly strengths: readonly { readonly text: string; readonly evidenceFields: readonly string[] }[];
      readonly cautions: readonly { readonly text: string; readonly evidenceFields: readonly string[] }[];
    }[];
    readonly missingInformation: readonly {
      readonly productId: number;
      readonly field: string;
      readonly reason: string;
    }[];
  };
}

// ---- authoritative factual payload(프롬프트에 그대로 JSON.stringify될 값) ----

// Corrective A(Phase 12.5.2.1 audit): text만 남기고 evidenceFields를 버리면 "추천 해석 ↔
// 근거 값" binding이 약해진다 - Recommendation이 이미 확보한 evidence trace(어떤
// comparisonFields/normalizedMeasurements/unitPrices 경로가 이 문장의 근거인지)를 Claude
// INPUT에서 보존한다. provenance는 계속 제외한다(Threads Copy 카피라이팅에 무의미).
export interface ProductRadarThreadsCopyStatementPayload {
  readonly text: string;
  readonly evidenceFields: readonly string[];
}

export interface ProductRadarThreadsCopyProductPayload {
  readonly productId: number;
  // Phase 12.5.2.2.2: 사람이 읽는 frozen 상품명. source는 정확히
  // ComparisonSnapshot.productEvidence[].displayLabel(이 productId와 같은 행) 하나뿐이다 -
  // live product_radar_products.product_name을 재조회하지 않고, identityTokens를 이어붙여
  // 만들지 않는다(설계서 4·7절). checkProductRadarThreadsCopyDisplayLabels()가 이미 모든
  // product에 usable(non-null, non-empty) 값이 있음을 확인한 뒤에만 payload가 만들어지므로
  // 여기서는 항상 non-null string이다.
  readonly displayLabel: string;
  readonly categoryKey: string | null;
  readonly identityTokens: readonly string[];
  readonly optionName: string | null;
  readonly comparisonFields: FactualComparisonEvidence | null;
  readonly normalizedMeasurements: NormalizedMeasurements | null;
  readonly unitPrices: RecommendationUnitPrices | null;
  readonly strengths: readonly ProductRadarThreadsCopyStatementPayload[];
  readonly cautions: readonly ProductRadarThreadsCopyStatementPayload[];
}

export interface ProductRadarThreadsCopyMissingInformation {
  readonly productId: number;
  readonly field: string;
  readonly reason: string;
}

export interface ProductRadarThreadsCopyPayload {
  readonly comparisonSnapshotId: number;
  readonly recommendationSnapshotId: number;
  readonly outputLanguage: RecommendationOutputLanguage;
  readonly products: readonly ProductRadarThreadsCopyProductPayload[];
  readonly missingInformation: readonly ProductRadarThreadsCopyMissingInformation[];
}

// ---- canonical result(Claude posts 검증 통과 후 host가 lineage를 주입한 최종 결과) ----

export interface ProductRadarThreadsCopyPost {
  readonly hook: string;
  readonly body: string;
}

export interface ProductRadarThreadsCopyResult {
  readonly comparisonSnapshotId: number;
  readonly recommendationSnapshotId: number;
  readonly outputLanguage: RecommendationOutputLanguage;
  readonly posts: readonly ProductRadarThreadsCopyPost[];
}

export type ProductRadarThreadsCopyBuildResult =
  | { ok: true; result: ProductRadarThreadsCopyResult; errors: readonly [] }
  | { ok: false; result: null; errors: readonly string[] };

// ---- 순수 helper ----

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isKnownOutputLanguage(v: unknown): v is RecommendationOutputLanguage {
  return v === "ko" || v === "en";
}

// Corrective A(요청서 6절): 이 파일의 ProductRadarThreadsCopyRecommendationInput은
// recommendationPersistence.ts와 결합을 피하기 위한 구조적 local type이라, 실제
// RecommendationSnapshotRecord처럼 hydration 시점에 buildRecommendationResult()가 강제하는
// evidenceFields invariant(경로 형식/실존/comparability)를 이 파일 자체는 보장받지 못한다.
// recommendation.ts에는 그 shape-only 검증만 재사용할 수 있는 exported pure helper가 없어
// (private checkEvidenceFields()는 export되지 않고 snapshot 전체 재검증까지 포함해 그대로
// 재사용하면 과설계), "evidenceFields가 문자열 배열이고 각 원소가 공백 아닌 문자열인가"라는
// 최소 shape만 이 파일 안에서 직접 확인한다 - 실제 경로가 evidence payload에 존재하는지
// 같은 의미론적 검증은 하지 않는다(그건 canonical record 생성 시점에 이미 보장됨).
function isValidEvidenceFieldsShape(v: unknown): v is readonly string[] {
  return Array.isArray(v) && v.every((s) => typeof s === "string" && s.trim().length > 0);
}

function isValidStatementListShape(v: unknown): boolean {
  return Array.isArray(v) && v.every((s) => isPlainObject(s) && typeof s.text === "string" && isValidEvidenceFieldsShape(s.evidenceFields));
}

// 최종 audit(evidence reference integrity, 요청서 4절): shape만으로는 부족하다 - 각 path가
// (1) parseEvidencePath()가 인정하는 canonical 문법이고, (2) 그 productId가 현재
// ComparisonSnapshot에 실제로 존재하며, (3) buildRecommendationEvidencePayload(snapshot)에서
// 그 필드 값이 실제로 non-null인지까지 확인한다. legacy([] 배열)는 이 함수를 아예 거치지
// 않는다(호출부에서 매 statement의 evidenceFields.length === 0이면 그대로 통과 - 빈
// 배열에 대해 순회할 것이 없으므로 자연스럽게 유효 처리됨). null은 evidence로 쓸 수 없고
// 0은 유효하다(index.validNonNullPaths가 이미 `!== null` 기준으로 만들어졌으므로 truthy/
// falsy 검사가 아니다 - recommendation.ts buildEvidencePathIndex() 그대로 재사용).
function isValidStatementEvidenceFields(evidenceFields: readonly string[], index: ReturnType<typeof buildEvidencePathIndex>): boolean {
  const seen = new Set<string>();
  for (const path of evidenceFields) {
    // 같은 statement 안 duplicate path 거부(요청서 15절) - strength A/B가 각자 같은
    // evidence를 인용하는 것은 이 함수 밖(서로 다른 호출)이라 허용된다.
    if (seen.has(path)) return false;
    seen.add(path);

    const parsed = parseEvidencePath(path);
    if (parsed === null) return false; // malformed path(문법 자체가 canonical vocabulary 밖)
    if (!index.productIds.has(parsed.productId)) return false; // 현재 snapshot에 없는 productId
    if (!index.validNonNullPaths.has(path)) return false; // 존재하지만 null이거나(unknown field는 애초에 index에 없음)
  }
  return true;
}

// ---- Phase 12.5.2.2.2: pre-Claude displayLabel usability gate ----

export type ProductRadarThreadsCopyDisplayLabelCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "threads_copy_display_label_missing" | "threads_copy_input_invalid" };

// Claude를 부르기 전, 이 ComparisonSnapshot의 모든 product가 usable한(사람이 실제로 읽을 수
// 있는) frozen displayLabel을 갖고 있는지 확인한다. TypeScript 타입은 ComparisonSnapshotProductEvidence.
// displayLabel을 string | null로 선언하지만, hasBasicShape()와 동일한 이유로(fabricated
// runtime 입력이 타입을 우회할 수 있음) 여기서도 실제 런타임 타입을 다시 확인한다 -
// null/undefined(key 자체 없음, legacy snapshot)/빈 문자열/공백만인 문자열은 모두 "아직
// 얼려진 이름이 없음"으로 취급해 threads_copy_display_label_missing(재수집 후 새 comparison
// 실행으로 회복 가능)을 반환하고, string이 아닌 다른 타입(number/object/array/boolean)은
// missing이 아니라 구조적으로 손상된 입력이므로 threads_copy_input_invalid를 반환한다(요청서
// 11·12절 - error taxonomy를 필요 이상으로 늘리지 않는다). trim은 판정에만 쓰고 값 자체를
// 정규화하지 않는다 - 이 함수는 boolean 판정만 하고 payload 조립에는 관여하지 않는다.
export function checkProductRadarThreadsCopyDisplayLabels(comparisonSnapshot: ComparisonSnapshot): ProductRadarThreadsCopyDisplayLabelCheck {
  for (const evidence of comparisonSnapshot.productEvidence) {
    const raw: unknown = (evidence as { displayLabel?: unknown }).displayLabel;
    if (raw === undefined || raw === null) return { ok: false, code: "threads_copy_display_label_missing" };
    if (typeof raw !== "string") return { ok: false, code: "threads_copy_input_invalid" };
    if (raw.trim().length === 0) return { ok: false, code: "threads_copy_display_label_missing" };
  }
  return { ok: true };
}

// comparisonSnapshot으로부터 evidence path index를 만들고, recommendationRecord의 모든
// product(strengths+cautions 전체)의 evidenceFields가 그 index 기준으로 유효한지 확인한다.
// hasBasicShape()를 통과한(=evidenceFields가 최소 string[] shape인) 입력만 이 함수를
// 호출한다고 가정한다(호출부가 항상 순서를 지킴).
export function isEvidenceFieldsSemanticValid(comparisonSnapshot: ComparisonSnapshot, recommendationRecord: ProductRadarThreadsCopyRecommendationInput): boolean {
  const evidencePayload = buildRecommendationEvidencePayload(comparisonSnapshot);
  const index = buildEvidencePathIndex(evidencePayload.products);
  return recommendationRecord.recommendation.products.every((p) =>
    [...p.strengths, ...p.cautions].every((s) => isValidStatementEvidenceFields(s.evidenceFields, index))
  );
}

// comparisonSnapshot/recommendationRecord가 TypeScript 타입을 우회해(예: as any) 기본 구조를
// 갖추지 못한 채 들어온 경우를 대비한 최소 방어(요청서 28절 threads_copy_input_invalid 용도) -
// 정상 호출(타입 그대로 넘어온 canonical/hydrated 객체)에서는 항상 통과한다. Corrective A로
// 각 product의 strengths/cautions 원소가 {text, evidenceFields} shape을 갖추는지도 확인한다.
function hasBasicShape(
  comparisonSnapshot: unknown,
  recommendationRecord: unknown
): comparisonSnapshot is ComparisonSnapshot {
  if (!isPlainObject(comparisonSnapshot) || !Array.isArray(comparisonSnapshot.productRefs)) return false;
  if (!Array.isArray((comparisonSnapshot as any).productEvidence)) return false;
  if (!isPlainObject(recommendationRecord)) return false;
  const rec = (recommendationRecord as any).recommendation;
  if (!isPlainObject(rec) || !Array.isArray(rec.products) || !Array.isArray(rec.missingInformation)) return false;
  const productsShapeOk = rec.products.every(
    (p: unknown) => isPlainObject(p) && isValidStatementListShape((p as any).strengths) && isValidStatementListShape((p as any).cautions)
  );
  if (!productsShapeOk) return false;
  return true;
}

// 요청서 5·6·31절: comparisonSnapshotId 이중 확인(record 최상위 + record.recommendation
// 내부) + compareGroupId/comparisonRevision/infoAsOf 일치 + 두 record의 productId 집합이
// 정확히 같은 집합인지(순서 무관, 개수/멤버십 모두 일치)까지 확인한다. 하나라도 다르면
// false - 잘못된 recommendation/snapshot 조합을 fail closed로 막는다.
export function isProductRadarThreadsCopyLineageConsistent(
  comparisonSnapshot: ComparisonSnapshot,
  recommendationRecord: ProductRadarThreadsCopyRecommendationInput
): boolean {
  if (!hasBasicShape(comparisonSnapshot, recommendationRecord)) return false;

  const rec = recommendationRecord.recommendation;
  if (recommendationRecord.comparisonSnapshotId !== comparisonSnapshot.id) return false;
  if (rec.comparisonSnapshotId !== comparisonSnapshot.id) return false;
  if (rec.compareGroupId !== comparisonSnapshot.compareGroupId) return false;
  if (rec.comparisonRevision !== comparisonSnapshot.revision) return false;
  if (rec.infoAsOf !== comparisonSnapshot.infoAsOf) return false;

  const snapshotIds = comparisonSnapshot.productRefs.map((r) => r.productId);
  const recIds = rec.products.map((p) => p.productId);
  if (snapshotIds.length !== recIds.length) return false;
  const snapshotIdSet = new Set(snapshotIds);
  return recIds.every((id) => snapshotIdSet.has(id));
}

// comparisonSnapshot.ts/recommendation.ts와 동일한 관례 - 반환값을 호출자가 실수로
// 변형하지 못하게 deep freeze한다.
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

// RecommendationEvidencePayload를 그대로 외부 contract로 오용하지 않는다(요청서 11절) -
// buildRecommendationEvidencePayload()가 이미 계산한 comparisonFields/normalizedMeasurements/
// unitPrices(내부적으로 unitPrices까지 포함, 요청서 19절)를 재사용하되, 여기서는 Threads
// Copy 전용 최소 identity(categoryKey/identityTokens/optionName)와 strengths/cautions
// 요약(text만, provenance/evidenceFields는 문장 단위로 요구하지 않음 - 요청서 32절)을
// 결합해 새 payload shape로 조립한다. identityTokens는 recommendationEvidence.ts가
// 의도적으로 제외한 필드지만(Recommendation Claude에는 불필요), Threads Copy는 상품을
// 자연어로 설명해야 하므로 ComparisonSnapshot.productEvidence[].identity에서 직접 가져온다
// (요청서 12절 - 실제 frozen된 값만 사용, product 이름을 발명하지 않음). URL/affiliate/
// disclosure는 어디에도 포함하지 않는다(요청서 13·14절 - 이번 Phase에서 frozen되어 있지
// 않고, live reread로 메우지 않음).
export function buildProductRadarThreadsCopyPayload(
  comparisonSnapshot: ComparisonSnapshot,
  recommendationRecord: ProductRadarThreadsCopyRecommendationInput
): ProductRadarThreadsCopyPayload | null {
  if (!isKnownOutputLanguage(recommendationRecord.outputLanguage)) return null;
  if (!isProductRadarThreadsCopyLineageConsistent(comparisonSnapshot, recommendationRecord)) return null;
  if (!isEvidenceFieldsSemanticValid(comparisonSnapshot, recommendationRecord)) return null;
  if (!checkProductRadarThreadsCopyDisplayLabels(comparisonSnapshot).ok) return null;

  const evidencePayload = buildRecommendationEvidencePayload(comparisonSnapshot);
  const evidenceByProductId = new Map(evidencePayload.products.map((p) => [p.productId, p]));
  const identityByProductId = new Map(comparisonSnapshot.productEvidence.map((e) => [e.productId, e.identity]));
  // Phase 12.5.2.2.2: displayLabel은 RecommendationEvidencePayload에 없다(그 payload는
  // Recommendation Claude 전용이라 상품명이 불필요 - 요청서 27절) - ComparisonSnapshot.
  // productEvidence[]에서 identityTokens와 동일한 방식으로 직접 가져온다.
  const displayLabelByProductId = new Map(comparisonSnapshot.productEvidence.map((e) => [e.productId, e.displayLabel]));
  const recByProductId = new Map(recommendationRecord.recommendation.products.map((p) => [p.productId, p]));

  const products: ProductRadarThreadsCopyProductPayload[] = comparisonSnapshot.productRefs.map((ref) => {
    const evidence = evidenceByProductId.get(ref.productId) || null;
    const identity = identityByProductId.get(ref.productId) || null;
    const rec = recByProductId.get(ref.productId) || null;
    return {
      productId: ref.productId,
      // 위 checkProductRadarThreadsCopyDisplayLabels() gate를 이미 통과했으므로 이 Map의
      // 모든 productId에 usable string 값이 존재한다(non-null assertion 안전).
      displayLabel: displayLabelByProductId.get(ref.productId) as string,
      categoryKey: evidence ? evidence.categoryKey : null,
      identityTokens: identity ? identity.identityTokens : [],
      optionName: evidence ? evidence.optionName : null,
      comparisonFields: evidence ? evidence.comparisonFields : null,
      normalizedMeasurements: evidence ? evidence.normalizedMeasurements : null,
      unitPrices: evidence ? evidence.unitPrices : null,
      // evidenceFields는 원본 배열을 그대로 참조하지 않고 새 배열로 복사한다(요청서 5절
      // mutation/reference alias 금지) - 문자열 배열이라 얕은 복사로 충분하고, 최종적으로
      // deepFreeze()가 payload 전체를 얼린다.
      strengths: rec ? rec.strengths.map((s) => ({ text: s.text, evidenceFields: [...s.evidenceFields] })) : [],
      cautions: rec ? rec.cautions.map((s) => ({ text: s.text, evidenceFields: [...s.evidenceFields] })) : [],
    };
  });

  const missingInformation: ProductRadarThreadsCopyMissingInformation[] = recommendationRecord.recommendation.missingInformation.map((m) => ({
    productId: m.productId,
    field: m.field,
    reason: m.reason,
  }));

  const payload: ProductRadarThreadsCopyPayload = {
    comparisonSnapshotId: comparisonSnapshot.id,
    recommendationSnapshotId: recommendationRecord.id,
    outputLanguage: recommendationRecord.outputLanguage,
    products,
    missingInformation,
  };
  return deepFreeze(payload);
}

// ---- Corrective B(요청서 8~13절): deterministic output safety guard ----
//
// 모든 hallucination을 문자열 검사로 막으려 하지 않는다(요청서 12절 - "리뷰/평점/배송/
// 할인/재고/인기/품질" 같은 넓은 키워드 금지는 "평점 정보는 확인할 수 없습니다" 같은
// 정당한 문장까지 오탐시킨다). host가 확실하게 판별 가능한 고위험 표현 3가지만
// deterministic하게 검사한다: (1) 실사용 경험 주장, (2) 실제 URL 출력, (3) 존재하지
// 않는 링크를 전제하는 CTA. disclosure hallucination은 guard에 넣지 않는다(요청서 11절) -
// 이번 Phase에는 고정 disclosure 문구 자체가 없어 정확히 매칭할 대상이 없고, "제휴"/
// "수수료" 같은 단어는 일반 문맥에도 등장할 수 있어 오탐 위험이 guard로 얻는 이득보다
// 크다고 판단해 prompt 금지(threadsCopyClaude.ts)만 유지한다.
const DIRECT_USE_CLAIM_PHRASES_KO: readonly string[] = ["직접 써봤", "직접 사용해봤", "제가 써봤", "제가 사용해봤", "며칠 써보니", "실사용해보니", "구매해서 써봤"];
const DIRECT_USE_CLAIM_PHRASES_EN: readonly string[] = ["i used this", "i've used this", "i tried this", "i've been using", "after using this", "after trying this"];
const FABRICATED_LINK_CTA_PHRASES_KO: readonly string[] = ["구매 링크", "링크에서 확인", "아래 링크", "링크 클릭"];
const FABRICATED_LINK_CTA_PHRASES_EN: readonly string[] = ["buy link", "link below", "click the link", "purchase link"];
// adversarial review(Phase 12.5.2.1 corrective 23절)에서 "http(s):// scheme만 검사하면
// www.example.com이나 example.com/product처럼 scheme 없이도 사람/Threads가 링크로 인식하는
// 형태를 놓친다"는 지적을 확인해 www. 접두어와 흔한 도메인 TLD 패턴을 추가했다. 오탐
// 위험을 낮게 유지하기 위해 TLD 목록을 상거래/링크 맥락에서 실제로 쓰이는 것만 좁게
// 유지한다(요청서 12절 원칙과 동일 - 넓게 잡지 않는다). 한글은 a-z 범위 밖이라 이 정규식과
// 아예 충돌하지 않는다.
const RAW_URL_PATTERN = /(https?:\/\/|www\.[a-z0-9-]+\.[a-z]{2,}|\b[a-z0-9-]+\.(?:com|net|org|kr|io|shop|link|me)\b)/i;

function containsAnyPhrase(haystackLower: string, needles: readonly string[]): boolean {
  return needles.some((needle) => haystackLower.includes(needle));
}

// null이면 안전, 문자열이면 그 값이 위반 종류(호출자는 failure code를 새로 늘리지 않고
// 기존 threads_copy_claude_output_invalid 하나로 묶어 반환한다 - 요청서 13절).
export function findProductRadarThreadsCopyOutputSafetyViolation(post: ProductRadarThreadsCopyPost): string | null {
  // 한글은 대소문자 구분이 없어 toLowerCase()가 안전하게 no-op으로 적용된다 - 영문 문구만
  // 대소문자 무관 비교가 실제로 필요하다.
  const combinedLower = `${post.hook}\n${post.body}`.toLowerCase();
  if (RAW_URL_PATTERN.test(combinedLower)) return "url";
  if (containsAnyPhrase(combinedLower, DIRECT_USE_CLAIM_PHRASES_KO) || containsAnyPhrase(combinedLower, DIRECT_USE_CLAIM_PHRASES_EN)) {
    return "direct_use_claim";
  }
  if (containsAnyPhrase(combinedLower, FABRICATED_LINK_CTA_PHRASES_KO) || containsAnyPhrase(combinedLower, FABRICATED_LINK_CTA_PHRASES_EN)) {
    return "fabricated_link_cta";
  }
  return null;
}

// 이미 threadsCopyClaudeContract.ts가 hook/body exact-shape로 검증한 posts를 받아 canonical
// ProductRadarThreadsCopyResult를 조립한다. lineage/language를 여기서 다시 확인하는 것은
// recommendation.ts가 저장/복원 경계마다 buildRecommendationResult()를 다시 통과시키는 것과
// 동일한 "단일 지점만 신뢰하지 않는다" 원칙이다(중복이지만 의도적).
export function buildProductRadarThreadsCopyResult(
  comparisonSnapshot: ComparisonSnapshot,
  recommendationRecord: ProductRadarThreadsCopyRecommendationInput,
  posts: readonly ProductRadarThreadsCopyPost[]
): ProductRadarThreadsCopyBuildResult {
  if (!hasBasicShape(comparisonSnapshot, recommendationRecord)) {
    return { ok: false, result: null, errors: ["threads_copy_input_invalid"] };
  }
  if (!isKnownOutputLanguage(recommendationRecord.outputLanguage)) {
    return { ok: false, result: null, errors: ["threads_copy_language_unknown"] };
  }
  if (!isProductRadarThreadsCopyLineageConsistent(comparisonSnapshot, recommendationRecord)) {
    return { ok: false, result: null, errors: ["threads_copy_lineage_mismatch"] };
  }
  // 최종 audit: fabricated/corrupt input의 evidenceFields가 실제 frozen evidence를
  // 가리키지 않으면 여기서도 다시 막는다(단일 지점만 신뢰하지 않는 기존 원칙 재적용 -
  // buildProductRadarThreadsCopyPayload()가 이미 같은 검사를 하지만, 이 함수는 payload를
  // 거치지 않고 직접 호출될 수도 있으므로 자체적으로도 확인한다).
  if (!isEvidenceFieldsSemanticValid(comparisonSnapshot, recommendationRecord)) {
    return { ok: false, result: null, errors: ["threads_copy_input_invalid"] };
  }
  // Phase 12.5.2.2.2: 이 함수는 payload를 거치지 않고 직접 호출될 수도 있으므로(위 주석과
  // 동일 원칙) displayLabel usability도 여기서 다시 확인한다 - 정상 흐름(generateProductRadarThreadsCopy())
  // 에서는 이미 Claude 호출 전에 걸러졌을 것이므로 이 분기는 방어적 defense-in-depth다.
  const displayLabelCheck = checkProductRadarThreadsCopyDisplayLabels(comparisonSnapshot);
  if (!displayLabelCheck.ok) {
    return { ok: false, result: null, errors: [displayLabelCheck.code] };
  }
  if (!Array.isArray(posts) || posts.length !== 1) {
    return { ok: false, result: null, errors: ["threads_copy_claude_output_invalid"] };
  }
  const post = posts[0];
  if (!post || typeof post.hook !== "string" || post.hook.trim().length === 0) {
    return { ok: false, result: null, errors: ["threads_copy_claude_output_invalid"] };
  }
  if (typeof post.body !== "string" || post.body.trim().length === 0) {
    return { ok: false, result: null, errors: ["threads_copy_claude_output_invalid"] };
  }
  // Corrective B: 실사용 경험 주장/실제 URL/가짜 링크 CTA 중 하나라도 발견되면 거부한다.
  // 새 top-level failure code를 늘리지 않고 기존 threads_copy_claude_output_invalid를
  // 그대로 재사용한다(요청서 13절).
  if (findProductRadarThreadsCopyOutputSafetyViolation({ hook: post.hook, body: post.body }) !== null) {
    return { ok: false, result: null, errors: ["threads_copy_claude_output_invalid"] };
  }

  // generatedAt을 여기 넣지 않는다(요청서 7·30절) - pure deterministic domain에 clock
  // dependency를 만들지 않는다. 저장 시각은 이후 draft persistence의 created_at이 담당한다.
  const result: ProductRadarThreadsCopyResult = {
    comparisonSnapshotId: comparisonSnapshot.id,
    recommendationSnapshotId: recommendationRecord.id,
    outputLanguage: recommendationRecord.outputLanguage,
    posts: [{ hook: post.hook, body: post.body }],
  };
  return { ok: true, result: deepFreeze(result), errors: [] };
}
