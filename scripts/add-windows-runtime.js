// scripts/add-windows-runtime.js
//
// Downloads the OFFICIAL Node.js v24.12.0 win-x64 release from nodejs.org,
// verifies its SHA-256 against the official SHASUMS256.txt, and only if
// every verification step below passes, copies node.exe + LICENSE into
// release\windows-staging\runtime\.
//
// This script never modifies app code, license code, package.json,
// package-lock.json, start-release.bat, the real .env, or any real user
// data (data\app.db, uploads, logs, license cache). All checks run against
// isolated temporary folders that are deleted afterward.
//
// Usage:
//   node scripts/add-windows-runtime.js
//
// Requires release\windows-staging\ to already exist (built by
// scripts\build-windows-staging.js) and internet access to nodejs.org.

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const http = require("http");
const crypto = require("crypto");
const { spawnSync, spawn } = require("child_process");

const NODE_VERSION = "v24.12.0";
const ZIP_NAME = "node-" + NODE_VERSION + "-win-x64.zip";
const DIST_DIR_URL = "https://nodejs.org/dist/" + NODE_VERSION + "/";
const ZIP_URL = DIST_DIR_URL + ZIP_NAME;
const SHASUMS_URL = DIST_DIR_URL + "SHASUMS256.txt";
const EXPECTED_TOP_FOLDER = "node-" + NODE_VERSION + "-win-x64";
const TAR_EXE = "C:\\Windows\\System32\\tar.exe";

const ROOT = path.join(__dirname, "..");
const STAGING = path.join(ROOT, "release", "windows-staging");
const RUNTIME_DIR = path.join(STAGING, "runtime");
// Same drive as STAGING (needed so relative-path env vars resolve correctly,
// see the DB_PATH note in runServerSmokeTest below). Deleted at the end.
const VERIFY_TMP = path.join(ROOT, "release", ".runtime-verify-tmp");
// Download/extraction scratch space - fine to be on any drive.
const DOWNLOAD_TMP = path.join(os.tmpdir(), "ddalkkak-node-runtime-dl-" + Date.now());

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
    console.error("RUNTIME BUILD FAILED: " + failures.length + " check(s) failed. runtime\\ was not added to staging.");
    for (const f of failures) console.error(" - " + f);
    process.exitCode = 1;
  } else {
    console.log("RUNTIME BUILD SUCCEEDED: all checks passed.");
  }
}

// ---------------------------------------------------------------------
// Networking helpers (nodejs.org over HTTPS only, redirects re-validated)
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
    if (parsed.protocol !== "https:" || parsed.hostname !== "nodejs.org") {
      reject(new Error("refusing non-official host/protocol: " + url));
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

async function downloadText(url) {
  const res = await httpsGetFollow(url);
  return new Promise((resolve, reject) => {
    let data = "";
    res.setEncoding("utf-8");
    res.on("data", (c) => (data += c));
    res.on("end", () => resolve(data));
    res.on("error", reject);
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

function parseShasums(text, filename) {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const hash = parts[0];
    const name = parts.slice(1).join(" ").replace(/^\*/, "");
    if (name === filename) return hash.toLowerCase();
  }
  return null;
}

// ---------------------------------------------------------------------
// better-sqlite3 real DB compatibility check (used both for the temp
// extracted runtime and, later, for the final copy in staging).
// ---------------------------------------------------------------------
function runSqliteCheck(nodeExePath, label) {
  const checkDir = fs.mkdtempSync(path.join(os.tmpdir(), "ddalkkak-sqlite-check-"));
  const checkDb = path.join(checkDir, "check.db");
  const betterSqlite3Entry = path.join(STAGING, "node_modules", "better-sqlite3");
  const testScript = path.join(checkDir, "sqlite-test.js");
  fs.writeFileSync(
    testScript,
    [
      "const Database = require(" + JSON.stringify(betterSqlite3Entry) + ");",
      "const db = new Database(" + JSON.stringify(checkDb) + ");",
      'db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)");',
      'db.prepare("INSERT INTO t (val) VALUES (?)").run("runtime-check-value");',
      'const row = db.prepare("SELECT val FROM t WHERE id = 1").get();',
      'if (!row || row.val !== "runtime-check-value") { console.error("VALUE_MISMATCH"); process.exit(1); }',
      "db.close();",
      'console.log("SQLITE_CHECK_OK");',
    ].join("\n"),
    "utf-8"
  );

  const result = spawnSync(nodeExePath, [testScript], { encoding: "utf-8" });
  const out = (result.stdout || "") + (result.stderr || "");
  rmrf(checkDir);

  if (result.status !== 0 || !out.includes("SQLITE_CHECK_OK")) {
    fail("better-sqlite3 DB create/insert/select check failed (" + label + "): " + out.trim());
    return false;
  }
  ok("better-sqlite3 create/insert/select/verify/close succeeded (" + label + ")");
  return true;
}

// ---------------------------------------------------------------------
// Isolated server smoke test
// ---------------------------------------------------------------------
async function waitForHealth(port, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await new Promise((resolve) => {
      const req = http.get({ host: "127.0.0.1", port, path: "/api/health", timeout: 1500 }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      });
      req.on("error", () => resolve(null));
      req.on("timeout", () => {
        req.destroy();
        resolve(null);
      });
    });
    if (result && result.status === 200) return result;
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

async function runServerSmokeTest(nodeExePath) {
  const smokeRoot = path.join(VERIFY_TMP, "smoke");
  const smokeData = path.join(smokeRoot, "data");
  const smokeUploads = path.join(smokeRoot, "uploads");
  const smokeLogs = path.join(smokeRoot, "logs");
  const smokeAppData = path.join(smokeRoot, "appdata");
  fs.mkdirSync(smokeData, { recursive: true });
  fs.mkdirSync(smokeUploads, { recursive: true });
  fs.mkdirSync(smokeLogs, { recursive: true });
  fs.mkdirSync(smokeAppData, { recursive: true });

  // src/env.ts resolves DB_PATH/UPLOAD_DIR/LOG_DIR as
  // path.join(__dirname, "..", process.env.X) - i.e. ALWAYS relative to the
  // app root, never taken as an absolute override. Verified directly:
  // passing an absolute "C:\..." value there produces a broken nested-drive
  // path like "E:\...\windows-staging\C:\..." (path.join does not special-
  // case an absolute later argument the way path.resolve does). So instead
  // of literal absolute paths, we pass paths *relative to STAGING* that
  // resolve to the isolated temp folders below. This requires VERIFY_TMP to
  // be on the same drive as STAGING (it is: both under the project root).
  const relDbPath = path.relative(STAGING, path.join(smokeData, "app.db"));
  const relUploadDir = path.relative(STAGING, smokeUploads);
  const relLogDir = path.relative(STAGING, smokeLogs);

  const TEST_PORT = "3940"; // does not collide with the real app's 3970
  const childEnv = Object.assign({}, process.env, {
    APPDATA: smokeAppData,
    DB_PATH: relDbPath,
    UPLOAD_DIR: relUploadDir,
    LOG_DIR: relLogDir,
    PORT: TEST_PORT,
    DRY_RUN: "true",
    DISABLE_SCHEDULER: "true",
  });

  const child = spawn(nodeExePath, [path.join(STAGING, "dist", "server.js")], {
    cwd: STAGING,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let childOut = "";
  child.stdout.on("data", (d) => (childOut += d.toString()));
  child.stderr.on("data", (d) => (childOut += d.toString()));

  const health = await waitForHealth(TEST_PORT, 15000);

  let smokeOk = false;
  if (health) {
    try {
      const parsed = JSON.parse(health.body);
      if (parsed && parsed.ok === true) {
        smokeOk = true;
        ok('GET /api/health responded 200 with {"ok":true} on isolated test port ' + TEST_PORT);
      } else {
        fail("GET /api/health responded but body was not {ok:true}: " + health.body);
      }
    } catch (e) {
      fail("GET /api/health response was not valid JSON: " + health.body);
    }
  } else {
    fail("server did not respond on /api/health within the timeout. Output:\n" + childOut.trim());
  }

  const exited = await new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve(true);
      return;
    }
    let settled = false;
    child.once("exit", () => {
      settled = true;
      resolve(true);
    });
    child.kill();
    setTimeout(() => {
      if (settled) return;
      if (child.pid) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
      setTimeout(() => resolve(child.exitCode !== null), 1000);
    }, 3000);
  });

  if (exited) ok("test server process terminated, no leftover process (pid " + child.pid + ")");
  else fail("could not confirm the test server process (pid " + child.pid + ") terminated");

  rmrf(smokeRoot);
  return smokeOk && exited;
}

// ---------------------------------------------------------------------
// Secret / dev-leftover scan (same method as build-windows-staging.js)
// ---------------------------------------------------------------------
function scanForSecrets() {
  const realEnvPath = path.join(ROOT, ".env");
  const realEnvContent = fs.existsSync(realEnvPath) ? fs.readFileSync(realEnvPath, "utf-8") : null;
  const realEnvValues = {};
  if (realEnvContent) {
    for (const rawLine of realEnvContent.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const idx = line.indexOf("=");
      if (idx === -1) continue;
      realEnvValues[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  const realToken = realEnvValues["THREADS_ACCESS_TOKEN"] || "";
  const realUserId = realEnvValues["THREADS_USER_ID"] || "";

  const TEXT_EXT = new Set([".js", ".json", ".bat", ".md", ".txt", ".map", ".html", ".css", ".ts", ".gs"]);
  function isProbablyText(file) {
    if (path.basename(file) === ".env") return true;
    if (path.basename(file) === "LICENSE") return true;
    return TEXT_EXT.has(path.extname(file).toLowerCase());
  }
  function isInsideNodeModules(file) {
    return file.split(path.sep).includes("node_modules");
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

  const allFiles = walkAllFiles(STAGING);
  const tokenHits = new Set();
  const privateKeyHits = new Set();
  const usernameHits = new Set();
  const absPathHits = new Set();
  const dbHits = allFiles.filter((f) => /\.db(-wal|-shm)?$/i.test(f));

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

  // Node.js 공식 배포본의 runtime/LICENSE 에는 Node가 번들하는 Apache-2.0 구성요소의
  // 라이선스 전문이 들어 있다. 빌드하는 사람의 OS 계정명이 그 문자열과 겹치면 bare
  // username 검사에 걸리지만 개인정보 유출이 아니다. 이 파일 하나에 한해 bare username
  // 검사만 건너뛴다. PRIVATE KEY / 절대경로 등 나머지 검사는 이 파일에도 그대로 적용된다.
  const RUNTIME_LICENSE_PATH = path.join(RUNTIME_DIR, "LICENSE");

  for (const file of allFiles) {
    if (!isProbablyText(file)) continue;
    let content;
    try {
      content = fs.readFileSync(file, "utf-8");
    } catch (e) {
      continue;
    }
    if (realToken && content.includes(realToken)) tokenHits.add(file);
    if (realUserId && realUserId.length >= 6 && content.includes(realUserId)) tokenHits.add(file);
    if (/THAA[A-Za-z0-9]{20,}/.test(content)) tokenHits.add(file);
    // bare username 검사도 node_modules 밖으로 한정한다. 제3자 패키지의 Apache-2.0 /
    // Apache License / apache.org 표기가 계정명과 겹칠 수 있고 그건 개인정보 유출이 아니다.
    // 아래 PRIVATE KEY / 절대경로 검사가 이미 쓰는 것과 같은 범위 규칙이다.
    if (isInsideNodeModules(file)) continue;
    if (DEV_USERNAME_RE && file !== RUNTIME_LICENSE_PATH && DEV_USERNAME_RE.test(content)) usernameHits.add(file);
    if (/-----BEGIN (RSA )?PRIVATE KEY-----/.test(content)) privateKeyHits.add(file);
    if (/C:\\Users\\(?!<)/i.test(content)) absPathHits.add(file);
  }

  if (dbHits.length) fail("database file(s) found in staging: " + dbHits.join(", "));
  else ok("no data\\app.db or test database files found in staging");

  if (realEnvContent) {
    const stagingEnv = fs.readFileSync(path.join(STAGING, ".env"), "utf-8");
    if (stagingEnv === realEnvContent) fail(".env in staging is byte-identical to the real project .env");
    else ok(".env in staging is not identical to the real project .env");
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
}

// =======================================================================
// Main
// =======================================================================
async function main() {
  if (!fs.existsSync(STAGING)) {
    console.error("release\\windows-staging\\ does not exist. Run scripts\\build-windows-staging.js first.");
    process.exit(1);
  }
  if (!fs.existsSync(path.join(STAGING, "node_modules", "better-sqlite3"))) {
    console.error("release\\windows-staging\\node_modules\\better-sqlite3 not found. Run scripts\\build-windows-staging.js first.");
    process.exit(1);
  }

  console.log("=== 1) Downloading official Node.js " + NODE_VERSION + " win-x64 release ===");
  fs.mkdirSync(DOWNLOAD_TMP, { recursive: true });

  const shasumsText = await downloadText(SHASUMS_URL);
  const expectedHash = parseShasums(shasumsText, ZIP_NAME);
  if (!expectedHash) {
    fail("could not find a " + ZIP_NAME + " entry in the official SHASUMS256.txt");
    rmrf(DOWNLOAD_TMP);
    printResult();
    return;
  }
  info("official SHA-256 (SHASUMS256.txt) for " + ZIP_NAME + ": " + expectedHash);

  const zipPath = path.join(DOWNLOAD_TMP, ZIP_NAME);
  const computedHash = await downloadToFile(ZIP_URL, zipPath);
  info("downloaded file SHA-256 for " + ZIP_NAME + ": " + computedHash);

  console.log("\n=== 2) SHA-256 verification ===");
  if (computedHash !== expectedHash) {
    fail("SHA-256 MISMATCH: expected " + expectedHash + " but downloaded file hashes to " + computedHash);
    fail("aborting before extraction; the ZIP was not run or unpacked");
    rmrf(DOWNLOAD_TMP);
    printResult();
    return;
  }
  ok("downloaded ZIP SHA-256 matches the official SHASUMS256.txt entry exactly");

  console.log("\n=== 3) Extracting to a temporary folder ===");
  const extractDir = path.join(DOWNLOAD_TMP, "extracted");
  fs.mkdirSync(extractDir, { recursive: true });
  const tarResult = spawnSync(TAR_EXE, ["-xf", zipPath, "-C", extractDir], { encoding: "utf-8" });
  if (tarResult.status !== 0) {
    fail("failed to extract the official ZIP: " + (tarResult.stderr || (tarResult.error && tarResult.error.message)));
    rmrf(DOWNLOAD_TMP);
    printResult();
    return;
  }

  const extractedRoot = path.join(extractDir, EXPECTED_TOP_FOLDER);
  const tempNodeExe = path.join(extractedRoot, "node.exe");
  const tempLicense = path.join(extractedRoot, "LICENSE");

  if (!fs.existsSync(tempNodeExe)) {
    fail("node.exe not found after extraction at expected path: " + tempNodeExe);
    rmrf(DOWNLOAD_TMP);
    printResult();
    return;
  }
  ok("node.exe present in the extracted official archive");

  if (!fs.existsSync(tempLicense)) {
    fail("LICENSE not found after extraction at expected path: " + tempLicense);
    rmrf(DOWNLOAD_TMP);
    printResult();
    return;
  }
  ok("LICENSE present in the extracted official archive");

  const verInfo = spawnSync(tempNodeExe, ["-e", "console.log(process.version+'|'+process.platform+'|'+process.arch)"], {
    encoding: "utf-8",
  });
  const verLine = (verInfo.stdout || "").trim();
  const parts = verLine.split("|");
  const ver = parts[0],
    plat = parts[1],
    arch = parts[2];

  if (ver !== NODE_VERSION) fail("extracted node.exe reports version '" + ver + "', expected exactly " + NODE_VERSION);
  else ok("node.exe -v reports exactly " + ver);

  if (plat !== "win32" || arch !== "x64") fail("extracted node.exe reports platform/arch '" + plat + "/" + arch + "', expected win32/x64");
  else ok("node.exe confirmed as Windows x64 (win32/x64)");

  if (failures.length > 0) {
    rmrf(DOWNLOAD_TMP);
    printResult();
    return;
  }

  console.log("\n=== 4) better-sqlite3 real DB compatibility check ===");
  rmrf(VERIFY_TMP);
  fs.mkdirSync(VERIFY_TMP, { recursive: true });
  const sqliteOk = runSqliteCheck(tempNodeExe, "temp extracted " + NODE_VERSION + " runtime");
  if (!sqliteOk) {
    fail("Node 20/22 fallback was NOT attempted, per instructions; aborting instead.");
    rmrf(DOWNLOAD_TMP);
    rmrf(VERIFY_TMP);
    printResult();
    return;
  }

  console.log("\n=== 5) Isolated server smoke test ===");
  const smokeOk = await runServerSmokeTest(tempNodeExe);

  rmrf(VERIFY_TMP);

  if (!smokeOk) {
    rmrf(DOWNLOAD_TMP);
    printResult();
    return;
  }

  console.log("\n=== 6) All checks passed on the temp copy - installing into staging\\runtime ===");
  rmrf(RUNTIME_DIR);
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  fs.copyFileSync(tempNodeExe, path.join(RUNTIME_DIR, "node.exe"));
  fs.copyFileSync(tempLicense, path.join(RUNTIME_DIR, "LICENSE"));
  ok("copied runtime\\node.exe and runtime\\LICENSE into staging (nothing else)");

  rmrf(DOWNLOAD_TMP);

  console.log("\n=== 7) Final staging verification (against the copy actually shipped) ===");
  const finalNodeExe = path.join(RUNTIME_DIR, "node.exe");

  const finalVer = spawnSync(finalNodeExe, ["-v"], { encoding: "utf-8" });
  if ((finalVer.stdout || "").trim() !== NODE_VERSION) fail("runtime\\node.exe -v does not report " + NODE_VERSION);
  else ok("runtime\\node.exe -v = " + NODE_VERSION);

  runSqliteCheck(finalNodeExe, "final runtime\\node.exe in staging");

  if (!fs.existsSync(path.join(STAGING, "dist", "server.js"))) fail("dist\\server.js missing from staging");
  else ok("dist\\server.js present in staging");

  if (!fs.existsSync(path.join(STAGING, "start-release.bat"))) fail("start-release.bat missing from staging");
  else ok("start-release.bat present in staging (not modified by this script)");

  const runtimeEntries = fs.readdirSync(RUNTIME_DIR);
  const unexpectedRuntimeEntries = runtimeEntries.filter((e) => e !== "node.exe" && e !== "LICENSE");
  if (unexpectedRuntimeEntries.length > 0) fail("unexpected extra file(s) in runtime\\: " + unexpectedRuntimeEntries.join(", "));
  else ok("runtime\\ contains exactly node.exe and LICENSE (no npm/npx/corepack/headers/docs)");

  scanForSecrets();

  function walkAllFilesFinal(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walkAllFilesFinal(full));
      else if (entry.isFile()) out.push(full);
    }
    return out;
  }
  const finalFiles = walkAllFilesFinal(STAGING);
  let totalBytes = 0;
  for (const f of finalFiles) totalBytes += fs.statSync(f).size;
  console.log("\nTotal files in staging (including runtime): " + finalFiles.length);
  console.log("Total size: " + (totalBytes / (1024 * 1024)).toFixed(2) + " MB");

  printResult();
}

main().catch((e) => {
  console.error("[FATAL] " + (e && e.stack ? e.stack : e));
  rmrf(DOWNLOAD_TMP);
  rmrf(VERIFY_TMP);
  process.exitCode = 1;
});
