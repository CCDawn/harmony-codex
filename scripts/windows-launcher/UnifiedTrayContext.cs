using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal sealed class UnifiedTrayContext : ApplicationContext
{
    private readonly NotifyIcon icon;
    private readonly Timer timer;
    private readonly Timer progressTimer;
    private readonly Control dispatcher = new Control();
    private readonly List<ToolStripItem> operations = new List<ToolStripItem>();
    private readonly string repoRoot;
    private readonly string pwsh;
    private readonly System.Threading.EventWaitHandle exitSignal;
    private readonly System.Threading.EventWaitHandle showSignal;
    private Dictionary<string, object> snapshot;
    private Dictionary<string, object> guardian;
    private ToolStripMenuItem guardianToggle;
    private ToolStripMenuItem guardianStatus;
    private ToolStripMenuItem guardianPolicyHint;
    private LinkStatusForm statusWindow;
    private string activeAction = "Status";
    private DateTimeOffset actionStartedAt = DateTimeOffset.UtcNow;
    private string currentOperationId = "";
    private string lastProgressStamp = "";
    private bool guardianBusy;
    private string guardianError = "";
    private bool busy;
    private bool exiting;
    private bool pendingStatus;
    private bool pendingExit;
    private int ticks;
    private string lastStatus = "正在检查";
    // 控制进程预热（standby）状态：信号文件路径在待命进程 spawn 成功后才有值，
    // 为空表示待命不可用，探测结论按旧路径直接 spawn。
    private volatile string standbySignalPath = "";
    private volatile bool standbyStartActive;

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
        guardianToggle = new ToolStripMenuItem("自动守护 · 状态未确认");
        guardianToggle.Enabled = false;
        guardianToggle.Click += delegate {
            if (guardian != null) ExecuteGuardian(Convert.ToBoolean(guardian["enabled"]) ? "Disable" : "Enable", false);
        };
        menu.Items.Add(guardianToggle);
        guardianPolicyHint = new ToolStripMenuItem("自动恢复权限尚未读取") { Enabled = false };
        menu.Items.Add(guardianPolicyHint);
        guardianStatus = new ToolStripMenuItem("查看守护故障与最近修复");
        guardianStatus.Click += delegate { ExecuteGuardian("Status", true); };
        menu.Items.Add(guardianStatus);
        AddOperation(menu, "启动链路", "Start");
        AddOperation(menu, "修复链路（必要时重启 Codex）", "Repair");
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
            if (++ticks % 6 == 0) {
                ExecuteGuardian("Ensure", false);
                if (!busy) Execute("Maintain", false);
            }
        };
        timer.Start();
        progressTimer = new Timer { Interval = 500 };
        progressTimer.Tick += delegate { PollOperationProgress(); if (statusWindow != null) statusWindow.UpdateElapsed(); };
        progressTimer.Start();
        // Persisted stop survives application exit and Windows reboot.
        // Show the owning window before any asynchronous startup work begins.
        EnsureStatusWindow(true);
        // 探测与待命控制进程同时起步：pwsh 冷启动与探测并行，结论出来时
        // 待命进程多半已预热完毕，Start 的进程创建成本不再串行挡路。
        SpawnStandbyController();
        RunInitialProbe();
        ExecuteGuardian("Ensure", false);
    }

    // ---- 冷启动快速判定 ----------------------------------------------------
    // 旧流程先跑完整 Status（65 秒预算，实测约 5 秒），完成后才决定是否拉起链路，
    // 把真正的 Start 排在了后面。这里改为两条廉价探测立即决策：
    //   bridge 健康——直接 GET bridge 的 /health（同一端点、同一鉴权头，1.2 秒超时）；
    //   desktop 存活——读最近一次 Status 落盘的快照（托盘每 30 秒 Maintain 会刷新）。
    // 两个条件都明确健康才跳过 Start；任一不健康、文件缺失、请求失败或无法判断
    // 都立即触发 Start——Start 自带幂等闸门，重复触发安全，漏触发才是故障。
    // 手动 Status、周期刷新、Start/Stop 语义与 operation.json 契约全部不变。
    private sealed class LinkProbeResult { public bool BridgeHealthy; public bool DesktopLive; public bool Paused; }

    private void RunInitialProbe()
    {
        Task.Run(delegate {
            var probe = ProbeLinkHealth();
            if (exiting) return;
            try { dispatcher.BeginInvoke((Action)delegate { CompleteInitialProbe(probe); }); }
            catch (InvalidOperationException) { }
        });
    }

    private LinkProbeResult ProbeLinkHealth()
    {
        return new LinkProbeResult {
            BridgeHealthy = ProbeBridgeHealth(ReadBridgeUrl()),
            DesktopLive = ReadDesktopLiveSnapshot(),
            Paused = IsPaused()
        };
    }

    private void CompleteInitialProbe(LinkProbeResult probe)
    {
        if (exiting) return;
        // 已停止：与旧 initialCheck 一致，不自动拉起也不自动维持。
        if (probe.Paused) { CancelStandby(); return; }
        if (probe.BridgeHealthy && probe.DesktopLive) { CancelStandby(); Execute("Maintain", false); return; }
        // 需要启动：优先放行已在预热的待命控制进程（写 go），不另 spawn；
        // busy（用户已手动操作，与旧路径一样不叠加自动 Start）、待命不可用或
        // go 写入失败时，回退旧路径直接 spawn。Start 自带幂等闸门，重复触发安全。
        if (!busy && ReleaseStandbyForStart()) return;
        CancelStandby();
        Execute("Start", false);
    }

    // ---- 控制进程预热（standby 握手）--------------------------------------
    // 契约：spawn `mobile-link-control.ps1 -Action Start -StandbyFile <signal>`，
    // 控制进程先完成自身预热，再按 100ms 轮询信号文件、最多 6 秒——内容 go 则
    // 删除文件并按正常 Start 继续；abort 或超时则无副作用 exit 0。go 写入时它
    // 尚未开始轮询也没关系：文件先在磁盘上等着，轮询到即放行。
    private void SpawnStandbyController()
    {
        Task.Run(delegate {
            var signalPath = Path.Combine(repoRoot, "logs", "state",
                "tray-standby-" + Process.GetCurrentProcess().Id + ".signal");
            try {
                Directory.CreateDirectory(Path.GetDirectoryName(signalPath));
                // 不重定向输出：待命进程无人读取管道，重定向会在它写满输出缓冲时卡死。
                var info = new ProcessStartInfo {
                    FileName = pwsh,
                    Arguments = "-NoProfile -ExecutionPolicy Bypass -File \""
                        + Path.Combine(repoRoot, "tools", "windows", "mobile-link-control.ps1")
                        + "\" -Action Start -StandbyFile \"" + signalPath + "\"",
                    WorkingDirectory = repoRoot, UseShellExecute = false,
                    CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden };
                using (var process = Process.Start(info)) {
                    if (process == null) return;
                    // 句柄用完即弃：不等待也不杀死，待命进程按自身轮询上限收尾；
                    // 托盘退出时若信号文件仍在，再补写 abort 兜底。
                    standbySignalPath = signalPath;
                }
            } catch { /* 待命不可用：CompleteInitialProbe 按旧路径直接 spawn。 */ }
        });
    }

    // Start 放行：与 Execute("Start") 相同的前台记账（busy、状态窗口、进度轮询
    // 所需的锚点），但不 spawn——本次启动由待命控制进程执行。写 go 失败时回滚
    // 记账并返回 false，由调用方走旧路径。
    private bool ReleaseStandbyForStart()
    {
        if (standbySignalPath.Length == 0) return false;
        standbyStartActive = true;
        busy = true;
        activeAction = "Start";
        actionStartedAt = DateTimeOffset.UtcNow;
        currentOperationId = "";
        lastProgressStamp = "";
        EnsureStatusWindow(true);
        if (statusWindow != null && statusWindow.Visible) statusWindow.BeginOperation("Start", actionStartedAt);
        foreach (var item in operations) item.Enabled = false;
        icon.Text = "Codex 手机链路 · 正在处理";
        try { File.WriteAllText(standbySignalPath, "go", new UTF8Encoding(false)); }
        catch {
            standbyStartActive = false;
            busy = false;
            foreach (var item in operations) item.Enabled = true;
            return false;
        }
        WatchStandbyStart(actionStartedAt, standbySignalPath);
        return true;
    }

    // 无需启动（paused / 健康→Maintain）或托盘退出时收掉待命进程。abort 之后的
    // 删除只是清理；即便删除时它还没读到，它也会按自身超时无副作用退出。
    private void CancelStandby()
    {
        var path = standbySignalPath;
        if (path.Length == 0 || !File.Exists(path)) return;
        try { File.WriteAllText(path, "abort", new UTF8Encoding(false)); } catch { }
        try { File.Delete(path); } catch { }
    }

    // 观察待命 Start 的收尾（不持有进程句柄，全部经由落盘契约）：
    //   终态收据（ready/partial/failed 且 active=false， freshness 由 AcceptOperation
    //   按 actionStartedAt 把关）→ 与旧路径收据分支一致，转一次只读 Status 刷新；
    //   go 写入 25 秒后信号文件仍在 → 待命进程没能接手（提前退出或错过轮询窗），
    //   清掉残留文件并回退旧路径补一次 Start（幂等，重复触发安全）；
    //   190 秒仍无收据 → 与旧 Start 超时（180 秒 + 裕量）同样的提示。
    private void WatchStandbyStart(DateTimeOffset startedAt, string signalPath)
    {
        Task.Run(delegate {
            while (DateTimeOffset.UtcNow - startedAt < TimeSpan.FromSeconds(190)) {
                System.Threading.Thread.Sleep(500);
                if (exiting || !standbyStartActive) return;
                if (DateTimeOffset.UtcNow - startedAt > TimeSpan.FromSeconds(25) && File.Exists(signalPath)) {
                    try { dispatcher.BeginInvoke((Action)delegate {
                        if (exiting || !standbyStartActive) return;
                        standbyStartActive = false;
                        if (pendingExit) { pendingExit = false; busy = false; foreach (var item in operations) item.Enabled = true; try { File.Delete(signalPath); } catch { } ExitApp(); return; }
                        busy = false;
                        foreach (var item in operations) item.Enabled = true;
                        try { File.Delete(signalPath); } catch { }
                        Execute("Start", false);
                    }); } catch (InvalidOperationException) { }
                    return;
                }
                if (ReadOperationReceipt(startedAt) == null) continue;
                try { dispatcher.BeginInvoke((Action)delegate {
                    if (exiting || !standbyStartActive) return;
                    standbyStartActive = false;
                    if (pendingExit) { pendingExit = false; busy = false; foreach (var item in operations) item.Enabled = true; ExitApp(); return; }
                    busy = false;
                    Execute("Status", false);
                }); } catch (InvalidOperationException) { }
                return;
            }
            try { dispatcher.BeginInvoke((Action)delegate {
                if (exiting || !standbyStartActive) return;
                standbyStartActive = false;
                if (pendingExit) { pendingExit = false; busy = false; foreach (var item in operations) item.Enabled = true; ExitApp(); return; }
                busy = false;
                lastStatus = "操作超时，请查看启动日志。";
                icon.Text = "Codex 手机链路 · 需要检查";
                foreach (var item in operations) item.Enabled = true;
                if (statusWindow != null) statusWindow.ShowFailure(lastStatus);
            }); } catch (InvalidOperationException) { }
        });
    }

    // 与 PollOperationProgress 相同的容错读取与验收：只认本次 Start（相对
    // actionStartedAt 仍新鲜）的终态收据，陈旧收据一律不算完成。
    private Dictionary<string, object> ReadOperationReceipt(DateTimeOffset startedAt)
    {
        try {
            var path = Path.Combine(repoRoot, "logs", "state", "mobile-link-operation.json");
            if (!File.Exists(path)) return null;
            string json;
            using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)) {
                if (stream.Length > 32768) return null;
                using (var reader = new StreamReader(stream, Encoding.UTF8)) json = reader.ReadToEnd();
            }
            var operation = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(json);
            if (!LinkStatusPresentation.AcceptOperation(operation, "Start", startedAt, "", DateTimeOffset.UtcNow)) return null;
            if (LinkStatusPresentation.Flag(operation, "active")) return null;
            var phase = LinkStatusPresentation.Text(operation, "phase");
            return phase == "ready" || phase == "partial" || phase == "failed" ? operation : null;
        } catch { return null; }
    }


    // bridge 地址沿用现有链路：优先读桌面连接状态文件里记录的 bridgeUrl（由启动与
    // 恢复脚本写入 logs\desktop-live-status.json），读不到时回落到
    // mobile-link-control.ps1 的默认 -BridgePort（8787），不引入新配置。
    private string ReadBridgeUrl()
    {
        try {
            var path = Path.Combine(repoRoot, "logs", "desktop-live-status.json");
            if (File.Exists(path)) {
                var data = ReadSharedJson(path);
                object value;
                var url = data != null && data.TryGetValue("bridgeUrl", out value) ? Convert.ToString(value) : "";
                if (url.StartsWith("http://", StringComparison.OrdinalIgnoreCase)
                    || url.StartsWith("https://", StringComparison.OrdinalIgnoreCase)) return url;
            }
        } catch { }
        return "http://127.0.0.1:8787";
    }

    // 与 mobile-link-control.ps1 Get-LinkHeaders 相同的令牌来源：BridgeConfig.ets。
    private string ReadBridgeToken()
    {
        try {
            var path = Path.Combine(repoRoot, "HarmonyCodexRemote", "entry", "src", "main", "ets", "config", "BridgeConfig.ets");
            if (!File.Exists(path)) return "";
            var match = Regex.Match(File.ReadAllText(path), "DEFAULT_BRIDGE_TOKEN:\\s*string\\s*=\\s*['\"]([^'\"]+)['\"]");
            return match.Success ? match.Groups[1].Value : "";
        } catch { return ""; }
    }

    // 与 Get-LinkApi '/health' 相同的端点与判定：HTTP 200 且响应体 ok 为真才算健康。
    private bool ProbeBridgeHealth(string bridgeUrl)
    {
        try {
            var request = (HttpWebRequest)WebRequest.Create(bridgeUrl.TrimEnd('/') + "/health");
            request.Method = "GET";
            // 冷启动时 bridge 多为「连接拒绝」这类瞬时失败；1.2 秒已足够覆盖本机
            // 慢响应，超时即判不健康并触发 Start（安全侧不变，Start 幂等）。
            request.Timeout = 1200;
            request.ReadWriteTimeout = 1200;
            var token = ReadBridgeToken();
            if (token.Length > 0) request.Headers["X-Codex-Bridge-Token"] = token;
            using (var response = (HttpWebResponse)request.GetResponse()) {
                if (response.StatusCode != HttpStatusCode.OK) return false;
                using (var reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8)) {
                    var data = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
                    object ok;
                    return data != null && data.TryGetValue("ok", out ok) && Convert.ToBoolean(ok);
                }
            }
        } catch { return false; }
    }

    // desktop 存活沿用 Status 命令自身落盘的快照（logs\state\mobile-link-status.json，
    // Get-LinkStatus 每次都会重写）：desktopLive 为真且 checkedAt 足够新才算健康；
    // 缺失、损坏或太旧（例如上次开机残留）一律视为无法判断，交由 Start 兜底。
    private bool ReadDesktopLiveSnapshot()
    {
        try {
            var path = Path.Combine(repoRoot, "logs", "state", "mobile-link-status.json");
            if (!File.Exists(path)) return false;
            var data = ReadSharedJson(path);
            object checkedAt;
            if (data == null || !data.TryGetValue("checkedAt", out checkedAt)) return false;
            DateTimeOffset stamp;
            if (!DateTimeOffset.TryParse(Convert.ToString(checkedAt), CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out stamp)) return false;
            if (DateTimeOffset.UtcNow - stamp > TimeSpan.FromSeconds(120)) return false;
            object live;
            return data.TryGetValue("desktopLive", out live) && Convert.ToBoolean(live);
        } catch { return false; }
    }

    // 状态文件由其它进程并发重写，按 PollOperationProgress 的方式容忍共享读写。
    private Dictionary<string, object> ReadSharedJson(string path)
    {
        using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)) {
            if (stream.Length > 32768) return null;
            using (var reader = new StreamReader(stream, Encoding.UTF8)) {
                try { return new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(reader.ReadToEnd()); }
                catch { return null; }
            }
        }
    }

    // Ensure only keeps the independent worker alive. It never changes the persisted mode.
    private void ExecuteGuardian(string action, bool show, string restartPolicy = "Preserve")
    {
        if (guardianBusy || exiting) return;
        guardianBusy = true;
        guardianToggle.Enabled = false;
        guardianStatus.Enabled = false;
        ApplyGuardianToWindow();
        Task.Run(delegate {
            var script = Path.Combine(repoRoot, "tools", "windows", "mobile-link-guardian.ps1");
            var policyArgument = action == "SetPolicy" ? " -RestartPolicy " + restartPolicy : "";
            var result = Run(HiddenProcess(pwsh, "-NoProfile -ExecutionPolicy Bypass -File \"" + script + "\" -Action " + action + policyArgument), 30000);
            if (exiting) return;
            try { dispatcher.BeginInvoke((Action)delegate { CompleteGuardian(action, show, result, restartPolicy); }); }
            catch (InvalidOperationException) { }
        });
    }

    private void CompleteGuardian(string action, bool show, CommandResult result, string restartPolicy = "Preserve")
    {
        if (exiting) return;
        guardianBusy = false;
        guardianStatus.Enabled = true;
        Dictionary<string, object> next = null;
        try {
            var data = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(result.Output.Trim());
            object value;
            if (data != null && data.TryGetValue("guardian", out value)) next = value as Dictionary<string, object>;
        } catch { }
        if (result.ExitCode != 0 || next == null || !next.ContainsKey("enabled") || !(next["enabled"] is bool)
            || !next.ContainsKey("phase") || ((action == "Enable" || action == "Disable")
            && Convert.ToBoolean(next["enabled"]) != (action == "Enable"))
            || (action == "SetPolicy" && (!LinkStatusPresentation.HasRestartPolicy(next)
                || LinkStatusPresentation.Flag(next, "allowForceRestart") != (restartPolicy == "Allow")))) {
            guardianError = "自动守护状态或设置未确认，请刷新状态后重试。";
            guardianToggle.Text = "自动守护 · 状态读取失败";
            guardianPolicyHint.Text = "自动恢复权限尚未确认";
            ApplyGuardianToWindow();
            if (show || action == "Enable" || action == "Disable" || action == "SetPolicy") EnsureStatusWindow(true);
            return;
        }
        guardian = next;
        guardianError = "";
        guardianToggle.Checked = Convert.ToBoolean(guardian["enabled"]);
        var phase = Convert.ToString(guardian["phase"]);
        guardianToggle.Text = "自动守护 · " + (guardianToggle.Checked ? "已开启" : "已关闭")
            + (!guardianToggle.Checked && phase == "disabled" ? "" : " · " + GuardianPhaseLabel(phase));
        guardianToggle.Enabled = true;
        guardianPolicyHint.Text = LinkStatusPresentation.HasRestartPolicy(guardian)
            ? LinkStatusPresentation.Flag(guardian, "allowForceRestart") ? "允许自动重启 Codex" : "自动恢复保留 Codex，不自动重启"
            : "自动恢复权限尚未确认";
        ApplyGuardianToWindow();
        if (show) ShowGuardianStatus();
    }

    private static string GuardianPhaseLabel(string phase)
    {
        switch (phase) {
            case "disabled": return "已关闭";
            case "checking": return "正在检查";
            case "healthy": return "读取健康";
            case "suspect": return "发现异常，正在确认";
            case "repairing": return "正在修复";
            case "cooldown": return "等待复查";
            case "needs_attention": return "需要处理";
            case "paused": return "链路已暂停";
            default: return "状态未确认";
        }
    }

    private static string GuardianValue(Dictionary<string, object> data, string key)
    {
        object value;
        return data != null && data.TryGetValue(key, out value) ? Convert.ToString(value) : "";
    }

    private void ShowGuardianStatus()
    {
        if (guardian == null) return;
        var text = new StringBuilder();
        text.AppendLine(guardianToggle.Text);
        text.AppendLine(GuardianValue(guardian, "summary"));
        text.AppendLine(LinkStatusPresentation.GuardianPolicy(guardian));
        text.AppendLine("模式保存在电脑；桌面重开后继续，退出管理应用或手机不影响独立守护。");
        text.AppendLine("上次检查：" + GuardianValue(guardian, "checkedAt"));
        text.AppendLine("最近修复：" + GuardianValue(guardian, "lastRepairAt"));
        text.AppendLine("下次检查：" + GuardianValue(guardian, "nextCheckAt"));
        object value;
        text.AppendLine();
        text.AppendLine("故障与检测：");
        var faults = guardian.TryGetValue("faults", out value) ? value as System.Collections.IEnumerable : null;
        if (faults != null) foreach (var entry in faults) {
            var fault = entry as Dictionary<string, object>;
            if (fault != null) text.AppendLine("• " + GuardianValue(fault, "title") + " · " + GuardianValue(fault, "state") + "：" + GuardianValue(fault, "message"));
        }
        text.AppendLine();
        text.AppendLine("最近处理记录：");
        var entries = new List<Dictionary<string, object>>();
        var history = guardian.TryGetValue("history", out value) ? value as System.Collections.IEnumerable : null;
        if (history != null) foreach (var entry in history) {
            var record = entry as Dictionary<string, object>;
            if (record != null) entries.Add(record);
        }
        for (int i = entries.Count - 1; i >= Math.Max(0, entries.Count - 5); i--)
            text.AppendLine("• " + GuardianValue(entries[i], "at") + " · " + GuardianValue(entries[i], "action") + " · " + GuardianValue(entries[i], "outcome") + "：" + GuardianValue(entries[i], "message"));
        MessageBox.Show(text.ToString(), "自动守护 · 状态", MessageBoxButtons.OK, MessageBoxIcon.Information);
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
            if (show) ShowStatus();
            return;
        }
        if (show || action == "Start" || action == "Repair") EnsureStatusWindow(true);
        busy = true;
        activeAction = action;
        actionStartedAt = DateTimeOffset.UtcNow;
        currentOperationId = "";
        lastProgressStamp = "";
        if (statusWindow != null && (statusWindow.Visible || show)) statusWindow.BeginOperation(action, actionStartedAt);
        if (action == "Status" && !guardianBusy) ExecuteGuardian("Status", false);
        foreach (var item in operations) item.Enabled = false;
        icon.Text = "Codex 手机链路 · 正在处理";
        Task.Run(delegate {
            var repairSwitch = action == "Repair" ? " -RestartDesktop" : "";
            var info = HiddenProcess(pwsh, "-NoProfile -ExecutionPolicy Bypass -File \"" + Path.Combine(repoRoot, "tools", "windows", "mobile-link-control.ps1") + "\" -Action " + action + repairSwitch);
            var timeout = action == "Repair" ? 300000 : action == "Stop" ? 240000 : action == "Start" ? 180000 : 65000;
            var result = Run(info, timeout);
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
        // Joining an existing operation (or reaching the wait deadline) returns
        // an operation receipt, not a complete diagnostic snapshot. Refresh
        // read-only status before presenting readiness or failure.
        Guid receiptId;
        if ((result.ExitCode == 0 || result.ExitCode == 2) && data != null && data.ContainsKey("startupOutcome")
            && !data.ContainsKey("bridgeHealthy") && Guid.TryParse(LinkStatusPresentation.Text(data, "operationId"), out receiptId)) {
            if (show || requestedStatus) EnsureStatusWindow(true);
            Execute("Status", false);
            return;
        }
        bool incompleteStartup = result.ExitCode == 2 && data != null && data.ContainsKey("startupOutcome")
            && data.ContainsKey("diagnostics") && data.ContainsKey("bridgeHealthy");
        if ((result.ExitCode != 0 && !incompleteStartup) || data == null || data.ContainsKey("error")) {
            // Raw subprocess output can contain secrets; it never reaches the desktop UI.
            lastStatus = result.TimedOut ? "操作超时，请查看启动日志。" : "操作未完成，请查看日志和统一状态。";
            icon.Text = "Codex 手机链路 · 需要检查";
            if (statusWindow != null) statusWindow.ShowFailure(lastStatus);
            if (show || requestedStatus) EnsureStatusWindow(true);
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
        object diagnosticValue;
        var diagnostics = data.TryGetValue("diagnostics", out diagnosticValue) ? diagnosticValue as Dictionary<string, object> : null;
        var severity = diagnostics == null ? "unknown" : Convert.ToString(diagnostics["severity"]);
        lastStatus = paused ? "已停止；点击启动链路恢复。" : diagnostics == null
            ? "部分状态未检测，请刷新统一状态。" : Convert.ToString(diagnostics["summary"]);
        icon.Text = paused ? "Codex 手机链路 · 已停止" : severity == "degraded"
            ? "Codex 手机链路 · 连接异常" : severity == "unverified"
            ? "Codex 手机链路 · 读取正常，通话未验收" : "Codex 手机链路 · 状态未确认";
        WriteHeartbeat();
        if (statusWindow != null) statusWindow.ApplySnapshot(snapshot, lastStatus, false, BuildStatusDetails());
        PollOperationProgress();
        if (show || requestedStatus) ShowStatus();
        // 冷启动是否自动拉起链路由 RunInitialProbe 的廉价探测立即决定，
        // 不再等待某次完整 Status 完成后才补触发 Start。
    }

    private void ShowStatus()
    {
        EnsureStatusWindow(true);
        if (snapshot != null && !busy) statusWindow.ApplySnapshot(snapshot, lastStatus, false, BuildStatusDetails());
        PollOperationProgress();
    }

    private void EnsureStatusWindow(bool show)
    {
        if (statusWindow == null || statusWindow.IsDisposed) {
            statusWindow = new LinkStatusForm(delegate(string action) { Execute(action, true); },
                delegate(bool enabled) { ExecuteGuardian(enabled ? "Enable" : "Disable", false); },
                delegate(bool allowed) { ExecuteGuardian("SetPolicy", false, allowed ? "Allow" : "Deny"); });
            try { statusWindow.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
            ApplyGuardianToWindow();
        }
        if (show) {
            if (!statusWindow.Visible) statusWindow.Show();
            if (statusWindow.WindowState == FormWindowState.Minimized) statusWindow.WindowState = FormWindowState.Normal;
            statusWindow.Activate();
        }
    }

    private void ApplyGuardianToWindow()
    {
        if (statusWindow != null && !statusWindow.IsDisposed) statusWindow.ApplyGuardian(guardian, guardianBusy, guardianError);
    }

    private void PollOperationProgress()
    {
        if (statusWindow == null || statusWindow.IsDisposed) return;
        try {
            var path = Path.Combine(repoRoot, "logs", "state", "mobile-link-operation.json");
            if (!File.Exists(path)) return;
            string json;
            using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)) {
                if (stream.Length > 32768) return;
                using (var reader = new StreamReader(stream, Encoding.UTF8)) json = reader.ReadToEnd();
            }
            var operation = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(json);
            var action = LinkStatusPresentation.Flag(operation, "active") ? LinkStatusPresentation.Text(operation, "action")
                : activeAction == "Start" || activeAction == "Repair" ? activeAction : "";
            if (action != "Start" && action != "Repair") return;
            if (!LinkStatusPresentation.AcceptOperation(operation, action, actionStartedAt, currentOperationId, DateTimeOffset.UtcNow)) return;
            var stamp = LinkStatusPresentation.Text(operation, "operationId") + ":" + LinkStatusPresentation.Text(operation, "updatedAt");
            if (stamp == lastProgressStamp) return;
            currentOperationId = LinkStatusPresentation.Text(operation, "operationId");
            lastProgressStamp = stamp;
            bool readyReceipt = !LinkStatusPresentation.Flag(operation, "active") && LinkStatusPresentation.Text(operation, "phase") == "ready";
            if (readyReceipt && !busy && LinkStatusPresentation.IsFreshReadback(snapshot, operation, actionStartedAt, DateTimeOffset.UtcNow))
                statusWindow.ApplySnapshot(snapshot, lastStatus, false, BuildStatusDetails());
            else {
                statusWindow.UpdateProgress(operation);
                if (readyReceipt && !busy) Execute("Status", false);
            }
        } catch { /* Partial or unavailable progress never replaces a confirmed result. */ }
    }

    private string BuildStatusDetails()
    {
        if (snapshot == null) return "正在读取状态。";
        var text = new StringBuilder();
        object startupValue;
        var startup = snapshot.TryGetValue("startupOutcome", out startupValue) ? startupValue as Dictionary<string, object> : null;
        if (startup != null) text.AppendLine("本次启动：" + startup["message"]);
        text.AppendLine(lastStatus);
        text.AppendLine("自动守护：" + (guardianError.Length > 0 ? guardianError : guardianToggle.Text));
        text.AppendLine("桥接健康：" + (Convert.ToBoolean(snapshot["bridgeHealthy"]) ? "正常" : "未确认"));
        text.AppendLine("Codex 实时连接：" + (Convert.ToBoolean(snapshot["desktopLive"]) ? "在线" : "未连接"));
        text.AppendLine("运行模式：" + Convert.ToString(snapshot["runtimeMode"]));
        object diagnosticValue;
        var diagnostics = snapshot.TryGetValue("diagnostics", out diagnosticValue) ? diagnosticValue as Dictionary<string, object> : null;
        if (diagnostics != null) {
            text.AppendLine();
            text.AppendLine("连接与业务检测（本机读取，不代表手机端实际体验）：");
            var checks = diagnostics["checks"] as System.Collections.IEnumerable;
            if (checks != null) foreach (var entry in checks) {
                var check = entry as Dictionary<string, object>;
                if (check != null) text.AppendLine("• " + check["title"] + "：" + check["message"]);
            }
            var nextAction = Convert.ToString(diagnostics["nextAction"]);
            text.AppendLine();
            if (nextAction == "desktop_restart_required")
                text.AppendLine("建议操作：点击菜单中的“修复链路（必要时重启 Codex）”。");
            else if (nextAction == "safe_repair")
                text.AppendLine("建议操作：点击菜单中的“修复链路（必要时重启 Codex）”，随后重新检查状态。");
            else if (nextAction == "check_logs")
                text.AppendLine("建议操作：打开日志目录，检查检测工具或本地配置。");
            else if (nextAction == "check_resources")
                text.AppendLine("本机资源不足：请减少并发或关闭不需要的应用后刷新；重复修复链路不会释放其他应用的内存。");
        }
        object recoveryValue;
        var recovery = snapshot.TryGetValue("desktopRecovery", out recoveryValue) ? recoveryValue as Dictionary<string, object> : null;
        if (recovery != null) text.AppendLine("本次桌面连接恢复：" + recovery["message"]);
        object tunnelValue;
        var tunnel = snapshot.TryGetValue("voiceTunnel", out tunnelValue) ? tunnelValue as Dictionary<string, object> : null;
        if (tunnel != null) {
            object message;
            string label = tunnel.TryGetValue("message", out message) ? Convert.ToString(message) :
                !Convert.ToBoolean(tunnel["configured"]) ? "未配置独立隧道" :
                Convert.ToBoolean(tunnel["running"]) ? "任务运行中（隧道连接和实际通话未验证）" : "未运行 / 需要恢复";
            text.AppendLine("国内语音隧道：" + label);
        }
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
        text.AppendLine("Codex 作为独立宿主接入；修复链路必要时会重启它，可能中断当前工作。");
        text.AppendLine("关闭此窗口不影响链路；退出管理应用后后台继续运行。");
        text.AppendLine("配置来源：BridgeConfig.ets + hdc-relay.local.psd1 + voice-tunnel.local.psd1");
        return text.ToString();
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
            case "watch-voice-tunnel": return "语音隧道恢复监控";
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
        progressTimer.Stop();
        // 待命控制进程可能仍在轮询：补写 abort 让它无副作用退出（best-effort）。
        CancelStandby();
        try { File.Delete(Path.Combine(repoRoot,"logs","state","desktop-supervisor.json")); } catch { }
        icon.Visible=false;
        icon.Dispose();
        timer.Dispose();
        progressTimer.Dispose();
        if (statusWindow != null) statusWindow.Shutdown();
        exitSignal.Dispose();
        showSignal.Dispose();
        dispatcher.Dispose();
        ExitThread();
    }
}
