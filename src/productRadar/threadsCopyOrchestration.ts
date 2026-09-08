// src/productRadar/threadsCopyOrchestration.ts
// 상품 레이더 Phase 12.5.2.3.3.2: Product Radar Threads Copy → Draft Atomic Orchestration.
//
// 이 파일의 책임은 "흐름 조립"뿐이다(comparisonOrchestration.ts/recommendationOrchestration.ts와
// 동일 원칙) - Claude prompt/parser/lineage/displayLabel/safety 검증 로직은 이미
// threadsCopy.ts/threadsCopyClaude.ts/threadsCopyClaudeContract.ts에 있고, recommendation/
// comparison 조회는 이미 recommendationPersistence.ts/comparisonPersistence.ts에 있고, draft
// 원자 저장은 이미 database.ts의 insertDraftsAtomic()에 있다 - 이 파일은 그것들을 정확한
// 순서로만 호출한다. 아무것도 복제하지 않는다(evidenceFields/displayLabel/lineage/URL
// safety/Claude 파서 재검증 없음).
//
// caller input은 정확히 recommendationSnapshotId 하나뿐이다 - comparisonSnapshotId/
// outputLanguage는 그 recommendation record에서만 파생한다(latest comparison/latest
// recommendation 조회 없음, 요청서 4·5·9절). caller가 지정한 exact recommendation row가
// 가리키는 exact parent comparison만 쓴다.
//
// 흐름:
// 1. getProductRadarRecommendationSnapshotById(recommendationSnapshotId)로 exact
//    RecommendationSnapshotRecord 확보 - 없거나 손상이면 즉시 그 error를 그대로 반환.
// 2. record.comparisonSnapshotId로 getProductRadarComparisonSnapshotById()를 호출해 exact
//    parent ComparisonSnapshot 확보 - latest-by-group 조회 없음.
// 3. generateProductRadarThreadsCopy(comparisonSnapshot, recommendationRecord) 호출 - 이
//    함수가 이미 language/lineage/evidenceFields/displayLabel/Claude 실행/파서/safety를
//    전부 검증한다. 실패하면 그 error들을 그대로 반환한다(새 prefix/translation 없음,
//    요청서 25절) - insertDraftsAtomic()을 호출하지 않는다.
// 4. buildProductRadarDraftInput()으로 성공한 result를 DraftInput으로 결정론적으로
//    mapping(요청서 11절 확정 계약 - title=hook exact, hook exact, body exact, topic="",
//    source_type="product_radar", usage_status="not_used", product_name/affiliate_url/
//    disclosure_text=null, generation_batch_id 생략, lineage FK=recommendationRecord.id).
// 5. insertDraftsAtomic([draftInput])으로 원자 저장 - 실패(예외)하면 draft 0개인 채로
//    threads_copy_draft_persistence_failed를 반환한다(raw DB 예외 메시지를 그대로 노출하지
//    않음, 요청서 27절).
//
// db.transaction()을 이 파일이 직접 열지 않는다 - recommendation/comparison 조회(짧은
// SELECT, 즉시 종료) -> Claude generation(수십 초 걸릴 수 있음, DB 미접근) -> 짧은
// insertDraftsAtomic() transaction 순서가 이미 자연스럽게 "Claude 호출 중 DB write
// transaction 없음"을 보장한다(recommendationOrchestration.ts와 동일 원칙, 요청서 23절).
//
// retry 없음 - recommendation/comparison 조회, Claude generation, draft insert 모두
// 정확히 1회씩만 호출한다. 같은 recommendationSnapshotId로 이 함수를 다시 호출하면
// (예: 사용자가 "다시 생성") 새 Claude 호출 + 새 draft가 만들어진다 - 기존 draft를
// overwrite/reject하지 않는다(요청서 30절, drafts에 UNIQUE 제약이 없음을 12.5.2.3.3.1이
// 이미 보장).

import { getProductRadarComparisonSnapshotById } from "./comparisonPersistence";
import {
  getProductRadarRecommendationSnapshotById,
  RecommendationSnapshotRecord,
} from "./recommendationPersistence";
import { generateProductRadarThreadsCopy } from "./threadsCopyClaude";
import { ProductRadarThreadsCopyResult } from "./threadsCopy";
import { DraftInput, getCurrentPersona, insertDraftsAtomic } from "../database";
import { buildPersonaStyleBlock } from "../claude";

// Claude가 만든 순수 result(hook/body)를 Product Radar V1-A(linkless, affiliate 없음) draft
// metadata 계약으로 결정론적으로 옮긴다 - DB/Claude 의존성 없는 pure function이라 별도
// 단위 테스트가 쉽다(요청서 38절). posts.length === 1은 generateProductRadarThreadsCopy()의
// 이미 검증된 contract(요청서 39절 - 여기서 다시 검증하지 않는다, 중복 validation 금지
// 원칙 요청서 55절).
//
// title=hook: 새 content generation이 아니다 - 이미 만들어진 frozen hook을 draft 목록
// 식별용 title로 그대로 재사용할 뿐이다(요청서 12절, 축약/번역/재작성 없음).
// topic="": Threads Copy에는 별도 topic이 없고, host가 상품명/카테고리를 추정해 topic을
// 만들지 않는다(요청서 15절).
// source_type="product_radar": draft origin을 뜻할 뿐 monetization 여부와 무관하다(요청서
// 16절) - 향후 affiliate가 붙어도 이 값은 그대로 유지 가능.
// usage_status="not_used": 자동 수집 상품에 직접 사용 경험을 주장할 수 없다는 기존 Threads
// Copy safety 원칙과 정확히 일치(요청서 17절), 사용자 선택 옵션 없음.
// product_name/affiliate_url/disclosure_text=null, generation_batch_id 생략: V1-A
// linkless/affiliate-free 불변식 그대로(요청서 18·19·20절) - sourceUrl/canonicalUrl도
// 여기 어디에도 등장하지 않는다(12.5.2.3.2는 계속 보류, 요청서 43절).
export function buildProductRadarDraftInput(recommendationSnapshotId: number, threadsCopyResult: ProductRadarThreadsCopyResult): DraftInput {
  const post = threadsCopyResult.posts[0];
  return {
    title: post.hook,
    hook: post.hook,
    body: post.body,
    topic: "",
    source_type: "product_radar",
    usage_status: "not_used",
    product_name: null,
    affiliate_url: null,
    disclosure_text: null,
    product_radar_recommendation_snapshot_id: recommendationSnapshotId,
  };
}

export type ProductRadarThreadsCopyOrchestrationResult =
  | {
      readonly ok: true;
      readonly recommendationSnapshotId: number;
      readonly comparisonSnapshotId: number;
      readonly draftId: number;
      readonly threadsCopy: ProductRadarThreadsCopyResult;
      readonly errors: readonly [];
    }
  | {
      readonly ok: false;
      readonly draftId: null;
      readonly errors: readonly string[];
    };

export async function generateAndPersistProductRadarThreadsCopyDraft(
  recommendationSnapshotId: number
): Promise<ProductRadarThreadsCopyOrchestrationResult> {
  const recommendationResult = getProductRadarRecommendationSnapshotById(recommendationSnapshotId);
  if (!recommendationResult.ok || !recommendationResult.record) {
    return { ok: false, draftId: null, errors: recommendationResult.errors };
  }
  const recommendationRecord: RecommendationSnapshotRecord = recommendationResult.record;

  // latest comparison이 아니라 이 exact recommendation record가 가리키는 그 comparisonSnapshotId만
  // 쓴다 - 그 사이 같은 compare group에 더 새 comparison revision이 생겼어도 무관하다.
  const comparisonResult = getProductRadarComparisonSnapshotById(recommendationRecord.comparisonSnapshotId);
  if (!comparisonResult.ok || !comparisonResult.snapshot) {
    return { ok: false, draftId: null, errors: comparisonResult.errors };
  }

  // P1.8: 사용자가 설정한 "내 글 스타일"을 생성 직전에 읽어 넘긴다(앱 시작 시 캐시하지
  // 않으므로 스타일을 바꿔 저장하면 다음 생성부터 바로 반영된다). 아직 저장된 스타일이
  // 없으면 넘기지 않고 기존 프롬프트 그대로 동작한다.
  const personaRow = getCurrentPersona();
  const personaStyleBlock = personaRow ? buildPersonaStyleBlock(personaRow.data) : undefined;
  const threadsCopyResult = await generateProductRadarThreadsCopy(comparisonResult.snapshot, recommendationRecord, personaStyleBlock);
  if (!threadsCopyResult.ok || !threadsCopyResult.result) {
    return { ok: false, draftId: null, errors: threadsCopyResult.errors };
  }

  const draftInput = buildProductRadarDraftInput(recommendationRecord.id, threadsCopyResult.result);

  let draftIds: number[];
  try {
    draftIds = insertDraftsAtomic([draftInput]);
  } catch {
    // raw DB 예외 메시지(FK 위반 등)를 그대로 caller에 노출하지 않는다(요청서 27절) - 이
    // 시점의 FK 위반은 이론상 불가능하다(바로 위에서 exact recommendation row 존재를 이미
    // 확인했으므로) - 그럼에도 방어적으로 fail closed한다.
    return { ok: false, draftId: null, errors: ["threads_copy_draft_persistence_failed"] };
  }
  if (draftIds.length !== 1) {
    return { ok: false, draftId: null, errors: ["threads_copy_draft_persistence_failed"] };
  }

  return {
    ok: true,
    recommendationSnapshotId: recommendationRecord.id,
    comparisonSnapshotId: comparisonResult.snapshot.id,
    draftId: draftIds[0],
    threadsCopy: threadsCopyResult.result,
    errors: [],
  };
}
