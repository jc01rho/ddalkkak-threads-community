// src/productRadar/recommendationOrchestration.ts
// 상품 레이더 Phase 12.4.2: Recommendation Generation Persistence Orchestration.
//
// 이 파일의 책임은 "흐름 조립"뿐이다(comparisonOrchestration.ts와 동일 원칙) -
// Claude prompt/parser/domain 검증 로직은 recommendationClaude.ts/recommendation.ts/
// recommendationClaudeContract.ts에 이미 있고, SQL은 recommendationPersistence.ts에
// 이미 있다 - 이 파일은 그 셋을 정확한 순서로만 호출한다. 아무것도 복제하지 않는다.
//
// 흐름: comparisonSnapshotId -> getProductRadarComparisonSnapshotById()로 canonical
// ComparisonSnapshot 확보 -> generateRecommendationWithClaude(snapshot, outputLanguage) ->
// 실패면 즉시 반환(persistence 호출 자체를 안 함) -> 성공한 RecommendationResult에서
// products/missingInformation만 추출 -> insertProductRadarRecommendationSnapshot(
// comparisonSnapshotId, outputLanguage, {products, missingInformation}) -> 그 결과를
// 그대로 반환.
//
// runProductRadarComparisonGroup()(comparisonOrchestration.ts)이 자신의 성공 결과로
// persistence의 ComparisonSnapshotBuildResult를 그대로 재사용하는 것과 동일하게, 이
// 함수도 새 wrapper 타입을 만들지 않고 recommendationPersistence.ts의
// RecommendationSnapshotBuildResult를 그대로 반환한다 - "persist된 record가 최종
// canonical source"라는 원칙(요청서 24절)과, 불필요한 새 taxonomy를 만들지 않는다는
// 원칙(요청서 23절) 둘 다 이 재사용으로 자연스럽게 만족된다.
//
// Claude generation 성공 결과(메모리 RecommendationResult)를 그대로 DB에 꽂지 않는다 -
// insertProductRadarRecommendationSnapshot()이 comparisonSnapshotId로 부모 snapshot을
// 다시 읽고 buildRecommendationResult()로 재검증하는 기존 double-validation 구조를
// 그대로 신뢰한다(요청서 3·12절 - 이 파일이 그 재검증을 최적화한다며 건너뛰지 않는다).
//
// database.ts를 직접 import하지 않는다 - live product 재조회
// (getProductRadarProduct())도 없다. Claude generation의 유일한 factual source는
// getProductRadarComparisonSnapshotById()가 반환한 frozen ComparisonSnapshot 하나뿐이다
// (요청서 4절). Express/route/fetch/spawn/child_process/filesystem/env secret도 이
// 파일에 없다 - Claude 실행은 recommendationClaude.ts 하나에만, SQL은
// recommendationPersistence.ts 하나에만 있다(요청서 14절).
//
// db.transaction()을 이 파일이 직접 열지 않는다 - snapshot 조회(짧은 SELECT, 즉시
// 종료) -> Claude generation(수십 초 걸릴 수 있음, DB 미접근) -> 짧은 persistence
// INSERT transaction 순서가 이미 자연스럽게 "Claude 호출 중 DB transaction 없음"을
// 보장한다(요청서 11절 - 새 transaction 경계 설계가 필요 없다).
//
// retry 없음(요청서 22절) - Claude generation도, persistence insert도 정확히 1회씩만
// 호출한다. 실패하면 그 실패를 그대로 반환하고 끝난다 - caller가 원하면 이 함수를
// 다시 호출할 수 있지만, 그 재호출 로직은 이 함수 밖의 책임이다.

import { getProductRadarComparisonSnapshotById } from "./comparisonPersistence";
import { generateRecommendationWithClaude } from "./recommendationClaude";
import { insertProductRadarRecommendationSnapshot, RecommendationSnapshotBuildResult } from "./recommendationPersistence";
import { RecommendationOutputLanguage } from "./types";

export async function generateAndPersistRecommendation(
  comparisonSnapshotId: number,
  outputLanguage: RecommendationOutputLanguage
): Promise<RecommendationSnapshotBuildResult> {
  const snapshotResult = getProductRadarComparisonSnapshotById(comparisonSnapshotId);
  if (!snapshotResult.ok || !snapshotResult.snapshot) {
    return { ok: false, record: null, errors: snapshotResult.errors };
  }

  const generated = await generateRecommendationWithClaude(snapshotResult.snapshot, outputLanguage);
  if (!generated.ok || !generated.recommendation) {
    return { ok: false, record: null, errors: generated.errors };
  }

  return insertProductRadarRecommendationSnapshot(comparisonSnapshotId, outputLanguage, {
    products: generated.recommendation.products,
    missingInformation: generated.recommendation.missingInformation,
  });
}
