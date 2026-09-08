// src/routes/settings.ts
// "설정 > 데이터 관리" 화면의 공장 전체 초기화 API. "화면 설정 초기화"는 localStorage만
// 건드리는 순수 클라이언트 동작이라 서버 API가 필요 없습니다(public/app.js 참고).
import { Router } from "express";
import fs from "fs";
import path from "path";
import { config } from "../env";
import { factoryResetClearAllTables, seedDefaultFeedsIfEmpty, saveNewPersonaVersion } from "../database";
import { loadDefaultPersona } from "./persona";

const router = Router();

const RESET_CONFIRM_TEXT = "초기화";

router.post("/factory-reset", (req, res) => {
  const confirmText = String((req.body && req.body.confirmText) || "").trim();
  // 클라이언트에서 버튼 활성화 여부로 이미 한 번 확인하지만, 서버가 다시 한번 정확히 검증합니다
  // (클라이언트 검증만 믿지 않음).
  if (confirmText !== RESET_CONFIRM_TEXT) {
    return res.status(400).json({ success: false, error: `확인 문구가 올바르지 않습니다. "${RESET_CONFIRM_TEXT}"를 정확히 입력해주세요.` });
  }

  let counts;
  try {
    // 초안/자료/예약/발행 기록/예약 루틴/사용자 설정/RSS 피드/페르소나/실패 로그 테이블을
    // 하나의 트랜잭션으로 비웁니다 - 도중에 오류가 나면 전체 롤백됩니다(부분 삭제 없음).
    counts = factoryResetClearAllTables();
  } catch (e: any) {
    return res.status(500).json({ success: false, error: "초기화 중 오류가 발생해 전체 롤백되었습니다: " + e.message });
  }

  // 여기부터는 DB 트랜잭션이 이미 커밋된 뒤입니다. 기본값 재시딩은 둘 다 기존에 있던
  // "비어있을 때만 채운다" 방식이라 안전합니다(새 로직 아님, 서버 시작 시/최초 실행 시와 동일).
  const feedsSeeded = seedDefaultFeedsIfEmpty();
  saveNewPersonaVersion(loadDefaultPersona());

  // 파일 삭제는 SQLite 트랜잭션과 원천적으로 묶을 수 없어 best-effort로 처리합니다.
  // 실패해도 DB는 이미 일관 상태이므로, 개별 실패는 경고로만 응답에 담습니다.
  const warnings: string[] = [];
  let uploadsDeleted = 0;
  try {
    if (fs.existsSync(config.UPLOAD_DIR)) {
      for (const filename of fs.readdirSync(config.UPLOAD_DIR)) {
        try {
          fs.unlinkSync(path.join(config.UPLOAD_DIR, filename));
          uploadsDeleted++;
        } catch (e: any) {
          warnings.push(`업로드 파일 삭제 실패: ${filename} (${e.message})`);
        }
      }
    }
  } catch (e: any) {
    warnings.push("업로드 폴더 정리 중 오류: " + e.message);
  }

  let failureLogsDeleted = 0;
  try {
    if (fs.existsSync(config.LOG_DIR)) {
      for (const filename of fs.readdirSync(config.LOG_DIR)) {
        if (/^claude-failure-\d+\.txt$/.test(filename)) {
          try {
            fs.unlinkSync(path.join(config.LOG_DIR, filename));
            failureLogsDeleted++;
          } catch (e: any) {
            warnings.push(`실패 로그 삭제 실패: ${filename} (${e.message})`);
          }
        }
      }
    }
  } catch (e: any) {
    warnings.push("로그 폴더 정리 중 오류: " + e.message);
  }

  const resetAt = new Date().toISOString();
  // 감사 로그: 비밀값 없이 초기화 시각과 결과(건수)만 한 줄 JSON으로 남깁니다. 새 DB 테이블을
  // 추가하지 않고 기존 로그 파일 관례(config.LOG_DIR)를 그대로 따릅니다.
  try {
    if (!fs.existsSync(config.LOG_DIR)) fs.mkdirSync(config.LOG_DIR, { recursive: true });
    const auditEntry = {
      at: resetAt,
      action: "factory_reset",
      result: warnings.length === 0 ? "success" : "success_with_warnings",
      counts: { ...counts, uploadsDeleted, failureLogsDeleted, feedsSeeded },
      warningCount: warnings.length,
    };
    fs.appendFileSync(path.join(config.LOG_DIR, "reset-audit.log"), JSON.stringify(auditEntry) + "\n", "utf-8");
  } catch {
    // 감사 로그 기록 실패는 초기화 결과 자체에 영향 주지 않습니다(DB는 이미 커밋됨).
  }

  res.json({ success: true, resetAt, counts, uploadsDeleted, failureLogsDeleted, feedsSeeded, warnings });
});

export default router;
