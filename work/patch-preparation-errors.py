from pathlib import Path
p=Path('voice/companion_session.py')
s=p.read_text(encoding='utf-8')
s=s.replace('    """An error with a fixed, log-safe message."""','''    """An error with a fixed, log-safe message."""

    def __init__(self, message, *, http_status=None, operation=None):
        super().__init__(message)
        self.http_status = http_status
        self.operation = operation''')
s=s.replace('            if response.get("error"):\n                raise CompanionSessionError("Companion request failed")','''            if response.get("error"):
                # Only the helper's strict status format may cross this boundary.
                match = re.fullmatch(r"Companion HTTP ([1-5][0-9]{2})", str(response["error"]))
                status = int(match.group(1)) if match else None
                operation = method if method in {"discover", "history", "start", "attach", "stop"} else "unknown"
                log("companion-rpc-error", f"operation={operation} http={status or 0}")
                raise CompanionSessionError("Companion request failed", http_status=status, operation=operation)''')
s=s.replace('                    "message": message,\n                })','''                    "message": message,
                    **({"httpStatus": exc.http_status} if isinstance(exc, CompanionSessionError)
                       and exc.http_status is not None else {}),
                })''')
p.write_text(s,encoding='utf-8')
p=Path('HarmonyCodexRemote/entry/src/main/ets/services/VoiceCallService.ets')
s=p.read_text(encoding='utf-8').replace('  failureStage?: string;','  failureStage?: string;\n  httpStatus?: number;')
s=s.replace("        VoiceCallService.failCall(failure === 'media' ? '媒体连接失败，请重试' : '个人助手准备失败，请重试', failure);",'''        let message = failure === 'media' ? '媒体连接失败，请重试' : '个人助手准备失败，请重试';
        if (event.httpStatus === 502 || event.httpStatus === 503 || event.httpStatus === 504) {
          message = 'Codex 语音服务暂时不可用，请稍后重试';
        } else if (event.httpStatus === 401 || event.httpStatus === 403) {
          message = 'Codex 语音访问被拒绝，请检查电脑端登录状态';
        } else if (event.httpStatus === 429) {
          message = 'Codex 语音请求受限，请稍后重试';
        }
        VoiceCallService.failCall(message, failure);''')
p.write_text(s,encoding='utf-8')
