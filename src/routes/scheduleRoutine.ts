// src/routes/scheduleRoutine.ts
// GET/PUT /api/schedule-routine - 예약 루틴(반복 시간/요일/하루 최대 발행 수) 설정 조회·저장.
// 새 설정 파일을 만들지 않고 기존 settings 키-값 테이블을 재사용합니다(요청서 1번).
//
// dailyLimit은 이 화면에서 저장한 값이 자동배치 계획과 스케줄러의 실제 하루 발행 상한 양쪽에
// 그대로 쓰입니다(단일 저장 위치: database.ts의 getScheduleRoutine()/setScheduleRoutine()).

import { Router } from "express";
import { getScheduleRoutine, setScheduleRoutine } from "../database";
import { validateScheduleRoutineInput } from "../scheduleRoutine";

const router = Router();

router.get("/", (_req, res) => {
  res.json({ routine: getScheduleRoutine() });
});

router.put("/", (req, res) => {
  const validation = validateScheduleRoutineInput(req.body);
  if (!validation.ok) {
    return res.status(400).json({ success: false, error: validation.error });
  }
  setScheduleRoutine(validation.value);
  res.json({ success: true, routine: validation.value });
});

export default router;
