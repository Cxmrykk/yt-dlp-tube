from flask import Flask, render_template, request, redirect, url_for, jsonify, session, Response
import yt_dlp
import json
import os
import concurrent.futures
import threading
from datetime import datetime, timedelta
import time
import secrets
import requests
import re
from urllib.parse import quote, urlparse

app = Flask(__name__)
SUBS_FILE = 'subscriptions.json'
SETTINGS_FILE = 'settings.json'
VIDEO_DATES_FILE = 'video_dates.json'
AUTH_FILE = 'secret.key'

DEFAULT_SETTINGS = {
    'background_interval_mins': 30,
    'per_page': 15,
    'desc_preview_height': 100,
    'shortcut_pause': 'Space',
    'shortcut_seek_fwd': 'ArrowRight',
    'shortcut_seek_bwd': 'ArrowLeft',
    'shortcut_mute': 'm',
    'shortcut_chap_next': 'PageUp',
    'shortcut_chap_prev': 'PageDown'
}

feed_cache = {'data': [], 'last_update': 0}
COMMENTS_CACHE = {} 
COMMENTS_LOCK = threading.Lock()
CHANNEL_ICON_CACHE = {}

FILE_LOCK = threading.Lock()
FEED_UPDATE_LOCK = threading.Lock()

# --- Proxy Session & Security ---
SESSION = requests.Session()
adapter = requests.adapters.HTTPAdapter(pool_connections=200, pool_maxsize=200, max_retries=1)
SESSION.mount('http://', adapter)
SESSION.mount('https://', adapter)

ALLOWED_DOMAINS = ['ytimg.com', 'ggpht.com', 'googleusercontent.com', 'youtube.com', 'googlevideo.com', 'ui-avatars.com']

def is_safe_url(url):
    try:
        domain = urlparse(url).netloc.lower()
        return any(domain == d or domain.endswith('.' + d) for d in ALLOWED_DOMAINS)
    except:
        return False

# --- Authentication Initialization ---
APP_SECRET_TOKEN = None

def init_auth():
    global APP_SECRET_TOKEN
    if os.path.exists(AUTH_FILE):
        try:
            with open(AUTH_FILE, 'r') as f:
                APP_SECRET_TOKEN = f.read().strip()
        except Exception as e:
            print(f"Error reading auth file: {e}")
            
    if not APP_SECRET_TOKEN:
        APP_SECRET_TOKEN = secrets.token_urlsafe(32)
        try:
            with open(AUTH_FILE, 'w') as f:
                f.write(APP_SECRET_TOKEN)
            print("\n" + "="*70)
            print("🔒 YT-DLP TUBE: AUTHENTICATION SECRET KEY GENERATED 🔒")
            print("This is your ONE-TIME display of the secret key.")
            print(f"\nSecret Key: {APP_SECRET_TOKEN}\n")
            print(f"To reset, delete the '{AUTH_FILE}' file and restart the server.")
            print("="*70 + "\n")
        except Exception as e:
            print(f"Error writing auth file: {e}")

init_auth()
app.secret_key = APP_SECRET_TOKEN 
app.config['PERMANENT_SESSION_LIFETIME'] = timedelta(days=365)

@app.before_request
def require_auth():
    if request.endpoint == 'login' or (request.endpoint and request.endpoint.startswith('static')):
        return

    if not session.get('authenticated'):
        if request.path.startswith('/api/') or request.path.startswith('/proxy/'):
            return jsonify({"error": "Unauthorized"}), 401
        return redirect(url_for('login'))

@app.route('/login', methods=['GET', 'POST'])
def login():
    if session.get('authenticated'):
        return redirect(url_for('feed'))
        
    error = None
    if request.method == 'POST':
        provided_key = request.form.get('secret_key', '').strip()
        if provided_key == APP_SECRET_TOKEN:
            session.permanent = True
            session['authenticated'] = True
            if 'last_feed_view' not in session:
                session['last_feed_view'] = time.time()
            return redirect(url_for('feed'))
        else:
            error = "Invalid secret key. Please check your console."
            
    return render_template('login.html', error=error)

@app.route('/logout')
def logout():
    session.clear()
    return redirect(url_for('login'))

# --- Proxy Endpoints ---
@app.route('/proxy/image')
def proxy_image():
    url = request.args.get('url')
    if not url or not is_safe_url(url):
        return "Invalid or unsafe URL", 400
    try:
        headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}
        r = SESSION.get(url, headers=headers, timeout=10)
        
        resp = Response(r.content, content_type=r.headers.get('Content-Type', 'image/jpeg'))
        resp.headers['Cache-Control'] = 'public, max-age=31536000, immutable'
        return resp
    except Exception:
        return "Image proxy failed", 500

@app.route('/proxy/media')
def proxy_media():
    url = request.args.get('url')
    if not url or not is_safe_url(url):
        return "Invalid or unsafe URL", 400
        
    headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}
    if 'Range' in request.headers:
        headers['Range'] = request.headers['Range']
        
    try:
        r = SESSION.get(url, headers=headers, stream=True, timeout=(5, 15))
        
        def generate():
            try:
                for chunk in r.iter_content(chunk_size=81920):
                    if chunk:
                        yield chunk
            except Exception:
                pass
            finally:
                r.close()
                
        forward_headers = {}
        for key in ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges']:
            if key in r.headers:
                forward_headers[key] = r.headers[key]
                
        forward_headers['Cache-Control'] = 'public, max-age=31536000'
        
        return Response(generate(), status=r.status_code, headers=forward_headers)
        
    except Exception as e:
        print(f"Proxy streaming failed: {e}")
        return str(e), 500

@app.route('/proxy/subtitles')
def proxy_subtitles():
    url = request.args.get('url')
    if not url or not is_safe_url(url):
        return "Invalid or unsafe URL", 400
        
    try:
        headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}
        r = SESSION.get(url, headers=headers, timeout=10)
        text = r.text
        
        text = re.sub(r'(-->\s*\d{2}:\d{2}:\d{2}\.\d{3}).*', r'\1', text)
        text = re.sub(r'</?c[^>]*>', '', text)
        
        resp = Response(text, content_type='text/vtt')
        resp.headers['Cache-Control'] = 'public, max-age=31536000, immutable'
        return resp
    except Exception as e:
        return str(e), 500

# --- Template Filters ---
@app.template_filter('proxy_image')
def proxy_image_filter(url):
    if not url: return ""
    if url.startswith('/proxy/') or url.startswith('data:'): return url
    return f"/proxy/image?url={quote(url)}"

@app.template_filter('yt_path')
def yt_path_filter(url):
    if not url: return "/"
    try:
        parsed = urlparse(url)
        if 'youtu.be' in parsed.netloc:
            video_id = parsed.path.strip('/')
            return f"/watch?v={video_id}"
        if 'youtube.com' in parsed.netloc:
            res = parsed.path
            if parsed.query: res += '?' + parsed.query
            return res
    except: pass
    return url

@app.template_filter('format_time')
def format_time(s): return format_time_str(s)

@app.template_filter('format_views')
def format_views(num): return format_views_str(num)

@app.template_filter('time_ago')
def time_ago(timestamp): return time_ago_str(timestamp)

# --- Helper Functions ---
def get_settings():
    with FILE_LOCK:
        if os.path.exists(SETTINGS_FILE):
            try:
                with open(SETTINGS_FILE, 'r') as f:
                    data = json.load(f)
                    return {**DEFAULT_SETTINGS, **data}
            except: pass
        return DEFAULT_SETTINGS.copy()

def save_settings(settings):
    with FILE_LOCK:
        with open(SETTINGS_FILE, 'w') as f: json.dump(settings, f)

def get_subs():
    with FILE_LOCK:
        if os.path.exists(SUBS_FILE):
            try:
                with open(SUBS_FILE, 'r') as f: return json.load(f)
            except: pass
        return []

def save_subs(subs):
    with FILE_LOCK:
        with open(SUBS_FILE, 'w') as f: json.dump(subs, f)

def get_video_dates():
    with FILE_LOCK:
        if os.path.exists(VIDEO_DATES_FILE):
            try:
                with open(VIDEO_DATES_FILE, 'r') as f: return json.load(f)
            except: pass
        return {}

def save_video_dates(dates):
    with FILE_LOCK:
        with open(VIDEO_DATES_FILE, 'w') as f: json.dump(dates, f)

def sync_video_dates(entries, is_initial_or_backlog=False):
    dates_cache = get_video_dates()
    changed = False
    now = time.time()
    
    for e in entries:
        if not e: continue
        vid = e.get('id')
        if not vid: continue
        
        if vid not in dates_cache:
            # New to the DB! If this is a backlog fetch, flag it false. Else, flag it as a genuine new upload.
            dates_cache[vid] = {"timestamp": now, "is_new": not is_initial_or_backlog}
            changed = True
        elif isinstance(dates_cache[vid], (int, float)):
            # Database Migration: Cleans out old float formats so they don't corrupt the new feed.
            dates_cache[vid] = {"timestamp": dates_cache[vid], "is_new": False}
            changed = True
        elif not isinstance(dates_cache[vid], dict):
            # Fallback for corrupted cache entries
            dates_cache[vid] = {"timestamp": now, "is_new": False}
            changed = True
            
        e['timestamp'] = dates_cache[vid].get('timestamp', now)
        e['is_new'] = dates_cache[vid].get('is_new', False)
        
    if changed:
        save_video_dates(dates_cache)

def purge_channel_from_feed(url):
    if not url: return
    n_url = url.strip('/').split('?')[0].lower()
    feed_cache['data'] = [v for v in feed_cache.get('data', []) if v.get('channel_url', '').strip('/').split('?')[0].lower() != n_url]

def get_cached_icon(url):
    if not url: return ""
    n_url = url.strip('/').split('?')[0].lower()
    for s in get_subs():
        if s['url'].strip('/').split('?')[0].lower() == n_url:
            return s.get('icon', '')
    return CHANNEL_ICON_CACHE.get(n_url, "")

def fix_youtube_url(url):
    if not url: return url
    if 'youtube.com' in url and ('/@' in url or '/c/' in url or '/channel/' in url):
        if '/videos' not in url and '/shorts' not in url and '/streams' not in url:
            return url.rstrip('/') + '/videos'
    return url

def fetch_channel_info(url):
    ydl_opts = {'extract_flat': 'in_playlist', 'playlistend': 1, 'quiet': True, 'no_warnings': True, 'ignoreerrors': True}
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(fix_youtube_url(url), download=False)
            if not info:
                return {"name": "Unknown", "url": url, "icon": "", "id": "", "subscriber_count": None}
            icon = info.get('thumbnails', [{'url': ''}])[-1]['url'] if info.get('thumbnails') else ''
            title = info.get('title', 'Unknown Channel').replace(' - Videos', '')
            channel_id = info.get('channel_id') or info.get('playlist_channel_id') or info.get('playlist_id') or info.get('id', '')
            if channel_id.startswith('UU'):  
                channel_id = 'UC' + channel_id[2:]
            return {"name": title, "url": url, "icon": icon, "id": channel_id, "subscriber_count": info.get('channel_follower_count')}
    except Exception:
        return {"name": "Unknown", "url": url, "icon": "", "id": "", "subscriber_count": None}

def update_feed_now():
    if not FEED_UPDATE_LOCK.acquire(blocking=False):
        return # Skip if a background update is already actively running
        
    try:
        subs = get_subs()
        settings = get_settings()
        fetch_limit = max(50, settings['per_page'] * 3) 
        
        def fetch_flat(sub):
            is_initial = not sub.get('initial_fetch_done', False)
            ydl_opts = {
                'extract_flat': 'in_playlist', 
                'playlistend': fetch_limit, 
                'quiet': True, 
                'no_warnings': True, 
                'ignoreerrors': True
            }
            try:
                with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                    info = ydl.extract_info(fix_youtube_url(sub['url']), download=False)
                    if info is not None:
                        valid_entries = []
                        for e in info.get('entries', []):
                            if e:
                                e['channel_name'] = sub['name']
                                e['channel_icon'] = sub.get('icon', '')
                                e['channel_url'] = sub['url']
                                e['is_initial_fetch'] = is_initial
                                valid_entries.append(e)
                        return sub['url'], valid_entries, True # Extraction strictly succeeded
            except Exception as e: 
                print(f"Background fetch failed for {sub['url']}: {e}")
            return sub['url'], [], False # Fail, prevents poisoning the DB next run

        # Lowered to 5 to protect from YT Rate Limits blocking the mass initial loads
        with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
            results = list(executor.map(fetch_flat, subs))
            
        all_entries = []
        successful_urls = set()
        
        for url, entries, success in results:
            if success:
                successful_urls.add(url)
                if entries:
                    is_initial = entries[0].get('is_initial_fetch', False)
                    sync_video_dates(entries, is_initial_or_backlog=is_initial)
                    all_entries.extend(entries)
                
        # Mark subs as initially fetched ONLY if the fetch successfully processed
        changed_subs = False
        for s in subs:
            if not s.get('initial_fetch_done') and s['url'] in successful_urls:
                s['initial_fetch_done'] = True
                changed_subs = True
        if changed_subs:
            save_subs(subs)
        
        # The Feed is now exclusively populated by genuinely new uploads.
        new_vids = [e for e in all_entries if e.get('is_new')]
        new_vids.sort(key=lambda x: x.get('timestamp') or 0, reverse=True)
        
        feed_cache['data'] = new_vids
        feed_cache['last_update'] = time.time()
        
    finally:
        FEED_UPDATE_LOCK.release()

def bg_worker():
    with app.app_context():
        while True:
            update_feed_now()
            settings = get_settings()
            interval_seconds = settings.get('background_interval_mins', 30) * 60
            time.sleep(interval_seconds)

if os.environ.get('WERKZEUG_RUN_MAIN') == 'true' or not app.debug:
    threading.Thread(target=bg_worker, daemon=True).start()

def get_flat_feed(page=1):
    settings = get_settings()
    per_page = settings['per_page']
    
    # We no longer strictly block the frontend router to trigger background jobs.
    # The bg worker loops naturally.
    all_videos = feed_cache.get('data', [])
    start = (page - 1) * per_page
    end = page * per_page
    return all_videos[start:end]

def format_time_str(s):
    if not s: return "0:00"
    try:
        m, s = divmod(int(float(s)), 60)
        h, m = divmod(m, 60)
        if h > 0: return f"{h}:{m:02d}:{s:02d}"
        return f"{m}:{s:02d}"
    except (ValueError, TypeError): return "0:00"

def format_views_str(num):
    if num is None or num == '': return None
    try:
        num = int(num)
        if num >= 1_000_000_000: return f"{num/1_000_000_000:.1f}B".replace(".0B", "B")
        if num >= 1_000_000: return f"{num/1_000_000:.1f}M".replace(".0M", "M")
        if num >= 1_000: return f"{num/1_000:.1f}K".replace(".0K", "K")
        return str(num)
    except: return str(num)

def time_ago_str(timestamp):
    if not timestamp: return ""
    try:
        timestamp = str(timestamp)
        if len(timestamp) == 8 and timestamp.isdigit(): dt = datetime.strptime(timestamp, "%Y%m%d")
        else: dt = datetime.fromtimestamp(float(timestamp))
        diff = (datetime.now() - dt).total_seconds()
        if diff < 60: return "just now"
        if diff < 3600: return f"{int(diff//60)} mins ago"
        if diff < 86400: return f"{int(diff//3600)} hours ago"
        if diff < 2592000: return f"{int(diff//86400)} days ago"
        if diff < 31536000: return f"{int(diff//2592000)} months ago"
        return f"{int(diff//31536000)} years ago"
    except: return ""

def parse_chapters_from_desc(desc):
    if not desc: return None
    chapters = []
    for line in desc.splitlines():
        m = re.search(r'(?:^|\s)((?:\d{1,2}:)?\d{1,2}:\d{2})\s+[\-\.]*\s*(.+)', line)
        if m:
            t_str = m.group(1)
            title = m.group(2).strip()
            parts = [int(x) for x in t_str.split(':')]
            sec = 0
            for p in parts: sec = sec * 60 + p
            chapters.append({'start_time': sec, 'title': title})
    if chapters and any(c['start_time'] == 0 for c in chapters):
        return sorted(chapters, key=lambda x: x['start_time'])
    return None

def fetch_missing_icons(videos):
    channels_to_fetch = set()
    for v in videos:
        c_url = v.get('channel_url') or v.get('uploader_url')
        if c_url:
            if not get_cached_icon(c_url): channels_to_fetch.add(c_url)
    if channels_to_fetch:
        def fetch_icon(curl): return curl, fetch_channel_info(curl).get('icon', '')
        with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
            for curl, icon in executor.map(fetch_icon, channels_to_fetch):
                if icon: CHANNEL_ICON_CACHE[curl.strip('/').split('?')[0].lower()] = icon
    for v in videos:
        c_url = v.get('channel_url') or v.get('uploader_url')
        if c_url:
            icon = get_cached_icon(c_url)
            if icon: v['channel_icon'] = icon

@app.context_processor
def inject_globals():
    last_view = session.get('last_feed_view', time.time())
    new_urls = set()
    
    for v in feed_cache.get('data', []):
        if v.get('timestamp', 0) > last_view:
            c_url = v.get('channel_url') or v.get('uploader_url')
            if c_url: new_urls.add(c_url.strip('/').split('?')[0].lower())
            
    subs = get_subs()
    subs_new = []
    subs_normal = []
    for s in subs:
        n_url = s['url'].strip('/').split('?')[0].lower()
        s['has_new'] = n_url in new_urls
        if s['has_new']:
            subs_new.append(s)
        else:
            subs_normal.append(s)
            
    return dict(subs=subs, subs_new=subs_new, subs_normal=subs_normal, app_settings=get_settings())

# --- Routes ---
@app.route('/')
def feed():
    resp = render_template('feed.html', title="New Uploads", type="feed", query="")
    session['last_feed_view'] = time.time()
    return resp

@app.route('/search')
def search():
    query = request.args.get('q')
    if not query: return redirect(url_for('feed'))
    return render_template('feed.html', title=f"Search: {query}", type="search", query=query)

@app.route('/watch')
def watch():
    v = request.args.get('v')
    if v:
        video_url = f"https://www.youtube.com/watch?v={v}"
    else:
        video_url = request.args.get('url')
    if not video_url: return "Video URL required", 400
    return render_template('watch.html', video_url=video_url)

@app.route('/shorts/<video_id>')
def shorts_redirect(video_id):
    return redirect(f'/watch?v={video_id}')

@app.route('/@<handle>')
@app.route('/channel/<channel_id>')
@app.route('/c/<channel_name>')
@app.route('/user/<username>')
def channel_page_routed(handle=None, channel_id=None, channel_name=None, username=None):
    if handle: yt_url = f"https://www.youtube.com/@{handle}"
    elif channel_id: yt_url = f"https://www.youtube.com/channel/{channel_id}"
    elif channel_name: yt_url = f"https://www.youtube.com/c/{channel_name}"
    elif username: yt_url = f"https://www.youtube.com/user/{username}"
    else: return "Invalid channel", 400
    return render_channel(yt_url)

@app.route('/channel')
def channel():
    channel_url = request.args.get('url')
    if not channel_url: return "Channel URL required", 400
    return render_channel(channel_url)

def render_channel(channel_url):
    subs = get_subs()
    n_url = channel_url.strip('/').split('?')[0].lower()
    sub = next((s for s in subs if s['url'].strip('/').split('?')[0].lower() == n_url), None)
    return render_template('channel.html', url=channel_url, channel_name=sub['name'] if sub else "Loading...", channel_icon=sub['icon'] if sub else "", is_subbed=bool(sub), needs_fetch=not bool(sub))

@app.route('/api/info')
def api_info():
    video_url = request.args.get('url')
    if not video_url: return jsonify({"error": "Video URL required"}), 400
    
    ydl_opts = {
        'quiet': True, 
        'no_warnings': True, 
        'ignoreerrors': True, 
        'getcomments': False,
        'writesubtitles': True,
        'allsubtitles': True
    }
    
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(video_url, download=False)
    except Exception as e: return jsonify({"error": str(e)}), 500
    if not info: return jsonify({"error": "Video unavailable"}), 404

    audio_formats = [f for f in info.get('formats', []) if f.get('vcodec') == 'none' and f.get('acodec') != 'none']
    video_formats = [f for f in info.get('formats', []) if f.get('vcodec') != 'none' and f.get('ext') in ['mp4', 'webm']]
    m4a_audio = [f for f in audio_formats if f.get('ext') == 'm4a']
    
    best_audio = sorted(m4a_audio, key=lambda x: x.get('abr', 0), reverse=True)[0] if m4a_audio else (sorted(audio_formats, key=lambda x: x.get('abr', 0), reverse=True)[0] if audio_formats else None)

    unique_resolutions = {}
    for f in sorted(video_formats, key=lambda x: (x.get('height', 0), x.get('tbr', 0)), reverse=True):
        h = f.get('height')
        if h and h not in unique_resolutions: unique_resolutions[h] = f

    resolutions = sorted(unique_resolutions.values(), key=lambda x: x.get('height', 0), reverse=True)
    resolutions_list = [{'height': r.get('height'), 'url': r.get('url'), 'fps': r.get('fps'), 'has_audio': r.get('acodec') != 'none'} for r in resolutions]

    uploader_url = info.get('uploader_url') or info.get('channel_url') or f"https://www.youtube.com/@{info.get('uploader')}"
    channel_icon = get_cached_icon(uploader_url)
    
    n_url = uploader_url.strip('/').split('?')[0].lower()
    is_subbed = any(s['url'].strip('/').split('?')[0].lower() == n_url for s in get_subs())

    title_words = info.get('title', 'video').replace('|', ' ').replace('-', ' ').split()
    broad_query = ' '.join(title_words[:4]).strip()
    if len(broad_query) < 3: broad_query = info.get('uploader', 'youtube')

    chapters = info.get('chapters')
    if not chapters:
        chapters = parse_chapters_from_desc(info.get('description', ''))

    # Subtitles Extraction Logic
    subtitles_list = []
    
    def extract_vtt_url(sub_formats):
        if not isinstance(sub_formats, list) or not sub_formats: return None
        vtt_sub = next((f for f in sub_formats if f.get('ext') == 'vtt'), None)
        if not vtt_sub: vtt_sub = sub_formats[-1]  
        
        url = vtt_sub.get('url')
        if not url: return None
        
        if 'youtube.com/api/timedtext' in url and 'fmt=vtt' not in url:
            url += '&fmt=vtt'
            
        return {'url': url, 'name': vtt_sub.get('name')}

    subs = info.get('subtitles')
    if isinstance(subs, dict):
        for lang, sub_formats in subs.items():
            if 'live_chat' in lang: continue
            
            vtt_data = extract_vtt_url(sub_formats)
            if vtt_data:
                label = vtt_data['name'] or lang
                subtitles_list.append({
                    'label': label,
                    'lang': lang,
                    'url': vtt_data['url'],
                    'is_auto': False
                })

    auto_subs = info.get('automatic_captions')
    if isinstance(auto_subs, dict):
        for lang, sub_formats in auto_subs.items():
            if not any(s['lang'] == lang and not s['is_auto'] for s in subtitles_list):
                vtt_data = extract_vtt_url(sub_formats)
                if vtt_data:
                    label = vtt_data['name'] or lang
                    subtitles_list.append({
                        'label': label, 
                        'lang': lang,
                        'url': vtt_data['url'],
                        'is_auto': True
                    })
                    
    subtitles_list.sort(key=lambda x: (x['is_auto'], x['label']))

    return jsonify({
        "id": info.get('id'),
        "title": info.get('title', 'Untitled'),
        "uploader": info.get('uploader') or info.get('channel') or 'Unknown',
        "uploader_url": uploader_url,
        "subscriber_count": format_views_str(info.get('channel_follower_count')),
        "view_count": format_views_str(info.get('view_count')),
        "time_ago": time_ago_str(info.get('timestamp') or info.get('upload_date')),
        "description": info.get('description', ''),
        "channel_icon": channel_icon,
        "is_subbed": is_subbed,
        "resolutions": resolutions_list,
        "best_audio": best_audio.get('url') if best_audio else None,
        "chapters": chapters,
        "subtitles": subtitles_list,
        "search_query": broad_query
    })

@app.route('/api/toggle_sub', methods=['POST'])
def api_toggle_sub():
    data = request.get_json()
    url = data.get('url')
    name = data.get('name')
    icon = data.get('icon', '')
    if not url: return jsonify({"error": "URL required"}), 400
    
    subs = get_subs()
    n_url = url.strip('/').split('?')[0].lower()
    existing = next((s for s in subs if s['url'].strip('/').split('?')[0].lower() == n_url), None)
    
    if existing:
        subs = [s for s in subs if s['url'].strip('/').split('?')[0].lower() != n_url]
        save_subs(subs)
        purge_channel_from_feed(url)
        return jsonify({"status": "removed", "is_subbed": False})
    else:
        if not icon or not name or name == 'Unknown':
            c_info = fetch_channel_info(url)
            name = name if (name and name != 'Unknown') else c_info['name']
            icon = icon or c_info['icon']
        # Omitting 'initial_fetch_done' means it defaults to False, making the first background fetch process it as backlog
        subs.append({"name": name, "url": url, "icon": icon, "id": ""})
        save_subs(subs)
        return jsonify({"status": "added", "is_subbed": True})

@app.route('/api/channel_info')
def api_channel_info():
    url = request.args.get('url')
    c_info = fetch_channel_info(url)
    n_url = url.strip('/').split('?')[0].lower()
    is_subbed = any(s['url'].strip('/').split('?')[0].lower() == n_url for s in get_subs())
    return jsonify({
        "name": c_info.get('name', 'Unknown Channel'),
        "icon": c_info.get('icon', ''),
        "is_subbed": is_subbed,
        "subscriber_count": format_views_str(c_info.get('subscriber_count'))
    })

@app.route('/api/videos')
def api_videos():
    page = int(request.args.get('page', 1))
    req_type = request.args.get('type', 'feed')
    query = request.args.get('query', '')
    settings = get_settings()
    per_page = settings['per_page']
    
    videos = []
    if req_type == 'feed':
        videos = get_flat_feed(page)
        return render_template('partials/video_cards.html', videos=videos, show_date=True, show_channel=True)
    elif req_type == 'channel' and query:
        start = (page - 1) * per_page + 1
        end = page * per_page
        ydl_opts = {'extract_flat': 'in_playlist', 'quiet': True, 'no_warnings': True, 'ignoreerrors': True, 'playlist_items': f'{start}-{end}'}
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(fix_youtube_url(query), download=False)
            if info:
                c_name = info.get('title', 'Unknown').replace(' - Videos', '')
                c_icon = info.get('thumbnails', [{'url': ''}])[-1]['url'] if info.get('thumbnails') else ''
                for e in info.get('entries', []):
                    if e and e.get('_type') != 'playlist':
                        e['channel_name'] = c_name
                        e['channel_icon'] = c_icon
                        e['channel_url'] = query
                        videos.append(e)
        # Prevent manual channel scrolling from populating the new upload feed
        sync_video_dates(videos, is_initial_or_backlog=True)
        return render_template('partials/video_cards.html', videos=videos, show_date=False, show_channel=False)
    elif req_type == 'search' and query:
        start = (page - 1) * per_page + 1
        end = page * per_page
        ydl_opts = {'extract_flat': 'in_playlist', 'quiet': True, 'no_warnings': True, 'ignoreerrors': True, 'playlist_items': f'{start}-{end}'}
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(f"ytsearch{end}:{query}", download=False)
            if info: videos = info.get('entries', [])
        fetch_missing_icons(videos)
        return render_template('partials/video_cards.html', videos=videos, show_date=True, show_channel=True)
    elif req_type == 'suggested' and query:
        start = (page - 1) * per_page + 1
        end = page * per_page
        ydl_opts = {'extract_flat': 'in_playlist', 'quiet': True, 'no_warnings': True, 'ignoreerrors': True, 'playlist_items': f'{start}-{end}'}
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(f"ytsearch{end}:{query}", download=False)
            videos = info.get('entries', []) if info else []
        fetch_missing_icons(videos)
        return render_template('partials/suggested_cards.html', videos=videos)
    return render_template('partials/video_cards.html', videos=[])

@app.route('/api/comments')
def api_comments():
    url = request.args.get('url')
    page = int(request.args.get('page', 1))
    sort = request.args.get('sort', 'top')
    per_page = 30
    if not url: return "No URL provided", 400
    if sort not in ('top', 'new'): sort = 'top'

    target_start = (page - 1) * per_page
    target_end = page * per_page
    cache_key = f"{url}|{sort}"

    with COMMENTS_LOCK:
        if len(COMMENTS_CACHE) > 50:
            for c_item in COMMENTS_CACHE.values():
                if c_item.get('ydl'):
                    try: c_item['ydl'].close()
                    except Exception: pass
            COMMENTS_CACHE.clear()

        if cache_key not in COMMENTS_CACHE:
            ydl_opts = {
                'quiet': True, 'no_warnings': True, 'ignoreerrors': True,
                'ignore_no_formats_error': True, 'getcomments': True,
                'skip_download': True, 'format': 'none', 
                'extractor_args': { 'youtube': { 'comment_sort': [sort], 'max-comments': ['all,all'] } }
            }
            ydl = yt_dlp.YoutubeDL(ydl_opts)
            try:
                info = ydl.extract_info(url, download=False, process=True)
                if not info or info.get('_type') in ('playlist', 'multi_video'):
                    ydl.close()
                    return "<p style='color:var(--text-muted);'>Comments not supported.</p>"
                lazy_list = info.get('comments')
                if lazy_list is None:
                    ydl.close()
                    return "<p style='color:var(--text-muted);'>Comments disabled or not supported.</p>"
                COMMENTS_CACHE[cache_key] = { 'lazy_list': lazy_list, 'ydl': ydl, 'exhausted': False }
            except Exception as e:
                ydl.close()
                return f"<p style='color:var(--accent);'>Error initializing comments: {e}</p>"
        cache_data = COMMENTS_CACHE[cache_key]

    try: chunk_plus_one = cache_data['lazy_list'][target_start : target_end + 1]
    except Exception as e: return f"<p style='color:var(--accent);'>Error loading comments: {e}</p>"

    chunk = chunk_plus_one[:per_page]
    with COMMENTS_LOCK:
        if len(chunk_plus_one) <= per_page: cache_data['exhausted'] = True
    if not chunk: return "" if page > 1 else "<p style='color:var(--text-muted);'>No comments found.</p>"
    return render_template('partials/comments.html', comments=chunk)

@app.route('/settings/export')
def export_subs():
    urls = [s['url'] for s in get_subs()]
    return app.response_class(response=json.dumps(urls, indent=4), status=200, mimetype='application/json', headers={"Content-disposition": "attachment; filename=subscriptions.json"})

@app.route('/settings', methods=['GET', 'POST'])
def settings_page():
    subs = get_subs()
    app_settings = get_settings()
    
    if request.method == 'POST':
        action = request.form.get('action')
        url = request.form.get('url')
        
        if action == 'add' and url:
            if not any(s['url'] == url for s in subs):
                c_info = fetch_channel_info(url)
                subs.append({"name": c_info['name'], "url": url, "icon": c_info['icon'], "id": c_info.get('id', '')})
            save_subs(subs)
            
        elif action == 'remove' and url:
            n_url = url.strip('/').split('?')[0].lower()
            subs = [s for s in subs if s['url'].strip('/').split('?')[0].lower() != n_url]
            save_subs(subs)
            purge_channel_from_feed(url)
            
        elif action == 'import_subs':
            file = request.files.get('import_file')
            if file and file.filename.endswith('.json'):
                try:
                    imported_urls = json.load(file)
                    if isinstance(imported_urls, list):
                        existing_urls = {s['url'].strip('/').split('?')[0].lower() for s in subs}
                        urls_to_add = []
                        for u in imported_urls:
                            if isinstance(u, str):
                                n_url = u.strip('/').split('?')[0].lower()
                                if n_url not in existing_urls:
                                    urls_to_add.append(u)
                                    existing_urls.add(n_url)
                        if urls_to_add:
                            def fetch_and_format(u):
                                c_info = fetch_channel_info(u)
                                return {"name": c_info['name'], "url": u, "icon": c_info['icon'], "id": c_info.get('id', '')}
                            with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
                                for r in executor.map(fetch_and_format, urls_to_add): subs.append(r)
                            save_subs(subs)
                            def background_feed_update():
                                with app.app_context(): update_feed_now()
                            threading.Thread(target=background_feed_update).start()
                except Exception as e: print(f"Import error: {e}")
                    
        elif action == 'reset_subs':
            save_subs([])
            feed_cache['data'] = []
            save_video_dates({}) # Wipe the corrupted DB cache as well
            
        elif action == 'update_settings':
            try:
                app_settings['background_interval_mins'] = int(request.form.get('background_interval_mins', 30))
                app_settings['per_page'] = int(request.form.get('per_page', 15))
                app_settings['desc_preview_height'] = int(request.form.get('desc_preview_height', 100))
                save_settings(app_settings)
            except ValueError: pass
                
        elif action == 'update_shortcuts':
            app_settings['shortcut_pause'] = request.form.get('shortcut_pause', 'Space')
            app_settings['shortcut_seek_fwd'] = request.form.get('shortcut_seek_fwd', 'ArrowRight')
            app_settings['shortcut_seek_bwd'] = request.form.get('shortcut_seek_bwd', 'ArrowLeft')
            app_settings['shortcut_mute'] = request.form.get('shortcut_mute', 'm')
            app_settings['shortcut_chap_next'] = request.form.get('shortcut_chap_next', 'PageUp')
            app_settings['shortcut_chap_prev'] = request.form.get('shortcut_chap_prev', 'PageDown')
            save_settings(app_settings)
                
        return redirect(request.referrer or url_for('settings_page'))
    return render_template('settings.html', subs=subs, app_settings=app_settings)

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5000, threaded=True)