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

            string claudeDirToPrepend = FindClaudeDirToPrepend();
            if (claudeDirToPrepend != null)
            {
                string currentPath = Environment.GetEnvironmentVariable("PATH") ?? "";
                psi.EnvironmentVariables["PATH"] = claudeDirToPrepend + ";" + currentPath;
                LogLauncher("Claude Code found; prepended to the child process PATH only: " + claudeDirToPrepend);
            }
            else
            {
                LogLauncher("Claude Code not found via any search step; server will start without it (existing not-connected UI applies).");
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

        // Search order matches the already-verified start-release.bat exactly:
        //   1) current PATH (claude.exe, then claude)
        //   2) %USERPROFILE%\.local\bin\claude.exe
        //   3) %APPDATA%\npm\claude.cmd
        //   4) %APPDATA%\npm\claude.exe
        // Returns null when it is already on PATH (nothing to add) or was not
        // found anywhere. Returns the single folder to prepend when it was only
        // found via step 2, 3, or 4. Never hardcodes a username or dev machine
        // path - only %USERPROFILE%/%APPDATA%, which Windows sets per user.
        private static string FindClaudeDirToPrepend()
        {
            if (IsOnCurrentPath("claude.exe") || IsOnCurrentPath("claude"))
            {
                return null;
            }

            string userProfile = Environment.GetEnvironmentVariable("USERPROFILE");
            if (!string.IsNullOrEmpty(userProfile))
            {
                string standaloneDir = Path.Combine(userProfile, ".local", "bin");
                if (File.Exists(Path.Combine(standaloneDir, "claude.exe")))
                {
                    return standaloneDir;
                }
            }

            string appData = Environment.GetEnvironmentVariable("APPDATA");
            if (!string.IsNullOrEmpty(appData))
            {
                string npmDir = Path.Combine(appData, "npm");
                if (File.Exists(Path.Combine(npmDir, "claude.cmd")) || File.Exists(Path.Combine(npmDir, "claude.exe")))
                {
                    return npmDir;
                }
            }

            return null;
        }

        private static bool IsOnCurrentPath(string exeName)
        {
            string pathVar = Environment.GetEnvironmentVariable("PATH");
            if (string.IsNullOrEmpty(pathVar)) return false;
            string[] dirs = pathVar.Split(';');
            for (int i = 0; i < dirs.Length; i++)
            {
                string dir = dirs[i].Trim();
                if (dir.Length == 0) continue;
                try
                {
                    if (File.Exists(Path.Combine(dir, exeName))) return true;
                }
                catch
                {
                    // Ignore malformed PATH entries and keep searching.
                }
            }
            return false;
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
