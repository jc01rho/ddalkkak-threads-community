// src/routes/schedule.ts
import { Router } from "express";
import { listDrafts } from "../database";
import { DraftMediaPointerRow, resolveDraftMediaSummaries } from "../productRadar/draftMediaReview";

const router = Router();

// 예약 목록도 초안함(GET /api/drafts)과 "같은" prMediaSummary 계약으로 내려간다.
// 두 화면이 공용 draftCardHtml을 쓰는데 한쪽 응답에만 요약이 없으면, 같은 글의 미디어가
// 예약 목록에서만 사라져 보이고 미디어 편집 버튼도 잘못된 상태로 그려진다.
// 요약 생성 로직을 새로 만들지 않고 drafts.ts가 쓰는 것과 완전히 같은 공용 배치 helper를
// 그대로 호출한다(resolveDraftMediaSummaries: job/asset을 각각 IN절 1회로 조회 - N+1 없음).
// scheduled/publishing 두 목록을 합친 뒤 한 번만 호출하므로 배치 조회도 1회다.
// 응답 필드 구성(scheduled 배열)과 정렬은 그대로다 - prMediaSummary만 추가된다.
router.get("/", (_req, res) => {
  const scheduled = listDrafts("scheduled");
  const publishing = listDrafts("publishing");
  const drafts = [...scheduled, ...publishing] as DraftMediaPointerRow[];
  const summaries = resolveDraftMediaSummaries(drafts);
  res.json({ scheduled: drafts.map((d) => ({ ...d, prMediaSummary: summaries.get(d.id) })) });
});

export default router;
