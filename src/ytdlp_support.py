"""
yt-dlp dependency diagnostics and user-flag handling for the direct URL downloader.

Two jobs live here:

1. Reporting on the optional dependencies yt-dlp relies on (ffmpeg, deno and
   curl_cffi). curl_cffi powers ``--impersonate``; without a version this
   yt-dlp build supports, no impersonation targets exist and yt-dlp refuses
   the flag outright.

2. Turning a string of yt-dlp command-line flags typed into the downloader UI
   into a ``YoutubeDL`` options dict, safely. Flags are parsed by yt-dlp's own
   option parser so behaviour matches the CLI exactly, then vetted twice:
   tokens naming dangerous options are refused before parsing, and the parsed
   result is diffed against yt-dlp's defaults so only an allowlisted set of
   option keys can ever reach a download.
"""

import contextlib
import io
import optparse
import os
import re
import shlex
import shutil
import threading

import yt_dlp

try:
    from yt_dlp.version import __version__ as YT_DLP_VERSION
except Exception:
    YT_DLP_VERSION = 'unknown'

try:
    from yt_dlp.options import create_parser as _create_parser
except Exception:
    _create_parser = None


INSTALL_HINT = 'pip install -U "yt-dlp[default,curl-cffi]"'

MAX_FLAGS_LENGTH = 2000
MAX_FLAG_TOKENS = 64
_IMPERSONATE_RE = re.compile(r'^[A-Za-z0-9._:\-]{1,64}$')


class FlagError(ValueError):
    """Raised when user-supplied flags are malformed or not permitted."""


# ----------------------------------------------------------------------
# Dependency discovery
# ----------------------------------------------------------------------

def find_deno():
    """Locate deno on PATH or in its default per-user install location."""
    path = shutil.which('deno')
    if path:
        return path
    candidate = os.path.join(os.path.expanduser('~'), '.deno', 'bin', 'deno')
    return candidate if os.path.exists(candidate) else None


_IMP_LOCK = threading.Lock()
_IMP_STATUS = None


def _probe_impersonation():
    status = {
        'curl_cffi_installed': False,
        'curl_cffi_version': None,
        'handler_error': None,
        'available': False,
        'clients': [],
        'targets': [],
        'message': ''
    }

    try:
        import curl_cffi
        status['curl_cffi_installed'] = True
        status['curl_cffi_version'] = getattr(curl_cffi, '__version__', None) or 'unknown'
    except Exception:
        pass

    # yt-dlp's curl_cffi request handler raises ImportError with a precise
    # reason (e.g. "Only curl_cffi versions ... are supported") when it can't
    # use what is installed. That reason is far more useful than "not found".
    try:
        import yt_dlp.networking._curlcffi  # noqa: F401
    except Exception as e:
        status['handler_error'] = (str(e) or e.__class__.__name__).strip()

    targets = []
    try:
        with yt_dlp.YoutubeDL({'quiet': True, 'no_warnings': True}) as ydl:
            getter = getattr(ydl, '_get_available_impersonate_targets', None)
            if getter:
                for item in getter():
                    target = item[0] if isinstance(item, (tuple, list)) else item
                    targets.append(target)
    except Exception as e:
        if not status['handler_error']:
            status['handler_error'] = str(e).strip()

    status['targets'] = sorted({str(t) for t in targets if str(t)})
    status['clients'] = sorted({
        (getattr(t, 'client', None) or '').lower() for t in targets
    } - {''})
    status['available'] = bool(status['targets'])

    if status['available']:
        status['message'] = (
            f"Browser impersonation is available (curl_cffi {status['curl_cffi_version']})."
        )
    elif not status['curl_cffi_installed']:
        status['message'] = (
            f"curl_cffi is not installed, so impersonation is unavailable. "
            f"Install it with: {INSTALL_HINT}, then restart the server."
        )
    elif status['handler_error']:
        status['message'] = (
            f"curl_cffi {status['curl_cffi_version']} is installed but yt-dlp {YT_DLP_VERSION} "
            f"can't use it ({status['handler_error']}). Reinstall with: {INSTALL_HINT}, "
            f"then restart the server."
        )
    else:
        status['message'] = (
            f"curl_cffi {status['curl_cffi_version']} is installed but yt-dlp reports no "
            f"impersonation targets. Reinstall with: {INSTALL_HINT}."
        )

    return status


def impersonation_status(refresh=False):
    """Cached for the life of the process: installing curl_cffi needs a restart anyway."""
    global _IMP_STATUS
    with _IMP_LOCK:
        if _IMP_STATUS is None or refresh:
            _IMP_STATUS = _probe_impersonation()
        return dict(_IMP_STATUS)


def dependency_report(refresh=False):
    return {
        'yt_dlp_version': YT_DLP_VERSION,
        'ffmpeg': shutil.which('ffmpeg'),
        'deno': find_deno(),
        'impersonation': impersonation_status(refresh=refresh)
    }


def log_dependency_report():
    try:
        r = dependency_report()
    except Exception as e:
        print(f"[deps] Could not build dependency report: {e}")
        return

    imp = r['impersonation']
    print("[deps] yt-dlp " + str(r['yt_dlp_version']))
    print("[deps] ffmpeg: " + (r['ffmpeg'] or "NOT FOUND (merging and audio extraction will fail)"))
    print("[deps] deno:   " + (r['deno'] or "NOT FOUND (YouTube JS challenges may fail)"))
    if imp['available']:
        print(f"[deps] impersonation: OK via curl_cffi {imp['curl_cffi_version']} "
              f"(clients: {', '.join(imp['clients'])})")
    else:
        print(f"[deps] impersonation: UNAVAILABLE - {imp['message']}")


# ----------------------------------------------------------------------
# User flag parsing
# ----------------------------------------------------------------------

_BLOCKED_GROUPS = {
    "is a program action that doesn't apply to the server": {
        '-h', '--help', '--version', '-U', '--update', '--no-update', '--update-to',
        '--list-extractors', '--extractor-descriptions', '--list-impersonate-targets',
        '--dump-user-agent',
    },
    "would read extra configuration or files from the server": {
        '--config-locations', '--config-location', '--ignore-config', '--no-config',
        '--no-config-locations', '-a', '--batch-file', '--no-batch-file',
        '--load-info-json', '--alias', '--plugin-dirs', '--no-plugin-dirs',
        '--enable-file-urls',
    },
    "would run commands or external programs on the server": {
        '--exec', '--no-exec', '--exec-before-download', '--no-exec-before-download',
        '--downloader', '--external-downloader', '--downloader-args',
        '--external-downloader-args', '--postprocessor-args', '--ppa',
        '--use-postprocessor', '--ffmpeg-location', '--js-runtimes', '--no-js-runtimes',
        '--remote-components', '--no-remote-components',
    },
    "would write to paths on the server": {
        '-o', '--output', '-P', '--paths', '--print-to-file', '--download-archive',
        '--no-download-archive', '--cache-dir', '--no-cache-dir', '--rm-cache-dir',
        '--write-pages', '--print-traffic', '--dump-pages',
    },
    "carries credentials, which would be stored in plain text in settings.json": {
        '-u', '--username', '-p', '--password', '-2', '--twofactor', '-n', '--netrc',
        '--netrc-location', '--netrc-cmd', '--video-password', '--ap-mso',
        '--ap-username', '--ap-password', '--client-certificate',
        '--client-certificate-key', '--client-certificate-password',
        '--cookies', '--no-cookies', '--cookies-from-browser', '--no-cookies-from-browser',
    },
}
_BLOCKED_REASON = {flag: reason for reason, flags in _BLOCKED_GROUPS.items() for flag in flags}

# Keys of the final YoutubeDL options dict that a user flag may change.
ALLOWED_OPT_KEYS = frozenset({
    # Networking / anti-bot
    'impersonate', 'http_headers', 'source_address', 'socket_timeout',
    'nocheckcertificate', 'prefer_insecure', 'legacyserverconnect',
    'geo_bypass', 'geo_bypass_country', 'geo_bypass_ip_block',
    # Pacing / retries
    'retries', 'fragment_retries', 'extractor_retries', 'file_access_retries',
    'retry_sleep_functions', 'skip_unavailable_fragments', 'concurrent_fragment_downloads',
    'ratelimit', 'throttledratelimit', 'http_chunk_size', 'buffersize', 'noresizebuffer',
    'sleep_interval_requests', 'sleep_interval', 'max_sleep_interval',
    'hls_use_mpegts', 'hls_split_discontinuity',
    # Extraction / selection
    'extractor_args', 'allowed_extractors', 'format_sort', 'format_sort_force',
    'prefer_free_formats', 'age_limit', 'live_from_start', 'wait_for_video',
    'download_ranges', 'force_keyframes_at_cuts',
})

_KEY_HINTS = {
    'proxy': 'use the Proxy section instead',
    'geo_verification_proxy': 'use the Proxy section instead',
    'format': 'pick the format from the list after the URL is analysed',
    'postprocessors': 'post-processing follows from the format you pick',
    'outtmpl': 'output names are managed by the server',
    'paths': 'output locations are managed by the server',
    'ignoreerrors': 'errors are always reported in the downloader',
    'noplaylist': 'the downloader always fetches a single item',
    'playlist_items': 'the downloader always fetches a single item',
    'merge_output_format': 'the container follows from the format you pick',
}

_PARSE_LOCK = threading.Lock()
_DEFAULTS_LOCK = threading.Lock()
_DEFAULT_OPTS = None
_MISSING = object()


def _extract_parser_error(text):
    lines = [l for l in (text or '').strip().splitlines() if l.strip()]
    for line in reversed(lines):
        if 'error:' in line:
            return line.split('error:', 1)[1].strip()
    return lines[-1].strip() if lines else 'yt-dlp rejected these flags.'


def _run_parse_options(argv):
    """Run yt-dlp's own CLI-to-options conversion.

    The parser reports problems by printing to stderr and calling sys.exit, so
    stderr is captured and SystemExit is turned into a FlagError. Passing an
    explicit argv also makes yt-dlp skip every on-disk config file.
    """
    err_buf = io.StringIO()
    with _PARSE_LOCK, contextlib.redirect_stderr(err_buf), contextlib.redirect_stdout(io.StringIO()):
        try:
            parsed = yt_dlp.parse_options(list(argv))
        except SystemExit:
            raise FlagError(_extract_parser_error(err_buf.getvalue()))
        except FlagError:
            raise
        except Exception as e:
            raise FlagError(str(e) or 'yt-dlp rejected these flags.')

    opts = getattr(parsed, 'ydl_opts', None)
    if opts is None:
        opts = parsed[3]
    return opts


def _default_ydl_opts():
    global _DEFAULT_OPTS
    with _DEFAULTS_LOCK:
        if _DEFAULT_OPTS is None:
            _DEFAULT_OPTS = _run_parse_options([])
        return _DEFAULT_OPTS


def _tokenize(extra_flags):
    if len(extra_flags) > MAX_FLAGS_LENGTH:
        raise FlagError(f"Flags are limited to {MAX_FLAGS_LENGTH} characters.")
    try:
        tokens = shlex.split(extra_flags)
    except ValueError as e:
        raise FlagError(f"Could not split the flags ({e}). Check your quotes.")
    if len(tokens) > MAX_FLAG_TOKENS:
        raise FlagError(f"Too many arguments (limit {MAX_FLAG_TOKENS}).")
    return tokens


def _check_blocked(option, typed):
    names = list(getattr(option, '_long_opts', [])) + list(getattr(option, '_short_opts', []))
    for name in names:
        reason = _BLOCKED_REASON.get(name)
        if reason:
            raise FlagError(f"{typed} is not allowed here: it {reason}.")


def _screen_tokens(tokens):
    """Walk the arguments the way optparse will, refusing blocked options and
    positional arguments before anything gets a chance to act on them."""
    if _create_parser is None:
        return  # Older yt-dlp; the key allowlist below still applies.

    parser = _create_parser()
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        i += 1

        if tok == '--' or tok == '-' or not tok.startswith('-'):
            raise FlagError(
                f"Unexpected argument '{tok}'. Only options are accepted here; "
                f"put the URL in the URL box."
            )

        if tok.startswith('--'):
            name, has_eq, _ = tok.partition('=')
            try:
                canonical = parser._match_long_opt(name)
            except optparse.BadOptionError:
                raise FlagError(f"Unknown option: {name}")
            except optparse.AmbiguousOptionError as e:
                raise FlagError(str(e))
            option = parser._long_opt[canonical]
            _check_blocked(option, name)
            if option.takes_value() and not has_eq:
                i += option.nargs or 1
            continue

        # Short option cluster, e.g. -4 or -R10
        for pos in range(1, len(tok)):
            short = '-' + tok[pos]
            option = parser._short_opt.get(short)
            if option is None:
                raise FlagError(f"Unknown option: {short}")
            _check_blocked(option, short)
            if option.takes_value():
                if pos + 1 == len(tok):
                    i += option.nargs or 1
                break


def _check_impersonate_target(target):
    try:
        # YoutubeDL itself refuses an unavailable target; reuse that check.
        with yt_dlp.YoutubeDL({'quiet': True, 'no_warnings': True, 'impersonate': target}):
            pass
    except Exception:
        status = impersonation_status()
        msg = f'Impersonation target "{target}" is not available on this server.'
        if not status['available']:
            msg += ' ' + status['message']
        else:
            choices = status['clients'] or status['targets'][:10]
            msg += ' Available: ' + ', '.join(choices) + '.'
        raise FlagError(msg)


def parse_fetch_flags(impersonate='', extra_flags=''):
    """Return the YoutubeDL options implied by the user's flags.

    Raises FlagError with a user-facing message on any problem.
    """
    impersonate = (impersonate or '').strip()
    extra_flags = (extra_flags or '').strip()

    tokens = []
    if impersonate:
        if not _IMPERSONATE_RE.match(impersonate):
            raise FlagError("The impersonation target contains invalid characters.")
        tokens += ['--impersonate', impersonate]
    if extra_flags:
        # Later occurrences win in optparse, so typed flags override the dropdown.
        tokens += _tokenize(extra_flags)

    if not tokens:
        return {}

    _screen_tokens(tokens)

    defaults = _default_ydl_opts()
    parsed = _run_parse_options(tokens)

    changed = {}
    for key, value in parsed.items():
        if key.startswith('_'):
            continue  # internal warning lists etc.
        if defaults.get(key, _MISSING) != value:
            changed[key] = value

    rejected = sorted(k for k in changed if k not in ALLOWED_OPT_KEYS)
    if rejected:
        parts = [f"{k} ({_KEY_HINTS[k]})" if k in _KEY_HINTS else k for k in rejected]
        raise FlagError("Not supported in the downloader: " + ', '.join(parts) + '.')

    if changed.get('impersonate') is not None:
        _check_impersonate_target(changed['impersonate'])

    return changed


def _describe(value):
    if value is None:
        return 'none'
    if isinstance(value, bool):
        return 'yes' if value else 'no'
    if isinstance(value, (str, int, float)):
        return str(value)
    if isinstance(value, dict):
        return ', '.join(f"{k}={_describe(v)}" for k, v in value.items())
    if isinstance(value, (list, tuple, set, frozenset)):
        return ', '.join(_describe(v) for v in value)
    if callable(value):
        return 'custom'
    text = str(value)
    return text if text else 'any'


def describe_opts(opts):
    return [{'key': k, 'value': _describe(v)} for k, v in sorted((opts or {}).items())]
