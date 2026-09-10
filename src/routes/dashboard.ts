// src/routes/dashboard.ts
import { Router } from "express";
import { checkClaudeCli } from "../claude";
import { validateThreadsToken } from "../threads-api";
import { isThreadsMediaPublishConfigured } from "../threadsMediaUrlProvider";
import { config, maskToken } from "../env";
import {
  countByStatusToday,
  countDraftsToday,
  countDryRunProcessedToday,
  countRealPublishedToday,
  getSetting,
  nextScheduledAt,
  setSetting,
} from "../database";

const router = Router();

router.get("/", async (_req, res) => {
  // 위와 같은 이유로 /api/status가 Claude 탐지 때문에 응답하지 못하는 일은 없어야 한다.
  const claudeStatus = await checkClaudeCli().catch((e) => ({
    available: false,
    error: `claude 확인 중 예외: ${e && e.message ? e.message : String(e)}`,
  }));

  const hasThreadsConfig = !!config.THREADS_ACCESS_TOKEN && !!config.THREADS_USER_ID;
  let threadsStatus: { connected: boolean; username?: string; error?: string; configured: boolean } = {
    connected: false,
    configured: hasThreadsConfig,
  };
  if (hasThreadsConfig) {
    const v = await validateThreadsToken();
    threadsStatus = { connected: v.valid, username: v.username, error: v.error, configured: true };
  } else {
    threadsStatus.error = "토큰/사용자 ID 미설정";
  }

  const autoPublish = getSetting("auto_publish", "off") === "on";

  res.json({
    claude: claudeStatus,
    threads: threadsStatus,
    dryRun: config.DRY_RUN,
    autoPublish,
    draftsCreatedToday: countDraftsToday(),
    publishedToday: countRealPublishedToday(),
    dryRunProcessedToday: countDryRunProcessedToday(),
    approvedToday: countByStatusToday("approved"),
    scheduledCountNext: nextScheduledAt(),
    dailyMaxPublish: config.DAILY_MAX_PUBLISH,
    // P1.6(AUD-P1-003): IMAGE/VIDEO/CAROUSEL 실제 발행 구성 여부(relay 또는 public gateway).
    // 화면이 미구성 안내/문구 분기에만 쓰는 boolean이며 endpoint 주소 등 내부 값은 노출하지 않는다.
    mediaPublishConfigured: isThreadsMediaPublishConfigured(),
    threadsTokenMasked: maskToken(config.THREADS_ACCESS_TOKEN),
    timezone: config.TZ,
    serverTime: new Date().toISOString(),
  });
});

router.post("/auto-publish", (req, res) => {
  const enabled = !!req.body?.enabled;
  setSetting("auto_publish", enabled ? "on" : "off");
  res.json({ autoPublish: enabled });
});

export default router;
