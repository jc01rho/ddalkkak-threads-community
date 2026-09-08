// scripts/build-windows-installer.js
//
// Compiles installer\DdalkkakThreadsFactory.iss into
// release\installer\DdalkkakThreadsFactory_Setup_<version>.exe using
// whichever Inno Setup 7 ISCC.exe is already installed on this machine.
// Installs nothing new. Runs a security scan of release\windows-staging\
// BEFORE compiling, and refuses to build the Setup EXE if anything fails.
// Never runs/installs the resulting Setup EXE.
//
// Usage:
//   node scripts/build-windows-installer.js

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const STAGING = path.join(ROOT, "release", "windows-staging");
const ISS_PATH = path.join(ROOT, "installer", "DdalkkakThreadsFactory.iss");
const OUTPUT_DIR = path.join(ROOT, "release", "installer");
// 버전은 package.json 하나만 source of truth로 둔다(installer .iss의 MyAppVersion과
// 반드시 같아야 하며, 아래 5)에서 실제 산출물 파일명으로 검증된다).
const APP_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8")).version;
const EXPECTED_OUTPUT_NAME = "DdalkkakThreadsFactory_Community_Setup_" + APP_VERSION + ".exe";
const EXPECTED_OUTPUT_PATH = path.join(OUTPUT_DIR, EXPECTED_OUTPUT_NAME);

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
function printResult() {
  console.log("\n=== Result ===");
  if (failures.length > 0) {
    console.error("INSTALLER BUILD FAILED: " + failures.length + " check(s) failed.");
    for (const f of failures) console.error(" - " + f);
    process.exitCode = 1;
  } else {
    console.log("INSTALLER BUILD SUCCEEDED: all checks passed.");
  }
}

// ---------------------------------------------------------------------
// 1) Inno Setup discovery (installs nothing)
// ---------------------------------------------------------------------
function findIscc() {
  const candidates = ["C:\\Program Files\\Inno Setup 7\\ISCC.exe", "C:\\Program Files (x86)\\Inno Setup 7\\ISCC.exe"];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  const whereResult = spawnSync("where", ["ISCC.exe"], { encoding: "utf-8" });
  if (whereResult.status === 0 && whereResult.stdout) {
    const first = whereResult.stdout.trim().split(/\r?\n/)[0];
    if (first && fs.existsSync(first)) return first;
  }
  return null;
}

console.log("=== 1) Inno Setup discovery ===");
const isccPath = findIscc();
if (!isccPath) {
  console.error("ISCC.exe not found (checked both standard Inno Setup 7 paths and PATH).");
  console.error("No new installer program was installed, and no Setup EXE was built.");
  process.exit(1);
}
ok("found ISCC.exe: " + isccPath);

const psVersion = spawnSync(
  "powershell",
  [
    "-NoProfile",
    "-Command",
    "(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | " +
      "Where-Object { $_.DisplayName -like 'Inno Setup*' } | Select-Object -First 1 -ExpandProperty DisplayVersion)",
  ],
  { encoding: "utf-8" }
);
const detectedVersion = (psVersion.stdout || "").trim();
info("registry-reported Inno Setup version: " + (detectedVersion || "(not found in registry)"));
if (detectedVersion === "7.0.2") {
  ok("confirmed installed Inno Setup version is exactly 7.0.2 (registry query, not assumed)");
} else {
  fail("could not confirm Inno Setup version is 7.0.2 via registry (got: '" + detectedVersion + "')");
}

// ---------------------------------------------------------------------
// Shared helpers (same method as the earlier staging/runtime scripts)
// ---------------------------------------------------------------------
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

function bufferIncludesAscii(buf, str) {
  return buf.includes(Buffer.from(str, "utf-8"));
}
function bufferIncludesUtf16(buf, str) {
  return buf.includes(Buffer.from(str, "utf16le"));
}
function bufferIncludesEither(buf, str) {
  return bufferIncludesAscii(buf, str) || bufferIncludesUtf16(buf, str);
}

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

// 개발자 계정명은 하드코딩하지 않는다. 빌드를 돌리는 사람의 OS 계정명을 그대로 쓰고,
// CI 등에서 추가로 막을 이름은 DDALKKAK_DEV_USERNAMES(쉼표 구분)로 넘긴다.
// 하드코딩을 없앤 것이지 검사를 없앤 게 아니다 - 누구의 계정명이든 산출물에 남으면 실패한다.
const os = require("os");
const DEV_USERNAMES = [
  ...(process.env.DDALKKAK_DEV_USERNAMES || "").split(",").map((s) => s.trim()),
  (() => { try { return os.userInfo().username; } catch (e) { return ""; } })(),
].filter((n) => n && n.length >= 4);
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
const DEV_USERNAME_RE = DEV_USERNAMES.length
  ? new RegExp("\\b(" + DEV_USERNAMES.map(escapeRegExp).join("|") + ")\\b", "i")
  : null;

// ---------------------------------------------------------------------
// 2) Pre-build security scan of release\windows-staging\
// ---------------------------------------------------------------------
console.log("\n=== 2) Pre-build security scan of release\\windows-staging ===");

if (!fs.existsSync(STAGING)) {
  fail("release\\windows-staging\\ does not exist");
  printResult();
  process.exit(1);
}

// AGPL-3.0 사본이 staging에 없으면 Setup.exe를 만들지 않는다.
// (LICENSE 복사 단계가 빠진 채 바이너리가 배포되는 것을 막는 최소 검사)
const stagingLicensePath = path.join(STAGING, "LICENSE");
if (!fs.existsSync(stagingLicensePath)) {
  fail("LICENSE missing from staging - run scripts\build-windows-staging.js (AGPL-3.0 copy must ship with the binary)");
} else {
  ok("LICENSE present in staging (" + fs.statSync(stagingLicensePath).size + " bytes)");
}

const stagingEnvPath = path.join(STAGING, ".env");
if (realEnvContent && fs.existsSync(stagingEnvPath)) {
  const stagingEnvContent = fs.readFileSync(stagingEnvPath, "utf-8");
  if (stagingEnvContent === realEnvContent) fail("staging .env is byte-identical to the real project .env");
  else ok("staging .env is not identical to the real project .env");
}

// Community 공용 배포 계약의 최종 관문: 하나의 Setup.exe를 모두가 내려받고 relay는 각자
// self-host하므로, 특정 사용자의 relay 주소/접속 키가 이 EXE에 실려서는 안 된다.
// staging 생성기(build-windows-staging.js)가 같은 계약을 이미 확인하지만, 그 뒤에 사람이
// staging .env를 손댔거나 예전 staging 폴더를 재사용하는 경우가 남는다. 포장 직전인
// 여기서 한 번 더 막는다 - 아래 "Pre-build security scan failed" 게이트가 ISCC 실행 자체를
// 취소하므로 값이 든 채로는 Setup.exe가 만들어지지 않는다.
// 값은 절대 읽어 출력하지 않고 "비어 있는가"만 본다(real .env와 비교하지 않는다).
const RELAY_KEYS_SHIPPED_EMPTY = ["THREADS_MEDIA_RELAY_BASE_URL", "THREADS_OAUTH_RELAY_URL", "THREADS_RELAY_CLIENT_KEY"];
if (!fs.existsSync(stagingEnvPath)) {
  fail("release\\windows-staging\\.env not found - cannot verify that relay values ship empty");
} else {
  // 메모장 등으로 손댄 뒤 CRLF가 되어도 계약 판정이 흔들리지 않게 줄바꿈만 정규화한다.
  const stagingEnvForRelayCheck = fs.readFileSync(stagingEnvPath, "utf-8").replace(/\r/g, "");
  for (const key of RELAY_KEYS_SHIPPED_EMPTY) {
    if (new RegExp("^" + key + "=$", "m").test(stagingEnvForRelayCheck)) {
      ok("staging .env ships " + key + " empty");
    } else {
      fail(
        "staging .env must ship " + key + " as an empty placeholder - " +
          "the shared Community Setup.exe must never carry a user's self-host relay value"
      );
    }
  }
}

const TEXT_EXT = new Set([".js", ".json", ".bat", ".md", ".txt", ".map", ".html", ".css", ".ts", ".gs", ".log"]);
function isProbablyText(file) {
  if (path.basename(file) === ".env") return true;
  if (path.basename(file) === "LICENSE") return true;
  return TEXT_EXT.has(path.extname(file).toLowerCase());
}
function isInsideNodeModules(file) {
  return file.split(path.sep).includes("node_modules");
}

// Node.js 공식 배포본의 runtime/LICENSE 에는 Node가 번들하는 Apache-2.0 구성요소의
// 라이선스 전문이 들어 있다. 빌드하는 사람의 OS 계정명이 그 문자열과 겹치면 bare
// username 검사에 걸리지만 개인정보 유출이 아니다. 이 파일 하나에 한해 bare username
// 검사만 건너뛴다. PRIVATE KEY / 절대경로 등 나머지 검사는 이 파일에도 그대로 적용된다.
// add-windows-runtime.js 의 같은 guard 와 동일한 예외다.
const RUNTIME_LICENSE_PATH = path.join(STAGING, "runtime", "LICENSE");

const stagingFiles = walkAllFiles(STAGING);
const tokenHits = new Set();
const privateKeyHits = new Set();
const usernameHits = new Set();
const absPathHits = new Set();
const dbHits = stagingFiles.filter((f) => /\.db(-wal|-shm)?$/i.test(f));

for (const file of stagingFiles) {
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
  if (/C:\/Users\/(?!<)/i.test(content)) absPathHits.add(file);
}

if (dbHits.length) fail("database file(s) found in staging: " + dbHits.join(", "));
else ok("no data\\app.db or test database files found in staging");

if (tokenHits.size) fail("Threads token/user-id like string(s) found in: " + [...tokenHits].join(", "));
else ok("no Threads access token / user id strings found in staging");

if (privateKeyHits.size) fail("PRIVATE KEY marker(s) found in: " + [...privateKeyHits].join(", "));
else ok("no PRIVATE KEY markers found in staging");

if (!DEV_USERNAME_RE) fail("developer username scan skipped: no username to check against (set DDALKKAK_DEV_USERNAMES)");
else if (usernameHits.size) fail("developer username found in: " + [...usernameHits].join(", "));
else ok("developer username not found in staging");

if (absPathHits.size) fail('"C:\\Users\\<user>" / "C:/Users/<user>" style path(s) found in: ' + [...absPathHits].join(", "));
else ok('no "C:\\Users\\<user>" / "C:/Users/<user>" style paths found in staging');

const mustNotExist = ["src", "license-server", path.join("docs", "tools"), path.join("scripts")];
const presentForbidden = mustNotExist.filter((rel) => fs.existsSync(path.join(STAGING, rel)));
if (presentForbidden.length) fail("dev-only path(s) found inside staging: " + presentForbidden.join(", "));
else ok("no src\\, license-server\\, docs\\tools\\, or scripts\\ found inside staging");

const exeInStaging = path.join(STAGING, "DdalkkakThreadsFactory.exe");
if (!fs.existsSync(exeInStaging)) fail("DdalkkakThreadsFactory.exe missing from staging");
else ok("DdalkkakThreadsFactory.exe present in staging");

const nodeExeInStaging = path.join(STAGING, "runtime", "node.exe");
if (!fs.existsSync(nodeExeInStaging)) {
  fail("runtime\\node.exe missing from staging");
} else {
  ok("runtime\\node.exe present in staging");
  const verResult = spawnSync(nodeExeInStaging, ["-v"], { encoding: "utf-8" });
  const ver = (verResult.stdout || "").trim();
  if (ver !== "v24.12.0") fail("runtime\\node.exe -v reported '" + ver + "', expected v24.12.0");
  else ok("runtime\\node.exe -v = v24.12.0");
}

if (!fs.existsSync(path.join(STAGING, "dist", "server.js"))) fail("dist\\server.js missing from staging");
else ok("dist\\server.js present in staging");

const win64Prebuild = path.join(STAGING, "node_modules", "better-sqlite3", "prebuilds", "win32-x64.node");
if (!fs.existsSync(win64Prebuild)) fail("better-sqlite3 win32-x64 native binary missing from staging");
else ok("better-sqlite3 win32-x64 native binary present in staging");

if (failures.length > 0) {
  console.error("\nPre-build security scan failed - the Setup EXE will NOT be built.");
  printResult();
  process.exit(1);
}

// ---------------------------------------------------------------------
// 3) Compile with ISCC.exe (nothing else is executed/installed)
// ---------------------------------------------------------------------
console.log("\n=== 3) Compiling installer\\DdalkkakThreadsFactory.iss ===");
fs.mkdirSync(OUTPUT_DIR, { recursive: true });
if (fs.existsSync(EXPECTED_OUTPUT_PATH)) fs.rmSync(EXPECTED_OUTPUT_PATH, { force: true });

const buildLogPath = path.join(OUTPUT_DIR, "build-log.txt");
const compileResult = spawnSync(isccPath, [ISS_PATH], { encoding: "utf-8" });
const compileLog = (compileResult.stdout || "") + (compileResult.stderr || "");
fs.writeFileSync(buildLogPath, compileLog, "utf-8");

if (compileResult.status !== 0 || !fs.existsSync(EXPECTED_OUTPUT_PATH)) {
  fail("ISCC compilation failed or did not produce " + EXPECTED_OUTPUT_NAME + ". See " + path.relative(ROOT, buildLogPath));
  printResult();
  process.exit(1);
}
ok("compiled " + path.relative(ROOT, EXPECTED_OUTPUT_PATH));

// ---------------------------------------------------------------------
// 4) Post-compile static verification (Setup EXE is never run)
// ---------------------------------------------------------------------
console.log("\n=== 4) Post-compile verification (static only, Setup EXE is not run) ===");

const setupBuf = fs.readFileSync(EXPECTED_OUTPUT_PATH);
const setupSize = setupBuf.length;
ok("Setup EXE size = " + setupSize + " bytes (" + (setupSize / (1024 * 1024)).toFixed(2) + " MB)");

const sha256 = crypto.createHash("sha256").update(setupBuf).digest("hex");
console.log("Setup EXE SHA-256: " + sha256);

// ---- PE header parsing (same technique as build-windows-launcher.js) ----
function parsePeHeader(buf) {
  if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) return { error: "missing MZ signature" };
  const peOffset = buf.readUInt32LE(0x3c);
  if (peOffset + 24 > buf.length || buf.readUInt32LE(peOffset) !== 0x00004550) return { error: "PE signature not found" };
  const fileHeaderOffset = peOffset + 4;
  const machine = buf.readUInt16LE(fileHeaderOffset + 0);
  const sizeOfOptionalHeader = buf.readUInt16LE(fileHeaderOffset + 16);
  const optionalHeaderOffset = fileHeaderOffset + 20;
  if (sizeOfOptionalHeader < 70 || optionalHeaderOffset + 70 > buf.length) return { error: "optional header too small" };
  const magic = buf.readUInt16LE(optionalHeaderOffset);
  const subsystem = buf.readUInt16LE(optionalHeaderOffset + 68);
  const dataDirOffset = optionalHeaderOffset + (magic === 0x20b ? 112 : 96);
  const certEntryOffset = dataDirOffset + 4 * 8; // data directory index 4 = Security/Certificate Table
  let certTableSize = null;
  if (certEntryOffset + 8 <= buf.length) {
    certTableSize = buf.readUInt32LE(certEntryOffset + 4);
  }

  const resourceEntryOffset = dataDirOffset + 2 * 8; // data directory index 2 = Resource Table
  let resourceRva = null;
  let resourceSize = null;
  if (resourceEntryOffset + 8 <= buf.length) {
    resourceRva = buf.readUInt32LE(resourceEntryOffset);
    resourceSize = buf.readUInt32LE(resourceEntryOffset + 4);
  }
  const numberOfSections = buf.readUInt16LE(fileHeaderOffset + 2);
  const sectionTableOffset = optionalHeaderOffset + sizeOfOptionalHeader;
  const sections = [];
  for (let i = 0; i < numberOfSections; i++) {
    const off = sectionTableOffset + i * 40;
    if (off + 40 > buf.length) break;
    sections.push({
      virtualSize: buf.readUInt32LE(off + 8),
      virtualAddress: buf.readUInt32LE(off + 12),
      pointerToRawData: buf.readUInt32LE(off + 20),
    });
  }

  return { machine, magic, subsystem, certTableSize, resourceRva, resourceSize, sections };
}

function rvaToFileOffset(sections, rva) {
  for (const s of sections) {
    if (rva >= s.virtualAddress && rva < s.virtualAddress + s.virtualSize) {
      return rva - s.virtualAddress + s.pointerToRawData;
    }
  }
  return null;
}

// Same technique as build-windows-launcher.js: walks the PE resource
// directory tree for a top-level entry with the given numeric type ID
// (RT_ICON = 3, RT_GROUP_ICON = 14). Works regardless of how the icon data
// was internally re-encoded/repackaged by the Inno Setup compiler, unlike a
// raw byte-substring search.
function peHasResourceType(buf, pe, typeId) {
  if (pe.resourceRva == null || !pe.resourceSize) return false;
  const rootOffset = rvaToFileOffset(pe.sections, pe.resourceRva);
  if (rootOffset == null || rootOffset + 16 > buf.length) return false;
  const numberOfNamedEntries = buf.readUInt16LE(rootOffset + 12);
  const numberOfIdEntries = buf.readUInt16LE(rootOffset + 14);
  const total = numberOfNamedEntries + numberOfIdEntries;
  for (let i = 0; i < total; i++) {
    const entryOffset = rootOffset + 16 + i * 8;
    if (entryOffset + 8 > buf.length) break;
    const nameOrId = buf.readUInt32LE(entryOffset);
    const isNamedEntry = (nameOrId & 0x80000000) !== 0;
    if (!isNamedEntry && nameOrId === typeId) return true;
  }
  return false;
}

const pe = parsePeHeader(setupBuf);
if (pe.error) {
  fail("PE header parse error: " + pe.error);
} else {
  ok("Setup EXE is a valid Windows PE file (MZ/PE signatures present)");
  if (pe.certTableSize === null) {
    fail("could not read the PE Certificate Table entry to check for a digital signature");
  } else if (pe.certTableSize === 0) {
    ok("PE Certificate Table size = 0: no digital signature embedded (unsigned, as instructed)");
  } else {
    fail("PE Certificate Table size = " + pe.certTableSize + " bytes: Setup EXE appears to be digitally signed, but no signing was requested");
  }
}

// ---- output filename / location ----
if (path.basename(EXPECTED_OUTPUT_PATH) === EXPECTED_OUTPUT_NAME) ok("output filename matches exactly: " + EXPECTED_OUTPUT_NAME);
else fail("output filename does not match the requested " + EXPECTED_OUTPUT_NAME);

// ---- .iss content checks ----
const issText = fs.readFileSync(ISS_PATH, "utf-8");
function issHas(label, re) {
  if (re.test(issText)) ok(label);
  else fail(label + " - not found in the .iss script");
}
// .iss의 MyAppVersion이 package.json과 정확히 같은지 확인한다. 정규식 이스케이프를 피하려고
// 단순 문자열 포함 검사로 처리한다(버전 문자열은 항상 리터럴이므로 이걸로 충분하다).
if (issText.includes('#define MyAppVersion "' + APP_VERSION + '"')) {
  ok('AppVersion={#MyAppVersion} resolves to "' + APP_VERSION + '"');
} else {
  fail('AppVersion={#MyAppVersion} must be "' + APP_VERSION + '" (package.json) - not found in the .iss script');
}
issHas("install path uses {localappdata}\\Programs\\DdalkkakThreadsFactoryCommunity", /DefaultDirName={localappdata}\\Programs\\DdalkkakThreadsFactoryCommunity/);
issHas("PrivilegesRequired=lowest (no admin rights requested)", /PrivilegesRequired=lowest/);
issHas("ArchitecturesAllowed=x64compatible", /ArchitecturesAllowed=x64compatible/);
issHas("shortcuts (Start Menu + Desktop) target the windowless launcher EXE", /Filename: "\{app\}\\\{#MyAppExeName\}"/);
issHas(".env uses onlyifdoesntexist (never overwritten on update)", /Source: "\{#MyStagingDir\}\\\.env".*Flags: onlyifdoesntexist uninsneveruninstall/);
issHas("AppMutex matches the launcher's Local\\DdalkkakThreadsFactoryCommunityLauncher mutex", /AppMutex=Local\\DdalkkakThreadsFactoryCommunityLauncher/);
issHas("SetupIconFile points at assets\\icons\\app-icon.ico", /SetupIconFile=\{#MyAppIcon\}/);
issHas("UninstallDisplayIcon points at the installed app EXE (which itself carries the embedded icon)", /UninstallDisplayIcon=\{app\}\\\{#MyAppExeName\}/);
if (issText.includes('Filename: "{app}\\start-release.bat"')) fail("start-release.bat is used as a shortcut/run target in the .iss script");
else ok("start-release.bat is not used as a shortcut/run target");

// ---- the uninstaller must only ever remove what Setup itself installed ----
if (/^\[UninstallRun\]/m.test(issText) || /^\[UninstallDelete\]/m.test(issText)) {
  fail("an [UninstallRun]/[UninstallDelete] section exists - the uninstaller must only remove the files Setup itself installed");
} else {
  ok("no [UninstallRun]/[UninstallDelete] section exists");
}

// ---- confirm the icon data itself is actually embedded, not just referenced ----
// Inno Setup re-packages icon data internally (it does not necessarily copy
// the source .ico's bytes verbatim), so a raw byte-substring search against
// the source file is not reliable here. Instead, parse the compiled Setup
// EXE's own PE resource directory directly - the same structural technique
// used for the launcher EXE - to confirm real RT_GROUP_ICON/RT_ICON entries
// are actually present in the file Explorer/the wizard will display.
const RT_ICON = 3;
const RT_GROUP_ICON = 14;
if (pe.error) {
  fail("cannot check icon resources: " + pe.error);
} else {
  const hasIconGroup = peHasResourceType(setupBuf, pe, RT_GROUP_ICON);
  const hasIcon = peHasResourceType(setupBuf, pe, RT_ICON);
  if (hasIconGroup && hasIcon) {
    ok("Setup EXE's PE resource directory contains RT_GROUP_ICON and RT_ICON entries (icon confirmed embedded, not just referenced in the .iss)");
  } else {
    fail("Setup EXE's PE resource directory is missing RT_GROUP_ICON/RT_ICON (group=" + hasIconGroup + ", icon=" + hasIcon + ")");
  }
}

// ---- secrets must not appear in the compiled Setup EXE or the build log ----
console.log("\n--- scanning compiled Setup EXE + build log for secrets ---");
function checkNeitherInOutputs(label, needle) {
  if (!needle) {
    ok(label + ": nothing to check against");
    return;
  }
  const inExe = bufferIncludesEither(setupBuf, needle);
  const inLog = compileLog.includes(needle);
  if (inExe || inLog) {
    fail(label + ": found in " + (inExe ? "Setup EXE" : "") + (inExe && inLog ? " and " : "") + (inLog ? "build log" : ""));
  } else {
    ok(label + ": 0 occurrences (Setup EXE and build log)");
  }
}
checkNeitherInOutputs("real Threads access token", realToken);
checkNeitherInOutputs("real Threads user ID", realUserId && realUserId.length >= 6 ? realUserId : "");
checkNeitherInOutputs("RSA PRIVATE KEY marker", bufferIncludesEither(setupBuf, "-----BEGIN RSA PRIVATE KEY-----") || compileLog.includes("-----BEGIN RSA PRIVATE KEY-----") ? "-----BEGIN RSA PRIVATE KEY-----" : "");
checkNeitherInOutputs("PKCS#8 PRIVATE KEY marker", "-----BEGIN PRIVATE KEY-----");
// 위 2)의 DEV_USERNAMES와 같은 출처를 쓴다(개발자 계정명 하드코딩 금지). 검사 대상이
// 하나도 없으면 조용히 통과시키지 않고 실패시킨다 - 검사를 없앤 게 아니기 때문이다.
if (!DEV_USERNAMES.length) {
  fail("developer username check: no username to check against (set DDALKKAK_DEV_USERNAMES)");
} else {
  for (const name of DEV_USERNAMES) {
    checkNeitherInOutputs('developer username "' + name + '"', name);
    checkNeitherInOutputs('literal "C:\\Users\\' + name + '"', "C:\\Users\\" + name);
  }
}

console.log("\nSetup EXE path: " + path.relative(ROOT, EXPECTED_OUTPUT_PATH));
console.log("Setup EXE size: " + setupSize + " bytes (" + (setupSize / (1024 * 1024)).toFixed(2) + " MB)");
console.log("Setup EXE SHA-256: " + sha256);
console.log("Build log: " + path.relative(ROOT, buildLogPath));

printResult();
