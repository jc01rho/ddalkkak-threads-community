// src/server.ts
// Express 서버 진입점. 이 파일을 실행하면 로컬 웹 화면(http://localhost:3970)이 켜집니다.

import express from "express";
import path from "path";
import { config } from "./env";
import { getDb, seedDefaultFeedsIfEmpty, syncBuiltInFeeds } from "./database";
import { BUILT_IN_FEEDS } from "./builtInFeeds";
import { applyStoredThreadsCredentialsToConfig } from "./threadsCredentials";
import { ClaudeCliStatus, checkClaudeCli } from "./claude";
import { reconcileInterruptedPublishing, startScheduler } from "./scheduler";
import { startThreadsMediaGatewayListener } from "./threadsMediaListener";
import { sweepOrphanedMedia } from "./mediaUpload";

import dashboardRoutes from "./routes/dashboard";
import materialsRoutes from "./routes/materials";
import draftsRoutes from "./routes/drafts";
import scheduleRoutes from "./routes/schedule";
import publishLogRoutes from "./routes/publishLog";
import personaRoutes from "./routes/persona";
import feedsRoutes from "./routes/feeds";
import threadsSettingsRoutes from "./routes/threadsSettings";
import affiliateRoutes from "./routes/affiliate";
import scheduleRoutineRoutes from "./routes/scheduleRoutine";
import settingsRoutes from "./routes/settings";
import productRadarRoutes from "./routes/productRadar";

const app = express();

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.use("/api/status", dashboardRoutes);
app.use("/api/materials", materialsRoutes);
app.use("/api/drafts", draftsRoutes);
app.use("/api/schedule", scheduleRoutes);
app.use("/api/publish-log", publishLogRoutes);
app.use("/api/persona", personaRoutes);
app.use("/api/feeds", feedsRoutes);
app.use("/api/threads-settings", threadsSettingsRoutes);
app.use("/api/affiliate", affiliateRoutes);
app.use("/api/schedule-routine", scheduleRoutineRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/product-radar", productRadarRoutes);

export async function startServer(): Promise<import("http").Server> {
  // DB 초기화(테이블 생성)
  getDb();

  // 설정 화면에서 저장해 둔 Threads 연결 정보를 런타임 config에 복원합니다.
  // (전체 액세스 토큰은 여기서도 절대 로그에 남기지 않습니다 - 사용 여부만 기록)
  if (applyStoredThreadsCredentialsToConfig()) {
    console.log("[threads] 저장된 Threads 연결 정보를 불러왔습니다.");
  }
  // 게시 모드(DRY_RUN)의 source of truth는 실행 환경(env/launch 정책)뿐입니다.
  // 과거에는 settings.dry_run 저장값이 여기서 config.DRY_RUN을 덮어썼지만, 구매자
  // 화면에서 게시 모드 UI를 제거하면서 이 덮어쓰기도 제거했습니다 - legacy DB에
  // dry_run=true가 남아 있어도 정상 Release(DRY_RUN=false 명시)가 테스트 모드에
  // 갇히지 않고, 테스트 환경의 강제 DRY_RUN=true도 DB 값으로 뒤집히지 않습니다.

  // 기본 자료 출처(RSS) 시딩 - 비어있을 때만
  const seededFeeds = seedDefaultFeedsIfEmpty();
  if (seededFeeds > 0) console.log(`[feeds] 기본 RSS 피드 ${seededFeeds}개를 등록했습니다.`);

  // P1.7A: 9개 카테고리를 커버하는 기본 자료원 팩을 기존 사용자에게도 적용한다.
  // 없는 built-in feed만 추가하며, 사용자가 직접 추가한 feed와 enabled 설정은 건드리지 않는다.
  const syncedFeeds = syncBuiltInFeeds(BUILT_IN_FEEDS);
  if (syncedFeeds.added > 0) console.log(`[feeds] 기본 자료원 ${syncedFeeds.added}개를 추가했습니다(기존 설정 유지).`);

  // checkClaudeCli는 어떤 실패도 available:false로 정상 반환하도록 만들어져 있다.
  // 그래도 Claude 탐지가 서버 기동을 막는 일은 절대 없어야 하므로 경계에서 한 겹만 더 막는다.
  const claudeStatus: ClaudeCliStatus = await checkClaudeCli().catch((e) => ({
    available: false,
    error: `claude 확인 중 예외: ${e && e.message ? e.message : String(e)}`,
  }));
  if (claudeStatus.available) {
    console.log(`[claude] CLI 감지됨: ${claudeStatus.version}`);
  } else {
    console.warn(`[claude] CLI를 찾지 못했습니다: ${claudeStatus.error}`);
    console.warn("[claude] 'claude --version' 이 정상 동작하는지 확인하세요. (README_KO.md 참고)");
  }

  console.log(`[config] DRY_RUN = ${config.DRY_RUN} (true면 실제 게시 안 함)`);
  console.log(`[config] 하루 최대 발행 수 = ${config.DAILY_MAX_PUBLISH}`);

  // 쿠파스 첨부 미디어 중 어떤 초안도 참조하지 않는(=거절된 초안 6개 전부, 또는 생성 도중 중단된)
  // 오래된 파일을 서버 시작 시 한 번 정리합니다(요청서 9번 - 정리 정책). 최근 업로드는
  // sweepOrphanedMedia()가 자체적으로 유예 시간을 두어 건드리지 않습니다.
  try {
    const swept = sweepOrphanedMedia();
    if (swept.deleted.length > 0) {
      console.log(`[media] 사용하지 않는 첨부 파일 ${swept.deleted.length}개 정리함`);
    }
  } catch (e: any) {
    console.warn("[media] 시작 시 첨부 파일 정리 중 오류(무시하고 계속 진행):", e.message);
  }

  // 스케줄러를 켜기 전에, 지난번 실행이 발행 도중 끊겨 'publishing'으로 남은 글을 먼저
  // 정리한다. 다시 게시하지 않고 남은 기록만으로 상태를 맞춘다(scheduler.ts 주석 참고).
  // 스케줄러를 끈 QA 환경에서도 화면에 고착 카드가 남지 않도록 항상 실행한다.
  try {
    reconcileInterruptedPublishing();
  } catch (e: any) {
    console.warn("[scheduler] 중단된 발행 복구 중 오류(무시하고 계속 진행):", e.message);
  }

  if (!config.DISABLE_SCHEDULER) {
    startScheduler();
  } else {
    console.log("[scheduler] DISABLE_SCHEDULER=true 이므로 자동 실행하지 않습니다.");
  }

  // Threads 전용 미디어 게이트웨이(별도 포트, /threads-media/:token 경로 하나뿐 - 보안 감사
  // 후 추가, threadsMediaListener.ts 헤더 주석 참고). THREADS_MEDIA_GATEWAY_PORT를 설정하지
  // 않으면 시작하지 않습니다(기본 비활성 - 아직 공개 이미지/영상 발행을 쓰지 않는 사용자에게
  // 여는 포트를 늘리지 않기 위함).
  startThreadsMediaGatewayListener();

  // Phase 9.6.1: host 인자 없는 app.listen(config.PORT, ...)은 Node에서 모든 네트워크
  // 인터페이스에 바인딩되어(0.0.0.0 동등) "local Node server = loopback only"라는 기존
  // architectural invariant와 충돌했다 - 이 파일이 만드는 소켓을 명시적으로 loopback에만
  // 묶는다.
  //
  // 127.0.0.1 하나만으로는 부족하다 - 이 프로젝트의 기존 클라이언트들이 IPv4/IPv6 loopback을
  // 섞어 쓴다(launcher/DdalkkakLauncher.cs의 AppUrl="http://localhost:3970",
  // routes/productRadar/browser.ts·launch.ts의 127.0.0.1/::1 허용 목록 둘 다 참고). 그리고
  // "localhost"가 어느 주소로 풀리는지는 OS/Node 버전에 따라 달라서 통제할 수 없다(이
  // 개발 환경에서 실측: dns.lookup("localhost", {all:true})가 ::1을 127.0.0.1보다 먼저
  // 반환함 - Windows hosts 파일에 둘 다 등록돼 있고 IPv6가 우선됨). IPv4만 바인딩하면
  // "localhost"가 ::1로 풀리는 환경에서 기존 UI/테스트가 전부 연결 실패한다. 그래서 두
  // loopback 주소 모두에 명시적으로 바인딩한다 - 0.0.0.0/::(모든 인터페이스)은 여전히
  // 피한다. HOST 환경변수로 사용자가 이 값을 바꿀 수 있게 하지 않는다(제품 보안 invariant는
  // 사용자 설정으로 풀리면 안 됨).
  return new Promise((resolve, reject) => {
    const logReady = () => {
      console.log(`\n===================================================`);
      console.log(`  딸칵 Threads 공장 v1 서버가 실행되었습니다.`);
      console.log(`  브라우저에서 아래 주소를 여세요:`);
      console.log(`  http://localhost:${config.PORT}`);
      console.log(`===================================================\n`);
    };

    const serverV4 = app.listen(config.PORT, "127.0.0.1");
    const serverV6 = app.listen(config.PORT, "::1");

    let v4Ready = false;
    let v6Settled = false;
    const tryResolve = () => {
      if (v4Ready && v6Settled) {
        logReady();
        resolve(serverV4);
      }
    };

    serverV4.on("listening", () => {
      v4Ready = true;
      tryResolve();
    });
    // 필수 IPv4 loopback listener가 시작에 실패하면 이미 열렸을 수도 있는 IPv6 listener를
    // 고아로 남기지 않는다(Phase 9.6.1 최종 lifecycle 검수) - serverV6가 아직 listening
    // 이벤트 전이라도 close()는 안전하다(콜백 없이 호출하면 예외를 던지지 않음).
    serverV4.on("error", (e) => {
      serverV6.close();
      reject(e);
    });

    serverV6.on("listening", () => {
      v6Settled = true;
      tryResolve();
    });
    serverV6.on("error", (e: NodeJS.ErrnoException) => {
      // IPv6 loopback이 이 머신에서 비활성화돼 있어도(예: IPv6 꺼짐) 치명적이지 않다 -
      // IPv4 loopback(127.0.0.1)은 이미 살아있으므로 경고만 남기고 계속 진행한다.
      console.warn(`[server] IPv6 loopback(::1) 바인딩 실패(무시하고 계속 진행): ${e.message}`);
      v6Settled = true;
      tryResolve();
    });
  });
}

export { app };

if (require.main === module) {
  startServer().catch((e) => {
    console.error("서버 시작 실패:", e);
    process.exit(1);
  });
}
