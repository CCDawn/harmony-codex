"""Watch only the reverse forward owned by this command's direct SSH parent."""

import argparse
import math
import os
import re
import signal
import socket
import time


class Refused(Exception):
    pass


def read_parent_identity(pid):
    with open(f'/proc/{pid}/stat', encoding='ascii') as source:
        stat = source.read()
    end = stat.rfind(')')
    fields = stat[end + 2:].split()
    executable = f'/proc/{pid}/exe'
    if stat[stat.find('(') + 1:end] != 'sshd' or os.path.basename(os.readlink(executable)) != 'sshd':
        raise Refused('parent_not_sshd')
    if len(fields) < 20:
        raise Refused('parent_unreadable')
    binary = os.stat(executable)
    return (int(fields[19]), binary.st_dev, binary.st_ino)


def require_owned_listener(pid, port):
    listeners = []
    for family in ('tcp', 'tcp6'):
        try:
            with open('/proc/net/' + family, encoding='ascii') as source:
                rows = source.readlines()[1:]
        except FileNotFoundError:
            if family == 'tcp6':
                continue
            raise
        for row in rows:
            fields = row.split()
            if len(fields) < 10 or fields[3] != '0A':
                continue
            address, encoded_port = fields[1].split(':')
            if int(encoded_port, 16) == port:
                listeners.append((family, address, fields[9]))
    if not listeners:
        raise Refused('listener_missing')
    if len(listeners) != 1 or listeners[0][:2] != ('tcp', '0100007F'):
        raise Refused('listener_ambiguous')
    expected = 'socket:[' + listeners[0][2] + ']'
    for descriptor in os.listdir(f'/proc/{pid}/fd'):
        try:
            if os.readlink(f'/proc/{pid}/fd/{descriptor}') == expected:
                return
        except FileNotFoundError:
            # An unrelated command/channel descriptor may close during inspection.
            continue
    raise Refused('listener_not_owned')


def probe_health(port, timeout):
    deadline = time.monotonic() + timeout
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=timeout) as connection:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return False
            connection.settimeout(remaining)
            # The bridge answers preflight before authentication. A repeated
            # unauthenticated GET would consume its shared auth-failure budget.
            connection.sendall(b'OPTIONS /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n')
            line = bytearray()
            while len(line) <= 4096:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                connection.settimeout(remaining)
                part = connection.recv(256)
                if not part:
                    return False
                line.extend(part)
                if b'\r\n' in line:
                    # A protected /health may return 401/403; that still proves
                    # the forward carries HTTP. Never read or print its body.
                    return bool(re.match(rb'HTTP/1\.[01] [1-5][0-9]{2}(?: |\r\n)', line))
    except OSError:
        return False
    return False


def emit_status(message):
    print(message, flush=True)


def run_watchdog(port, timeout=5, interval=5, probe=probe_health, sleep=time.sleep, emit=emit_status):
    descriptor = None
    try:
        if not callable(getattr(os, 'pidfd_open', None)) or not callable(getattr(signal, 'pidfd_send_signal', None)):
            raise Refused('pidfd_unavailable')
        parent = os.getppid()
        identity = read_parent_identity(parent)
        descriptor = os.pidfd_open(parent, 0)

        def verify():
            if os.getppid() != parent or read_parent_identity(parent) != identity:
                raise Refused('parent_changed')
            require_owned_listener(parent, port)

        verify()
        emit('voice-watchdog state=ready')
        failures = 0
        while True:
            verify()
            healthy = probe(port, timeout)
            verify()
            if healthy:
                if failures:
                    emit('voice-watchdog state=recovered')
                failures = 0
            else:
                failures += 1
                emit(f'voice-watchdog state=probe_failed consecutive={failures}')
                if failures == 3:
                    verify()
                    emit('voice-watchdog state=retiring')
                    signal.pidfd_send_signal(descriptor, signal.SIGTERM)
                    return 0
            sleep(interval)
    except Refused as refusal:
        emit('voice-watchdog state=refused reason=' + str(refusal))
        return 2
    except (OSError, ValueError):
        emit('voice-watchdog state=refused reason=inspection_failed')
        return 2
    finally:
        if descriptor is not None:
            os.close(descriptor)


def bounded_seconds(value):
    number = float(value)
    if not math.isfinite(number) or not 0.05 <= number <= 5:
        raise argparse.ArgumentTypeError('seconds must be between 0.05 and 5')
    return number


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, required=True)
    parser.add_argument('--timeout', type=bounded_seconds, default=5)
    parser.add_argument('--interval', type=bounded_seconds, default=5)
    options = parser.parse_args()
    if not 1 <= options.port <= 65535:
        parser.error('port must be between 1 and 65535')
    return run_watchdog(options.port, timeout=options.timeout, interval=options.interval)


if __name__ == '__main__':
    raise SystemExit(main())
