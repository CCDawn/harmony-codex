using System;
using System.Collections.Generic;
using System.Globalization;

// Presentation only: this class never starts services or changes recovery policy.
internal static class LinkStatusPresentation
{
    internal static string Text(Dictionary<string, object> data, string key)
    {
        object value;
        return data != null && data.TryGetValue(key, out value) && value != null ? Convert.ToString(value) : "";
    }

    internal static bool Flag(Dictionary<string, object> data, string key)
    {
        object value;
        return data != null && data.TryGetValue(key, out value) && value is bool && (bool)value;
    }

    internal static string StateLabel(string state)
    {
        switch (state) {
            case "ready": return "已通过";
            case "error": return "连接异常";
            case "blocked": return "需要处理";
            case "waiting": return "等待就绪";
            case "unverified": return "尚未验证";
            case "checking": return "检查中";
            default: return "尚未确认";
        }
    }

    internal static string PhaseTitle(string phase)
    {
        switch (phase) {
            case "checking": return "正在检查链路";
            case "starting_services": return "正在启动连接服务";
            case "connecting_desktop": return "正在连接 Codex 桌面";
            case "restarting_desktop": return "正在重启 Codex 桌面";
            case "verifying": return "正在验证会话读取";
            case "ready": return "桌面链路已就绪";
            case "partial": return "部分链路需要处理";
            case "failed": return "链路未恢复";
            case "pending": return "正在等待连接就绪";
            case "stopped": return "链路已停止";
            default: return "正在读取当前状态";
        }
    }

    internal static string PhaseDescription(string phase)
    {
        switch (phase) {
            case "checking": return "检查服务状态和已有连接，确认需要恢复的环节。";
            case "starting_services": return "启动本应用管理的桥接和连接服务。";
            case "connecting_desktop": return "尝试重新连接桌面接口，保留正在运行的 Codex。";
            case "restarting_desktop": return "恢复桌面远程接口，随后重新检查会话。";
            case "verifying": return "确认桌面连接、会话列表和个人助手内容能够读取。";
            case "ready": return "桌面连接与会话读取已通过；手机在线和实际通话请查看各项结果。";
            case "partial": return "已恢复部分连接，请查看下方尚未通过的环节。";
            case "failed": return "本次操作未通过验证，可查看详细信息后重试。";
            case "pending": return "恢复仍在进行，无需重复点击；完成后会更新结果。";
            case "stopped": return "已保留停止状态，点击“启动链路”可重新连接。";
            default: return "正在读取状态。关闭窗口后，链路仍会继续在托盘运行。";
        }
    }

    internal static string GuardianPolicy(Dictionary<string, object> guardian)
    {
        object allowed;
        if (guardian == null || !guardian.TryGetValue("allowForceRestart", out allowed) || !(allowed is bool))
            return "自动恢复权限尚未读取。";
        return (bool)allowed ? "允许自动重启 Codex，可能中断任务或通话。"
            : "自动恢复仅重连和恢复服务，不会自动重启 Codex。";
    }

    internal static bool HasRestartPolicy(Dictionary<string, object> guardian)
    {
        object value;
        return guardian != null && guardian.TryGetValue("allowForceRestart", out value) && value is bool;
    }

    internal static bool CoreReady(Dictionary<string, object> snapshot)
    {
        if (!Flag(snapshot, "bridgeHealthy") || !Flag(snapshot, "desktopLive")) return false;
        object value;
        var diagnostics = snapshot.TryGetValue("diagnostics", out value) ? value as Dictionary<string, object> : null;
        if (diagnostics == null || !diagnostics.TryGetValue("checks", out value)) return false;
        var entries = value as System.Collections.IEnumerable;
        if (entries == null) return false;
        var passed = new HashSet<string>();
        foreach (var item in entries) {
            var check = item as Dictionary<string, object>;
            if (Text(check, "state") == "ready") passed.Add(Text(check, "id"));
        }
        return passed.Contains("bridge") && passed.Contains("desktop") && passed.Contains("sessions") && passed.Contains("companion");
    }

    internal static bool TryTime(Dictionary<string, object> data, string key, out DateTimeOffset value)
    {
        return DateTimeOffset.TryParse(Text(data, key), CultureInfo.InvariantCulture,
            DateTimeStyles.RoundtripKind, out value);
    }

    internal static bool AcceptOperation(Dictionary<string, object> data, string action,
        DateTimeOffset requestStartedAt, string operationId, DateTimeOffset now)
    {
        Guid parsed;
        DateTimeOffset started, updated;
        if (data == null || Text(data, "version") != "1" || !Guid.TryParse(Text(data, "operationId"), out parsed)
            || Text(data, "action") != action || !TryTime(data, "startedAt", out started)
            || !TryTime(data, "updatedAt", out updated) || updated < started || updated > now.AddSeconds(5)) return false;
        var phase = Text(data, "phase");
        if (phase != "checking" && phase != "starting_services" && phase != "connecting_desktop"
            && phase != "restarting_desktop" && phase != "verifying" && phase != "pending"
            && phase != "ready" && phase != "partial" && phase != "failed") return false;
        // A caller may join an operation already running, but a previous
        // completed operation must not appear as the result of a new click.
        if (operationId.Length > 0 && Text(data, "operationId") != operationId) return false;
        if (!Flag(data, "active") && operationId.Length == 0 && updated < requestStartedAt) return false;
        DateTimeOffset deadline;
        if (!TryTime(data, "deadlineAt", out deadline)) deadline = started.AddMinutes(8);
        if (Flag(data, "active") && deadline <= now) return false;
        return !Flag(data, "active") || now - updated < TimeSpan.FromMinutes(5);
    }

    internal static string LocalTime(Dictionary<string, object> data, string key)
    {
        DateTimeOffset value;
        return TryTime(data, key, out value) ? value.ToLocalTime().ToString("MM-dd HH:mm:ss") : "尚未记录";
    }

    internal static bool IsFreshReadback(Dictionary<string, object> snapshot, Dictionary<string, object> operation,
        DateTimeOffset requestStartedAt, DateTimeOffset now)
    {
        DateTimeOffset checkedAt, operationStartedAt;
        return TryTime(snapshot, "checkedAt", out checkedAt) && TryTime(operation, "startedAt", out operationStartedAt)
            && checkedAt >= requestStartedAt && checkedAt >= operationStartedAt && checkedAt <= now.AddSeconds(5);
    }
}
