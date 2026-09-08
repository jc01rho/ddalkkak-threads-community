// src/routes/publishLog.ts
import { Router } from "express";
import { deletePublishLog, listPublishLog } from "../database";

const router = Router();

router.get("/", (req, res) => {
  const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 200;
  res.json({ logs: listPublishLog(limit) });
});

// 발행 기록 1건 삭제. 이 프로그램 안의 이력만 지우며 Threads 게시물은 건드리지 않습니다.
// (Threads 게시물 삭제는 v1 범위가 아니고, 여기서 Threads API를 호출하지도 않습니다)
router.delete("/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ ok: false, error: "잘못된 기록 id입니다." });
  }
  if (!deletePublishLog(id)) {
    return res.status(404).json({ ok: false, error: "해당 발행 기록을 찾을 수 없습니다." });
  }
  return res.json({ ok: true });
});

// 성과(조회수 등) 조회 API는 v1에서 아직 지원하지 않습니다. 가짜 데이터를 넣지 않고 명확히 표시합니다.
router.get("/insights", (_req, res) => {
  res.json({ supported: false, message: "성과 조회 기능은 v1에서 아직 지원하지 않습니다. (추후 지원 예정)" });
});

export default router;
