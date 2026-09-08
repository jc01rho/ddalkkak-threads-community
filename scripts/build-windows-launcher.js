// scripts/build-windows-launcher.js
//
// Compiles launcher\DdalkkakLauncher.cs into
// release\windows-staging\DdalkkakThreadsFactory.exe using whatever C#
// compiler is already installed on this machine (.NET Framework 4.x csc.exe
// first, then the dotnet SDK). Installs nothing. If no compiler is
// available, it stops and reports instead of forcing any file into
// existence.
//
// After compiling, it runs static verification only (PE header parsing,
// string scans for secrets/forbidden calls) - it never launches the
// resulting EXE.
//
// Usage:
//   node scripts/build-windows-launcher.js

"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const STAGING = path.join(ROOT, "release", "windows-staging");
const SOURCE_CS = path.join(ROOT, "launcher", "DdalkkakLauncher.cs");
const OUTPUT_EXE = path.join(STAGING, "DdalkkakThreadsFactory.exe");
// Resolved relative to the project root, not any developer-specific path -
// works the same on any machine that has this repo checked out.
const APP_ICON_ICO = path.join(ROOT, "assets", "icons", "app-icon.ico");

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
    console.error("LAUNCHER BUILD FAILED: " + failures.length + " check(s) failed.");
    for (const f of failures) console.error(" - " + f);
    process.exitCode = 1;
  } else {
    console.log("LAUNCHER BUILD SUCCEEDED: all checks passed.");
  }
}

// ---------------------------------------------------------------------
// 1) Compiler discovery (no installation, ever)
// ---------------------------------------------------------------------
function findCscExe() {
  const candidates = [
    "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe",
    "C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe",
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function findDotnetSdk() {
  const result = spawnSync("dotnet", ["--list-sdks"], { encoding: "utf-8" });
  if (result.status === 0 && result.stdout && result.stdout.trim().length > 0) {
    return result.stdout.trim().split(/\r?\n/)[0];
  }
  return null;
}

if (!fs.existsSync(STAGING)) {
  console.error("release\\windows-staging\\ does not exist. Build staging first.");
  process.exit(1);
}
if (!fs.existsSync(SOURCE_CS)) {
  console.error("launcher\\DdalkkakLauncher.cs not found.");
  process.exit(1);
}

console.log("=== 1) Compiler discovery ===");
const cscPath = findCscExe();
let compiler = null;
if (cscPath) {
  const verResult = spawnSync(cscPath, ["/help"], { encoding: "utf-8" });
  const firstLine = ((verResult.stdout || "").split(/\r?\n/)[0] || "").trim();
  info("found .NET Framework csc.exe: " + cscPath);
  info("compiler identifies itself as: " + firstLine);
  compiler = { kind: "csc", path: cscPath, label: firstLine || "csc.exe (.NET Framework 4.x)" };
} else {
  info(".NET Framework 4.x csc.exe not found at either standard location.");
  const sdk = findDotnetSdk();
  if (sdk) {
    info("found dotnet SDK: " + sdk);
    compiler = { kind: "dotnet-sdk", path: "dotnet", label: "dotnet SDK " + sdk };
  } else {
    info("no dotnet SDK found either.");
  }
}

if (!compiler) {
  console.error("\nNo usable C# compiler found on this machine (.NET Framework 4.x csc.exe or dotnet SDK).");
  console.error("Per instructions, no new SDK was installed and no launcher file was created.");
  process.exit(1);
}
ok("using compiler: " + compiler.label);

if (compiler.kind !== "csc") {
  console.error("\nOnly the .NET Framework csc.exe path is implemented in this script (dotnet SDK was not found");
  console.error("on this machine, so the dotnet-project build path was not exercised). Stopping without building.");
  process.exit(1);
}

// ---------------------------------------------------------------------
// 2) Compile
// ---------------------------------------------------------------------
console.log("\n=== 2) Compiling launcher\\DdalkkakLauncher.cs ===");
if (fs.existsSync(OUTPUT_EXE)) fs.rmSync(OUTPUT_EXE, { force: true });

if (!fs.existsSync(APP_ICON_ICO)) {
  console.error("assets\\icons\\app-icon.ico not found. Cannot embed the app icon.");
  process.exit(1);
}

const cscArgs = [
  "/nologo",
  "/target:winexe", // Windows GUI subsystem - never a console window
  "/platform:x64", // matches the rest of this win-x64-only staging bundle
  "/optimize+",
  "/win32icon:" + APP_ICON_ICO, // embeds the app icon into the EXE resources (also used by Explorer/shortcuts)
  "/r:System.Windows.Forms.dll",
  "/out:" + OUTPUT_EXE,
  SOURCE_CS,
];
info("csc " + cscArgs.join(" "));
const compileResult = spawnSync(compiler.path, cscArgs, { encoding: "utf-8" });
if (compileResult.status !== 0 || !fs.existsSync(OUTPUT_EXE)) {
  fail("compilation failed:\n" + (compileResult.stdout || "") + (compileResult.stderr || ""));
  printResult();
  process.exit(1);
}
ok("compiled " + path.relative(ROOT, OUTPUT_EXE));
if (compileResult.stdout && compileResult.stdout.trim()) info("csc output: " + compileResult.stdout.trim());

// =======================================================================
// 3) Static verification (the EXE itself is never run)
// =======================================================================
console.log("\n=== Verification (static only, EXE is not executed) ===");

const exeBuf = fs.readFileSync(OUTPUT_EXE);
const exeSize = exeBuf.length;
ok("DdalkkakThreadsFactory.exe exists, size = " + exeSize + " bytes (" + (exeSize / 1024).toFixed(1) + " KB)");

// ---- PE header parsing ----
function parsePeHeader(buf) {
  if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) {
    return { error: "not a valid PE file (missing MZ signature)" };
  }
  const peOffset = buf.readUInt32LE(0x3c);
  if (peOffset + 24 > buf.length || buf.readUInt32LE(peOffset) !== 0x00004550) {
    return { error: "PE signature not found at expected offset" };
  }
  const fileHeaderOffset = peOffset + 4;
  const machine = buf.readUInt16LE(fileHeaderOffset + 0);
  const sizeOfOptionalHeader = buf.readUInt16LE(fileHeaderOffset + 16);
  const characteristics = buf.readUInt16LE(fileHeaderOffset + 18);
  const optionalHeaderOffset = fileHeaderOffset + 20;
  if (sizeOfOptionalHeader < 70 || optionalHeaderOffset + 70 > buf.length) {
    return { error: "optional header missing or too small to read Subsystem field" };
  }
  const magic = buf.readUInt16LE(optionalHeaderOffset);
  // Subsystem sits at offset 68 from the start of the optional header in
  // BOTH PE32 (0x10b) and PE32+ (0x20b) layouts.
  const subsystem = buf.readUInt16LE(optionalHeaderOffset + 68);

  // Data directory array starts at offset 96 (PE32) / 112 (PE32+) from the
  // start of the optional header. Entry index 2 is the Resource Table.
  const dataDirOffset = optionalHeaderOffset + (magic === 0x20b ? 112 : 96);
  const resourceEntryOffset = dataDirOffset + 2 * 8;
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

  return { machine, characteristics, magic, subsystem, resourceRva, resourceSize, sections };
}

function rvaToFileOffset(sections, rva) {
  for (const s of sections) {
    if (rva >= s.virtualAddress && rva < s.virtualAddress + s.virtualSize) {
      return rva - s.virtualAddress + s.pointerToRawData;
    }
  }
  return null;
}

// Walks the PE resource directory tree looking for a top-level entry whose
// numeric type ID matches typeId (RT_GROUP_ICON = 14, RT_ICON = 3). This is
// a direct structural check that the compiled EXE actually embeds an icon
// resource - not just a file-size guess.
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

const pe = parsePeHeader(exeBuf);
if (pe.error) {
  fail("PE header parse error: " + pe.error);
} else {
  const IMAGE_SUBSYSTEM_WINDOWS_GUI = 2;
  const IMAGE_SUBSYSTEM_WINDOWS_CUI = 3;
  const IMAGE_FILE_MACHINE_AMD64 = 0x8664;

  if (pe.subsystem === IMAGE_SUBSYSTEM_WINDOWS_GUI) {
    ok("PE Subsystem = IMAGE_SUBSYSTEM_WINDOWS_GUI (2) - Windows GUI subsystem, no console window");
  } else if (pe.subsystem === IMAGE_SUBSYSTEM_WINDOWS_CUI) {
    fail("PE Subsystem = IMAGE_SUBSYSTEM_WINDOWS_CUI (3) - this would show a console window");
  } else {
    fail("PE Subsystem = " + pe.subsystem + " - not the expected Windows GUI subsystem (2)");
  }

  if (pe.machine === IMAGE_FILE_MACHINE_AMD64) {
    ok("PE Machine = IMAGE_FILE_MACHINE_AMD64 (0x8664) - runs on x64 Windows");
  } else {
    fail("PE Machine = 0x" + pe.machine.toString(16) + " - expected 0x8664 (AMD64/x64)");
  }

  const RT_ICON = 3;
  const RT_GROUP_ICON = 14;
  const hasIconGroup = peHasResourceType(exeBuf, pe, RT_GROUP_ICON);
  const hasIcon = peHasResourceType(exeBuf, pe, RT_ICON);
  if (hasIconGroup && hasIcon) {
    ok("PE resource directory contains RT_GROUP_ICON and RT_ICON entries - app-icon.ico is actually embedded");
  } else {
    fail("PE resource directory is missing RT_GROUP_ICON/RT_ICON - the icon does not appear to be embedded (group=" + hasIconGroup + ", icon=" + hasIcon + ")");
  }
}

// ---- secret / dev-leftover / forbidden-call scans ----
function bufferIncludesAscii(buf, str) {
  return buf.includes(Buffer.from(str, "utf-8"));
}
function bufferIncludesUtf16(buf, str) {
  return buf.includes(Buffer.from(str, "utf16le"));
}
function bufferIncludesEither(buf, str) {
  return bufferIncludesAscii(buf, str) || bufferIncludesUtf16(buf, str);
}

// Strip C# comments before scanning for forbidden call names (cmd.exe,
// wscript.exe, etc.) - this source file's own comments *explain* that those
// are never used, which would otherwise falsely trip a naive substring scan.
// A simple string-aware scanner is enough here: this file has no verbatim
// (@"...") strings or char literals, only plain double-quoted strings.
function stripCSharpComments(text) {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const c = text[i];
    const c2 = text[i + 1];
    if (inString) {
      out += c;
      if (c === "\\") {
        out += c2 || "";
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i += 1;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i += 1;
      continue;
    }
    if (c === "/" && c2 === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && c2 === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

const sourceTextRaw = fs.readFileSync(SOURCE_CS, "utf-8");
const sourceText = stripCSharpComments(sourceTextRaw);

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

function checkNeither(label, needle) {
  const inSource = sourceText.includes(needle);
  const inExe = needle.length > 0 && bufferIncludesEither(exeBuf, needle);
  if (inSource || inExe) {
    fail(label + ": found in " + (inSource ? "source" : "") + (inSource && inExe ? " and " : "") + (inExe ? "compiled EXE" : ""));
    return false;
  }
  ok(label + ": 0 occurrences (source and compiled EXE)");
  return true;
}

// 개발자 계정명은 하드코딩하지 않는다. 빌드를 돌리는 사람의 OS 계정명을 그대로 쓰고,
// CI 등에서 추가로 막을 이름은 DDALKKAK_DEV_USERNAMES(쉼표 구분)로 넘긴다.
// 하드코딩을 없앤 것이지 검사를 없앤 게 아니다.
const os = require("os");
const DEV_USERNAMES = [
  ...(process.env.DDALKKAK_DEV_USERNAMES || "").split(",").map((s) => s.trim()),
  (() => { try { return os.userInfo().username; } catch (e) { return ""; } })(),
].filter((n) => n && n.length >= 4);
if (!DEV_USERNAMES.length) {
  fail("developer username check: no username to check against (set DDALKKAK_DEV_USERNAMES)");
} else {
  for (const name of DEV_USERNAMES) {
    checkNeither('developer username "' + name + '"', name);
    checkNeither('literal "C:\\Users\\' + name + '"', "C:\\Users\\" + name);
    checkNeither('literal "C:/Users/' + name + '"', "C:/Users/" + name);
  }
}
if (realToken) checkNeither("real Threads access token", realToken);
else ok("real Threads access token: not set in .env, nothing to check against");
if (realUserId && realUserId.length >= 6) checkNeither("real Threads user ID", realUserId);
else ok("real Threads user ID: not set (or too short) in .env, nothing to check against");
checkNeither("RSA PRIVATE KEY marker", "-----BEGIN RSA PRIVATE KEY-----");
checkNeither("PKCS#8 PRIVATE KEY marker", "-----BEGIN PRIVATE KEY-----");
checkNeither("start-release.bat reference", "start-release.bat");
checkNeither("wscript.exe reference", "wscript.exe");
checkNeither("cscript.exe reference", "cscript.exe");
checkNeither("cmd.exe reference", "cmd.exe");
checkNeither("powershell reference", "powershell");
checkNeither("requireAdministrator manifest marker", "requireAdministrator");

// The whole real .env file content should not appear verbatim anywhere.
if (realEnvContent && realEnvContent.trim().length > 0) {
  const embedded = sourceText.includes(realEnvContent) || bufferIncludesEither(exeBuf, realEnvContent);
  if (embedded) fail("the real .env file content appears to be embedded in the source or compiled EXE");
  else ok("real .env file content is not embedded in the source or compiled EXE");
}

// ---------------------------------------------------------------------
// 4) Confirm no other project files were modified by this step
// ---------------------------------------------------------------------
console.log("\n=== Untouched-file check ===");
const shouldBeUntouched = [
  "package.json",
  "package-lock.json",
  ".env",
  "start-release.bat",
  "HANDOFF.md",
  "CHANGELOG.md",
];
// Snapshot is informational only (mtimes are also visible to the operator
// running this script); real confirmation is done by inspecting `git`-free
// mtimes/sizes printed here against what was known before this step.
for (const rel of shouldBeUntouched) {
  const p = path.join(ROOT, rel);
  if (fs.existsSync(p)) {
    const st = fs.statSync(p);
    info(rel + ": mtime=" + st.mtime.toISOString() + " size=" + st.size);
  }
}

console.log("\nCompiled EXE path: " + path.relative(ROOT, OUTPUT_EXE));
console.log("Compiled EXE size: " + exeSize + " bytes (" + (exeSize / 1024).toFixed(1) + " KB)");

printResult();
