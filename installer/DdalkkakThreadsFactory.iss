; installer\DdalkkakThreadsFactory.iss
;
; Internal-verification Windows Setup builder for Ddalkkak Threads Factory.
; Installs ONLY the contents of release\windows-staging\ (already vetted by
; scripts\build-windows-staging.js, scripts\add-windows-runtime.js,
; and scripts\build-windows-launcher.js)
; - it never reads from the project root (no src\, no real .env, no real DB,
; no license-server\, no dev scripts).
;
; Per-user install, no admin rights, no Program Files, no code signing.

#define MyAppName "딸깍 Threads 공장 Community"
#define MyAppNameEn "Ddalkkak Threads Factory"
#define MyAppVersion "1.11.71"
#define MyAppPublisher "Pulse Factory"
#define MyAppExeName "DdalkkakThreadsFactory.exe"
#define MyStagingDir "..\release\windows-staging"
#define MyAppIcon "..\assets\icons\app-icon.ico"

[Setup]
; ===================================================================
; Fixed AppId (Community edition) - DO NOT CHANGE THIS VALUE IN ANY FUTURE VERSION.
; Generated once for this product (crypto.randomUUID()) and must stay
; identical across every future release/update build so Windows and
; Inno Setup recognize a new installer as an UPDATE of this same
; program, not a separate install. Re-generating this GUID on a future
; build would orphan existing installs (duplicate Add/Remove entries,
; broken update-in-place behavior).
; ===================================================================
AppId={{217E6188-5CCC-4BCC-9D7C-2A55EF4A99BA}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL=https://pulse-audio.co.kr/
AppSupportURL=https://pulse-audio.co.kr/
AppUpdatesURL=https://pulse-audio.co.kr/
AppVerName={#MyAppName} {#MyAppVersion}

DefaultDirName={localappdata}\Programs\DdalkkakThreadsFactoryCommunity
DisableProgramGroupPage=yes
; DisableDirPage left at its default (page is shown) - the requirement only
; fixes the *default* location, it does not ask to lock the wizard page.

PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0

; Blocks install/update/uninstall while the app is running, using the exact
; same session-scoped mutex name the launcher already uses. Inno's built-in
; handling shows its own "please close the application" message and aborts -
; no process is ever force-terminated here.
AppMutex=Local\DdalkkakThreadsFactoryCommunityLauncher

OutputDir=..\release\installer
OutputBaseFilename=DdalkkakThreadsFactory_Community_Setup_{#MyAppVersion}
Compression=lzma2
SolidCompression=yes
SetupLogging=yes

; Used for the Setup wizard/installer EXE itself. UninstallDisplayIcon below
; (Add/Remove Programs) intentionally points at the installed app EXE
; instead, since that EXE already carries this same icon embedded in it.
SetupIconFile={#MyAppIcon}

UninstallDisplayName={#MyAppName}
UninstallDisplayIcon={app}\{#MyAppExeName}

; No custom privilege elevation, no SmartScreen/AV bypass, no firewall rules,
; no startup/run-key registration, and no [Code] section at all - none of
; that is used anywhere in this script.

[Languages]
; Korean only - Inno Setup's official bundled Korean.isl. With exactly one
; language defined, Setup never shows a language-selection dialog; every
; wizard page (welcome, directory, ready-to-install, installing, finish) and
; every default button (Next/Back/Install/Finish/Cancel) uses this file's
; Korean translations automatically.
Name: "korean"; MessagesFile: "compiler:Languages\Korean.isl"

[Tasks]
; Checked by default (no "unchecked" flag) per spec; the user can still
; untick it before installing.
Name: "desktopicon"; Description: "바탕화면에 바로가기 만들기"; GroupDescription: "추가 아이콘:"

[Dirs]
; These are empty in release\windows-staging (no files to copy), so they
; need explicit [Dirs] entries to guarantee they exist after install.
Name: "{app}\data\uploads"
Name: "{app}\logs"

[Files]
; Everything in the vetted staging folder EXCEPT .env, which is handled
; separately below so it can carry the "never overwrite/never remove" flags.
Source: "{#MyStagingDir}\*"; DestDir: "{app}"; Excludes: ".env"; Flags: recursesubdirs createallsubdirs ignoreversion

; Safe placeholder .env: installed only on first install (never overwrites
; an existing one on update) and never removed by the uninstaller even
; though Setup itself put it there.
Source: "{#MyStagingDir}\.env"; DestDir: "{app}"; Flags: onlyifdoesntexist uninsneveruninstall

[Icons]
; {autoprograms}/{autodesktop} resolve to the current user's own Start Menu/
; Desktop under PrivilegesRequired=lowest - no admin rights needed, and no
; shared/all-users location is touched. start-release.bat is intentionally
; never used as a shortcut target; the shortcut always points at the
; windowless launcher EXE.
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
; Checked by default on the finish page; "skipifsilent" means a silent/
; unattended install never auto-launches the app; "nowait" so Setup does not
; block waiting for the (background-supervising) launcher to exit.
Filename: "{app}\{#MyAppExeName}"; Description: "{#MyAppName} 실행"; Flags: postinstall skipifsilent nowait

; No [UninstallDelete] section on purpose: Inno Setup's uninstaller only
; removes the specific files/folders it itself installed (tracked in its own
; log) and silently leaves any non-empty folder alone. Nothing here tells it
; to wildcard-delete the {app}\data or logs folders, so anything the running
; app later creates there (data\app.db, uploads, log files) is left in place
; automatically - no custom preservation logic was needed.
