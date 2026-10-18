"""
In-process log capture for the Settings -> Logs page.

Everything the application writes to stdout/stderr (print() calls, the yt-dlp
logger, Werkzeug access lines, Flask's exception logger, uncaught thread
tracebacks) is teed into a bounded ring buffer that the web UI polls, and
optionally appended to a rotating file under DATA_DIR/logs so a crash can still
be diagnosed after a restart.

The original streams keep receiving every byte, so console output is unchanged.

Each captured line is classified into a level (debug/info/warning/error) and a
source, using the conventions already present in the codebase:

    [yt-dlp WARNING] ...     -> source "yt-dlp",  level "warning"
    [Fetch] Download failed  -> source "fetch",   level from keywords
    127.0.0.1 - - [...] "GET / HTTP/1.1" 500 -   -> source "http", level from status
    Traceback (most recent call last): ...       -> level "error" until the
                                                    exception line closes it
"""

import collections
import datetime
import itertools
import logging
import os
import platform
import re
import sys
import threading
import time
import uuid

from config import DATA_DIR

PROCESS_STARTED = time.time()

LOG_DIR = os.path.join(DATA_DIR, 'logs')
LOG_FILE = os.path.join(LOG_DIR, 'app.log')

DEFAULT_CAPACITY = 5000
LOG_FILE_MAX_BYTES = 5 * 1024 * 1024
LOG_FILE_BACKUPS = 3
RESTORE_TAIL_BYTES = 512 * 1024
MAX_LINE_CHARS = 8000
MAX_PARTIAL_CHARS = 64 * 1024

# Requests made by the Logs page itself. Logging them would mean the act of
# watching the log fills it with its own polling.
QUIET_ACCESS_PATHS = ('/api/logs',)

LEVELS = ('debug', 'info', 'warning', 'error')

_LEVEL_WORDS = {
    'DEBUG': 'debug',
    'INFO': 'info',
    'NOTICE': 'info',
    'WARN': 'warning',
    'WARNING': 'warning',
    'ERROR': 'error',
    'CRITICAL': 'error',
    'FATAL': 'error',
}

_ANSI_RE = re.compile(r'\x1b\[[0-9;?]*[ -/]*[@-~]')
_TAG_RE = re.compile(r'^\[([^\[\]\n]{1,48})\]\s?(.*)$')
_PREFIX_RE = re.compile(r'^(ERROR|WARNING|WARN|DEBUG|INFO|CRITICAL):\s*(.*)$')
_FLASK_RE = re.compile(r'^\[\d{4}-\d{2}-\d{2}[^\]]*\]\s+([A-Z]+) in ([\w.]+):\s?(.*)$')
_ACCESS_RE = re.compile(r'^\S+ - - \[[^\]]*\] "[^"]*" (\d{3})\b')
_ERR_WORDS_RE = re.compile(r'\b(error|exception|traceback|fatal|critical)\b', re.I)
_WARN_WORDS_RE = re.compile(
    r"\b(warn|warning|deprecated|fail|failed|failing|failure|could not|couldn't|unable to|timed out)\b",
    re.I
)

# Redaction: credentials embedded in URLs (proxy settings), the Werkzeug
# debugger PIN, and any secret explicitly registered via redact().
_URL_CREDS_RE = re.compile(r'(\b[a-z][a-z0-9+.\-]*://)[^/\s:@]+:[^/\s@]+@', re.I)
_PIN_RE = re.compile(r'(Debugger PIN:\s*)\S+', re.I)
_SECRETS = ()
_SECRETS_LOCK = threading.Lock()

_BUFFER = None
_INSTALL_LOCK = threading.Lock()


def redact(secret):
    """Register a value that must never appear in captured logs."""
    global _SECRETS
    if not secret or not isinstance(secret, str) or len(secret) < 6:
        return
    with _SECRETS_LOCK:
        if secret not in _SECRETS:
            _SECRETS = _SECRETS + (secret,)


def _redact(text):
    text = _URL_CREDS_RE.sub(r'\1***:***@', text)
    text = _PIN_RE.sub(r'\1[redacted]', text)
    for secret in _SECRETS:
        if secret in text:
            text = text.replace(secret, '[redacted]')
    return text


def _fmt_ts(ts):
    return datetime.datetime.fromtimestamp(ts).strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]


def _format_file_line(entry):
    source = entry['source'].replace('|', '/')
    return f"{_fmt_ts(entry['ts'])} | {entry['level'].upper():<7} | {source} | {entry['msg']}\n"


def _parse_file_line(raw):
    parts = raw.split(' | ', 3)
    if len(parts) != 4:
        return None
    try:
        ts = datetime.datetime.strptime(parts[0].strip(), '%Y-%m-%d %H:%M:%S.%f').timestamp()
    except ValueError:
        return None
    level = parts[1].strip().lower()
    if level not in LEVELS:
        level = 'info'
    source = parts[2].strip() or 'app'
    return ts, level, source, parts[3]


def _classify(line, stream, state):
    """Return (level, source, message) for one captured line."""
    default_source = 'server' if stream == 'stderr' else 'app'

    m = _ACCESS_RE.match(line)
    if m:
        state.tb = False
        code = int(m.group(1))
        level = 'error' if code >= 500 else ('warning' if code >= 400 else 'info')
        return level, 'http', line

    if line.startswith('Traceback (most recent call last)'):
        state.tb = True
        return 'error', default_source, line

    if getattr(state, 'tb', False):
        # Frames are indented; the first unindented line is the exception
        # itself and closes the traceback.
        if not line[:1].isspace():
            state.tb = False
        return 'error', default_source, line

    m = _FLASK_RE.match(line)
    if m:
        level = _LEVEL_WORDS.get(m.group(1).upper(), 'info')
        return level, 'flask', f"{m.group(2)}: {m.group(3)}"

    level = None
    source = default_source
    msg = line

    m = _PREFIX_RE.match(line)
    if m:
        # yt-dlp's own "ERROR: [extractor] id: reason" style.
        level = _LEVEL_WORDS[m.group(1).upper()]
        msg = m.group(2) or line
        if msg.startswith('['):
            source = 'yt-dlp'
    else:
        m = _TAG_RE.match(line)
        if m and not m.group(1)[:1].isdigit():
            words = m.group(1).split()
            if words and words[-1].upper() in _LEVEL_WORDS:
                level = _LEVEL_WORDS[words[-1].upper()]
                words = words[:-1]
            if words:
                source = ' '.join(words).lower()
            msg = m.group(2) or line

    if _ERR_WORDS_RE.search(msg):
        hint = 'error'
    elif _WARN_WORDS_RE.search(msg):
        hint = 'warning'
    else:
        hint = None

    if level is None:
        level = hint or 'info'
    elif level == 'debug' and hint:
        # Much of the codebase logs real failures under [DEBUG].
        level = hint

    return level, source, msg


class LogBuffer:
    def __init__(self, capacity=DEFAULT_CAPACITY):
        self.capacity = max(100, int(capacity))
        self._lock = threading.Lock()
        self._entries = collections.deque(maxlen=self.capacity)
        self._seq = 0
        self.epoch = uuid.uuid4().hex
        self.file_path = None
        self._fh = None
        self._file_bytes = 0
        self._file_error_reported = False

    # ------------------------------------------------------------------
    # File persistence
    # ------------------------------------------------------------------

    def enable_file(self, path=LOG_FILE):
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            restored = self._read_tail(path, min(self.capacity // 2, 2000))
            self._fh = open(path, 'a', encoding='utf-8', errors='replace')
            self._file_bytes = os.path.getsize(path)
            self.file_path = path
        except Exception as e:
            self._fh = None
            self._report_file_error(e)
            return

        if restored:
            with self._lock:
                for ts, level, source, msg in restored:
                    self._append_locked(ts, level, source, msg, persist=False)
            self.add(
                'info', 'app',
                f'---- {len(restored)} line(s) above were restored from the previous run ----',
                persist=False
            )

    @staticmethod
    def _read_tail(path, limit):
        if not os.path.isfile(path) or limit <= 0:
            return []
        size = os.path.getsize(path)
        with open(path, 'rb') as f:
            if size > RESTORE_TAIL_BYTES:
                f.seek(size - RESTORE_TAIL_BYTES)
                f.readline()  # discard the partial first line
            data = f.read().decode('utf-8', 'replace')
        out = []
        for raw in data.splitlines():
            parsed = _parse_file_line(raw)
            if parsed:
                out.append(parsed)
        return out[-limit:]

    def _report_file_error(self, exc):
        if self._file_error_reported:
            return
        self._file_error_reported = True
        try:
            # Straight to the real stderr: going through the tee would recurse.
            if sys.__stderr__ is not None:
                sys.__stderr__.write(f"[logs] Log file disabled: {exc}\n")
                sys.__stderr__.flush()
        except Exception:
            pass

    def _write_locked(self, entry):
        if self._fh is None:
            return
        try:
            line = _format_file_line(entry)
            self._fh.write(line)
            self._fh.flush()
            self._file_bytes += len(line.encode('utf-8', 'replace'))
            if self._file_bytes >= LOG_FILE_MAX_BYTES:
                self._rotate_locked()
        except Exception as e:
            self._fh = None
            self._report_file_error(e)

    def _rotate_locked(self):
        try:
            self._fh.close()
            for i in range(LOG_FILE_BACKUPS, 0, -1):
                src = f"{self.file_path}.{i - 1}" if i > 1 else self.file_path
                dst = f"{self.file_path}.{i}"
                if os.path.exists(src):
                    os.replace(src, dst)
            self._fh = open(self.file_path, 'a', encoding='utf-8', errors='replace')
            self._file_bytes = 0
        except Exception as e:
            self._fh = None
            self._report_file_error(e)

    # ------------------------------------------------------------------
    # Recording
    # ------------------------------------------------------------------

    def _append_locked(self, ts, level, source, msg, persist=True):
        self._seq += 1
        entry = {'seq': self._seq, 'ts': ts, 'level': level, 'source': source, 'msg': msg}
        self._entries.append(entry)
        if persist:
            self._write_locked(entry)
        return entry

    def add(self, level, source, msg, persist=True, ts=None):
        level = level if level in LEVELS else 'info'
        source = (str(source or 'app').strip() or 'app')[:48]
        msg = _redact(str(msg))
        with self._lock:
            return self._append_locked(ts or time.time(), level, source, msg, persist)

    def ingest(self, raw, stream, state):
        """Called by the stream tee for every complete line."""
        line = _ANSI_RE.sub('', raw)
        if '\r' in line:
            line = line.rstrip('\r')
            if '\r' in line:
                # Carriage-return progress output: keep what a terminal would show.
                line = line.rsplit('\r', 1)[-1]
        line = line.rstrip()
        if not line.strip():
            return

        line = _redact(line)
        if len(line) > MAX_LINE_CHARS:
            line = line[:MAX_LINE_CHARS] + ' ... [truncated]'

        level, source, msg = _classify(line, stream, state)
        with self._lock:
            self._append_locked(time.time(), level, source[:48], msg)

    # ------------------------------------------------------------------
    # Reading
    # ------------------------------------------------------------------

    def since(self, after=0, limit=2000, client_epoch=None):
        with self._lock:
            epoch = self.epoch
            if client_epoch != epoch:
                after = 0

            last = self._seq
            fresh = []
            if self._entries and after < last:
                first = self._entries[0]['seq']
                start = max(0, after - first + 1)
                fresh = list(itertools.islice(self._entries, start, None))

            if len(fresh) > limit:
                fresh = fresh[-limit:]

            skipped = 0
            if after and fresh:
                skipped = max(0, fresh[0]['seq'] - after - 1)

            return {
                'epoch': epoch,
                'entries': fresh,  # entries are never mutated after creation
                'last_seq': last,
                'skipped': skipped,
                'capacity': self.capacity,
                'persisted': self._fh is not None
            }

    def clear(self):
        """Empties the in-memory buffer. The log file on disk is left alone."""
        with self._lock:
            self._entries.clear()
            self.epoch = uuid.uuid4().hex
            epoch = self.epoch
        self.add('info', 'app', 'Log view cleared from the web UI.')
        return epoch

    def export_text(self):
        with self._lock:
            paths = None
            snapshot = None
            if self._fh is not None:
                try:
                    self._fh.flush()
                except Exception:
                    pass
                paths = [f"{self.file_path}.{i}" for i in range(LOG_FILE_BACKUPS, 0, -1)]
                paths.append(self.file_path)
            else:
                snapshot = list(self._entries)

        if paths:
            chunks = []
            for p in paths:
                if os.path.isfile(p):
                    try:
                        with open(p, 'r', encoding='utf-8', errors='replace') as f:
                            chunks.append(f.read())
                    except Exception:
                        pass
            return ''.join(chunks)

        return ''.join(_format_file_line(e) for e in snapshot)


class _StreamTee:
    """Pass-through wrapper around a text stream that also feeds a LogBuffer.

    Partial writes are buffered per thread, so print() calls racing on different
    threads can't splice their lines together.
    """

    def __init__(self, original, stream_name, sink):
        self._original = original
        self._stream_name = stream_name
        self._sink = sink
        self._local = threading.local()

    def write(self, data):
        result = None
        if self._original is not None:
            try:
                result = self._original.write(data)
            except Exception:
                pass
        try:
            self._capture(data)
        except Exception:
            pass
        if result is not None:
            return result
        return len(data) if data else 0

    def writelines(self, lines):
        for line in lines:
            self.write(line)

    def _capture(self, data):
        if not data:
            return
        if isinstance(data, (bytes, bytearray)):
            data = bytes(data).decode('utf-8', 'replace')
        elif not isinstance(data, str):
            data = str(data)

        local = self._local
        pending = getattr(local, 'buf', '') + data
        if '\n' not in pending:
            local.buf = pending[-MAX_PARTIAL_CHARS:]
            return

        *lines, rest = pending.split('\n')
        local.buf = rest[-MAX_PARTIAL_CHARS:]
        for line in lines:
            self._sink.ingest(line, self._stream_name, local)

    def flush(self):
        if self._original is not None:
            try:
                self._original.flush()
            except Exception:
                pass

    def isatty(self):
        try:
            return bool(self._original and self._original.isatty())
        except Exception:
            return False

    def fileno(self):
        if self._original is None:
            raise OSError("stream has no file descriptor")
        return self._original.fileno()

    def __getattr__(self, name):
        original = self.__dict__.get('_original')
        if original is None:
            raise AttributeError(name)
        return getattr(original, name)


class _QuietAccessFilter(logging.Filter):
    def filter(self, record):
        try:
            msg = record.getMessage()
        except Exception:
            return True
        return not any(p in msg for p in QUIET_ACCESS_PATHS)


def install_log_capture(persist=True):
    """Idempotent. Call as early as possible so import-time output is captured."""
    global _BUFFER
    with _INSTALL_LOCK:
        if _BUFFER is not None:
            return _BUFFER

        try:
            capacity = int(os.environ.get('LOG_BUFFER_LINES', DEFAULT_CAPACITY))
        except ValueError:
            capacity = DEFAULT_CAPACITY

        buf = LogBuffer(capacity)
        if persist and os.environ.get('LOG_TO_FILE', '1') != '0':
            buf.enable_file(LOG_FILE)

        if not isinstance(sys.stdout, _StreamTee):
            sys.stdout = _StreamTee(sys.stdout, 'stdout', buf)
        if not isinstance(sys.stderr, _StreamTee):
            sys.stderr = _StreamTee(sys.stderr, 'stderr', buf)

        logging.getLogger('werkzeug').addFilter(_QuietAccessFilter())
        _BUFFER = buf

    buf.add(
        'info', 'app',
        f'Server process started (pid {os.getpid()}, Python {platform.python_version()}).'
    )
    return buf


def get_log_buffer():
    return _BUFFER
