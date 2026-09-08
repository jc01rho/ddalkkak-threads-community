// src/scheduler.ts
// node-cron으로 1분마다 예약된 글 중 발행 시간이 지난 글을 확인하고, 공식 Threads API로 발행합니다.
//
// 안전장치 요약:
// - "자동 발행" 토글(대시보드/설정에서 켜고 끔)이 꺼져 있으면 스케줄러는 아무 것도 하지 않습니다.
//   (이 토글이 꺼진 상태 = 기본값이며, 아무 글도 건드리지 않는 가장 안전한 상태입니다)
// - DRY_RUN=true(기본값)면 절대 실제로 게시하지 않고, "모의 발행" 로그만 남기고
//   해당 글의 상태를 'dry_run_done'으로 바꿔 다음 예약 목록/재처리 대상에서 제외합니다.
//   DRY_RUN 모드는 Threads 토큰/사용자 ID가 없어도 항상 동작합니다(토큰 검사를 하지 않습니다).
// - 실제 발행(DRY_RUN=false)은 다음 조건을 모두 만족해야 합니다:
//   1) Threads API 토큰 검증 성공
//   2) DRY_RUN=false
//   3) 글 상태가 scheduled
//   4) 예약 시간이 도달함
//   5) 본문이 비어 있지 않음
//   6) 동일 글이 발행(처리)된 기록이 없음 (publish_log에 draft_id로 이미 기록이 있으면 건너뜀)
// - 하루 최대 발행 수를 넘지 않습니다. 이 값은 예약 루틴 화면(src/routes/scheduleRoutine.ts)에서
//   저장한 dailyLimit을 매 tick마다 다시 읽어 사용합니다(getScheduleRoutine()). 저장된 값이 없거나
//   손상됐으면 .env의 DAILY_MAX_PUBLISH(기본 6)가 기본값으로 쓰입니다.
// - 인증 오류는 자동 재시도하지 않고, 그 외 오류는 최대 2회까지 재시도합니다. Phase 12.5.4부터는
//   재시도해도 결과가 같은 미디어 오류(포맷 미지원/파일 없음/public URL 미설정/처리 자체 실패)도
//   인증 오류와 동일하게 즉시 실패 처리합니다(threadsPublishDispatcher.ts의 noRetry).
// - 발행 직전 status를 'publishing'으로 원자적으로 바꿔서(claimDraftForPublishing) 중복 발행을 막습니다.
// - Phase 12.5.4: 실제 발행은 publishTextToThreads()를 직접 부르지 않고
//   threadsPublishDispatcher.publishDraftToThreads(draft)를 거칩니다 - 첨부 미디어가 없으면
//   기존과 동일하게 TEXT만 발행하고, 있으면 IMAGE/VIDEO/CAROUSEL까지 발행합니다(CAROUSEL은
//   Phase 12.5.4.1부터). 미디어를 요구했는데 발행하지 못하면(미지원 포맷/GIF/캐러셀 개수 범위
//   초과/public URL 없음/영상 처리 실패 등) 텍스트만 대신 게시하는 fallback은 절대 하지
//   않습니다 - 미디어까지 성공해야 published가 됩니다.

import cron, { ScheduledTask } from "node-cron";
import { config } from "./env";
import { validateThreadsToken } from "./threads-api";
import { publishDraftToThreads } from "./threadsPublishDispatcher";
import { resolveDraftPublishMedia } from "./threadsMediaAttachment";
import { maybeRefreshThreadsToken } from "./threadsOAuth";
import {
  claimDraftForPublishing,
  countRealPublishedToday,
  getDraft,
  getPublishLogsForDraft,
  getScheduleRoutine,
  hasPublishLogForDraft,
  insertPublishLog,
  isAutoPublishEnabled,
  listDraftsByStatus,
  listDueScheduledDrafts,
  markDraftDryRunDone,
  markDraftFailed,
  markDraftPublished,
  nowIso,
  revertDraftToScheduledWithRetry,
} from "./database";

let task: ScheduledTask | null = null;
const MAX_RETRY = 2;

// node-cron 반복 콜백. "trigger"는 node-cron이 넘겨주는 값으로,
// 시작 직후 즉시 실행이면 "init", 수동 실행(테스트용)이면 "manual",
// 정기 실행(매분)이면 실제 Date 객체가 들어옵니다.
// 최상단부터 전체를 try/catch로 감싸서, 이 콜백 안에서 어떤 예외가 나도
// 프로세스가 죽거나 다음 tick이 등록 안 되는 일 없이 CMD에 스택을 남기고 넘어갑니다.
function runTick(trigger: Date | "manual" | "init"): void {
  const startedAt = nowIso();
  // 요청사항: 콜백이 실제로 호출되는지 눈으로 바로 확인할 수 있도록 첫 줄에 무조건 출력.
  console.log(`[scheduler] tick 시작: ${startedAt} (trigger=${trigger})`);
  try {
    processDueScheduledDrafts().catch((e) => {
      console.error(`[scheduler] tick 처리 중 오류(비동기): ${e && e.stack ? e.stack : e}`);
    });
  } catch (e: any) {
    console.error(`[scheduler] tick 실행 중 오류(동기): ${e && e.stack ? e.stack : e}`);
  }
}

export function startScheduler(): void {
  if (task) return;
  task = cron.schedule("* * * * *", runTick, {
    timezone: "Asia/Seoul",
    // 서버가 켜진 시점에 예약 시간이 이미 지나 있어도 다음 정각까지 기다리지 않도록
    // 시작 직후 1회 즉시 실행하고, 이후 매분 반복 실행합니다.
    runOnInit: true,
  });
  console.log("[scheduler] 예약 발행 스케줄러 시작 (Asia/Seoul, 1분마다 확인, 시작 직후 1회 즉시 실행)");
}

export function stopScheduler(): void {
  if (task) {
    task.stop();
    task = null;
  }
}

// 테스트 전용: 실제로 1분을 기다리지 않고도 "반복 콜백이 실제로 다시 호출되는지"를
// 검증하기 위해, 시작된 스케줄러의 동일한 task를 한 번 더 수동으로 트리거합니다.
export function triggerTickForTesting(): void {
  if (!task) throw new Error("스케줄러가 시작되지 않았습니다. startScheduler()를 먼저 호출하세요.");
  task.now();
}

export interface ProcessSummary {
  licenseValid: boolean; // false면 이 tick은 라이선스 검사에서 즉시 중단되어 아래 필드는 전부 0/빈 상태입니다.
  autoPublishEnabled: boolean;
  found: number; // 예약 시간이 지난(due) 글 수
  checked: number; // 실제로 검토를 시작한 글 수 (found와 보통 같음)
  dryRunLogged: number;
  published: number;
  failed: number;
  retried: number;
  skippedDailyLimit: number;
  skippedDuplicate: number;
  legacyReconciled: number; // 구버전 버그로 인해 처리 기록은 있는데 상태가 scheduled로 남아있던 글을 자동 복구한 수
}

// 구버전 스케줄러는 DRY_RUN 처리 후 publish_log만 남기고 draft 상태를 바꾸지 않는 버그가 있었습니다.
// 그 결과 이미 처리된(로그가 있는) 글이 여전히 status='scheduled'로 남아, 매 tick마다 계속 "만기 예약"으로
// 재발견되는 레거시 데이터가 생겼습니다.
// 이 함수는 그런 글을 재게시(재시도)하지 않고, 기존 publish_log 기록만 근거로 draft 상태를 안전하게 보정합니다.
// - publish_log를 새로 추가하거나 삭제하지 않습니다 (감사 기록 보존, 요구사항 4/7)
// - 이미 실제 발행 성공 기록이 있으면 published로, DRY_RUN 완료 기록만 있으면 dry_run_done으로 복구합니다.
// - scheduled_at은 원래 예약 시각을 그대로 남겨 두어 그 자체가 감사 기록이 되도록 합니다(별도로 지우지 않음).
function reconcileLegacyStatusMismatch(draft: { id: number }, tag: string): boolean {
  const logs = getPublishLogsForDraft(draft.id);
  const realSuccess = logs.some((l) => l.success === 1 && l.dry_run === 0);
  const dryRunDone = logs.some((l) => l.dry_run === 1);

  if (!realSuccess && !dryRunDone) return false; // 판단할 근거가 없으면 손대지 않음

  console.log(`${tag} → 기존 처리 기록과 상태 불일치 발견`);
  if (realSuccess) {
    markDraftPublished(draft.id);
    console.log(`${tag} → published로 상태 복구`);
  } else {
    markDraftDryRunDone(draft.id);
    console.log(`${tag} → dry_run_done으로 상태 복구`);
  }
  return true;
}

// 서버가 발행 도중(status='publishing') 죽으면 그 글은 어디에서도 다시 다뤄지지 않습니다.
// listDueScheduledDrafts는 status='scheduled'만 찾으므로 스케줄러가 다시 집어들지 않고,
// 예약 관리 화면에는 "발행 중" 카드가 취소도 변경도 안 되는 채로 영원히 남습니다.
//
// 복구 원칙은 "이미 남아 있는 기록만 근거로 삼고, 절대 다시 게시하지 않는다"입니다.
// 기록 없이 publishing으로 남은 글을 scheduled로 되돌리면, 죽기 직전에 Threads가 이미
// 글을 받았을 경우 같은 글이 두 번 올라갑니다(과거 판매중지 원인). 그래서 판단이 불가능한
// 경우는 실패로 표시해 사용자가 직접 확인하고 다시 예약하도록 남겨둡니다.
export function reconcileInterruptedPublishing(): { recovered: number; published: number; failed: number } {
  const stuck = listDraftsByStatus("publishing");
  const result = { recovered: 0, published: 0, failed: 0 };
  for (const draft of stuck) {
    const logs = getPublishLogsForDraft(draft.id);
    const realSuccess = logs.some((l) => l.success === 1 && l.dry_run === 0);
    if (realSuccess) {
      markDraftPublished(draft.id);
      result.published++;
      console.log(`[scheduler] 글 #${draft.id} → 발행 성공 기록이 있어 published로 복구`);
    } else {
      // 기록이 실패뿐이거나 아예 없는 경우. 재게시하지 않고 실패로 표시한다.
      markDraftFailed(draft.id);
      if (logs.length === 0) {
        insertPublishLog({
          draft_id: draft.id,
          body: draft.body || "",
          scheduled_at: draft.scheduled_at,
          success: false,
          dry_run: false,
          // 이 글은 "실패한 글"이 아니라 "결과를 모르는 글"이다. Meta가 게시를 받은 직후
          // 기록을 남기기 전에 종료됐을 수 있어, 구매자가 바로 다시 예약하면 같은 글이 두 번
          // 올라간다. 그래서 문구가 반드시 "확인 불가 → Threads에서 먼저 확인"으로 읽혀야 한다.
          error_message:
            "게시 처리 중 프로그램이 종료되어 실제 게시 여부를 확인할 수 없습니다. Threads에서 게시 여부를 먼저 확인한 뒤 다시 시도해 주세요.",
          sources: draft.source_url,
          persona_version: draft.persona_version,
        });
      }
      result.failed++;
      console.log(`[scheduler] 글 #${draft.id} → 발행 결과를 확인할 수 없어 failed로 표시(재게시하지 않음)`);
    }
    result.recovered++;
  }
  if (result.recovered > 0) {
    console.log(`[scheduler] 중단된 발행 복구 완료 · 대상 ${result.recovered} · published ${result.published} · failed ${result.failed}`);
  }
  return result;
}

// 스케줄러가 매분 실행하는 핵심 함수. 테스트에서도 직접 호출해서 검증합니다.
export async function processDueScheduledDrafts(): Promise<ProcessSummary> {
  const emptySummary = (licenseValid: boolean, autoPublishEnabled: boolean): ProcessSummary => ({
    licenseValid,
    autoPublishEnabled,
    found: 0,
    checked: 0,
    dryRunLogged: 0,
    published: 0,
    failed: 0,
    retried: 0,
    skippedDailyLimit: 0,
    skippedDuplicate: 0,
    legacyReconciled: 0,
  });

  // P0.5: OAuth로 연결한 long-lived 토큰의 자동 갱신. 매 tick 네트워크를 쓰지 않고
  // expiresAtIso 기준으로 "만료 10일 전 + 저장 24시간 경과 + 실패 후 6시간 쿨다운"일 때만
  // 1회 호출한다(threadsOAuth.decideTokenRefresh). 수동 연결(만료 미상)은 건드리지 않으며,
  // 갱신 실패 시 기존 토큰을 지우지 않는다. 라이선스 검증 뒤에 두어 무효 라이선스에서는 호출 0.
  try {
    await maybeRefreshThreadsToken();
  } catch (e: any) {
    console.warn(`[scheduler] 토큰 자동 갱신 확인 중 오류(무시하고 계속): ${e?.message || e}`);
  }

  const nowStr = nowIso();
  const autoPublishEnabled = isAutoPublishEnabled();
  const summary: ProcessSummary = { ...emptySummary(true, autoPublishEnabled) };

  // "자동 발행"이 꺼져 있으면(기본값) 스케줄러는 예약 글을 조회만 하고 아무 것도 처리하지 않습니다.
  // 이렇게 하면 사용자가 명시적으로 켜기 전까지는 DRY_RUN 로그조차 남기지 않는, 가장 안전한 상태가 유지됩니다.
  if (!autoPublishEnabled) {
    const dueCount = listDueScheduledDrafts(nowStr).length;
    summary.found = dueCount;
    console.log(
      `[scheduler] 확인 시각(UTC)=${nowStr} · 예약 시간이 지난 글 ${dueCount}개 발견 · 자동 발행이 꺼져 있어 처리하지 않습니다. (대시보드에서 "자동 발행"을 켜주세요)`
    );
    return summary;
  }

  const dueDrafts = listDueScheduledDrafts(nowStr);
  summary.found = dueDrafts.length;
  let publishedSoFarToday = countRealPublishedToday();

  // 하루 최대 발행 수는 예약 루틴 화면에서 저장한 dailyLimit을 그대로 씁니다(승인 글 자동배치
  // 계획이 쓰는 값과 완전히 동일한 단일 값 - database.ts의 getScheduleRoutine() 참고). settings에
  // 저장된 값이 없거나 손상됐으면 .env의 DAILY_MAX_PUBLISH가 기본값으로 쓰입니다. 매 tick마다
  // 다시 읽으므로, 화면에서 dailyLimit을 바꾸면 서버 재시작 없이 다음 tick부터 바로 반영됩니다.
  const effectiveDailyLimit = getScheduleRoutine().dailyLimit;

  console.log(
    `[scheduler] 확인 시각(UTC)=${nowStr} · DRY_RUN=${config.DRY_RUN} · 하루 최대 발행 수=${effectiveDailyLimit} · 예약 시간이 지난 글 ${dueDrafts.length}개 발견`
  );

  // draft는 claim 성공 직후 최신값으로 한 번 다시 읽는다(아래 참고) - 그래서 const가 아니다.
  for (let draft of dueDrafts) {
    summary.checked++;
    const tag = `[scheduler] 글 #${draft.id} (예약=${draft.scheduled_at})`;

    // 조건 6: 동일 글이 이미 처리(로그)된 적 있으면 건너뜀 -> 중복 발행 방지
    // 단, status가 여전히 'scheduled'인데 처리 기록이 있다면(구버전 버그로 인한 레거시 불일치)
    // 재게시하는 대신 기존 기록을 근거로 상태만 안전하게 복구합니다.
    if (hasPublishLogForDraft(draft.id)) {
      const reconciled = reconcileLegacyStatusMismatch(draft, tag);
      if (reconciled) {
        summary.legacyReconciled++;
      } else {
        summary.skippedDuplicate++;
        console.log(`${tag} → 건너뜀 (이미 처리 기록 있음, 중복 방지)`);
      }
      continue;
    }

    // 최종 guard: 제휴 홍보글인데 발행 본문에 제휴링크가 없고, 사용자가 "링크 없이 예약"을
    // 명시적으로 승인하지도 않은 글은 발행하지 않는다. 승인한 글
    // (allow_publish_without_affiliate_link = 1)은 여기서 다시 막지 않는다 - 승인은 예약 행에
    // 저장돼 있어 프로그램을 재시작해도 그대로 유지된다.
    // 이 검사는 source_type='affiliate_product'에만 적용된다(일반 글/직접 작성/상품 레이더 무관).
    if (
      draft.source_type === "affiliate_product" &&
      !draft.allow_publish_without_affiliate_link &&
      !String(draft.body ?? "").includes(String(draft.affiliate_url ?? " "))
    ) {
      markDraftFailed(draft.id);
      insertPublishLog({
        draft_id: draft.id,
        body: draft.body || "",
        scheduled_at: draft.scheduled_at,
        success: false,
        dry_run: config.DRY_RUN,
        error_message: "제휴 홍보글인데 본문에 제휴링크가 없고 '링크 없이 예약' 승인도 없어 발행하지 않았습니다.",
        sources: draft.source_url,
        persona_version: draft.persona_version,
      });
      summary.failed++;
      console.log(`${tag} → 실패 (제휴링크 없음 + 사용자 승인 없음)`);
      continue;
    }

    // 조건 5: 본문이 비어 있으면 실패 처리
    if (!draft.body || !String(draft.body).trim()) {
      markDraftFailed(draft.id);
      insertPublishLog({
        draft_id: draft.id,
        body: draft.body || "",
        scheduled_at: draft.scheduled_at,
        success: false,
        dry_run: config.DRY_RUN,
        error_message: "본문이 비어 있어 발행할 수 없습니다.",
        sources: draft.source_url,
        persona_version: draft.persona_version,
      });
      summary.failed++;
      console.log(`${tag} → 실패 (본문 비어 있음)`);
      continue;
    }

    // DRY_RUN 모드: 실제로 게시하지 않고 "모의 발행" 로그만 남긴 뒤, 상태를 완료(dry_run_done)로 바꾼다.
    // Threads 토큰/사용자 ID가 없어도 이 경로는 항상 정상 동작한다. 미디어 종류 판정
    // (resolveDraftPublishMedia)은 DB/디스크만 보는 순수 로컬 판정이라 네트워크 호출이 전혀
    // 없다 - DRY_RUN에서도 안전하게 호출해 로그에 어떤 미디어로 시도될지 남길 수 있다.
    if (config.DRY_RUN) {
      const dryRunMedia = resolveDraftPublishMedia(draft);
      const dryRunMediaNote =
        dryRunMedia.kind === "none"
          ? "TEXT"
          : dryRunMedia.kind === "unsupported"
          ? `UNSUPPORTED(${dryRunMedia.reasonCode})`
          : dryRunMedia.kind === "carousel"
          ? `CAROUSEL(${dryRunMedia.items?.length ?? 0}개)`
          : dryRunMedia.kind.toUpperCase();
      insertPublishLog({
        draft_id: draft.id,
        body: draft.body,
        scheduled_at: draft.scheduled_at,
        success: false,
        dry_run: true,
        error_message: `[DRY_RUN] 실제로 발행하지 않았습니다. 모의 발행 처리(내용 기록)만 완료했습니다. (미디어: ${dryRunMediaNote})`,
        sources: draft.source_url,
        persona_version: draft.persona_version,
        media_type: dryRunMedia.kind === "none" ? "TEXT" : dryRunMedia.kind === "unsupported" ? null : dryRunMedia.kind.toUpperCase(),
      });
      markDraftDryRunDone(draft.id);
      summary.dryRunLogged++;
      console.log(`${tag} → DRY_RUN 처리 완료 (실제 게시 안 함, 상태: dry_run_done, 미디어: ${dryRunMediaNote})`);
      continue;
    }

    // 여기부터는 실제 발행 경로 (DRY_RUN=false)
    // 하루 최대 발행 수 체크
    if (publishedSoFarToday >= effectiveDailyLimit) {
      summary.skippedDailyLimit++;
      console.log(`${tag} → 건너뜀 (하루 최대 발행 수 ${effectiveDailyLimit}개 도달)`);
      continue;
    }

    // 조건 1: 토큰 검증 (실제 게시 직전에만 수행 - DRY_RUN 경로에서는 절대 검사하지 않음)
    const tokenCheck = await validateThreadsToken();
    if (!tokenCheck.valid) {
      markDraftFailed(draft.id);
      insertPublishLog({
        draft_id: draft.id,
        body: draft.body,
        scheduled_at: draft.scheduled_at,
        success: false,
        dry_run: false,
        error_message: `토큰 검증 실패: ${tokenCheck.error}`,
        sources: draft.source_url,
        persona_version: draft.persona_version,
      });
      summary.failed++;
      console.log(`${tag} → 실패 (Threads 토큰 검증 실패: ${tokenCheck.error})`);
      continue;
    }

    // 발행 직전 잠금(트랜잭션 성격의 원자적 UPDATE)으로 중복 발행 방지
    const claimed = claimDraftForPublishing(draft.id);
    if (!claimed) {
      summary.skippedDuplicate++;
      console.log(`${tag} → 건너뜀 (이미 다른 처리에서 선점됨)`);
      continue;
    }

    // claim 성공 후 draft를 딱 한 번 다시 읽는다.
    //
    // 위의 listDueScheduledDrafts()로 행을 읽은 시점과 claim 사이에는 아주 짧지만 사용자가
    // [수정 저장]으로 본문/미디어를 바꿀 수 있는 틈이 있다(예약된 글도 발행 전이면 수정
    // 가능하다 - routes/drafts.ts PATCH 참고). 그 틈에 저장된 내용이 DB에는 반영됐는데 이
    // 1회 발행만 옛 객체로 나가는 것을 막는다. claim이 status를 'publishing'으로 바꾼 뒤에는
    // updateDraftContent()의 원자 조건절이 수정을 거부하므로, 여기서 읽은 값이 곧 최종본이다.
    //
    // 정책은 전혀 바뀌지 않는다: 예약 시각/ASC 처리/daily limit/자동 발행 스위치/claim CAS/
    // publish_log 중복 방지/retry 계산은 그대로이고, "무엇을 발행하는지"만 최신값이 된다.
    // 재조회가 실패하는 경우(정상 흐름에서는 불가능 - 방금 UPDATE에 성공한 행이다)에는
    // 기존 객체를 그대로 써서 발행이 멈추지 않게 한다.
    draft = getDraft(draft.id) || draft;

    // Phase 12.5.4/12.5.4.1: 미디어 종류 판별 -> (있으면) media/carousel item container 생성 ->
    // 준비 상태 확인 -> 실제 발행까지 threadsPublishDispatcher가 전부 조립한다. 첨부 미디어가
    // 있는데 발행하지 못하면(미지원 포맷/GIF/캐러셀 개수 범위 초과/public URL 없음/처리 실패
    // 등) 이 함수는 절대 TEXT로 조용히 강등하지 않고 실패를 그대로 돌려준다 - 아래 분기가 그
    // 실패를 성공으로 둔갑시키지 않는다.
    const result = await publishDraftToThreads(draft);
    const mediaTag = result.mediaFilename
      ? ` [미디어: ${result.mediaType}/${result.sourceMediaId}/${result.mediaFilename}]`
      : result.itemCount
      ? ` [미디어: ${result.mediaType}/${result.sourceMediaId}/${result.itemCount}개]`
      : "";

    if (result.success) {
      markDraftPublished(draft.id);
      insertPublishLog({
        draft_id: draft.id,
        body: draft.body,
        scheduled_at: draft.scheduled_at,
        published_at: nowIso(),
        threads_post_id: result.postId,
        success: true,
        dry_run: false,
        sources: draft.source_url,
        persona_version: draft.persona_version,
        media_type: result.mediaType,
      });
      summary.published++;
      publishedSoFarToday++;
      console.log(`${tag} → 발행 성공 (게시물 ID: ${result.postId})${mediaTag}`);
    } else if (result.authError || result.noRetry) {
      // 인증 오류, 또는 재시도해도 결과가 같을 미디어 오류(noRetry)는 자동 재시도하지 않는다.
      markDraftFailed(draft.id);
      const reasonLabel = result.authError ? "인증 오류" : `미디어 오류: ${result.mediaErrorCode || "unknown"}`;
      insertPublishLog({
        draft_id: draft.id,
        body: draft.body,
        scheduled_at: draft.scheduled_at,
        success: false,
        dry_run: false,
        error_message: `${reasonLabel}(재시도 안 함): ${result.error}`,
        sources: draft.source_url,
        persona_version: draft.persona_version,
        media_type: result.mediaType,
      });
      summary.failed++;
      console.log(`${tag} → 실패 (${reasonLabel}, 재시도 안 함: ${result.error})${mediaTag}`);
    } else if (draft.retry_count < MAX_RETRY) {
      // 인증/미디어 확정 오류가 아니면 최대 2회까지 재시도 (다음 스케줄러 tick에서 다시 시도)
      revertDraftToScheduledWithRetry(draft.id);
      insertPublishLog({
        draft_id: draft.id,
        body: draft.body,
        scheduled_at: draft.scheduled_at,
        success: false,
        dry_run: false,
        error_message: `발행 실패, 재시도 예정 (${draft.retry_count + 1}/${MAX_RETRY}): ${result.error}`,
        sources: draft.source_url,
        persona_version: draft.persona_version,
        media_type: result.mediaType,
      });
      summary.retried++;
      console.log(`${tag} → 재시도 예정 (${draft.retry_count + 1}/${MAX_RETRY}): ${result.error}${mediaTag}`);
    } else {
      markDraftFailed(draft.id);
      insertPublishLog({
        draft_id: draft.id,
        body: draft.body,
        scheduled_at: draft.scheduled_at,
        success: false,
        dry_run: false,
        error_message: `재시도 ${MAX_RETRY}회 모두 실패: ${result.error}`,
        sources: draft.source_url,
        persona_version: draft.persona_version,
        media_type: result.mediaType,
      });
      summary.failed++;
      console.log(`${tag} → 최종 실패 (재시도 ${MAX_RETRY}회 모두 실패: ${result.error})${mediaTag}`);
    }
  }

  console.log(
    `[scheduler] 처리 완료 · 발견 ${summary.found} · DRY_RUN처리 ${summary.dryRunLogged} · 발행 ${summary.published} · 실패 ${summary.failed} · 재시도 ${summary.retried} · 중복건너뜀 ${summary.skippedDuplicate} · 레거시복구 ${summary.legacyReconciled} · 일일한도초과 ${summary.skippedDailyLimit}`
  );

  return summary;
}
