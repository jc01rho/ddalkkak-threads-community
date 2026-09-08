// src/threadsMediaListener.ts
// Phase 12.5.4 correction: Threads 전용 미디어 게이트웨이의 별도 HTTP listener입니다. 딸깍
// 메인 서버(server.ts - PORT, 대시보드/드래프트/예약/설정 등 전체 /api)와 완전히 분리된 별도
// express 앱 + 별도 포트를 씁니다.
//
// 이 리스너가 제공하는 경로는 GET /threads-media/:token 단 하나뿐입니다 - 헬스체크, 정적
// 파일, /api 등 그 어떤 것도 이 앱에 등록하지 않습니다. 그래서 운영자가 터널/리버스 프록시를
// 이 포트에만 연결하면, 메인 서버(대시보드/DB/설정 API)는 구조적으로 절대 외부에 노출되지
// 않습니다 - "이 리스너에 다른 라우트를 추가하면 안 된다"는 이 파일의 핵심 불변식이며,
// scripts/test-runner.js의 회귀 테스트가 이 앱의 라우트 스택에 정확히 이 경로 하나만
// 등록되어 있는지 확인합니다.
//
// 기본은 꺼져 있습니다 - config.THREADS_MEDIA_GATEWAY_PORT가 설정되지 않으면(0/빈값)
// startThreadsMediaGatewayListener()는 아무 것도 하지 않습니다. 아직 공개 미디어 URL 기능을
// 쓰지 않는 사용자에게 여는 포트를 늘리지 않기 위함입니다.
//
// server.ts와 동일한 loopback-only 원칙을 그대로 따릅니다(0.0.0.0/::은 절대 바인딩하지
// 않음 - 두 loopback 주소(127.0.0.1/::1) 모두에 명시적으로 바인딩. server.ts의 Phase 9.6.1
// 주석 참고 - "localhost"가 어느 주소로 풀리는지는 OS/Node 버전에 따라 달라 통제할 수 없어
// 두 주소 모두에 바인딩하는 동일한 이유가 여기도 적용됩니다).

import express, { Express } from "express";
import { Server } from "http";
import { config } from "./env";
import { resolveMediaPath } from "./mediaUpload";
import { resolveThreadsMediaToken } from "./threadsMediaGateway";

let serverV4: Server | null = null;
let serverV6: Server | null = null;

// 이 앱에는 절대 다른 라우트를 추가하지 마세요(파일 헤더 주석 참고) - 라우트가 하나뿐이라는
// 사실 자체가 보안 경계입니다. 테스트(listThreadsMediaGatewayRoutesForTesting)와 실제
// listener(startThreadsMediaGatewayListener)가 둘 다 이 함수를 통해서만 앱을 만듭니다.
export function buildThreadsMediaGatewayApp(): Express {
  const app = express();
  app.get("/threads-media/:token", (req, res) => {
    const lookup = resolveThreadsMediaToken(req.params.token);
    if (!lookup.ok) {
      // not_found/expired를 구분해 402류 정보 노출 없이 표준적인 의미로만 응답합니다
      // (만료된 적 있었는지조차 굳이 감출 필요는 없는 무작위 256비트 token 공간입니다).
      res.status(lookup.reason === "expired" ? 410 : 404).end();
      return;
    }
    // resolveMediaPath가 isSafeMediaFilename을 다시 한 번 확인합니다(defense in depth -
    // token 저장 자체는 호출자를 신뢰하지만, 실제 파일 서빙 직전에는 항상 재검증합니다).
    const fullPath = resolveMediaPath(lookup.filename);
    if (!fullPath) {
      res.status(404).end();
      return;
    }
    res.sendFile(fullPath, (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  });
  return app;
}

export function startThreadsMediaGatewayListener(): void {
  if (!config.THREADS_MEDIA_GATEWAY_PORT) return;
  if (serverV4 || serverV6) return;
  const app = buildThreadsMediaGatewayApp();
  const port = config.THREADS_MEDIA_GATEWAY_PORT;
  serverV4 = app.listen(port, "127.0.0.1", () => {
    console.log(`[threads-media-gateway] Threads 전용 미디어 게이트웨이 시작 (포트 ${port}, 경로: GET /threads-media/:token 하나뿐)`);
  });
  serverV6 = app.listen(port, "::1");
}

export function stopThreadsMediaGatewayListener(): void {
  serverV4?.close();
  serverV6?.close();
  serverV4 = null;
  serverV6 = null;
}

// 테스트 전용: 실제로 포트를 열지 않고도 "이 앱에 등록된 라우트가 정확히 media 경로
// 하나뿐"이라는 불변식을 검증할 수 있게 라우트 스택을 문자열 목록으로 노출합니다.
export function listThreadsMediaGatewayRoutesForTesting(): string[] {
  const app = buildThreadsMediaGatewayApp();
  const stack: any[] = (app as any)._router?.stack || [];
  return stack.filter((layer) => layer.route).map((layer) => `${Object.keys(layer.route.methods).join(",").toUpperCase()} ${layer.route.path}`);
}
