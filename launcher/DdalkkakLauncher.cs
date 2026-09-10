// launcher\DdalkkakLauncher.cs
//
// Windows GUI launcher for Ddalkkak Threads Factory. Compiled with
// /target:winexe so it never shows a console/CMD/PowerShell window.
//
// This program only starts the already-built release package
// (runtime\node.exe dist\server.js) directly via CreateProcess
// (UseShellExecute = false). It never goes through cmd.exe, PowerShell,
// wscript.exe, cscript.exe, or start-release.bat, and never requests
// administrator privileges.

using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;

namespace DdalkkakLauncher
{
    internal static class Program
    {
        private const string AppUrl = "http://localhost:3970";
        private const string HealthUrl = "http://127.0.0.1:3970/api/health";
        private const int ReadyTimeoutMs = 20000;
        private const int PollIntervalMs = 500;
        private const long MaxLogBytes = 5 * 1024 * 1024; // 5 MB, simple one-shot rotation

        private static string appDir;
        private static string logsDir;
        private static string serverLogPath;
        private static string launcherLogPath;

        [STAThread]
        private static void Main()
        {
            appDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            logsDir = Path.Combine(appDir, "logs");
            serverLogPath = Path.Combine(logsDir, "server-console.log");
            launcherLogPath = Path.Combine(logsDir, "launcher.log");

            Mutex mutex = null;
            bool ownsMutex = false;
            try
            {
                // Local\ scopes this to the current user session only - never a
                // system-wide/admin-level mutex.
                mutex = new Mutex(false, "Local\\DdalkkakThreadsFactoryCommunityLauncher");
                try
                {
                    ownsMutex = mutex.WaitOne(3000);
                }
                catch (AbandonedMutexException)
                {
                    ownsMutex = true;
                }

                Run(ownsMutex);
            }
            finally
            {
                if (mutex != null)
                {
                    if (ownsMutex)
                    {
                        try { mutex.ReleaseMutex(); } catch { }
                    }
                    mutex.Close();
                }
            }
        }

        private static void Run(bool ownsMutex)
        {
            EnsureLogsDir();
            RotateLogIfTooBig(serverLogPath);
            RotateLogIfTooBig(launcherLogPath);

            string nodeExe = Path.Combine(appDir, "runtime", "node.exe");
            string serverJs = Path.Combine(appDir, "dist", "server.js");

            if (!File.Exists(nodeExe) || !File.Exists(serverJs))
            {
                LogLauncher("Missing required file(s). runtime\\node.exe exists=" + File.Exists(nodeExe) +
                            ", dist\\server.js exists=" + File.Exists(serverJs));
                ShowError("Application files are missing or damaged.");
                return;
            }

            // Checked for completeness (per spec item 3); not fatal by themselves,
            // since the app itself already handles a missing .env with safe
            // defaults and public\ is only needed once the server is serving.
            string publicDir = Path.Combine(appDir, "public");
            string envFile = Path.Combine(appDir, ".env");
            LogLauncher("public\\ exists: " + Directory.Exists(publicDir));
            LogLauncher(".env exists: " + File.Exists(envFile));

            HealthResult existing = CheckHealth();
            if (existing == HealthResult.Ok)
            {
                LogLauncher("Existing healthy server found on port 3970; not starting a new one.");
                OpenBrowser();
                return;
            }
            if (existing == HealthResult.PortInUseByOther)
            {
                LogLauncher("Port 3970 responded but not with this app's health payload; another program is using it.");
                ShowError("Port 3970 is being used by another application.");
                return;
            }

            if (!ownsMutex)
            {
                // Another instance of this launcher is currently starting the
                // server. Do not start a second Node process - just wait for it
                // and then either open the browser or report failure.
                LogLauncher("Another launcher instance holds the startup mutex; waiting instead of starting a second server.");
                HealthResult afterWait = WaitForHealth(ReadyTimeoutMs);
                if (afterWait == HealthResult.Ok) OpenBrowser();
                else ShowError("Failed to start Ddalkkak Threads Factory.\nSee logs\\server-console.log for details.");
                return;
            }

            Process serverProcess;
            try
            {
                serverProcess = StartServerProcess(nodeExe, serverJs);
            }
            catch (Exception ex)
            {
                LogLauncher("Failed to start node.exe: " + ex.Message);
                ShowError("Failed to start Ddalkkak Threads Factory.\nSee logs\\server-console.log for details.");
                return;
            }

            HealthResult ready = WaitForHealth(ReadyTimeoutMs);
            if (ready == HealthResult.Ok)
            {
                OpenBrowser();
                SuperviseUntilExit(serverProcess);
                return;
            }

            LogLauncher("Server did not become ready within " + ReadyTimeoutMs + " ms.");
            TryKillOnlyOurProcess(serverProcess);
            ShowError("Failed to start Ddalkkak Threads Factory.\nSee logs\\server-console.log for details.");
        }

        // Keeps this launcher process alive for as long as the Node server
        // process it started keeps running, instead of returning right after
        // opening the browser. No window or message loop is created here -
        // this just blocks the (windowless) main thread.
        //
        // Root cause this fixes (found by direct reproduction): the old
        // behavior returned immediately after OpenBrowser(), so the launcher
        // process exited within seconds. Since runtime\node.exe's stdout/
        // stderr are redirected to anonymous pipes owned by this launcher
        // (RedirectStandardOutput/Error = true), Windows closed the read
        // ends of those pipes the moment the launcher exited. The Node
        // process kept running for a while with nothing to log, then the
        // next write to the now-broken pipe (most likely the scheduler's
        // once-a-minute tick log in src/scheduler.ts) triggered a silent,
        // untrapped stream error that killed it - with no crash trace,
        // because stderr was broken too. Verified: launcher-started server
        // reproducibly died ~90-120s after launch in 3/3 runs; the same
        // server started directly (stdio to files, no launcher pipe) ran
        // 580s+ with no issue. Keeping the launcher alive for the server's
        // whole lifetime keeps the pipe read ends open the whole time, so
        // this failure mode cannot occur.
        private static void SuperviseUntilExit(Process serverProcess)
        {
            try
            {
                // No timeout: supervise for as long as the server itself
                // runs. The parameterless overload also waits for the
                // asynchronous redirected-output events to finish, so any
                // output the server produced right before exiting still
                // reaches server-console.log before this returns.
                serverProcess.WaitForExit();
                LogLauncher("Server process exited (exit code " + SafeExitCode(serverProcess) + "). Launcher shutting down.");
            }
            catch (Exception ex)
            {
                LogLauncher("Error while supervising the server process: " + ex.Message);
            }
            finally
            {
                try { serverProcess.Dispose(); } catch { }
            }
        }

        private static string SafeExitCode(Process p)
        {
            try { return p.ExitCode.ToString(); } catch { return "unknown"; }
        }

        private enum HealthResult
        {
            Ok,
            NotResponding,
            PortInUseByOther
        }

        private static HealthResult CheckHealth()
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(HealthUrl);
                req.Method = "GET";
                req.Timeout = 1500;
                using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                {
                    if (resp.StatusCode == HttpStatusCode.OK)
                    {
                        string body;
                        using (StreamReader sr = new StreamReader(resp.GetResponseStream()))
                        {
                            body = sr.ReadToEnd();
                        }
                        // src/server.ts responds to /api/health with exactly {"ok":true}.
                        // Only that specific payload counts as "our app is healthy" -
                        // merely getting *a* 200 response is not treated as proof.
                        if (body != null && body.Contains("\"ok\":true"))
                        {
                            return HealthResult.Ok;
                        }
                    }
                    return HealthResult.PortInUseByOther;
                }
            }
            catch (WebException wex)
            {
                if (wex.Response != null)
                {
                    // Got a real HTTP response, just not a normal 200 - some other
                    // program is answering on this port.
                    return HealthResult.PortInUseByOther;
                }
                // Connection refused / timed out / nothing listening at all.
                return HealthResult.NotResponding;
            }
            catch (Exception)
            {
                return HealthResult.NotResponding;
            }
        }

        private static HealthResult WaitForHealth(int timeoutMs)
        {
            int waited = 0;
            while (waited < timeoutMs)
            {
                HealthResult r = CheckHealth();
                if (r == HealthResult.Ok) return HealthResult.Ok;
                if (r == HealthResult.PortInUseByOther) return HealthResult.PortInUseByOther;
                Thread.Sleep(PollIntervalMs);
                waited += PollIntervalMs;
            }
            return HealthResult.NotResponding;
        }

        private static Process StartServerProcess(string nodeExe, string serverJs)
        {
            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = nodeExe;
            psi.Arguments = "\"" + serverJs + "\"";
            psi.WorkingDirectory = appDir;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.WindowStyle = ProcessWindowStyle.Hidden;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;

            ClaudeLookup claude = FindClaude();
            if (claude.Kind == "NOT_FOUND")
            {
                LogLauncher("Claude Code not found via any search step; server will start without it (existing not-connected UI applies).");
            }
            else
            {
                // 찾은 실행 파일의 전체 경로를 자식 프로세스에만 CLAUDE_BIN으로 넘깁니다.
                // PATH prepend에만 의존하면 두 가지가 깨집니다:
                //   - Claude Desktop 번들 CLI는 버전 폴더 안에 있어 PATH에 올릴 대상이 아님
                //   - npm 전역 설치본은 claude.cmd라서 PATH에 올려도 Node가 직접 실행할 수 없음
                // 그래서 경로를 명시적으로 전달하고, PATH prepend는 호환성 차원에서 유지합니다.
                psi.EnvironmentVariables["CLAUDE_BIN"] = claude.FullPath;
                if (claude.DirToPrepend != null)
                {
                    string currentPath = Environment.GetEnvironmentVariable("PATH") ?? "";
                    psi.EnvironmentVariables["PATH"] = claude.DirToPrepend + ";" + currentPath;
                }
                // 개인 사용자 전체 경로는 로그에 남기지 않고 발견 위치 유형과 파일명만 남깁니다.
                LogLauncher("Claude Code found (" + claude.Kind + "): " + Path.GetFileName(claude.FullPath)
                    + (claude.DirToPrepend != null ? "; its folder was prepended to the child process PATH only" : "; already reachable, PATH unchanged"));
            }

            Process p = new Process();
            p.StartInfo = psi;
            p.OutputDataReceived += OnServerOutputReceived;
            p.ErrorDataReceived += OnServerOutputReceived;
            p.Start();
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();
            return p;
        }

        private static void OnServerOutputReceived(object sender, DataReceivedEventArgs e)
        {
            if (e.Data != null) AppendServerLog(e.Data);
        }

        // Where Claude Code was found, and what (if anything) to do about PATH.
        // Kind is one of: FOUND_ENV, FOUND_IN_PATH, FOUND_LOCAL_BIN, FOUND_NPM,
        // FOUND_DESKTOP, NOT_FOUND. DirToPrepend is null when the folder is
        // already reachable and nothing needs to be added.
        private sealed class ClaudeLookup
        {
            public string Kind;
            public string FullPath;
            public string DirToPrepend;
        }

        // Search order (start-release.bat performs the same search in the same order):
        //   0) an explicit CLAUDE_BIN that points at a file that actually exists
        //   1) current PATH: claude.exe
        //   2) current PATH: claude, claude.cmd
        //   3) %USERPROFILE%\.local\bin\claude.exe, then claude
        //   4) %APPDATA%\npm\claude.cmd, then claude.exe
        //   5) %APPDATA%\Claude\claude-code\<version>\claude.exe  (Claude Desktop bundle)
        // Never hardcodes a username or a developer machine path - only the
        // %USERPROFILE%/%APPDATA% values Windows sets per user. Never guesses a
        // path that does not exist: every candidate is File.Exists-checked.
        private static ClaudeLookup FindClaude()
        {
            // 0) Respect an explicit CLAUDE_BIN, but only when it really exists.
            string envBin = Environment.GetEnvironmentVariable("CLAUDE_BIN");
            if (!string.IsNullOrEmpty(envBin))
            {
                try
                {
                    if (File.Exists(envBin))
                    {
                        return new ClaudeLookup { Kind = "FOUND_ENV", FullPath = envBin, DirToPrepend = null };
                    }
                }
                catch
                {
                    // A malformed CLAUDE_BIN must not stop the search below.
                }
            }

            // 1) + 2) already reachable through the current PATH.
            string[] pathNames = new string[] { "claude.exe", "claude", "claude.cmd" };
            for (int i = 0; i < pathNames.Length; i++)
            {
                string hit = FindOnCurrentPath(pathNames[i]);
                if (hit != null)
                {
                    return new ClaudeLookup { Kind = "FOUND_IN_PATH", FullPath = hit, DirToPrepend = null };
                }
            }

            // 3) standalone installer (install.ps1 / install.cmd).
            string userProfile = Environment.GetEnvironmentVariable("USERPROFILE");
            if (!string.IsNullOrEmpty(userProfile))
            {
                string standaloneDir = Path.Combine(userProfile, ".local", "bin");
                string hit = FirstExisting(standaloneDir, new string[] { "claude.exe", "claude" });
                if (hit != null)
                {
                    return new ClaudeLookup { Kind = "FOUND_LOCAL_BIN", FullPath = hit, DirToPrepend = standaloneDir };
                }
            }

            string appData = Environment.GetEnvironmentVariable("APPDATA");

            // 4) npm global install.
            if (!string.IsNullOrEmpty(appData))
            {
                string npmDir = Path.Combine(appData, "npm");
                string hit = FirstExisting(npmDir, new string[] { "claude.cmd", "claude.exe" });
                if (hit != null)
                {
                    return new ClaudeLookup { Kind = "FOUND_NPM", FullPath = hit, DirToPrepend = npmDir };
                }
            }

            // 5) Claude Desktop ships its own Claude Code under a per-version
            //    folder that is not on PATH, so only an explicit path reaches it.
            if (!string.IsNullOrEmpty(appData))
            {
                string desktopExe = FindNewestDesktopClaude(Path.Combine(appData, "Claude", "claude-code"));
                if (desktopExe != null)
                {
                    return new ClaudeLookup { Kind = "FOUND_DESKTOP", FullPath = desktopExe, DirToPrepend = Path.GetDirectoryName(desktopExe) };
                }
            }

            return new ClaudeLookup { Kind = "NOT_FOUND", FullPath = null, DirToPrepend = null };
        }

        // Picks the newest version folder that actually contains claude.exe.
        // Folder names are normally versions ("2.1.260"); anything that does not
        // parse as a version still stays a candidate and is ordered by name, so
        // an unexpected name can never make the whole lookup fail.
        private static string FindNewestDesktopClaude(string baseDir)
        {
            try
            {
                if (!Directory.Exists(baseDir)) return null;
                string[] dirs = Directory.GetDirectories(baseDir);
                string bestPath = null;
                Version bestVersion = null;
                string bestName = null;
                for (int i = 0; i < dirs.Length; i++)
                {
                    string exe = Path.Combine(dirs[i], "claude.exe");
                    if (!File.Exists(exe)) continue;
                    string name = Path.GetFileName(dirs[i]);
                    Version parsed = null;
                    Version.TryParse(name, out parsed);

                    if (bestPath == null)
                    {
                        bestPath = exe; bestVersion = parsed; bestName = name; continue;
                    }
                    if (parsed != null && bestVersion != null)
                    {
                        if (parsed > bestVersion) { bestPath = exe; bestVersion = parsed; bestName = name; }
                    }
                    else if (parsed != null && bestVersion == null)
                    {
                        // A real version always beats an unparseable folder name.
                        bestPath = exe; bestVersion = parsed; bestName = name;
                    }
                    else if (parsed == null && bestVersion == null)
                    {
                        if (string.Compare(name, bestName, StringComparison.OrdinalIgnoreCase) > 0)
                        {
                            bestPath = exe; bestName = name;
                        }
                    }
                }
                return bestPath;
            }
            catch
            {
                return null;
            }
        }

        private static string FirstExisting(string dir, string[] fileNames)
        {
            for (int i = 0; i < fileNames.Length; i++)
            {
                try
                {
                    string full = Path.Combine(dir, fileNames[i]);
                    if (File.Exists(full)) return full;
                }
                catch
                {
                    // Ignore malformed paths and keep looking.
                }
            }
            return null;
        }

        private static string FindOnCurrentPath(string exeName)
        {
            string pathVar = Environment.GetEnvironmentVariable("PATH");
            if (string.IsNullOrEmpty(pathVar)) return null;
            string[] dirs = pathVar.Split(';');
            for (int i = 0; i < dirs.Length; i++)
            {
                string dir = dirs[i].Trim();
                if (dir.Length == 0) continue;
                try
                {
                    string full = Path.Combine(dir, exeName);
                    if (File.Exists(full)) return full;
                }
                catch
                {
                    // Ignore malformed PATH entries and keep searching.
                }
            }
            return null;
        }

        // Only ever targets the exact Process handle this launcher itself
        // started - never searches for or terminates any other process.
        private static void TryKillOnlyOurProcess(Process p)
        {
            if (p == null) return;
            try
            {
                if (!p.HasExited)
                {
                    p.Kill();
                    p.WaitForExit(5000);
                }
            }
            catch (Exception ex)
            {
                LogLauncher("Failed to stop the server process this launcher started: " + ex.Message);
            }
        }

        // ShellExecute (UseShellExecute = true) directly, via the Win32 shell -
        // not cmd.exe's "start" command and not PowerShell.
        private static void OpenBrowser()
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = AppUrl;
                psi.UseShellExecute = true;
                Process.Start(psi);
            }
            catch (Exception ex)
            {
                LogLauncher("Failed to open the default browser: " + ex.Message);
            }
        }

        private static void ShowError(string message)
        {
            MessageBox.Show(message, "Ddalkkak Threads Factory", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }

        private static void EnsureLogsDir()
        {
            try
            {
                if (!Directory.Exists(logsDir)) Directory.CreateDirectory(logsDir);
            }
            catch
            {
                // Best-effort only; the app itself also ensures its own folders.
            }
        }

        private static void RotateLogIfTooBig(string path)
        {
            try
            {
                if (!File.Exists(path)) return;
                FileInfo fi = new FileInfo(path);
                if (fi.Length <= MaxLogBytes) return;
                string backupPath = path + ".old";
                if (File.Exists(backupPath)) File.Delete(backupPath);
                File.Move(path, backupPath);
            }
            catch
            {
                // Best-effort only; never block startup over log housekeeping.
            }
        }

        private static readonly object ServerLogLock = new object();
        private static void AppendServerLog(string line)
        {
            try
            {
                lock (ServerLogLock)
                {
                    File.AppendAllText(serverLogPath, "[" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "] " + line + Environment.NewLine);
                }
            }
            catch
            {
                // Best-effort logging only; never throw from a log write.
            }
        }

        private static readonly object LauncherLogLock = new object();
        private static void LogLauncher(string line)
        {
            try
            {
                lock (LauncherLogLock)
                {
                    File.AppendAllText(launcherLogPath, "[" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "] " + line + Environment.NewLine);
                }
            }
            catch
            {
                // Best-effort logging only; never throw from a log write.
            }
        }
    }
}
