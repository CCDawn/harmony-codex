using System;
using System.Collections.Generic;
using System.Reflection;
using System.Windows.Forms;

internal static class LinkStatusFormTests
{
    private static int count;
    private static void Check(bool value, string name) { if (!value) throw new Exception(name); count++; }
    private static T Field<T>(object value, string name) { return (T)value.GetType().GetField(name, BindingFlags.NonPublic | BindingFlags.Instance).GetValue(value); }
    private static Dictionary<string, object> CheckRow(string id, string state)
    { return new Dictionary<string, object> { { "id", id }, { "title", id }, { "state", state }, { "message", "检测结果" } }; }
    private static Dictionary<string, object> Snapshot()
    {
        return new Dictionary<string, object> { { "bridgeHealthy", true }, { "desktopLive", true }, { "paused", false },
            { "checkedAt", DateTimeOffset.UtcNow.ToString("o") }, { "diagnostics", new Dictionary<string, object> {
                { "checks", new object[] { CheckRow("bridge", "ready"), CheckRow("desktop", "ready"), CheckRow("sessions", "ready"),
                    CheckRow("companion", "ready"), CheckRow("public", "error"), CheckRow("phone_recent", "waiting"), CheckRow("phone_debug", "waiting") } } } } };
    }
    private static Dictionary<string, object> Operation(DateTimeOffset now)
    {
        return new Dictionary<string, object> { { "version", 1 }, { "operationId", Guid.NewGuid().ToString("N") },
            { "action", "Repair" }, { "phase", "restarting_desktop" }, { "active", true },
            { "startedAt", now.AddSeconds(-10).ToString("o") }, { "updatedAt", now.ToString("o") },
            { "deadlineAt", now.AddMinutes(7).ToString("o") } };
    }
    [STAThread]
    private static void Main(string[] args)
    {
        var now = DateTimeOffset.UtcNow;
        Check(LinkStatusPresentation.GuardianPolicy(null).Contains("尚未读取"), "missing permission cannot claim restart is allowed");
        var policy = new Dictionary<string, object> { { "enabled", true }, { "allowForceRestart", false } };
        Check(LinkStatusPresentation.GuardianPolicy(policy).Contains("不会自动重启"), "denied permission is explicit");
        var op = Operation(now);
        Check(LinkStatusPresentation.AcceptOperation(op, "Repair", now, "", now), "join an existing live operation");
        Check(!LinkStatusPresentation.AcceptOperation(op, "Start", now, "", now), "different action cannot replace progress");
        op["active"] = false; op["updatedAt"] = now.AddSeconds(-1).ToString("o");
        Check(!LinkStatusPresentation.AcceptOperation(op, "Repair", now, "", now), "old completion cannot satisfy a new click");
        op = Operation(now); op["deadlineAt"] = now.AddSeconds(-1).ToString("o");
        Check(!LinkStatusPresentation.AcceptOperation(op, "Repair", now, "", now), "expired operation cannot remain live");
        op = Operation(now); op["updatedAt"] = now.AddMinutes(1).ToString("o");
        Check(!LinkStatusPresentation.AcceptOperation(op, "Repair", now, "", now), "future progress is rejected");
        var snapshot = Snapshot();
        var currentOperation = Operation(now);
        snapshot["checkedAt"] = now.AddSeconds(-30).ToString("o");
        Check(!LinkStatusPresentation.IsFreshReadback(snapshot, currentOperation, now, now), "previous healthy snapshot cannot confirm current repair");
        snapshot["checkedAt"] = now.ToString("o");
        Check(LinkStatusPresentation.IsFreshReadback(snapshot, currentOperation, now, now), "current complete readback can confirm repair");
        Check(LinkStatusPresentation.CoreReady(snapshot), "desktop readiness is independent of public/phone status");
        var rows = (object[])((Dictionary<string, object>)snapshot["diagnostics"])["checks"];
        ((Dictionary<string, object>)rows[2])["state"] = "error";
        Check(!LinkStatusPresentation.CoreReady(snapshot), "failed conversation read cannot claim desktop is ready");
        ((Dictionary<string, object>)rows[2])["state"] = "ready";
        int changes = 0;
        using (var form = new LinkStatusForm(delegate(string action) { }, delegate(bool enabled) { changes++; }, delegate(bool allowed) { changes++; })) {
            form.ApplyGuardian(policy, false, "");
            Check(changes == 0, "hydrating confirmed policy cannot submit changes");
            Check(!Field<CheckBox>(form, "allowRestart").Checked, "UI reflects denied restart permission");
            Check(Field<CheckBox>(form, "allowRestart").Enabled, "confirmed policy is editable");
            form.ApplyGuardian(null, false, "");
            Check(!Field<CheckBox>(form, "allowRestart").Enabled, "unknown policy stays disabled");
            form.BeginOperation("Start", now);
            Check(Field<Label>(form, "headline").Text.Contains("检查"), "startup has immediate status");
            Check(!Field<Button>(form, "primary").Enabled, "running operation prevents duplicate UI clicks");
            form.UpdateProgress(Operation(now));
            Check(Field<Label>(form, "headline").Text.Contains("重启"), "actual restart phase is visible");
            Check(!Field<Button>(form, "primary").Enabled, "shared active operation disables repeated repair requests");
            form.ApplySnapshot(snapshot, "桌面读取通过，公网仍未通过", false, "详细信息");
            Check(Field<DataGridView>(form, "checks").Rows.Count == 6, "optional HDC is outside primary connection checks");
            Check(Field<Label>(form, "headline").Text.Contains("桌面链路已就绪"), "title describes only verified desktop scope");
            Check(Field<Label>(form, "description").Text.Contains("公网仍未通过"), "public failure remains visible");
            ((Dictionary<string, object>)rows[2])["state"] = "error";
            form.ApplySnapshot(snapshot, "会话读取失败", false, "");
            Check(!Field<Label>(form, "headline").Text.Contains("已就绪"), "unreadable sessions cannot produce successful headline");
            var receipt = Operation(now); receipt["phase"] = "ready"; receipt["active"] = false;
            form.UpdateProgress(receipt);
            Check(!Field<Label>(form, "headline").Text.Contains("已就绪"), "terminal receipt cannot override failed current checks");
            Check(Field<Label>(form, "headline").Text.Contains("验证"), "completion waits for independent readback");
            form.ShowFailure("本机资源不足，操作未完成");
            Check(!Field<ProgressBar>(form, "activity").Visible, "failed operation stops progress animation");
        }
        Console.WriteLine("PASS " + count + " desktop status behavior checks");
        if (args.Length > 0 && args[0] == "--show") {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            var form = new LinkStatusForm(delegate(string action) { }, delegate(bool enabled) { }, delegate(bool allowed) { });
            form.ApplyGuardian(policy, false, "");
            form.ApplySnapshot(Snapshot(), "桌面连接与会话读取正常；手机最近未报告在线。", false,
                "这里只展示固定测试数据，不连接真实服务、不启动通话。\r\n手机安装调试：未连接。此状态不代表手机会话是否在线。");
            Application.Run(form);
        }
    }
}
