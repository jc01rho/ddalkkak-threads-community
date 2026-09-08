// src/routes/feeds.ts
// 자료 출처(RSS) 관리 API.
//
// built-in 기본 자료원(builtInFeeds.ts)은 프로그램이 자동 관리하는 목록이라 사용자가 개별로
// 켜고 끄거나 지울 대상이 아니다. 그래서 GET 응답에 builtIn 플래그를 실어 화면이 기본
// 자료원과 "내가 추가한 자료원"을 구분해 보여줄 수 있게 한다(DB schema 변경 없음 - 응답
// 시점에 URL로 판정).
import { Router } from "express";
import { addFeed, canonicalizeFeedUrl, deleteFeed, findFeedByUrl, listFeeds, setFeedEnabled } from "../database";
import { BUILT_IN_FEEDS } from "../builtInFeeds";
import { fetchFeedForValidation } from "../rss";

const router = Router();

const BUILT_IN_CANONICAL_URLS = new Set(BUILT_IN_FEEDS.map((f) => canonicalizeFeedUrl(f.url)));

function isBuiltInFeedUrl(url: string): boolean {
  return BUILT_IN_CANONICAL_URLS.has(canonicalizeFeedUrl(url));
}

router.get("/", (_req, res) => {
  const feeds = listFeeds().map((f) => ({ ...f, builtIn: isBuiltInFeedUrl(f.url) }));
  res.json({ feeds, builtInCount: feeds.filter((f) => f.builtIn).length });
});

// 자료원 추가. 화면 문자열 비교로 끝내지 않고 서버가 두 가지를 직접 확인한다:
//   1) 이미 등록된 자료원인지(정규화 URL 기준 - 대소문자/후행 슬래시 차이로 중복 등록 금지)
//   2) 실제로 가져와 읽을 수 있는 RSS/Atom인지(읽지 못하는 주소를 등록해 두면 수집 때마다
//      조용히 실패하므로, 등록 시점에 알려준다)
// 응답 code는 화면이 구매자용 문구를 고르는 데만 쓴다(원문 오류 메시지는 노출하지 않는다).
router.post("/", async (req, res) => {
  const name = String(req.body?.name || "").trim();
  const url = String(req.body?.url || "").trim();
  if (!name || !url) return res.status(400).json({ success: false, code: "MISSING_INPUT", error: "이름과 주소를 모두 입력해 주세요." });

  const existing = findFeedByUrl(url);
  if (existing) {
    return res.status(409).json({ success: false, code: "DUPLICATE_FEED", builtIn: isBuiltInFeedUrl(existing.url), error: "이미 등록된 자료원입니다." });
  }

  const check = await fetchFeedForValidation(url);
  if (!check.ok) {
    return res.status(400).json({ success: false, code: check.code, error: "자료원을 확인하지 못했습니다." });
  }

  try {
    const feed = addFeed(name, url);
    res.json({ success: true, feed: { ...feed, builtIn: isBuiltInFeedUrl(feed.url) } });
  } catch {
    // UNIQUE 충돌 등 - 위 중복 검사와 같은 상황으로 취급한다(원문 오류 비노출).
    res.status(409).json({ success: false, code: "DUPLICATE_FEED", error: "이미 등록된 자료원입니다." });
  }
});

router.patch("/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (typeof req.body?.enabled === "boolean") setFeedEnabled(id, req.body.enabled);
  res.json({ success: true });
});

router.delete("/:id", (req, res) => {
  deleteFeed(parseInt(req.params.id, 10));
  res.json({ success: true });
});

export default router;
