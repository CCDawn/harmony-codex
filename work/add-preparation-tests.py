from pathlib import Path
p=Path('test/companion_session_harness.py')
s=p.read_text(encoding='utf-8')
insert='''    async def test_rpc_preserves_only_strict_http_status_and_operation(self):
        for raw, expected in [("Companion HTTP 502", 502), ("private token and SDP", None),
                              ("Companion HTTP 502 private", None)]:
            session = CS.CompanionSession(ws=object())
            session.helper = FakeHelperProcess(lambda request: {})
            session._read_rpc_response = mock.AsyncMock(return_value={"id": 1, "error": raw})
            with self.assertRaises(CS.CompanionSessionError) as caught:
                await session._rpc("start")
            self.assertEqual(caught.exception.http_status, expected)
            self.assertEqual(caught.exception.operation, "start")
            self.assertNotIn("private", str(caught.exception))

    async def test_run_reports_upstream_status_without_private_message(self):
        session = CS.CompanionSession(ws=object())
        session._start_helper = mock.AsyncMock(side_effect=CS.CompanionSessionError(
            "private", http_status=502, operation="start"))
        session.send_json = mock.AsyncMock()
        session.emit_closed = mock.AsyncMock()
        session.cleanup = mock.AsyncMock()
        await session.run()
        event = session.send_json.await_args_list[-1].args[0]
        self.assertEqual(event["httpStatus"], 502)
        self.assertNotIn("private", str(event))

'''
s=s.replace('    async def test_run_reports_safe_assistant_failure_without_ready(self):',insert+'    async def test_run_reports_safe_assistant_failure_without_ready(self):')
p.write_text(s,encoding='utf-8')
