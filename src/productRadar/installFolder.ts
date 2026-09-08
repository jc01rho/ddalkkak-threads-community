// src/productRadar/installFolder.ts
// "확장프로그램 폴더 열기" - Windows 탐색기로 browser-extension 폴더를 엽니다.
//
// 보안 원칙(요청서 2절):
// - 경로는 항상 config.EXTENSION_FOLDER_PATH(서버가 미리 정한 고정값) 하나만 사용합니다.
//   이 파일 어디에도 요청 바디/쿼리스트링에서 경로를 읽는 코드가 없습니다(라우트 쪽도 동일).
// - child_process.execFile을 인자 배열로 호출합니다(shell:true를 쓰지 않음 - src/claude.ts의
//   spawn(..., {shell:false}) 및 src/license/deviceId.ts의 execFileSync(...) 배열 인자 패턴과
//   동일한 원칙 - 셸을 거치지 않으므로 경로에 공백/한글/특수문자가 있어도 셸 인젝션 위험이 없음).
// - 폴더가 실제로 존재하는지 먼저 확인하고, 없으면 탐색기를 아예 실행하지 않습니다.

import fs from "fs";
import { execFile, ExecFileException } from "child_process";
import { config } from "../env";

export type OpenInstallFolderError = "EXTENSION_FOLDER_NOT_FOUND" | "OPEN_FAILED";
export type OpenInstallFolderResult = { ok: true } | { ok: false; error: OpenInstallFolderError };

// 순수 의존성 주입 지점입니다(src/license/deviceId.ts의 reader 인자와 동일한 원칙) - 운영
// 코드는 항상 인자 없이 openInstallFolder()를 호출해 실제 explorer.exe를 실행하고, 테스트는
// 이 함수 자리에 가짜 구현을 넣어 실제 프로세스를 띄우지 않고 "어떤 경로로 호출됐는지"만
// 검증합니다.
export type ExplorerOpener = (folderPath: string) => Promise<void>;

// Phase 12.5.3.6: 미디어 보관함의 "폴더 열기"(mediaLibraryFolder.ts)도 동일한 안전 패턴
// (execFile 배열 인자, ENOENT만 실패)이 필요해 export한다 - 로직 자체는 완전히 그대로다.
export function realExplorerOpener(folderPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (process.platform !== "win32") {
      reject(new Error("UNSUPPORTED_PLATFORM"));
      return;
    }
    // 인자를 배열로 분리해 전달합니다(셸을 거치지 않음) - 폴더 경로에 공백·한글이 있어도
    // 그대로 하나의 인자로 explorer.exe에 전달되어 안전합니다.
    execFile("explorer.exe", [folderPath], (err: ExecFileException | null) => {
      // explorer.exe는 창을 정상적으로 열어도 0이 아닌 종료 코드를 반환하는 경우가 실제로
      // 있습니다(Windows의 알려진 동작). 실행 파일 자체를 찾지 못한 경우(ENOENT - 개발 중인
      // 비Windows 환경 등)만 실패로 취급하고, 그 외 종료 코드는 성공으로 간주합니다.
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

// folderPathOverride는 테스트 전용 의존성 주입 지점입니다(createPairingCode()의 ttlMsOverride와
// 동일한 원칙). 라우트(src/routes/productRadar/extension.ts)는 이 인자를 절대 넘기지 않고 항상
// openInstallFolder()를 인자 없이 호출하므로, 클라이언트 요청이 이 값에 영향을 줄 방법은
// 없습니다 - 테스트만 서로 다른 임시 폴더로 시나리오(존재/부재/공백·한글 경로)를 검증합니다.
export async function openInstallFolder(
  opener: ExplorerOpener = realExplorerOpener,
  folderPathOverride?: string
): Promise<OpenInstallFolderResult> {
  const folderPath = folderPathOverride ?? config.EXTENSION_FOLDER_PATH;

  let exists = false;
  try {
    exists = fs.existsSync(folderPath) && fs.statSync(folderPath).isDirectory();
  } catch {
    exists = false;
  }
  if (!exists) {
    return { ok: false, error: "EXTENSION_FOLDER_NOT_FOUND" };
  }

  try {
    await opener(folderPath);
    return { ok: true };
  } catch {
    return { ok: false, error: "OPEN_FAILED" };
  }
}
