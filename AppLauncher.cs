// Nuri launcher (compile with .NET Framework csc.exe, C# 5 syntax only)
//
// 1. Starts the orchestrator server inside WSL (scripts/start-server.sh) and waits for /v1/health.
//    The hidden wsl.exe process is kept alive on purpose: background jobs ("&") started through
//    wsl.exe are killed as soon as wsl.exe exits, which is why the old launcher never got a server.
// 2. Launches the desktop app (apps/desktop). If it is not installed, falls back to
//    Edge/Chrome with the ANB extension loaded plus the AI cockpit as an extension app window.

using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Threading;
using System.Windows.Forms;

namespace NuriLauncher
{
    static class Program
    {
        const string Title = "Nuri";
        const string ServerUrl = "http://127.0.0.1:3456";
        // Fixed by the "key" field in extension/manifest.json
        const string ExtensionId = "pgilknmfgggkflkimlehmjbbbmamaebp";
        const int ServerWaitSeconds = 40;

        [STAThread]
        static void Main()
        {
            string baseDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
            string healthUrl = ServerUrl + "/v1/health";
            try { Directory.CreateDirectory(Path.Combine(baseDir, "logs")); } catch { }
            logPath = Path.Combine(baseDir, "logs", "launcher.log");
            Log("launcher start, baseDir=" + baseDir);

            // Preferred: the desktop app (embedded Chromium + AI agent). It starts the WSL server itself.
            string appDir = Path.Combine(baseDir, @"apps\desktop");
            string runtime = Path.Combine(appDir, @"node_modules\electron\dist\electron.exe");
            if (File.Exists(runtime))
            {
                ProcessStartInfo app = new ProcessStartInfo();
                app.FileName = runtime;
                app.Arguments = "\"" + appDir + "\"";
                app.WorkingDirectory = appDir;
                app.UseShellExecute = false;
                Log("launch desktop app " + runtime);
                Process.Start(app);
                return;
            }
            Log("desktop app not installed, falling back to Edge + extension mode");

            if (!IsServerHealthy(healthUrl))
            {
                if (!StartBackgroundServer(baseDir)) return;

                bool healthy = false;
                DateTime deadline = DateTime.Now.AddSeconds(ServerWaitSeconds);
                while (DateTime.Now < deadline)
                {
                    Thread.Sleep(500);
                    if (IsServerHealthy(healthUrl)) { healthy = true; break; }
                }

                Log("server healthy=" + healthy);
                if (!healthy)
                {
                    MessageBox.Show(
                        "AI 엔진 서버가 " + ServerWaitSeconds + "초 안에 응답하지 않았습니다.\n\n" +
                        "로그를 확인해 주세요:\n" + Path.Combine(baseDir, "logs", "server.log"),
                        Title, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    return;
                }
            }

            LaunchBrowser(baseDir);
        }

        static string logPath;

        static void Log(string msg)
        {
            try { File.AppendAllText(logPath, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") + " " + msg + Environment.NewLine); }
            catch { }
        }

        static bool IsServerHealthy(string url)
        {
            try
            {
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
                request.Method = "GET";
                request.Timeout = 1500;
                request.Proxy = null;
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                {
                    return response.StatusCode == HttpStatusCode.OK;
                }
            }
            catch (Exception ex)
            {
                Log("health check failed: " + ex.Message);
                return false;
            }
        }

        // D:\work\anb -> /mnt/d/work/anb
        static string ToWslPath(string windowsPath)
        {
            string full = Path.GetFullPath(windowsPath);
            if (full.Length >= 2 && full[1] == ':')
            {
                string drive = char.ToLowerInvariant(full[0]).ToString();
                return "/mnt/" + drive + full.Substring(2).Replace('\\', '/');
            }
            return full.Replace('\\', '/');
        }

        static bool StartBackgroundServer(string baseDir)
        {
            string script = Path.Combine(baseDir, "scripts", "start-server.sh");
            if (!File.Exists(script))
            {
                MessageBox.Show("서버 시작 스크립트를 찾을 수 없습니다:\n" + script, Title,
                    MessageBoxButtons.OK, MessageBoxIcon.Error);
                return false;
            }

            try
            {
                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = "wsl.exe";
                psi.Arguments = "-e /bin/bash \"" + ToWslPath(script) + "\"";
                psi.CreateNoWindow = true;
                psi.UseShellExecute = false;
                psi.WindowStyle = ProcessWindowStyle.Hidden;
                // Do not wait: this wsl.exe process hosts the server and must stay alive.
                Process.Start(psi);
                Log("started wsl.exe " + psi.Arguments);
                return true;
            }
            catch (Exception ex)
            {
                MessageBox.Show("WSL 서버 기동 실패: " + ex.Message + "\n\nWSL(Ubuntu)이 설치되어 있는지 확인해 주세요.",
                    Title, MessageBoxButtons.OK, MessageBoxIcon.Error);
                return false;
            }
        }

        static string FindBrowser()
        {
            string pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            string pf86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string[] candidates = new string[]
            {
                Path.Combine(pf86, @"Microsoft\Edge\Application\msedge.exe"),
                Path.Combine(pf, @"Microsoft\Edge\Application\msedge.exe"),
                Path.Combine(pf, @"Google\Chrome\Application\chrome.exe"),
                Path.Combine(pf86, @"Google\Chrome\Application\chrome.exe"),
                Path.Combine(local, @"Google\Chrome\Application\chrome.exe")
            };
            foreach (string path in candidates)
            {
                if (File.Exists(path)) return path;
            }
            return null;
        }

        static void LaunchBrowser(string baseDir)
        {
            string browserPath = FindBrowser();
            if (browserPath == null)
            {
                MessageBox.Show("Microsoft Edge 또는 Google Chrome을 찾을 수 없습니다.", Title,
                    MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            string extensionPath = Path.Combine(baseDir, "extension");
            string profileDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "AI-Native-Browser", "profile");

            // Recent Edge/Chrome builds ignore --load-extension unless this feature is disabled.
            string common =
                "--user-data-dir=\"" + profileDir + "\" " +
                "--load-extension=\"" + extensionPath + "\" " +
                "--disable-features=DisableLoadExtensionCommandLineSwitch " +
                "--no-first-run --no-default-browser-check";

            int screenW = Screen.PrimaryScreen.WorkingArea.Width;
            int screenH = Screen.PrimaryScreen.WorkingArea.Height;
            int panelW = 440;
            int mainW = Math.Max(800, screenW - panelW);

            // 1. Main browser window (left)
            Start(browserPath, common +
                " --window-position=0,0 --window-size=" + mainW + "," + screenH +
                " --new-window https://www.naver.com");

            // 2. AI cockpit as an extension page (right), so it can control the browser tabs.
            Thread.Sleep(1500);
            Start(browserPath, common +
                " --window-position=" + mainW + ",0 --window-size=" + panelW + "," + screenH +
                " --app=chrome-extension://" + ExtensionId + "/sidepanel.html");
        }

        static void Start(string file, string args)
        {
            Log("launch " + file + " " + args);
            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = file;
            psi.Arguments = args;
            psi.UseShellExecute = false;
            Process.Start(psi);
        }
    }
}
