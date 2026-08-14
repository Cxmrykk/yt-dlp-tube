import re
import html
from datetime import datetime
from urllib.parse import urlparse, parse_qs, quote
from markupsafe import Markup, escape

def extract_video_id(raw_id, url=None):
    """
    Sanitizes video IDs returned by yt-dlp's flat extraction.
    Removes RSS 'yt:video:' prefixes and strips out dynamic tracking parameters
    if the fallback extractor returns a full URL instead of an ID.
    """
    if not raw_id:
        return None
        
    if raw_id.startswith('yt:video:'):
        return raw_id[9:]
        
    for val in (raw_id, url):
        if val and ('youtube.com' in val or 'youtu.be' in val):
            try:
                parsed = urlparse(val)
                if 'youtu.be' in parsed.netloc:
                    return parsed.path.strip('/')
                qs = parse_qs(parsed.query)
                if 'v' in qs:
                    return qs['v'][0]
                if parsed.path.startswith('/shorts/'):
                    return parsed.path.split('/shorts/', 1)[1].strip('/')
            except Exception:
                pass
                
    # Sanity fallback: if yt-dlp returned something extremely long 
    # but it didn't cleanly parse above, try to regex a standard 11-char ID.
    if len(raw_id) > 15:
        match = re.search(r'(?:v=|/)([0-9A-Za-z_-]{11})(?:[&?]|$)', raw_id)
        if match:
            return match.group(1)

    return raw_id


def format_time_str(s):
    if not s: return "0:00"
    try:
        m, s = divmod(int(float(s)), 60)
        h, m = divmod(m, 60)
        if h > 0: return f"{h}:{m:02d}:{s:02d}"
        return f"{m}:{s:02d}"
    except (ValueError, TypeError): 
        return "0:00"

def format_views_str(num):
    if num is None or num == '': return None
    try:
        num = int(num)
        if num >= 1_000_000_000: return f"{num/1_000_000_000:.1f}B".replace(".0B", "B")
        if num >= 1_000_000: return f"{num/1_000_000:.1f}M".replace(".0M", "M")
        if num >= 1_000: return f"{num/1_000:.1f}K".replace(".0K", "K")
        return str(num)
    except: 
        return str(num)

def time_ago_str(timestamp):
    if not timestamp: return ""
    try:
        timestamp = str(timestamp)
        if len(timestamp) == 8 and timestamp.isdigit(): 
            dt = datetime.strptime(timestamp, "%Y%m%d")
        else: 
            dt = datetime.fromtimestamp(float(timestamp))
        diff = (datetime.now() - dt).total_seconds()
        
        if diff < 60: return "just now"
        if diff < 3600:
            val = int(diff//60)
            return f"{val} min{'s' if val != 1 else ''} ago"
        if diff < 86400:
            val = int(diff//3600)
            return f"{val} hour{'s' if val != 1 else ''} ago"
        if diff < 2592000:
            val = int(diff//86400)
            return f"{val} day{'s' if val != 1 else ''} ago"
        if diff < 31536000:
            val = int(diff//2592000)
            return f"{val} month{'s' if val != 1 else ''} ago"
        val = int(diff//31536000)
        return f"{val} year{'s' if val != 1 else ''} ago"
    except: 
        return ""


# ----------------------------------------------------
# URL normalisation & rich-text linkification
# ----------------------------------------------------

YOUTUBE_HOSTS = (
    'youtube.com', 'www.youtube.com', 'm.youtube.com',
    'music.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com'
)
YOUTU_BE_HOSTS = ('youtu.be', 'www.youtu.be')


def unwrap_yt_redirect(url):
    """YouTube descriptions wrap outbound links in /redirect?...&q=<encoded>."""
    try:
        parsed = urlparse(url)
        host = parsed.netloc.lower()
        if host in YOUTUBE_HOSTS and parsed.path.rstrip('/') == '/redirect':
            q = parse_qs(parsed.query).get('q')
            if q and q[0]:
                return q[0]
    except Exception:
        pass
    return url


def to_internal_path(url):
    """Rewrite a YouTube URL into an in-app path so PJAX can handle it.

    Returns the original URL untouched when it isn't a YouTube link.
    """
    if not url:
        return "/"
    try:
        parsed = urlparse(url)
        host = parsed.netloc.lower()
        if host in YOUTU_BE_HOSTS:
            video_id = parsed.path.strip('/')
            if video_id:
                return f"/watch?v={video_id}"
            return url
        if host in YOUTUBE_HOSTS:
            path = parsed.path
            # /shorts/<id> is served by a redirect route, but link straight to /watch
            if path.startswith('/shorts/'):
                vid = path.split('/shorts/', 1)[1].strip('/')
                if vid:
                    return f"/watch?v={vid}"
            res = path or '/'
            if parsed.query:
                res += '?' + parsed.query
            return res
    except Exception:
        pass
    return url


def is_internal_target(url):
    try:
        host = urlparse(url).netloc.lower()
        return host in YOUTUBE_HOSTS or host in YOUTU_BE_HOSTS
    except Exception:
        return False


# Order matters: URLs are matched first so timestamps/handles inside a URL
# are swallowed by the URL alternative rather than matched separately.
_LINK_TOKEN_RE = re.compile(
    r'(?P<url>https?://[^\s<>"\'\)\]]+)'
    r'|(?P<ts>(?<![\d:])(?:\d{1,3}:)?\d{1,2}:\d{2}(?![\d:]))'
    r'|(?P<handle>(?<![\w@./-])@[A-Za-z0-9._-]{3,30}(?![\w.]))'
    r'|(?P<tag>(?<![\w#])#[A-Za-z0-9_\-]{1,50})'
)

# Trailing punctuation that is almost never part of the intended URL
_URL_TRAILING = '.,;:!?\'"'


def _build_url_anchor(raw_url):
    trailing = ''
    while raw_url and raw_url[-1] in _URL_TRAILING:
        trailing = raw_url[-1] + trailing
        raw_url = raw_url[:-1]
    if not raw_url:
        return escape(trailing)

    target = unwrap_yt_redirect(raw_url)
    label = raw_url

    if is_internal_target(target):
        href = to_internal_path(target)
        attrs = ''
    else:
        href = target
        attrs = ' target="_blank" rel="noopener noreferrer nofollow"'

    return Markup(
        f'<a href="{escape(href)}" class="rich-link"{attrs}>{escape(label)}</a>'
    ) + escape(trailing)


def linkify_text(text, urls=True, timestamps=True, handles=True, hashtags=True):
    """Convert plain text into safe HTML with clickable links.

    The raw text is tokenised *before* escaping, so every literal span and every
    generated attribute is escaped exactly once. Nothing attacker-controlled ever
    reaches the output unescaped.
    """
    if not text:
        return Markup("")

    out = []
    pos = 0
    for m in _LINK_TOKEN_RE.finditer(text):
        kind = m.lastgroup
        if kind == 'url' and not urls: continue
        if kind == 'ts' and not timestamps: continue
        if kind == 'handle' and not handles: continue
        if kind == 'tag' and not hashtags: continue

        out.append(escape(text[pos:m.start()]))
        token = m.group(0)

        if kind == 'url':
            out.append(_build_url_anchor(token))
        elif kind == 'ts':
            out.append(Markup(
                f'<a href="javascript:void(0)" class="comment-timestamp">{escape(token)}</a>'
            ))
        elif kind == 'handle':
            out.append(Markup(
                f'<a href="/{escape(token)}" class="rich-link">{escape(token)}</a>'
            ))
        elif kind == 'tag':
            q = quote(token, safe='')
            out.append(Markup(
                f'<a href="/search?q={q}" class="rich-link">{escape(token)}</a>'
            ))

        pos = m.end()

    out.append(escape(text[pos:]))
    return Markup(''.join(str(p) for p in out))
