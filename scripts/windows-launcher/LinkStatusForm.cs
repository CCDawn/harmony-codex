using System;
using System.Collections;
using System.Collections.Generic;
using System.Drawing;
using System.Windows.Forms;

// One reusable, modeless window. Closing it hides the window, not the link.
internal sealed class LinkStatusForm : Form
{
    private readonly Label headline;
    private readonly Label description;
    private readonly Label timing;
    private readonly ProgressBar activity;
    private readonly DataGridView checks;
    private readonly CheckBox guardianEnabled;
    private readonly CheckBox allowRestart;
    private readonly Label policy;
    private readonly Button primary;
    private readonly Button refresh;
    private readonly TextBox details;
    private readonly LinkLabel detailsToggle;
    private bool applying;
    private bool disposing;
    private DateTimeOffset operationStart;
    private string currentPhase = "checking";
    private bool working;

    internal LinkStatusForm(Action<string> run, Action<bool> setGuardian, Action<bool> setRestart)
    {
        Text = "Codex 手机链路 · 连接状态";
        Font = new Font("Microsoft YaHei UI", 9F);
        BackColor = Color.White;
        ForeColor = Color.FromArgb(23, 32, 42);
        AutoScaleMode = AutoScaleMode.Dpi;
        StartPosition = FormStartPosition.CenterScreen;
        Size = new Size(820, 710);
        MinimumSize = new Size(680, 580);
        var shell = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(24),
            ColumnCount = 1, RowCount = 9 };
        shell.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        shell.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        shell.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        shell.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        shell.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        shell.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        shell.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        shell.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        shell.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        headline = new Label { AutoSize = true, Font = new Font(Font.FontFamily, 18F, FontStyle.Bold),
            Text = "正在检查链路", Margin = new Padding(0, 0, 0, 8) };
        description = new Label { AutoSize = true, MaximumSize = new Size(1050, 0),
            Text = LinkStatusPresentation.PhaseDescription("checking"), Margin = new Padding(0, 0, 0, 10) };
        timing = new Label { AutoSize = true, ForeColor = Color.FromArgb(103, 113, 125),
            Text = "正在读取当前状态", Margin = new Padding(0, 0, 0, 10) };
        activity = new ProgressBar { Dock = DockStyle.Top, Height = 5, Style = ProgressBarStyle.Marquee,
            MarqueeAnimationSpeed = 35, Margin = new Padding(0, 0, 0, 18) };
        checks = new DataGridView { Dock = DockStyle.Fill, ReadOnly = true, AllowUserToAddRows = false,
            AllowUserToDeleteRows = false, AllowUserToResizeRows = false, RowHeadersVisible = false,
            BackgroundColor = Color.White, BorderStyle = BorderStyle.None,
            AutoSizeRowsMode = DataGridViewAutoSizeRowsMode.AllCells,
            SelectionMode = DataGridViewSelectionMode.FullRowSelect, MultiSelect = false,
            CellBorderStyle = DataGridViewCellBorderStyle.SingleHorizontal,
            GridColor = Color.FromArgb(237, 240, 244), EnableHeadersVisualStyles = false,
            AccessibleName = "各段连接检测结果", Margin = new Padding(0, 0, 0, 12) };
        checks.ColumnHeadersDefaultCellStyle.BackColor = Color.FromArgb(246, 248, 250);
        checks.ColumnHeadersDefaultCellStyle.ForeColor = ForeColor;
        checks.ColumnHeadersDefaultCellStyle.Padding = new Padding(8);
        checks.DefaultCellStyle.Padding = new Padding(7, 9, 7, 9);
        checks.DefaultCellStyle.WrapMode = DataGridViewTriState.True;
        checks.DefaultCellStyle.SelectionBackColor = Color.FromArgb(237, 244, 251);
        checks.DefaultCellStyle.SelectionForeColor = ForeColor;
        checks.Columns.Add(new DataGridViewTextBoxColumn { Name = "section", HeaderText = "连接环节", Width = 130 });
        checks.Columns.Add(new DataGridViewTextBoxColumn { Name = "state", HeaderText = "状态", Width = 96 });
        checks.Columns.Add(new DataGridViewTextBoxColumn { Name = "message", HeaderText = "说明", AutoSizeMode = DataGridViewAutoSizeColumnMode.Fill });
        var settings = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Fill, WrapContents = true,
            Margin = new Padding(0, 2, 0, 0) };
        guardianEnabled = new CheckBox { AutoSize = true, Text = "自动守护", Enabled = false,
            Margin = new Padding(0, 0, 24, 0) };
        allowRestart = new CheckBox { AutoSize = true, Text = "允许自动重启 Codex", Enabled = false,
            Margin = new Padding(0) };
        guardianEnabled.CheckedChanged += delegate { if (!applying) setGuardian(guardianEnabled.Checked); };
        allowRestart.CheckedChanged += delegate { if (!applying) setRestart(allowRestart.Checked); };
        settings.Controls.Add(guardianEnabled); settings.Controls.Add(allowRestart);
        policy = new Label { AutoSize = true, Text = "自动恢复权限尚未读取。",
            ForeColor = Color.FromArgb(103, 113, 125), Margin = new Padding(0, 8, 0, 12) };
        var buttons = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Fill,
            FlowDirection = FlowDirection.LeftToRight, WrapContents = true, Margin = new Padding(0) };
        primary = new Button { AutoSize = true, Text = "修复链路", Height = 36,
            Padding = new Padding(14, 5, 14, 5), BackColor = Color.FromArgb(37, 53, 71),
            ForeColor = Color.White, FlatStyle = FlatStyle.Flat, Margin = new Padding(0, 0, 10, 0) };
        primary.FlatAppearance.BorderSize = 0;
        primary.Click += delegate { run(primary.Tag as string ?? "Repair"); };
        refresh = new Button { AutoSize = true, Text = "刷新状态", Padding = new Padding(12, 5, 12, 5),
            FlatStyle = FlatStyle.System, Margin = new Padding(0, 0, 14, 0) };
        refresh.Click += delegate { run("Status"); };
        detailsToggle = new LinkLabel { AutoSize = true, Text = "详细信息", Margin = new Padding(0, 9, 0, 0) };
        details = new TextBox { Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical,
            Dock = DockStyle.Fill, Height = 150, Visible = false, BackColor = Color.FromArgb(248, 250, 252),
            BorderStyle = BorderStyle.FixedSingle, Margin = new Padding(0, 12, 0, 0), AccessibleName = "链路详细信息" };
        detailsToggle.LinkClicked += delegate {
            details.Visible = !details.Visible;
            detailsToggle.Text = details.Visible ? "收起详细信息" : "详细信息";
        };
        buttons.Controls.Add(primary); buttons.Controls.Add(refresh); buttons.Controls.Add(detailsToggle);
        var footer = new TableLayoutPanel { AutoSize = true, Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 2 };
        footer.Controls.Add(details);
        footer.Controls.Add(new Label { AutoSize = true, ForeColor = Color.FromArgb(103, 113, 125),
            Text = "关闭窗口后，链路继续在托盘运行。发送、声音和远程操作需分别验证。",
            Margin = new Padding(0, 14, 0, 0) });
        shell.Controls.Add(headline); shell.Controls.Add(description); shell.Controls.Add(timing);
        shell.Controls.Add(activity); shell.Controls.Add(checks); shell.Controls.Add(settings);
        shell.Controls.Add(policy); shell.Controls.Add(buttons); shell.Controls.Add(footer);
        Controls.Add(shell);
        Resize += delegate { description.MaximumSize = new Size(Math.Max(200, ClientSize.Width - 50), 0); };
        FormClosing += delegate(object sender, FormClosingEventArgs args) {
            if (!disposing && args.CloseReason == CloseReason.UserClosing) { args.Cancel = true; Hide(); }
        };
        SetInitialChecks();
    }

    private void SetInitialChecks()
    {
        foreach (var title in new[] { "本地桥接", "Codex 桌面", "会话读取", "手机公网入口", "手机最近在线" })
            checks.Rows.Add(title, "等待检查", "正在读取当前状态");
    }

    internal void BeginOperation(string action, DateTimeOffset started)
    {
        operationStart = started;
        working = true;
        currentPhase = "checking";
        headline.Text = action == "Repair" ? "正在检查需要修复的环节" : "正在检查链路";
        description.Text = LinkStatusPresentation.PhaseDescription("checking");
        activity.Visible = true;
        SetBusy(true);
        UpdateElapsed();
    }

    internal void UpdateProgress(Dictionary<string, object> operation)
    {
        currentPhase = LinkStatusPresentation.Text(operation, "phase");
        // A worker completion is a receipt. Only the complete current checks
        // in ApplySnapshot may produce a successful headline.
        bool needsReadback = currentPhase == "ready";
        if (needsReadback) currentPhase = "verifying";
        headline.Text = LinkStatusPresentation.PhaseTitle(currentPhase);
        // Only fixed presentation text is rendered from the operation phase;
        // subprocess output and arbitrary persisted messages never reach UI.
        description.Text = LinkStatusPresentation.PhaseDescription(currentPhase);
        working = needsReadback || LinkStatusPresentation.Flag(operation, "active");
        activity.Visible = working;
        if (working) primary.Enabled = false;
        DateTimeOffset start;
        if (LinkStatusPresentation.TryTime(operation, "startedAt", out start)) operationStart = start;
        UpdateElapsed();
        if (!working) timing.Text = "完成时间 " + LinkStatusPresentation.LocalTime(operation,
            LinkStatusPresentation.Text(operation, "completedAt").Length > 0 ? "completedAt" : "updatedAt");
    }

    internal void UpdateElapsed()
    {
        if (working) timing.Text = "已用时 " + Math.Max(0, (int)(DateTimeOffset.UtcNow - operationStart).TotalSeconds)
            + " 秒 · " + LinkStatusPresentation.PhaseTitle(currentPhase);
    }

    internal void SetBusy(bool busy)
    {
        primary.Enabled = !busy;
        refresh.Enabled = !busy;
    }

    internal void ApplyGuardian(Dictionary<string, object> guardian, bool busy, string error)
    {
        applying = true;
        try {
            guardianEnabled.Checked = LinkStatusPresentation.Flag(guardian, "enabled");
            allowRestart.Checked = LinkStatusPresentation.Flag(guardian, "allowForceRestart");
            guardianEnabled.Enabled = guardian != null && !busy && error.Length == 0;
            allowRestart.Enabled = LinkStatusPresentation.HasRestartPolicy(guardian) && !busy && error.Length == 0;
            policy.Text = error.Length > 0 ? error : LinkStatusPresentation.GuardianPolicy(guardian);
        } finally { applying = false; }
    }

    internal void ApplySnapshot(Dictionary<string, object> snapshot, string summary, bool busy, string detailText)
    {
        if (snapshot == null) return;
        working = busy;
        object value;
        var diagnostics = snapshot.TryGetValue("diagnostics", out value) ? value as Dictionary<string, object> : null;
        var paused = LinkStatusPresentation.Flag(snapshot, "paused");
        var startup = snapshot.TryGetValue("startupOutcome", out value) ? value as Dictionary<string, object> : null;
        var state = LinkStatusPresentation.Text(startup, "state");
        if (paused) currentPhase = "stopped";
        else if (state == "pending") { currentPhase = "pending"; working = true; }
        else if (state == "failed" || state == "blocked") currentPhase = "failed";
        else if (state == "partial") currentPhase = "partial";
        else currentPhase = LinkStatusPresentation.CoreReady(snapshot) ? "ready" : "partial";
        headline.Text = LinkStatusPresentation.PhaseTitle(currentPhase);
        description.Text = summary;
        activity.Visible = working;
        timing.Text = "检查时间 " + LinkStatusPresentation.LocalTime(snapshot, "checkedAt");
        primary.Text = paused ? "启动链路" : "修复链路";
        primary.Tag = paused ? "Start" : "Repair";
        details.Text = detailText;
        if (diagnostics != null && diagnostics.TryGetValue("checks", out value)) {
            var entries = value as IEnumerable;
            if (entries != null) {
                checks.Rows.Clear();
                foreach (var item in entries) {
                    var check = item as Dictionary<string, object>;
                    if (check == null || LinkStatusPresentation.Text(check, "id") == "phone_debug") continue;
                    var checkState = LinkStatusPresentation.Text(check, "state");
                    var index = checks.Rows.Add(LinkStatusPresentation.Text(check, "title"),
                        LinkStatusPresentation.StateLabel(checkState), LinkStatusPresentation.Text(check, "message"));
                    checks.Rows[index].Cells[1].Style.ForeColor = checkState == "ready" ? Color.FromArgb(30, 116, 79)
                        : checkState == "error" || checkState == "blocked" ? Color.FromArgb(173, 62, 52)
                        : Color.FromArgb(130, 98, 40);
                }
            }
        }
        SetBusy(busy);
    }

    internal void ShowFailure(string message)
    {
        working = false;
        currentPhase = "failed";
        headline.Text = LinkStatusPresentation.PhaseTitle("failed");
        description.Text = message;
        timing.Text = "检查时间 " + DateTimeOffset.Now.ToString("MM-dd HH:mm:ss");
        activity.Visible = false;
        SetBusy(false);
    }

    internal void Shutdown()
    {
        disposing = true;
        Close();
        Dispose();
    }
}
