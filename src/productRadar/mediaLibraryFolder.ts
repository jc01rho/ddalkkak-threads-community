// src/productRadar/mediaLibraryFolder.ts
// 상품 레이더 Phase 12.5.3.6: "미디어 폴더 열기" - Windows 탐색기로 현재 authoritative
// media storage root(config.UPLOAD_DIR)를 엽니다. installFolder.ts(확장프로그램 폴더 열기)
// 와 완전히 동일한 안전 원칙을 그대로 따른다(요청서 3·4절):
// - 경로는 항상 config.UPLOAD_DIR(서버가 미리 정한 고정값) 하나만 쓴다 - 요청 바디/쿼리
//   스트링에서 경로를 읽는 코드가 이 파일/라우트 어디에도 없다(client가 임의 path를 전달할
//   방법이 구조적으로 없음).
// - execFile을 인자 배열로 호출한다(shell:true 없음 - installFolder.ts와 동일한
//   realExplorerOpener를 그대로 재사용, 로직 복제 없음).
// - 폴더가 실제로 존재하는지 먼저 확인하고, 없으면 탐색기를 실행하지 않는다.

import fs from "fs";
import { config } from "../env";
import { ExplorerOpener, realExplorerOpener } from "./installFolder";

export type OpenMediaLibraryFolderError = "MEDIA_FOLDER_NOT_FOUND" | "OPEN_FAILED";
export type OpenMediaLibraryFolderResult = { ok: true } | { ok: false; error: OpenMediaLibraryFolderError };

// folderPathOverride는 테스트 전용(installFolder.ts의 동일 원칙) - 라우트는 인자 없이
// openMediaLibraryFolder()만 호출하므로 client 요청이 이 값에 영향을 줄 방법이 없다.
export async function openMediaLibraryFolder(
  opener: ExplorerOpener = realExplorerOpener,
  folderPathOverride?: string
): Promise<OpenMediaLibraryFolderResult> {
  const folderPath = folderPathOverride ?? config.UPLOAD_DIR;

  let exists = false;
  try {
    exists = fs.existsSync(folderPath) && fs.statSync(folderPath).isDirectory();
  } catch {
    exists = false;
  }
  if (!exists) {
    return { ok: false, error: "MEDIA_FOLDER_NOT_FOUND" };
  }

  try {
    await opener(folderPath);
    return { ok: true };
  } catch {
    return { ok: false, error: "OPEN_FAILED" };
  }
}
