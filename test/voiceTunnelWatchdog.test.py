import io
import pathlib
import signal
import unittest
from unittest import mock


SOURCE = pathlib.Path(__file__).resolve().parents[1] / 'tools/harmony/voice_tunnel_watchdog.py'
namespace = {'__name__': 'voice_tunnel_watchdog'}
exec(compile(SOURCE.read_text(encoding='utf-8'), str(SOURCE), 'exec'), namespace)


class StopChecks(Exception):
    pass


class WatchdogTests(unittest.TestCase):
    def setUp(self):
        self.messages = []
        self.signals = []
        self.closed = []
        self.pid = 42
        self.identity = (100, 1, 2)
        self.patches = [
            mock.patch.dict(namespace, {
                'read_parent_identity': mock.Mock(side_effect=lambda pid: self.identity),
                'require_owned_listener': mock.Mock(),
            }),
            mock.patch.object(namespace['os'], 'getppid', side_effect=lambda: self.pid),
            mock.patch.object(namespace['os'], 'pidfd_open', return_value=7, create=True),
            mock.patch.object(namespace['os'], 'close', side_effect=self.closed.append),
            mock.patch.object(signal, 'pidfd_send_signal', side_effect=lambda *args: self.signals.append(args), create=True),
        ]
        for patch in self.patches:
            patch.start()
            self.addCleanup(patch.stop)

    def run_watchdog(self, results, mutate=None):
        results = iter(results)
        def probe(port, timeout):
            self.assertEqual(port, 38787)
            self.assertEqual(timeout, 5)
            result = next(results)
            if mutate:
                mutate()
            return result
        return namespace['run_watchdog'](38787, probe=probe, sleep=lambda interval: None, emit=self.messages.append)

    def test_three_failures_signal_only_the_captured_parent_once(self):
        self.assertEqual(self.run_watchdog([False, False, False]), 0)
        self.assertEqual(self.signals, [(7, signal.SIGTERM)])
        self.assertEqual(self.closed, [7])
        self.assertGreaterEqual(namespace['require_owned_listener'].call_count, 8)
        self.assertIn('voice-watchdog state=retiring', self.messages)

    def test_one_or_two_failures_then_health_reset_the_counter(self):
        with self.assertRaises(StopChecks):
            results = iter([False, False, True, False, True])
            def probe(*args):
                try:
                    return next(results)
                except StopIteration:
                    raise StopChecks()
            namespace['run_watchdog'](38787, probe=probe, sleep=lambda _: None, emit=self.messages.append)
        self.assertEqual(self.signals, [])
        self.assertIn('voice-watchdog state=recovered', self.messages)
        self.assertEqual(self.closed, [7])

    def test_parent_change_after_probe_refuses_signal(self):
        self.assertEqual(self.run_watchdog([False], mutate=lambda: setattr(self, 'pid', 43)), 2)
        self.assertEqual(self.signals, [])
        self.assertIn('voice-watchdog state=refused reason=parent_changed', self.messages)

    def test_parent_start_ticks_change_refuses_signal(self):
        self.assertEqual(self.run_watchdog([False], mutate=lambda: setattr(self, 'identity', (101, 1, 2))), 2)
        self.assertEqual(self.signals, [])

    def test_missing_or_foreign_listener_refuses_at_startup(self):
        for reason in ['listener_missing', 'listener_not_owned', 'listener_ambiguous']:
            with self.subTest(reason=reason):
                namespace['require_owned_listener'].side_effect = namespace['Refused'](reason)
                self.assertEqual(self.run_watchdog([]), 2)
                self.assertNotIn('voice-watchdog state=ready', self.messages)
                self.assertEqual(self.signals, [])

    def test_missing_pidfd_capability_refuses_before_ready(self):
        with mock.patch.object(namespace['os'], 'pidfd_open', None):
            self.assertEqual(self.run_watchdog([]), 2)
        self.assertEqual(self.signals, [])
        self.assertEqual(self.closed, [])
        self.assertIn('voice-watchdog state=refused reason=pidfd_unavailable', self.messages)

    def test_missing_pidfd_signal_capability_refuses_before_ready(self):
        with mock.patch.object(signal, 'pidfd_send_signal', None):
            self.assertEqual(self.run_watchdog([]), 2)
        self.assertEqual(self.signals, [])
        self.assertEqual(self.closed, [])

    def test_pidfd_open_permission_failure_refuses_before_ready(self):
        with mock.patch.object(namespace['os'], 'pidfd_open', side_effect=PermissionError()):
            self.assertEqual(self.run_watchdog([]), 2)
        self.assertEqual(self.signals, [])
        self.assertNotIn('voice-watchdog state=ready', self.messages)

    def test_listener_change_at_the_signal_boundary_refuses(self):
        check = namespace['require_owned_listener']
        check.side_effect = [None] * 7 + [namespace['Refused']('listener_not_owned')]
        self.assertEqual(self.run_watchdog([False, False, False]), 2)
        self.assertEqual(self.signals, [])
        self.assertNotIn('voice-watchdog state=retiring', self.messages)


class LinuxOwnershipTests(unittest.TestCase):
    def test_exact_loopback_listener_owned_by_parent_is_accepted(self):
        table = 'header\n0: 0100007F:9783 00000000:0000 0A 0:0 0:0 0 0 0 123\n'
        def tables(path, *args, **kwargs):
            return io.StringIO('header\n' if path.endswith('tcp6') else table)
        with mock.patch('builtins.open', side_effect=tables), \
                mock.patch.object(namespace['os'], 'listdir', return_value=['4']), \
                mock.patch.object(namespace['os'], 'readlink', return_value='socket:[123]'):
            namespace['require_owned_listener'](42, 38787)

    def test_other_process_listener_is_refused(self):
        table = 'header\n0: 0100007F:9783 00000000:0000 0A 0:0 0:0 0 0 0 123\n'
        with mock.patch('builtins.open', side_effect=lambda *args, **kw: io.StringIO(table)), \
                mock.patch.object(namespace['os'], 'listdir', return_value=['4']), \
                mock.patch.object(namespace['os'], 'readlink', return_value='socket:[456]'):
            with self.assertRaisesRegex(namespace['Refused'], 'listener_ambiguous'):
                namespace['require_owned_listener'](42, 38787)
        # A single loopback listener exists, but its inode belongs to another process.
        def tables(path, *args, **kwargs):
            return io.StringIO('header\n' if path.endswith('tcp6') else table)
        with mock.patch('builtins.open', side_effect=tables), \
                mock.patch.object(namespace['os'], 'listdir', return_value=['4']), \
                mock.patch.object(namespace['os'], 'readlink', return_value='socket:[456]'):
            with self.assertRaisesRegex(namespace['Refused'], 'listener_not_owned'):
                namespace['require_owned_listener'](42, 38787)

    def test_parent_must_be_the_sshd_executable(self):
        stat = '42 (sshd) S ' + '0 ' * 18 + '100 0\n'
        with mock.patch('builtins.open', return_value=io.StringIO(stat)), \
                mock.patch.object(namespace['os'], 'readlink', return_value='/usr/bin/python3'):
            with self.assertRaisesRegex(namespace['Refused'], 'parent_not_sshd'):
                namespace['read_parent_identity'](42)


class HealthTests(unittest.TestCase):
    def test_http_401_is_health_without_reading_a_body(self):
        connection = mock.MagicMock()
        connection.__enter__.return_value = connection
        connection.recv.return_value = b'HTTP/1.1 401 Unauthorized\r\n'
        with mock.patch.object(namespace['socket'], 'create_connection', return_value=connection):
            self.assertTrue(namespace['probe_health'](38787, 5))
        self.assertEqual(connection.recv.call_count, 1)
        self.assertIn(b'OPTIONS /health HTTP/1.1', connection.sendall.call_args.args[0])

    def test_timeout_is_failure_and_does_not_log_response_text(self):
        with mock.patch.object(namespace['socket'], 'create_connection', side_effect=TimeoutError('PRIVATE_DATA')):
            self.assertFalse(namespace['probe_health'](38787, 5))


if __name__ == '__main__':
    unittest.main()
