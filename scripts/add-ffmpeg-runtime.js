// scripts/add-ffmpeg-runtime.js
//
// Phase 12.5.3.9: LGPL FFmpeg(h264_mf, GPL-free)의 고정 버전을 다운로드/SHA-256 검증한 뒤
// release\windows-staging\third-party\ffmpeg\에 self-contained으로 심습니다. 이 스크립트는
// scripts\add-windows-runtime.js와 정확히 같은 철학입니다: "빌드 시점(개발자 PC)에 공식
// 자산을 한 번 검증해서 staging에 심어두면, 구매자 PC는 인터넷 접근 없이 그 파일을 그대로
// 씁니다" - runtime(서버 실행 중)에는 어떤 다운로드도 하지 않습니다.
//
// 다운로드/버전 고정(요청서 확정본 7·8절): 아래 상수(RELEASE_TAG/ASSET_NAME/EXPECTED_SHA256)는
// 2026-08-11 실측 검증(h264_mf 실제 인코딩 성공, GPL 전용 라이브러리 미포함 configure 로그 확인)
// 당시의 정확한 값입니다. BtbN/FFmpeg-Builds는 오래된 autobuild 릴리스를 주기적으로 정리할 수
// 있어(고정 URL이 영구 보장되지는 않음), 이 스크립트가 향후 404로 실패하면 이는 "다른 버전으로
// 몰래 대체"가 아니라 "명시적으로 실패"입니다 - 그때는 BtbN Releases 페이지에서 새 win64-lgpl
// 자산을 골라 아래 3개 상수 + THIRD_PARTY 파일들을 함께 갱신해야 합니다(완료 보고 known
// limitation 참고).
//
// 라이선스(요청서 확정본 7절 - "LICENSE.txt 하나로 끝났다고 단정하지 않는다"): 이 zip은 LGPL
// (일부 컴포넌트는 BSD/MIT 등 더 관대한 라이선스) 조합입니다. configure 로그에
// --disable-libx264/--disable-libx265(GPL 전용 인코더 배제)가 있음을 이 스크립트가 실행 시
// 다시 확인합니다(요청서 확정본 - 추측하지 않고 매 빌드마다 실측). ffmpeg.exe는 이 앱과 별도
// 프로세스로 spawn만 되고(child_process.execFile, 링크 아님) 저장소 코드와 정적/동적으로
// 링크되지 않습니다 - "별도 프로세스로 통신하는 독립 저작물"이라는 업계 표준 배포 패턴입니다.
//
// Usage:
//   node scripts/add-ffmpeg-runtime.js
//
// Requires release\windows-staging\ to already exist and internet access to github.com
// (다운로드 자체는 이 스크립트 실행 시점 = 개발자 빌드 시점에만 일어납니다 - 구매자는 절대
// 인터넷에 접근하지 않습니다).

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const RELEASE_TAG = "autobuild-2026-07-31-14-10";
const ASSET_NAME = "ffmpeg-n8.1.2-34-g9b6c8969e0-win64-lgpl-8.1.zip";
const DOWNLOAD_URL = `https://github.com/BtbN/FFmpeg-Builds/releases/download/${RELEASE_TAG}/${ASSET_NAME}`;
// 이 값은 BtbN/FFmpeg-Builds 해당 release 자산의 실제 SHA-256(64자)입니다.
//
// 2026-08-26 갱신: 기존에 pin한 일일 autobuild(autobuild-2026-08-11-13-11)가 upstream에서
// 삭제되어 404가 났습니다. BtbN은 일일 빌드를 롤링 14일만 보관하고(확인 시점: 최신 14개,
// 2026-08-12~08-25) 월말 빌드만 장기 보관합니다(2024-09-30~2026-07-31, 23개 = 약 23개월).
// 그래서 같은 소스 리비전(n8.1.2-34-g9b6c8969e0)을 담고 있으면서 장기 보존되는 월말
// release로 옮겼습니다. 두 빌드의 configure 플래그는 --extra-version(20260811 vs 20260731)
// 하나만 다르고 나머지 180개가 동일하며, 인코더/포맷 목록도 완전히 같습니다 - 즉 빌드 날짜
// 스탬프만 다른 사실상 같은 FFmpeg입니다. 그래서 EXPECTED_TOP_FOLDER와
// FFMPEG_VERSION_STRING은 바꾸지 않습니다.
const EXPECTED_SHA256 = "089e4169e93b2b3f3acbfced3c0704d24276a225641bdda04d796d28b07a2a38";
const EXPECTED_TOP_FOLDER = "ffmpeg-n8.1.2-34-g9b6c8969e0-win64-lgpl-8.1";
const FFMPEG_VERSION_STRING = "n8.1.2-34-g9b6c8969e0"; // `ffmpeg -version`이 보고해야 하는 정확한 문자열
const TAR_EXE = "C:\\Windows\\System32\\tar.exe"; // bsdtar(Windows 10+ 기본 내장) - .zip도 처리 가능(add-windows-runtime.js와 동일 도구 재사용)

const ROOT = path.join(__dirname, "..");
const STAGING = path.join(ROOT, "release", "windows-staging");
const FFMPEG_DIR = path.join(STAGING, "third-party", "ffmpeg");
const DOWNLOAD_TMP = path.join(os.tmpdir(), "ddalkkak-ffmpeg-runtime-dl-" + Date.now());

const failures = [];
function ok(msg) {
  console.log("[OK] " + msg);
}
function fail(msg) {
  failures.push(msg);
  console.error("[FAIL] " + msg);
}
function info(msg) {
  console.log("[INFO] " + msg);
}
function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function printResult() {
  console.log("\n=== Result ===");
  if (failures.length > 0) {
    console.error("FFMPEG RUNTIME BUILD FAILED: " + failures.length + " check(s) failed. third-party\\ffmpeg\\ was not added to staging.");
    for (const f of failures) console.error(" - " + f);
    process.exitCode = 1;
  } else {
    console.log("FFMPEG RUNTIME BUILD SUCCEEDED: all checks passed.");
  }
}

// ---------------------------------------------------------------------
// 다운로드 - GitHub Releases는 실제 바이트를 별도 CDN 호스트(*.githubusercontent.com)로
// 리다이렉트한다(add-windows-runtime.js의 nodejs.org 단일호스트 정책과 다른 이유) - 그래서
// 여기서는 호스트를 화이트리스트로 제한하는 대신, 최종 다운로드된 바이트의 SHA-256이
// EXPECTED_SHA256과 정확히 일치하는지로 authenticity를 검증한다(호스트가 무엇이든 바이트
// 내용 자체가 서명/해시로 고정되므로 이쪽이 더 강한 보장이다).
// ---------------------------------------------------------------------
function httpsGetFollow(url, maxRedirects) {
  if (maxRedirects == null) maxRedirects = 5;
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      reject(e);
      return;
    }
    if (parsed.protocol !== "https:") {
      reject(new Error("refusing non-https url: " + url));
      return;
    }
    https
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (maxRedirects <= 0) {
            reject(new Error("too many redirects for " + url));
            return;
          }
          const nextUrl = new URL(res.headers.location, url).toString();
          resolve(httpsGetFollow(nextUrl, maxRedirects - 1));
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error("HTTP " + res.statusCode + " for " + url));
          res.resume();
          return;
        }
        resolve(res);
      })
      .on("error", reject);
  });
}

async function downloadToFile(url, destPath) {
  const res = await httpsGetFollow(url);
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const fileStream = fs.createWriteStream(destPath);
    res.on("data", (chunk) => hash.update(chunk));
    res.pipe(fileStream);
    fileStream.on("finish", () => resolve(hash.digest("hex")));
    fileStream.on("error", reject);
    res.on("error", reject);
  });
}

// ---------------------------------------------------------------------
// third-party 고지 파일(요청서 확정본 7절 - LICENSE.txt 하나로 끝났다고 단정하지 않는다).
// ---------------------------------------------------------------------
function writeThirdPartyNoticeFiles() {
  const noticeText = [
    "딸깍 Threads 공장 - 짧은 영상/GIF 생성 기능은 오픈소스 FFmpeg(https://ffmpeg.org)를",
    "별도 실행 파일(ffmpeg.exe, ffprobe.exe)로 포함하여 사용합니다.",
    "",
    "이 앱은 FFmpeg를 별도 프로세스로 실행(spawn)할 뿐, FFmpeg 코드를 이 앱의 코드와",
    "정적/동적으로 링크하지 않습니다.",
    "",
    "라이선스: LGPL(버전 3 조항 포함, --enable-version3) - GNU 및 그 외 관대한 라이선스",
    "(BSD/MIT 등) 컴포넌트의 조합입니다. GPL 전용 라이브러리(libx264/libx265 등)는 이 빌드에",
    "포함되어 있지 않습니다(--disable-libx264 --disable-libx265, add-ffmpeg-runtime.js가 매",
    "빌드 시 configure 로그로 재확인합니다). H.264 인코딩은 Windows Media Foundation의",
    "h264_mf 인코더(Windows OS 구성요소, 이 zip에 포함되지 않음)를 통해 이루어집니다.",
    "",
    "전체 라이선스 전문은 같은 폴더의 LICENSE.txt를 참고하세요.",
    "정확한 빌드/버전/커밋/소스 위치는 BUILD_INFO.txt/SOURCE_INFO.txt를 참고하세요.",
  ].join("\r\n");
  fs.writeFileSync(path.join(FFMPEG_DIR, "NOTICE.txt"), noticeText, "utf-8");

  fs.writeFileSync(path.join(FFMPEG_DIR, "VERSION.txt"), FFMPEG_VERSION_STRING + "\r\n", "utf-8");

  const buildInfoText = [
    "FFmpeg version string: " + FFMPEG_VERSION_STRING,
    "Build provider: BtbN/FFmpeg-Builds (https://github.com/BtbN/FFmpeg-Builds)",
    "Release tag: " + RELEASE_TAG,
    "Asset: " + ASSET_NAME,
    "Asset SHA-256: " + EXPECTED_SHA256,
    "Build variant: win64-lgpl (GPL-only libraries excluded)",
    "Included in this app: bin/ffmpeg.exe, bin/ffprobe.exe (bin/ffplay.exe intentionally excluded - not used)",
    "Fetched/verified by: scripts/add-ffmpeg-runtime.js on " + new Date().toISOString(),
  ].join("\r\n");
  fs.writeFileSync(path.join(FFMPEG_DIR, "BUILD_INFO.txt"), buildInfoText + "\r\n", "utf-8");

  const sourceInfoText = [
    "FFmpeg source code: https://ffmpeg.org/download.html and https://git.ffmpeg.org/ffmpeg.git",
    "Corresponding source for this exact binary build (build scripts + component versions):",
    "  https://github.com/BtbN/FFmpeg-Builds",
    "  https://github.com/BtbN/FFmpeg-Builds/releases/tag/" + RELEASE_TAG,
    "This satisfies the LGPL/BSD/MIT source-availability terms for the components in this build.",
    "No modifications were made to the upstream binaries - the asset above is redistributed as-is.",
  ].join("\r\n");
  fs.writeFileSync(path.join(FFMPEG_DIR, "SOURCE_INFO.txt"), sourceInfoText + "\r\n", "utf-8");

  ok("third-party\\ffmpeg\\{NOTICE,VERSION,BUILD_INFO,SOURCE_INFO}.txt 작성 완료");
}

// =======================================================================
// Main
// =======================================================================
async function main() {
  if (!fs.existsSync(STAGING)) {
    console.error("release\\windows-staging\\ does not exist. Run scripts\\build-windows-staging.js first.");
    process.exit(1);
  }

  console.log("=== 1) Downloading " + ASSET_NAME + " (pinned release) ===");
  fs.mkdirSync(DOWNLOAD_TMP, { recursive: true });
  const zipPath = path.join(DOWNLOAD_TMP, ASSET_NAME);
  const computedHash = await downloadToFile(DOWNLOAD_URL, zipPath);
  info("downloaded file SHA-256: " + computedHash);

  console.log("\n=== 2) SHA-256 verification (고정 버전 - 이 값이 다르면 절대 진행하지 않는다) ===");
  if (computedHash !== EXPECTED_SHA256) {
    fail("SHA-256 MISMATCH: expected " + EXPECTED_SHA256 + " but downloaded file hashes to " + computedHash);
    fail("aborting before extraction; the ZIP was not run or unpacked");
    rmrf(DOWNLOAD_TMP);
    printResult();
    return;
  }
  ok("downloaded ZIP SHA-256 matches the pinned expected value exactly");

  console.log("\n=== 3) Extracting to a temporary folder ===");
  const extractDir = path.join(DOWNLOAD_TMP, "extracted");
  fs.mkdirSync(extractDir, { recursive: true });
  const tarResult = spawnSync(TAR_EXE, ["-xf", zipPath, "-C", extractDir], { encoding: "utf-8" });
  if (tarResult.status !== 0) {
    fail("failed to extract the ZIP: " + (tarResult.stderr || (tarResult.error && tarResult.error.message)));
    rmrf(DOWNLOAD_TMP);
    printResult();
    return;
  }

  const extractedBin = path.join(extractDir, EXPECTED_TOP_FOLDER, "bin");
  const tempFfmpeg = path.join(extractedBin, "ffmpeg.exe");
  const tempFfprobe = path.join(extractedBin, "ffprobe.exe");
  const tempLicense = path.join(extractDir, EXPECTED_TOP_FOLDER, "LICENSE.txt");

  if (!fs.existsSync(tempFfmpeg) || !fs.existsSync(tempFfprobe)) {
    fail("ffmpeg.exe/ffprobe.exe not found after extraction at expected path: " + extractedBin);
    rmrf(DOWNLOAD_TMP);
    printResult();
    return;
  }
  ok("ffmpeg.exe/ffprobe.exe present in the extracted archive");
  if (!fs.existsSync(tempLicense)) {
    fail("LICENSE.txt not found after extraction at expected path: " + tempLicense);
    rmrf(DOWNLOAD_TMP);
    printResult();
    return;
  }
  ok("LICENSE.txt present in the extracted archive");

  console.log("\n=== 4) Runtime sanity check (버전/설정/h264_mf encoder) ===");
  const verInfo = spawnSync(tempFfmpeg, ["-version"], { encoding: "utf-8" });
  const verOut = verInfo.stdout || "";
  if (!verOut.includes(FFMPEG_VERSION_STRING)) {
    fail("extracted ffmpeg.exe -version does not report expected version string '" + FFMPEG_VERSION_STRING + "'");
  } else {
    ok("ffmpeg.exe -version reports expected version string");
  }
  if (verOut.includes("--enable-libx264") || verOut.includes("--enable-libx265")) {
    fail("build configuration reports GPL-only libx264/libx265 ENABLED - this is not the expected LGPL build, aborting");
  } else if (!verOut.includes("--disable-libx264") || !verOut.includes("--disable-libx265")) {
    fail("could not confirm --disable-libx264/--disable-libx265 in build configuration - aborting rather than guessing license status");
  } else {
    ok("build configuration confirms GPL-only libx264/libx265 are disabled (LGPL-safe build)");
  }

  const encInfo = spawnSync(tempFfmpeg, ["-hide_banner", "-h", "encoder=h264_mf"], { encoding: "utf-8" });
  if (!(encInfo.stdout || "").includes("Encoder h264_mf")) {
    fail("h264_mf encoder not found in extracted ffmpeg.exe - this build cannot produce H.264 MP4 output");
  } else {
    ok("h264_mf (Windows Media Foundation) encoder confirmed present");
  }

  if (failures.length > 0) {
    rmrf(DOWNLOAD_TMP);
    printResult();
    return;
  }

  console.log("\n=== 5) Installing into staging\\third-party\\ffmpeg (ffplay.exe intentionally excluded) ===");
  rmrf(FFMPEG_DIR);
  fs.mkdirSync(FFMPEG_DIR, { recursive: true });
  fs.copyFileSync(tempFfmpeg, path.join(FFMPEG_DIR, "ffmpeg.exe"));
  fs.copyFileSync(tempFfprobe, path.join(FFMPEG_DIR, "ffprobe.exe"));
  fs.copyFileSync(tempLicense, path.join(FFMPEG_DIR, "LICENSE.txt"));
  ok("copied ffmpeg.exe/ffprobe.exe/LICENSE.txt into staging");
  writeThirdPartyNoticeFiles();

  rmrf(DOWNLOAD_TMP);

  console.log("\n=== 6) Final staging verification (against the copy actually shipped) ===");
  const finalEntries = fs.readdirSync(FFMPEG_DIR);
  const expectedEntries = new Set(["ffmpeg.exe", "ffprobe.exe", "LICENSE.txt", "NOTICE.txt", "VERSION.txt", "BUILD_INFO.txt", "SOURCE_INFO.txt"]);
  const unexpected = finalEntries.filter((e) => !expectedEntries.has(e));
  if (unexpected.length > 0) fail("unexpected extra file(s) in third-party\\ffmpeg\\: " + unexpected.join(", "));
  else ok("third-party\\ffmpeg\\ contains exactly the expected files (no ffplay.exe, no extras)");

  const finalFfmpeg = path.join(FFMPEG_DIR, "ffmpeg.exe");
  const finalVer = spawnSync(finalFfmpeg, ["-version"], { encoding: "utf-8" });
  if (!(finalVer.stdout || "").includes(FFMPEG_VERSION_STRING)) fail("final staged ffmpeg.exe -version mismatch");
  else ok("final staged ffmpeg.exe -version = " + FFMPEG_VERSION_STRING);

  let totalBytes = 0;
  for (const e of finalEntries) totalBytes += fs.statSync(path.join(FFMPEG_DIR, e)).size;
  console.log("\nTotal size of third-party\\ffmpeg\\: " + (totalBytes / (1024 * 1024)).toFixed(2) + " MB");

  printResult();
}

main().catch((e) => {
  console.error("[FATAL] " + (e && e.stack ? e.stack : e));
  rmrf(DOWNLOAD_TMP);
  process.exitCode = 1;
});
