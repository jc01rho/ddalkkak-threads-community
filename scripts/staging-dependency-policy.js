// scripts/staging-dependency-policy.js
//
// build-windows-staging.js의 production dependency completeness gate가 쓰는
// 순수 판정 함수입니다. 파일시스템/네트워크에 전혀 접근하지 않으므로
// scripts/test-runner.js가 그대로 require해서 계약을 영구 검증합니다
// (테스트가 이 로직을 복제하면 같은 버그를 공유하므로, 반드시 이 함수만이
// 판정의 단일 출처여야 합니다).
//
// 계약 (release gate):
//   - dev === true            -> "skip-dev"                    (staging에 절대 포함하지 않음)
//   - 미설치 + optional true  -> "skip-optional-not-installed" (npm이 이 플랫폼에 설치하지
//                                않은 optionalDependency, 예: @img/sharp-darwin-arm64.
//                                missing production failure가 아님)
//   - 미설치 + optional 아님  -> "fail-missing-production"     (진짜 누락, staging build FAIL)
//   - 설치됨(비-dev)          -> "copy"                        (optional 여부와 무관하게 복사.
//                                예: @img/sharp-win32-x64는 optional이지만 반드시 포함)

function decideStagingPackageAction(lockEntry, isInstalled) {
  if (lockEntry && lockEntry.dev === true) return "skip-dev";
  if (!isInstalled) {
    if (lockEntry && lockEntry.optional === true) return "skip-optional-not-installed";
    return "fail-missing-production";
  }
  return "copy";
}

module.exports = { decideStagingPackageAction };
