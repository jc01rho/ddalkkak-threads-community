// scripts/build-windows-staging.js
//
// Builds release\windows-staging\ - a clean, allowlist-based folder that a
// later Windows installer step can package. This script never modifies or
// deletes any existing project file; it only creates/recreates the
// release\windows-staging\ output folder (and reads from the project root).
//
// Requires "npm run build" to have already produced dist\.
//
// Usage:
//   node scripts/build-windows-staging.js

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { decideStagingPackageAction } = require("./staging-dependency-policy");

const ROOT = path.join(__dirname, "..");
const STAGING = path.join(ROOT, "release", "windows-staging");
const REAL_ENV_PATH = path.join(ROOT, ".env");
const ENV_EXAMPLE_PATH = path.join(ROOT, ".env.example");
const LOCKFILE_PATH = path.join(ROOT, "package-lock.json");

const failures = [];

function ok(msg) {
  console.log("[OK] " + msg);
}
function fail(msg) {
  failures.push(msg);
  console.error("[FAIL] " + msg);
}

// ---------------------------------------------------------------------
// 0) Preconditions
// ---------------------------------------------------------------------
if (!fs.existsSync(path.join(ROOT, "dist", "server.js"))) {
  console.error('dist\\server.js not found. Run "npm run build" first, then re-run this script.');
  process.exit(1);
}
// 루트 real .env는 더 이상 필수가 아니다. 예전에는 relay endpoint URL을 여기서 읽어
// staging .env에 주입했지만, Community 공용 빌드는 빌드 머신의 relay 값을 산출물에 넣지
// 않는다(아래 5절). 남은 용도는 검증뿐이라 파일이 없으면 그 검증만 건너뛴다 -
// build-windows-installer.js / add-windows-runtime.js가 이미 쓰는 것과 같은 처리 방식이다.
if (!fs.existsSync(ENV_EXAMPLE_PATH)) {
  console.error(".env.example not found at project root.");
  process.exit(1);
}
if (!fs.existsSync(LOCKFILE_PATH)) {
  console.error("package-lock.json not found.");
  process.exit(1);
}

// ---------------------------------------------------------------------
// 1) Reset the staging folder only (never touches anything else)
// ---------------------------------------------------------------------
if (fs.existsSync(STAGING)) {
  fs.rmSync(STAGING, { recursive: true, force: true });
}
fs.mkdirSync(STAGING, { recursive: true });
ok("reset release\\windows-staging\\");

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------
function copyFile(relSrc, relDest) {
  const src = path.join(ROOT, relSrc);
  const dest = path.join(STAGING, relDest || relSrc);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyDirRecursive(srcDir, destDir, opts) {
  opts = opts || {};
  const skipDirNames = opts.skipDirNames || [];
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (skipDirNames.includes(entry.name)) continue;
      copyDirRecursive(path.join(srcDir, entry.name), path.join(destDir, entry.name), opts);
    } else if (entry.isFile()) {
      fs.copyFileSync(path.join(srcDir, entry.name), path.join(destDir, entry.name));
    }
    // Symlinks are intentionally not followed/copied (none expected here).
  }
}

function walkAllFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkAllFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function parseEnvFile(content) {
  const out = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------
// 2) Runtime-required application files (allowlist)
// ---------------------------------------------------------------------
copyDirRecursive(path.join(ROOT, "dist"), path.join(STAGING, "dist"));
ok("copied dist\\");

copyDirRecursive(path.join(ROOT, "public"), path.join(STAGING, "public"));
ok("copied public\\");

copyFile("package.json", "package.json");
ok("copied package.json");

copyFile("start-release.bat", "start-release.bat");
ok("copied start-release.bat");

// AGPL-3.0 배포 조건: 바이너리를 배포할 때 라이선스 사본을 함께 넣는다.
// .iss의 [Files]가 staging root를 재귀 포함하므로 설치 폴더 루트({app}\LICENSE)에 그대로 들어간다.
copyFile("LICENSE", "LICENSE");
ok("copied LICENSE (AGPL-3.0)");

copyFile(path.join("data", "default-persona.json"), path.join("data", "default-persona.json"));
copyFile(path.join("data", "default-feeds.json"), path.join("data", "default-feeds.json"));
ok("copied data\\default-persona.json and data\\default-feeds.json");

// NOTE on buyer-facing guide docs: README_KO.md and every existing manual
// under docs\manuals (and their built PDFs under docs\output\pdf) describe
// the OLD install.bat + "npm install" + "npm run build" flow, not this
// staging package's start-release.bat-only flow (e.g. 01_..._설치방법.md
// explicitly tells the reader to run install.bat and wait for "npm install").
// Shipping them as-is inside this staging build would give buyers incorrect
// instructions, so none of them were included here. This is a reviewed
// decision, not an oversight - see the final report for the follow-up item.

// ---------------------------------------------------------------------
// 3) Empty user-data folders (no real user data is ever placed here)
// ---------------------------------------------------------------------
fs.mkdirSync(path.join(STAGING, "data", "uploads"), { recursive: true });
fs.mkdirSync(path.join(STAGING, "logs"), { recursive: true });
ok("created empty data\\uploads\\ and logs\\ (no data\\app.db - app creates it on first run)");

// runtime\node.exe is intentionally NOT created in this step (later step).

// ---------------------------------------------------------------------
// 4) Production-only node_modules, derived from package-lock.json
//    (reads the real project node_modules as a read-only source; never
//    modifies or prunes it; npm is never invoked)
// ---------------------------------------------------------------------
const lock = JSON.parse(fs.readFileSync(LOCKFILE_PATH, "utf-8"));
const packages = lock.packages || {};
const prodKeys = [];
const devKeys = [];
for (const key of Object.keys(packages)) {
  if (key === "" || !key.startsWith("node_modules/")) continue;
  const entry = packages[key];
  if (entry && entry.dev === true) devKeys.push(key);
  else prodKeys.push(key);
}

const missingSrc = [];
const skippedOptional = [];
let copiedCount = 0;
for (const key of prodKeys) {
  const srcDir = path.join(ROOT, key);
  const destDir = path.join(STAGING, key);
  // 판정은 scripts/staging-dependency-policy.js의 순수 함수가 단일 출처입니다
  // (scripts/test-runner.js "windowsStagingGate" 테스트가 같은 함수를 영구 검증).
  // "skip-optional-not-installed": npm이 이 플랫폼에 설치하지 않은 optionalDependency
  // (예: sharp의 타 OS/CPU 바이너리 @img/sharp-darwin-arm64 등) - 누락 실패가 아님.
  // 설치되어 있는 optional(예: @img/sharp-win32-x64)은 그대로 "copy"로 복사됩니다.
  const action = decideStagingPackageAction(packages[key], fs.existsSync(srcDir));
  if (action === "skip-optional-not-installed") {
    skippedOptional.push(key);
    continue;
  }
  if (action === "fail-missing-production") {
    missingSrc.push(key);
    continue;
  }
  copyDirRecursive(srcDir, destDir, { skipDirNames: ["node_modules"] });
  copiedCount += 1;
}
if (missingSrc.length > 0) {
  fail("production dependency folder(s) missing from the project's node_modules: " + missingSrc.join(", "));
} else {
  ok(
    "reconstructed production-only node_modules from package-lock.json (" +
      copiedCount +
      " package folders copied, " +
      devKeys.length +
      " devDependency-only package folders skipped, " +
      skippedOptional.length +
      " optionalDependency package(s) not installed on this platform)"
  );
}

// ---------------------------------------------------------------------
// 5) Safe .env for the staging build
//    .env.example is used as the sanitized base - no real secrets in it.
//
//    Exactly one deliberate difference from that base - the release run mode:
//      * Release staging intentionally overrides DRY_RUN to false (enforced
//        further below). DRY_RUN is not a user-facing switch: true means test
//        mode with publishing blocked, so a release build must ship false or
//        buyers could never publish at all. The base keeps DRY_RUN=true as the
//        safe default for development.
//
//    Shipping DRY_RUN=false does not mean posts go out on their own. New
//    installs still start with auto_publish off (database.ts:
//    getSetting("auto_publish", "off")), so nothing is published until the
//    user turns 자동 발행 on in Settings.
//
//    Relay 3종(THREADS_MEDIA_RELAY_BASE_URL / THREADS_OAUTH_RELAY_URL /
//    THREADS_RELAY_CLIENT_KEY)은 .env.example의 빈 placeholder 그대로 나간다.
//    Community는 공용 Setup.exe 하나를 배포하고 각자 자기 Cloudflare relay를 self-host
//    하므로 값이 사용자마다 다르다. 빌드 머신의 값을 넣으면 그 relay 주소와 접속 키가
//    모든 사용자에게 배포된다 - 그래서 읽지도, 넣지도 않는다. 사용자는 설치 후
//    <설치폴더>\.env 에서 직접 채운다.
// ---------------------------------------------------------------------
const exampleContent = fs.readFileSync(ENV_EXAMPLE_PATH, "utf-8");
// real .env는 검증 전용(선택). 없으면 그 검증만 건너뛴다 - 값을 읽어 쓰지는 않는다.
const realEnvContent = fs.existsSync(REAL_ENV_PATH) ? fs.readFileSync(REAL_ENV_PATH, "utf-8") : null;
const realEnvValues = realEnvContent ? parseEnvFile(realEnvContent) : {};

let stagingEnvContent = exampleContent;

// Release runtime policy (구매자 P0): 정식 구매본은 항상 "실제 게시 모드"로 실행되어야
// 한다. 소스/개발 기본값(DRY_RUN=true)은 안전장치로 유지하되, 정식 Release 실행 경로인
// 이 staging .env에서만 DRY_RUN=false를 명시한다. 구매자 UI에서 게시 모드 선택을 제거했고
// 서버도 legacy settings.dry_run을 더 이상 읽지 않으므로, 이 값이 구매본 게시 모드의
// 유일한 source of truth다.
if (/^DRY_RUN=/m.test(stagingEnvContent)) {
  stagingEnvContent = stagingEnvContent.replace(/^DRY_RUN=.*/m, "DRY_RUN=false");
} else {
  stagingEnvContent += "\nDRY_RUN=false\n";
}
if (!/^DRY_RUN=false$/m.test(stagingEnvContent)) {
  fail("staging .env must explicitly set DRY_RUN=false for the release runtime");
}

// Community 배포 계약: 공용 Setup.exe에는 빌드 머신의 relay 주소/접속 키가 절대 들어가지
// 않는다. 세 값은 .env.example의 빈 placeholder 그대로여야 한다. 누군가 .env.example에
// 실값을 채워 넣거나 위 로직이 되살아나 값이 섞이면 여기서 빌드가 실패한다.
const RELAY_KEYS_SHIPPED_EMPTY = ["THREADS_MEDIA_RELAY_BASE_URL", "THREADS_OAUTH_RELAY_URL", "THREADS_RELAY_CLIENT_KEY"];
for (const key of RELAY_KEYS_SHIPPED_EMPTY) {
  if (!new RegExp("^" + key + "=$", "m").test(stagingEnvContent)) {
    fail(
      "staging .env must ship " + key + " as an empty placeholder - " +
        "self-host relay values are filled in by each user after install, never baked into the shared Setup.exe"
    );
  }
}

fs.writeFileSync(path.join(STAGING, ".env"), stagingEnvContent, "utf-8");
const stagingEnvKeys = Object.keys(parseEnvFile(stagingEnvContent));
ok("generated staging .env (based on .env.example; relay values shipped empty for user self-host; DRY_RUN=false enforced for release)");

// ---------------------------------------------------------------------
// 5b) Windows launcher into staging
//
//    section 1) recreates release\windows-staging\ from scratch, which used to
//    silently drop DdalkkakThreadsFactory.exe. It is produced here by the
//    existing official script, and a non-zero exit fails staging.
//    Community에는 ProductRadarBrowser가 없으므로 그 단계는 존재하지 않습니다.
// ---------------------------------------------------------------------
function runOfficialScript(name) {
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", name)], { stdio: "inherit", cwd: ROOT });
  if (r.status !== 0) fail(name + " exited with code " + r.status + " - staging is incomplete");
  else ok(name + " completed");
}
console.log("\n=== 5b) Launcher ===");
runOfficialScript("build-windows-launcher.js");

// =======================================================================
// 6) Automated verification
// =======================================================================
console.log("\n=== Verification ===");

// 6a. staging .env must differ from the real project .env
const stagingEnvOnDisk = fs.readFileSync(path.join(STAGING, ".env"), "utf-8");
if (realEnvContent === null) {
  ok("no real .env at project root - staging .env cannot have copied anything from it");
} else if (stagingEnvOnDisk === realEnvContent) {
  fail(".env in staging is byte-identical to the real project .env");
} else {
  ok(".env in staging is not identical to the real project .env");
}

// 6a-2. 디스크에 실제로 쓰인 staging .env에도 relay 3종이 빈 값인지 다시 확인한다.
// 위 생성 시점 검사와 같은 계약이지만, 이쪽은 installer에 그대로 실릴 "산출물"을 본다.
for (const key of RELAY_KEYS_SHIPPED_EMPTY) {
  if (new RegExp("^" + key + "=.+$", "m").test(stagingEnvOnDisk)) {
    fail("staging .env on disk carries a value for " + key + " - it must ship empty");
  } else {
    ok("staging .env ships " + key + " empty (user configures self-host relay after install)");
  }
}

// 6b/6c/6d/6e. scan all text-like files for secrets, username, absolute paths
const realToken = realEnvValues["THREADS_ACCESS_TOKEN"] || "";
const realUserId = realEnvValues["THREADS_USER_ID"] || "";

const TEXT_EXT = new Set([".js", ".json", ".bat", ".md", ".txt", ".map", ".html", ".css", ".ts", ".gs"]);
function isProbablyText(file) {
  if (path.basename(file) === ".env") return true;
  return TEXT_EXT.has(path.extname(file).toLowerCase());
}

// 개발자 계정명은 하드코딩하지 않는다. 빌드를 돌리는 사람의 OS 계정명을 그대로 쓰고,
// CI 등에서 추가로 막을 이름은 DDALKKAK_DEV_USERNAMES(쉼표 구분)로 넘긴다.
// 하드코딩을 없앤 것이지 검사를 없앤 게 아니다 - 누구의 계정명이든 산출물에 남으면 실패한다.
const DEV_USERNAMES = [
  ...(process.env.DDALKKAK_DEV_USERNAMES || "").split(",").map((s) => s.trim()),
  (() => { try { return os.userInfo().username; } catch (e) { return ""; } })(),
].filter((n) => n && n.length >= 4);
const DEV_USERNAME_RE = DEV_USERNAMES.length
  ? new RegExp("\\b(" + DEV_USERNAMES.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")\\b", "i")
  : null;

const allStagingFiles = walkAllFiles(STAGING);
const tokenHits = new Set();
const privateKeyHits = new Set();
const usernameHits = new Set();
const absPathHits = new Set();

// node_modules holds unmodified third-party package files (not authored by
// this project). Exact secret/username substring matches are still checked
// there too (near-zero false-positive risk), but the generic "PRIVATE KEY"
// marker and generic "C:\Users\" path patterns are common in unrelated
// third-party documentation (e.g. dotenv's own README shows a PRIVATE KEY
// as a usage example) and are only meaningful for files this project itself
// ships/authors, so those two generic checks are scoped to everything
// outside node_modules.
function isInsideNodeModules(file) {
  return file.split(path.sep).includes("node_modules");
}

for (const file of allStagingFiles) {
  if (!isProbablyText(file)) continue;
  let content;
  try {
    content = fs.readFileSync(file, "utf-8");
  } catch (e) {
    continue; // not readable as text, skip
  }
  if (realToken && content.includes(realToken)) tokenHits.add(file);
  if (realUserId && realUserId.length >= 6 && content.includes(realUserId)) tokenHits.add(file);
  if (/THAA[A-Za-z0-9]{20,}/.test(content)) tokenHits.add(file);
  // bare username 검사도 node_modules 밖으로 한정한다. 제3자 패키지의 Apache-2.0 /
  // Apache License / apache.org 표기가 계정명과 겹칠 수 있고 그건 개인정보 유출이 아니다.
  // 아래 PRIVATE KEY / 절대경로 검사가 이미 쓰는 것과 같은 범위 규칙이다.
  if (isInsideNodeModules(file)) continue;
  if (DEV_USERNAME_RE && DEV_USERNAME_RE.test(content)) usernameHits.add(file);
  if (/-----BEGIN (RSA )?PRIVATE KEY-----/.test(content)) privateKeyHits.add(file);
  // "<" can never appear in a real Windows path, so "C:\Users\<...>" is a
  // documentation placeholder (e.g. "C:\Users\<사용자>\AppData\Roaming" in a
  // comment explaining %APPDATA%), not a real leaked absolute path.
  if (/C:\\Users\\(?!<)/i.test(content)) absPathHits.add(file);
}

if (tokenHits.size) fail("Threads token/user-id like string(s) found in: " + [...tokenHits].join(", "));
else ok("no Threads access token / user id strings found in staging");

if (privateKeyHits.size) fail("PRIVATE KEY marker(s) found in: " + [...privateKeyHits].join(", "));
else ok("no PRIVATE KEY markers found in staging");

if (!DEV_USERNAME_RE) fail("developer username scan skipped: no username to check against (set DDALKKAK_DEV_USERNAMES)");
else if (usernameHits.size) fail("developer username found in: " + [...usernameHits].join(", "));
else ok("developer username not found in staging");

if (absPathHits.size) fail('"C:\\Users\\" style absolute path(s) found in: ' + [...absPathHits].join(", "));
else ok('no "C:\\Users\\" style absolute paths found in staging');

// 6f. no app.db / test db files
const dbLike = allStagingFiles.filter((f) => /\.db(-wal|-shm)?$/i.test(f));
if (dbLike.length) fail("database file(s) found in staging: " + dbLike.join(", "));
else ok("no data\\app.db or test database files found in staging");

// 6g. forbidden dev-only paths must not exist
const mustNotExist = [
  "src",
  "license-server",
  path.join("docs", "dev-tools"),
  path.join("docs", "tools"),
  path.join("docs", "seed-data"),
  path.join("docs", "assets"),
  path.join("docs", "output", "preview"),
  path.join("scripts", "test-runner.js"),
  path.join("scripts", "fixtures"),
  ".claude",
];
const presentForbidden = mustNotExist.filter((rel) => fs.existsSync(path.join(STAGING, rel)));
if (presentForbidden.length) fail("forbidden dev-only path(s) found in staging: " + presentForbidden.join(", "));
else ok("no forbidden dev-only directories/files found in staging");

// 6h. devDependencies must not be present in staging node_modules
const leakedDevPackages = devKeys.filter((key) => fs.existsSync(path.join(STAGING, key)));
if (leakedDevPackages.length) fail("devDependency package(s) leaked into staging node_modules: " + leakedDevPackages.join(", "));
else ok("no devDependency packages present in staging node_modules (checked " + devKeys.length + " dev-only package path(s))");

// 6i. better-sqlite3 production module + win32-x64 native binary present
const betterSqlite3Dir = path.join(STAGING, "node_modules", "better-sqlite3");
if (!fs.existsSync(betterSqlite3Dir)) {
  fail("node_modules\\better-sqlite3 missing from staging");
} else {
  const prebuildWin = path.join(betterSqlite3Dir, "prebuilds", "win32-x64.node");
  if (!fs.existsSync(prebuildWin)) fail("better-sqlite3 win32-x64 native binary missing from staging");
  else ok("better-sqlite3 present with win32-x64 native binary");
}

// 6j. dist\server.js and start-release.bat present
if (!fs.existsSync(path.join(STAGING, "dist", "server.js"))) fail("dist\\server.js missing from staging");
else ok("dist\\server.js present in staging");

if (!fs.existsSync(path.join(STAGING, "start-release.bat"))) fail("start-release.bat missing from staging");
else ok("start-release.bat present in staging");


// 6l. Windows launcher present (produced by 5b, never hand-copied)
if (!fs.existsSync(path.join(STAGING, "DdalkkakThreadsFactory.exe"))) {
  fail("DdalkkakThreadsFactory.exe missing from staging (build-windows-launcher.js did not produce it)");
} else {
  ok("DdalkkakThreadsFactory.exe present in staging");
}

// 6k. total file count and size
const finalFiles = walkAllFiles(STAGING);
let totalBytes = 0;
for (const f of finalFiles) totalBytes += fs.statSync(f).size;
console.log("\nTotal files in staging: " + finalFiles.length);
console.log("Total size: " + (totalBytes / (1024 * 1024)).toFixed(2) + " MB");

console.log("\nIncluded .env variable names: " + stagingEnvKeys.join(", "));

// =======================================================================
// Final result
// =======================================================================
console.log("\n=== Result ===");
if (failures.length > 0) {
  console.error("STAGING BUILD FAILED: " + failures.length + " check(s) failed.");
  for (const f of failures) console.error(" - " + f);
  process.exitCode = 1;
} else {
  console.log("STAGING BUILD SUCCEEDED: all checks passed.");
}
