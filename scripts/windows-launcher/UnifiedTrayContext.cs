using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal sealed class UnifiedTrayContext : ApplicationContext
{
    private readonly NotifyIcon icon;
    private readonly Timer timer;
    private readonly Control dispatcher = new Control();
    private readonly List<ToolStripItem> operations = new List<ToolStripItem>();
    private readonly string repoRoot;
    private readonly string pwsh;
    private readonly System.Threading.EventWaitHandle exitSignal;
    private readonly System.Threading.EventWaitHandle showSignal;
    private Dictionary<string, object> snapshot;
    private bool busy;
    private bool exiting;
    private bool pendingStatus;
    private bool pendingExit;
    private bool initialCheck = true;
    private int ticks;
    private string lastStatus = "正在检查";

    public UnifiedTrayContext()
    {
        repoRoot = FindRepoRoot();
        pwsh = ResolvePwsh();
        dispatcher.CreateControl();
        exitSignal = new System.Threading.EventWaitHandle(false, System.Threading.EventResetMode.AutoReset, "Local\\CodexMobileRemoteTrayExit");
        showSignal = new System.Threading.EventWaitHandle(false, System.Threading.EventResetMode.AutoReset, "Local\\CodexMobileRemoteTrayShow");
        icon = new NotifyIcon { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath) ?? SystemIcons.Application,
            Visible = true, Text = "Codex 手机链路" };
        var menu = new ContextMenuStrip();
        menu.Items.Add("查看统一状态", null, delegate { Execute("Status", true); });
        AddOperation(menu, "启动链路", "Start");
        AddOperation(menu, "安全修复 / 补齐服务", "Repair");
        menu.Items.Add(new ToolStripSeparator());
        AddOperation(menu, "手机配对二维码", "Pair");
        menu.Items.Add("打开日志目录", null, delegate { OpenPath(Path.Combine(repoRoot, "logs")); });
        menu.Items.Add(new ToolStripSeparator());
        var stop = menu.Items.Add("停止链路（保留 Codex）", null, delegate {
            if (MessageBox.Show("停止本应用管理的桥接、语音和恢复监控后，手机连接与通话会断开。\n官方 Codex 会保留。", "停止手机链路", MessageBoxButtons.OKCancel, MessageBoxIcon.Warning) == DialogResult.OK)
                Execute("Stop", true);
        });
        operations.Add(stop);
        menu.Items.Add("退出管理应用（链路继续运行）", null, delegate { ExitApp(); });
        icon.ContextMenuStrip = menu;
        icon.DoubleClick += delegate { Execute("Status", true); };
        RegisterShortcut();
        WriteHeartbeat();
        timer = new Timer { Interval = 5000 };
        timer.Tick += delegate {
            if (exitSignal.WaitOne(0)) { ExitApp(); return; }
            if (showSignal.WaitOne(0)) { Execute("Status", true); }
            WriteHeartbeat();
            if (++ticks % 6 == 0 && !busy) Execute("Maintain", false);
        };
        timer.Start();
        // Persisted stop survives application exit and Windows reboot.
        Execute("Status", false);
    }

    private void AddOperation(ContextMenuStrip menu, string label, string action)
    {
        operations.Add(menu.Items.Add(label, null, delegate { Execute(action, true); }));
    }

    private bool IsPaused()
    {
        var path = Path.Combine(repoRoot, "logs", "state", "mobile-link-control.json");
        if (!File.Exists(path)) return false;
        try {
            var state = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(path));
            return Convert.ToString(state["desiredState"]) == "stopped";
        } catch { return true; }
    }

    private void Execute(string action, bool show)
    {
        if (busy) {
            if (show) pendingStatus = true;
            return;
        }
        busy = true;
        foreach (var item in operations) item.Enabled = false;
        icon.Text = "Codex 手机链路 · 正在处理";
        Task.Run(delegate {
            var info = HiddenProcess(pwsh, "-NoProfile -ExecutionPolicy Bypass -File \"" + Path.Combine(repoRoot, "tools", "windows", "mobile-link-control.ps1") + "\" -Action " + action);
            var result = Run(info, action == "Start" || action == "Repair" ? 180000 : 30000);
            if (exiting) return;
            try { dispatcher.BeginInvoke((Action)delegate { Complete(action, show, result); }); } catch (InvalidOperationException) { }
        });
    }

    private void Complete(string action, bool show, CommandResult result)
    {
        if (exiting) return;
        busy = false;
        if (pendingExit) { pendingExit=false; ExitApp(); return; }
        bool requestedStatus = pendingStatus;
        pendingStatus = false;
        foreach (var item in operations) item.Enabled = true;
        Dictionary<string, object> data = null;
        try { data = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(result.Output.Trim()); } catch { }
        if (result.ExitCode != 0 || data == null || data.ContainsKey("error")) {
            // Raw subprocess output can contain secrets; it never reaches the desktop UI.
            lastStatus = result.TimedOut ? "操作超时，请查看启动日志。" : "操作未完成，请查看日志和统一状态。";
            icon.Text = "Codex 手机链路 · 需要检查";
            if (show || requestedStatus) MessageBox.Show(lastStatus, "Codex 手机链路", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }
        if (action == "Pair") {
            OpenPath(Convert.ToString(data["pairingFile"]));
            icon.Text = "Codex 手机链路";
            if (requestedStatus) Execute("Status", true);
            return;
        }
        snapshot = data;
        bool paused = Convert.ToBoolean(data["paused"]);
        lastStatus = paused ? "已停止；点击启动链路恢复。" : "统一管理已运行。";
        icon.Text = paused ? "Codex 手机链路 · 已停止" : "Codex 手机链路";
        WriteHeartbeat();
        if (show || requestedStatus) ShowStatus();
        if (initialCheck) {
            initialCheck = false;
            if (!paused && !Convert.ToBoolean(data["bridgeHealthy"])) Execute("Start", false);
            else if (!paused) Execute("Maintain", false);
        }
    }

    private void ShowStatus()
    {
        var text = new StringBuilder();
        text.AppendLine(lastStatus);
        text.AppendLine("桥接健康：" + (Convert.ToBoolean(snapshot["bridgeHealthy"]) ? "正常" : "未确认"));
        text.AppendLine("Codex 实时连接：" + (Convert.ToBoolean(snapshot["desktopLive"]) ? "在线" : "未连接"));
        text.AppendLine("运行模式：" + Convert.ToString(snapshot["runtimeMode"]));
        text.AppendLine();
        text.AppendLine("本应用管理的后台组件：");
        var services = snapshot["services"] as System.Collections.IEnumerable;
        var groups = new Dictionary<string, List<string>>();
        if (services != null) foreach (var entry in services) {
            var service = entry as Dictionary<string, object>;
            if (service != null) {
                var label=RoleLabel(Convert.ToString(service["role"]));
                if (!groups.ContainsKey(label)) groups[label]=new List<string>();
                groups[label].Add(Convert.ToString(service["pid"]));
            }
        }
        foreach (var group in groups) text.AppendLine("• " + group.Key + "  PID " + String.Join(", ", group.Value));
        if (groups.Count == 0) text.AppendLine("暂无已确认归属的组件");
        text.AppendLine();
        text.AppendLine("监听端口（语音服务按需启动）：");
        var ports = snapshot["ports"] as System.Collections.IEnumerable;
        if (ports != null) foreach (var entry in ports) {
            var port = entry as Dictionary<string, object>;
            if (port != null) text.AppendLine("• " + port["port"] + "  PID " + port["pid"] + "  " + (Convert.ToString(port["ownership"]) == "managed" ? "本应用管理" : "外部宿主 / 共享服务"));
        }
        text.AppendLine();
        text.AppendLine("官方 Codex 作为独立宿主接入，安全修复不会重启它。");
        text.AppendLine("关闭此窗口不影响链路；退出管理应用后后台继续运行。");
        text.AppendLine("配置来源：BridgeConfig.ets + hdc-relay.local.psd1");
        using (var owner = new Form { TopMost=true, ShowInTaskbar=false, Opacity=0, StartPosition=FormStartPosition.CenterScreen, Size=new Size(1,1) }) {
            owner.Show();
            MessageBox.Show(owner, text.ToString(), "Codex 手机链路 · 统一状态", MessageBoxButtons.OK, MessageBoxIcon.Information);
            owner.Close();
        }
    }

    private static string RoleLabel(string role)
    {
        switch (role) {
            case "bridge": return "本地桥接";
            case "bridge-host": return "桥接启动宿主";
            case "voice": return "语音服务";
            case "hdc-proxy": return "手机调试代理";
            case "public-proxy": return "公网连接代理";
            case "start-hdc-relay": return "中继启动宿主";
            case "watch-local-bridge": return "桥接恢复监控";
            case "watch-desktop-live": return "桌面连接监控";
            case "watch-bridge-proxy": return "公网恢复监控";
            case "watch-hdc-connection": return "手机调试监控";
            default: return role;
        }
    }

    private void WriteHeartbeat()
    {
        var path = Path.Combine(repoRoot, "logs", "state", "desktop-supervisor.json");
        try {
            if (IsPaused()) { File.Delete(path); return; }
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            var json = new JavaScriptSerializer().Serialize(new { pid = Process.GetCurrentProcess().Id, heartbeatAt = DateTime.UtcNow.ToString("o"), app = "codex-mobile-remote-tray" });
            File.WriteAllText(path, json, new UTF8Encoding(false));
        } catch { lastStatus = "管理心跳未写入，请检查日志目录权限。"; }
    }

    private void RegisterShortcut()
    {
        Task.Run(delegate {
            var script = Path.Combine(repoRoot, "tools", "windows", "register-tray-shortcut.ps1");
            Run(HiddenProcess(pwsh, "-NoProfile -File \"" + script + "\" -ExePath \"" + Application.ExecutablePath + "\" -Repo \"" + repoRoot + "\""), 15000);
        });
    }

    private ProcessStartInfo HiddenProcess(string file, string arguments)
    {
        return new ProcessStartInfo { FileName=file, Arguments=arguments, WorkingDirectory=repoRoot,
            UseShellExecute=false, CreateNoWindow=true, WindowStyle=ProcessWindowStyle.Hidden,
            RedirectStandardOutput=true, RedirectStandardError=true, StandardOutputEncoding=Encoding.UTF8, StandardErrorEncoding=Encoding.UTF8 };
    }

    internal sealed class CommandResult { public string Output; public int ExitCode; public bool TimedOut; }

    internal static CommandResult Run(ProcessStartInfo info, int timeout)
    {
        try {
            using (var process = Process.Start(info)) {
                if (process == null) return new CommandResult { Output="", ExitCode=-1 };
                var stdout = process.StandardOutput.ReadToEndAsync();
                var stderr = process.StandardError.ReadToEndAsync();
                if (!process.WaitForExit(timeout)) {
                    // Keep the operation mutex held in the child. Killing just its host could
                    // orphan a still-running startup script and permit conflicting operations.
                    return new CommandResult { Output="", ExitCode=-1, TimedOut=true };
                }
                if (!Task.WaitAll(new Task[] { stdout, stderr }, 2000))
                    return new CommandResult { Output="", ExitCode=-1, TimedOut=true };
                return new CommandResult { Output=stdout.Result, ExitCode=process.ExitCode };
            }
        } catch { return new CommandResult { Output="", ExitCode=-1 }; }
    }

    private static void OpenPath(string path)
    {
        try {
            if (Directory.Exists(path) || File.Exists(path)) Process.Start(new ProcessStartInfo(path) { UseShellExecute=true });
        } catch { MessageBox.Show("无法打开，请查看日志目录。", "Codex 手机链路"); }
    }

    private static string FindRepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null) {
            if (File.Exists(Path.Combine(dir.FullName, "project.manifest.json"))) return dir.FullName;
            dir=dir.Parent;
        }
        return Directory.GetCurrentDirectory();
    }

    private static string ResolvePwsh()
    {
        foreach (var part in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator)) {
            var candidate=Path.Combine(part,"pwsh.exe");
            if (File.Exists(candidate)) return candidate;
        }
        return "pwsh.exe";
    }

    private void ExitApp()
    {
        if (busy) { pendingExit=true; return; }
        exiting=true;
        timer.Stop();
        try { File.Delete(Path.Combine(repoRoot,"logs","state","desktop-supervisor.json")); } catch { }
        icon.Visible=false;
        icon.Dispose();
        timer.Dispose();
        exitSignal.Dispose();
        showSignal.Dispose();
        dispatcher.Dispose();
        ExitThread();
    }
}
