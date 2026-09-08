// src/scheduleRoutine.ts
// "예약 루틴 저장 + 승인 글 일괄 자동배치" 전용 로직.
// - 예약 루틴(반복 시간/요일/하루 최대 발행 수) 검증과 기본값
// - 선택된 승인 글들을 루틴에 맞춰 빈 슬롯에 순서대로 배치하는 계획 알고리즘(DB에 쓰지 않는 순수 함수)
//
// 이 파일은 DB에 직접 접근하지 않습니다(라우트가 database.ts로 조회한 결과를 인자로 넘겨줍니다).
// 모든 날짜/요일 계산은 Asia/Seoul 기준이며, DST가 없는 시간대라 UTC 날짜 산술로 안전하게 처리합니다.

export interface ScheduleRoutine {
  times: string[]; // 정렬된 "HH:mm" 배열, 중복 없음
  weekdays: number[]; // 0(일)~6(토), JS Date.getDay()와 동일한 규칙, 정렬됨
  dailyLimit: number; // 1~20
  timezone: "Asia/Seoul";
}

export const MIN_ROUTINE_TIMES = 1;
export const MAX_ROUTINE_TIMES = 20;
export const MIN_DAILY_LIMIT = 1;
export const MAX_DAILY_LIMIT = 20;

// 예약 루틴의 dailyLimit은 자동배치 계획과 스케줄러의 실제 발행 하루 상한이 함께 사용하는
// 단일 값입니다(database.ts의 getScheduleRoutine() 참고). 이 기본값(6)은 settings에 저장된
// 값이 아예 없을 때만 쓰이는 "최후의" 기본값이고, 실제로는 getScheduleRoutine()이 settings가
// 없거나 손상된 경우 이 값 대신 config.DAILY_MAX_PUBLISH를 기본값으로 사용합니다.
export const DEFAULT_SCHEDULE_ROUTINE: ScheduleRoutine = {
  times: ["09:00", "12:00", "18:00", "21:00"],
  weekdays: [0, 1, 2, 3, 4, 5, 6], // 매일
  dailyLimit: 6,
  timezone: "Asia/Seoul",
};

export function clampDailyLimit(n: number): number {
  const int = Number.isFinite(n) ? Math.trunc(n) : DEFAULT_SCHEDULE_ROUTINE.dailyLimit;
  return Math.min(MAX_DAILY_LIMIT, Math.max(MIN_DAILY_LIMIT, int));
}

// 새 예약이 저장되려면 지금부터 최소 이만큼 여유가 있어야 합니다(기존 reschedule API의
// MIN_RESCHEDULE_LEAD_MS와 동일한 값 - 스케줄러가 1분마다 확인하므로 2분 여유를 둡니다).
export const MIN_SCHEDULE_LEAD_MS = 2 * 60 * 1000;

const HHMM_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export type RoutineValidationResult = { ok: true; value: ScheduleRoutine } | { ok: false; error: string };

// 예약 루틴 입력 검증(요청서 1번). 실패하면 명확한 사유를 돌려주고, 성공하면 정렬·중복 제거된
// 값을 돌려줍니다. 설정값이 손상된 경우의 기본값 복구는 이 함수를 호출하는 쪽(routes/schedule.ts)
// 에서 실패 시 DEFAULT_SCHEDULE_ROUTINE으로 대체하는 방식으로 처리합니다.
export function validateScheduleRoutineInput(body: any): RoutineValidationResult {
  if (!Array.isArray(body?.times) || body.times.length === 0) {
    return { ok: false, error: "예약 시간을 1개 이상 입력해주세요." };
  }

  const seen = new Set<string>();
  const cleanedTimes: string[] = [];
  for (const raw of body.times) {
    const t = typeof raw === "string" ? raw.trim() : "";
    if (!HHMM_PATTERN.test(t)) {
      return { ok: false, error: `올바르지 않은 시간 형식입니다: "${raw}" (HH:mm 형식이어야 합니다. 예: 09:30)` };
    }
    if (!seen.has(t)) {
      seen.add(t);
      cleanedTimes.push(t);
    }
  }
  if (cleanedTimes.length < MIN_ROUTINE_TIMES) {
    return { ok: false, error: "예약 시간을 1개 이상 입력해주세요." };
  }
  if (cleanedTimes.length > MAX_ROUTINE_TIMES) {
    return { ok: false, error: `예약 시간은 최대 ${MAX_ROUTINE_TIMES}개까지 등록할 수 있습니다.` };
  }
  // "HH:mm" 문자열은 사전순 정렬이 곧 시간순 정렬입니다.
  cleanedTimes.sort();

  if (!Array.isArray(body?.weekdays) || body.weekdays.length === 0) {
    return { ok: false, error: "요일을 최소 1개 이상 선택해주세요." };
  }
  const weekdaySet = new Set<number>();
  for (const raw of body.weekdays) {
    const n = parseInt(String(raw), 10);
    if (!Number.isInteger(n) || n < 0 || n > 6) {
      return { ok: false, error: `올바르지 않은 요일 값입니다: ${raw} (0=일요일 ~ 6=토요일)` };
    }
    weekdaySet.add(n);
  }
  const weekdays = Array.from(weekdaySet).sort((a, b) => a - b);

  const dailyLimitRaw = parseInt(String(body?.dailyLimit ?? DEFAULT_SCHEDULE_ROUTINE.dailyLimit), 10);
  if (!Number.isFinite(dailyLimitRaw) || dailyLimitRaw < MIN_DAILY_LIMIT || dailyLimitRaw > MAX_DAILY_LIMIT) {
    return { ok: false, error: `하루 최대 발행 수는 ${MIN_DAILY_LIMIT}~${MAX_DAILY_LIMIT} 사이여야 합니다.` };
  }

  return { ok: true, value: { times: cleanedTimes, weekdays, dailyLimit: dailyLimitRaw, timezone: "Asia/Seoul" } };
}

// ---------------------------------------------------------------------------
// 날짜/시간 유틸(Asia/Seoul 전용, DST 없음 - UTC 날짜 산술로 자정 전후 오류를 방지)
// ---------------------------------------------------------------------------

export function nowKstDateStr(): string {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(new Date());
}

function utcIsoToKstDateStr(iso: string): string {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(new Date(iso));
}

// "YYYY-MM-DD" 문자열에 일수를 더합니다. 달력 날짜만 다루므로(시각 없음) 항상 UTC로 계산해
// 서버 실행 환경의 시스템 시간대나 DST 여부와 무관하게 정확합니다.
export function addDaysToDateStr(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

// "YYYY-MM-DD" 날짜의 요일(0=일~6=토)을 돌려줍니다. 달력 날짜의 요일은 시간대와 무관하게
// 고정된 값이므로 UTC 기준으로 계산해도 항상 정확합니다.
export function weekdayOfDateStr(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

// "YYYY-MM-DD" + "HH:mm"(둘 다 Asia/Seoul 기준)을 실제 UTC ISO 순간으로 변환합니다.
// src/time.ts의 seoulLocalToUtcIso와 동일한 계산이지만, 이 모듈은 독립적으로 유지하기 위해
// 동일한 상수를 직접 사용합니다(시간대 정보 없는 "YYYY-MM-DDTHH:mm"을 그대로 넘겨도 결과가 같음).
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
export function kstDateTimeToUtcIso(dateStr: string, timeStr: string): string {
  const [y, mo, d] = dateStr.split("-").map(Number);
  const [h, mi] = timeStr.split(":").map(Number);
  const asIfUtcMs = Date.UTC(y, mo - 1, d, h, mi, 0);
  return new Date(asIfUtcMs - KST_OFFSET_MS).toISOString();
}

// ---------------------------------------------------------------------------
// 배치 계획(요청서 3번 규칙 그대로) - DB에 아무것도 쓰지 않는 순수 함수.
// ---------------------------------------------------------------------------

export interface BatchScheduleAssignment {
  draftId: number;
  dateKST: string; // "YYYY-MM-DD"
  timeKST: string; // "HH:mm"
  scheduledAtUtcIso: string;
}

export interface PlanBatchScheduleInput {
  routine: ScheduleRoutine;
  selectedDraftIds: number[]; // 배치할 순서 그대로(사용자가 선택/화면에 표시된 순서)
  occupiedTimestamps: Iterable<string>; // 이미 다른 글이 차지한 scheduled_at(UTC ISO) 전체
  nowUtcMs?: number; // 테스트에서 "현재 시각"을 고정하기 위한 선택적 오버라이드
}

// 하루 최대 발행 수를 지키며 무한히 미래로만 찾다가 실수로 무한 루프에 빠지는 일이 없도록
// 안전 상한을 둡니다(예: 요일을 전부 비활성화한 손상된 설정 등 비정상 상황 방지).
const MAX_DAYS_TO_SEARCH = 3650; // 약 10년

// 선택된 글들을 요청서 3번 규칙대로 루틴의 빈 슬롯에 순서대로 배치합니다.
// - 이미 지난 시간/이미 점유된 시각/비활성 요일/하루 한도 초과 슬롯은 건너뜁니다.
// - 배치할 수 없으면(요일이 전부 비활성화된 손상된 루틴 등) 오류를 던집니다.
export function planBatchSchedule(input: PlanBatchScheduleInput): BatchScheduleAssignment[] {
  const { routine, selectedDraftIds } = input;
  const nowMs = input.nowUtcMs ?? Date.now();

  if (routine.weekdays.length === 0) {
    throw new Error("예약 루틴에 활성화된 요일이 없습니다. 요일을 최소 1개 이상 선택해주세요.");
  }
  if (routine.times.length === 0) {
    throw new Error("예약 루틴에 등록된 시간이 없습니다. 예약 시간을 최소 1개 이상 등록해주세요.");
  }

  const occupied = new Set<string>(input.occupiedTimestamps);
  const countByDate = new Map<string, number>();
  for (const iso of occupied) {
    const d = utcIsoToKstDateStr(iso);
    countByDate.set(d, (countByDate.get(d) || 0) + 1);
  }

  const weekdaySet = new Set(routine.weekdays);
  const assignments: BatchScheduleAssignment[] = [];

  let cursorDate = nowKstDateStrFromMs(nowMs);
  let cursorTimeIdx = 0;

  for (const draftId of selectedDraftIds) {
    let placed = false;
    let daysChecked = 0;

    while (!placed) {
      if (daysChecked > MAX_DAYS_TO_SEARCH) {
        throw new Error("예약 가능한 슬롯을 찾지 못했습니다. 예약 루틴 설정(시간·요일·하루 최대 발행 수)을 확인해주세요.");
      }

      if (!weekdaySet.has(weekdayOfDateStr(cursorDate))) {
        cursorDate = addDaysToDateStr(cursorDate, 1);
        cursorTimeIdx = 0;
        daysChecked++;
        continue;
      }

      const usedToday = countByDate.get(cursorDate) || 0;
      if (usedToday >= routine.dailyLimit) {
        cursorDate = addDaysToDateStr(cursorDate, 1);
        cursorTimeIdx = 0;
        daysChecked++;
        continue;
      }

      let foundIdx = -1;
      let foundIso = "";
      for (let i = cursorTimeIdx; i < routine.times.length; i++) {
        const timeStr = routine.times[i];
        const iso = kstDateTimeToUtcIso(cursorDate, timeStr);
        if (new Date(iso).getTime() < nowMs + MIN_SCHEDULE_LEAD_MS) continue; // 지난 시간/너무 임박한 시간 건너뛰기
        if (occupied.has(iso)) continue; // 이미 다른 글이 예약된 동일 시각 건너뛰기
        foundIdx = i;
        foundIso = iso;
        break;
      }

      if (foundIdx === -1) {
        // 오늘(또는 이 날짜) 남은 시간에는 더 이상 빈 슬롯이 없음 -> 다음 날짜로
        cursorDate = addDaysToDateStr(cursorDate, 1);
        cursorTimeIdx = 0;
        daysChecked++;
        continue;
      }

      assignments.push({ draftId, dateKST: cursorDate, timeKST: routine.times[foundIdx], scheduledAtUtcIso: foundIso });
      occupied.add(foundIso);
      countByDate.set(cursorDate, usedToday + 1);
      cursorTimeIdx = foundIdx + 1;
      placed = true;
    }
  }

  return assignments;
}

function nowKstDateStrFromMs(ms: number): string {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(new Date(ms));
}
