from flask import Flask, render_template, request, redirect, url_for, jsonify
import yt_dlp
import json
import os
import concurrent.futures
import threading
from datetime import datetime
import time
import itertools

app = Flask(__name__)
SUBS_FILE = 'subscriptions.json'
SETTINGS_FILE = 'settings.json'
VIDEO_DATES_FILE = 'video_dates.json'

DEFAULT_SETTINGS = {
    'background_interval_mins': 30,
    'per_page': 15
}

feed_cache = {'data': [], 'last_update': 0}

# Simple cache so we don't refetch the exact same page if the user refreshes
COMMENTS_CACHE = {} 
COMMENTS_LOCK = threading.Lock()

def get_settings():
    if os.path.exists(SETTINGS_FILE):
        try:
            with open(SETTINGS_FILE, 'r') as f:
                data = json.load(f)
                return {**DEFAULT_SETTINGS, **data}
        except: pass
    return DEFAULT_SETTINGS.copy()

def save_settings(settings):
    with open(SETTINGS_FILE, 'w') as f:
        json.dump(settings, f)

def get_subs():
    if os.path.exists(SUBS_FILE):
        with open(SUBS_FILE, 'r') as f:
            return json.load(f)
    return []

def save_subs(subs):
    with open(SUBS_FILE, 'w') as f:
        json.dump(subs, f)

def get_video_dates():
    if os.path.exists(VIDEO_DATES_FILE):
        try:
            with open(VIDEO_DATES_FILE, 'r') as f:
                return json.load(f)
        except: pass
    return {}

def save_video_dates(dates):
    with open(VIDEO_DATES_FILE, 'w') as f:
        json.dump(dates, f)

def sync_video_dates(entries):
    dates_cache = get_video_dates()
    changed = False
    now = time.time()
    
    for e in entries:
        if not e: continue
        vid = e.get('id')
        if not vid: continue
        
        if vid not in dates_cache:
            dates_cache[vid] = now
            changed = True
            
        e['timestamp'] = dates_cache[vid]
        
    if changed:
        save_video_dates(dates_cache)

def fix_youtube_url(url):
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
                return {"name": "Unknown", "url": url, "icon": "", "id": ""}
                
            icon = info.get('thumbnails', [{'url': ''}])[-1]['url'] if info.get('thumbnails') else ''
            title = info.get('title', 'Unknown Channel').replace(' - Videos', '')
            
            channel_id = info.get('channel_id') or info.get('playlist_channel_id') or info.get('playlist_id') or info.get('id', '')
            if channel_id.startswith('UU'):  
                channel_id = 'UC' + channel_id[2:]
                
            return {"name": title, "url": url, "icon": icon, "id": channel_id}
    except Exception:
        return {"name": "Unknown", "url": url, "icon": "", "id": ""}

def update_feed_now():
    subs = get_subs()
    settings = get_settings()
    fetch_limit = max(50, settings['per_page'] * 3) 
    
    def fetch_flat(sub):
        ydl_opts = {'extract_flat': 'in_playlist', 'playlistend': fetch_limit, 'quiet': True, 'no_warnings': True, 'ignoreerrors': True}
        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(fix_youtube_url(sub['url']), download=False)
                if info and info.get('entries'):
                    for e in info['entries']:
                        if e:
                            e['channel_name'] = sub['name']
                            e['channel_icon'] = sub.get('icon', '')
                            e['channel_url'] = sub['url']
                    return [e for e in info['entries'] if e]
        except Exception:
            pass
        return []

    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:
        results = list(executor.map(fetch_flat, subs))
        
    interleaved = []
    if results:
        max_len = max([len(r) for r in results] + [0])
        for i in range(max_len):
            for r in results:
                if i < len(r):
                    interleaved.append(r[i])
    
    sync_video_dates(interleaved)
    feed_cache['data'] = interleaved
    feed_cache['last_update'] = time.time()

def bg_worker():
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
    
    if not feed_cache['data']:
        update_feed_now()

    all_videos = feed_cache['data']
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
        if diff < 3600: return f"{int(diff//60)} mins ago"
        if diff < 86400: return f"{int(diff//3600)} hours ago"
        if diff < 2592000: return f"{int(diff//86400)} days ago"
        if diff < 31536000: return f"{int(diff//2592000)} months ago"
        return f"{int(diff//31536000)} years ago"
    except:
        return ""

@app.template_filter('format_time')
def format_time(s): return format_time_str(s)

@app.template_filter('format_views')
def format_views(num): return format_views_str(num)

@app.template_filter('time_ago')
def time_ago(timestamp): return time_ago_str(timestamp)

@app.context_processor
def inject_globals():
    return dict(
        subs=get_subs(),
        app_settings=get_settings()
    )

@app.route('/')
def feed():
    return render_template('feed.html', title="Your Feed", type="feed", query="")

@app.route('/search')
def search():
    query = request.args.get('q')
    if not query: return redirect(url_for('feed'))
    return render_template('feed.html', title=f"Search: {query}", type="search", query=query)

@app.route('/watch')
def watch():
    video_url = request.args.get('url')
    if not video_url:
        if request.args.get('v'):
            video_url = f"https://www.youtube.com/watch?v={request.args.get('v')}"
        else:
            return "Video URL required", 400
    return render_template('watch.html', video_url=video_url)

@app.route('/api/info')
def api_info():
    video_url = request.args.get('url')
    if not video_url:
        return jsonify({"error": "Video URL required"}), 400

    ydl_opts = {'quiet': True, 'no_warnings': True, 'ignoreerrors': True, 'getcomments': False}
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(video_url, download=False)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    if not info:
        return jsonify({"error": "Video unavailable"}), 404

    audio_formats = [f for f in info.get('formats', []) if f.get('vcodec') == 'none' and f.get('acodec') != 'none']
    video_formats = [f for f in info.get('formats', []) if f.get('vcodec') != 'none' and f.get('ext') in ['mp4', 'webm']]
    
    m4a_audio = [f for f in audio_formats if f.get('ext') == 'm4a']
    if m4a_audio:
        best_audio = sorted(m4a_audio, key=lambda x: x.get('abr', 0), reverse=True)[0]
    else:
        best_audio = sorted(audio_formats, key=lambda x: x.get('abr', 0), reverse=True)[0] if audio_formats else None

    unique_resolutions = {}
    for f in sorted(video_formats, key=lambda x: (x.get('height', 0), x.get('tbr', 0)), reverse=True):
        h = f.get('height')
        if h and h not in unique_resolutions:
            unique_resolutions[h] = f

    resolutions = sorted(unique_resolutions.values(), key=lambda x: x.get('height', 0), reverse=True)
    resolutions_list = [{'height': r.get('height'), 'url': r.get('url'), 'fps': r.get('fps'), 'has_audio': r.get('acodec') != 'none'} for r in resolutions]

    channel_icon = ""
    uploader_url = info.get('uploader_url') or info.get('channel_url') or f"https://www.youtube.com/@{info.get('uploader')}"
    for s in get_subs():
        if s['url'].strip('/') == uploader_url.strip('/'):
            channel_icon = s.get('icon', '')

    title_words = info.get('title', 'video').replace('|', ' ').replace('-', ' ').split()
    broad_query = ' '.join(title_words[:4]).strip()
    if len(broad_query) < 3: broad_query = info.get('uploader', 'youtube')

    return jsonify({
        "id": info.get('id'),
        "title": info.get('title', 'Untitled'),
        "uploader": info.get('uploader') or info.get('channel') or 'Unknown',
        "uploader_url": uploader_url,
        "view_count": format_views_str(info.get('view_count')),
        "time_ago": time_ago_str(info.get('timestamp') or info.get('upload_date')),
        "description": info.get('description', ''),
        "channel_icon": channel_icon,
        "resolutions": resolutions_list,
        "best_audio": best_audio.get('url') if best_audio else None,
        "search_query": broad_query
    })

@app.route('/channel')
def channel():
    channel_url = request.args.get('url')
    if not channel_url: return "Channel URL required", 400

    subs = get_subs()
    sub = next((s for s in subs if s['url'].strip('/') == channel_url.strip('/')), None)
    
    return render_template(
        'channel.html', 
        url=channel_url, 
        channel_name=sub['name'] if sub else "Loading...", 
        channel_icon=sub['icon'] if sub else "", 
        is_subbed=bool(sub),
        needs_fetch=not bool(sub)
    )

@app.route('/api/channel_info')
def api_channel_info():
    url = request.args.get('url')
    c_info = fetch_channel_info(url)
    is_subbed = any(s['url'].strip('/') == url.strip('/') for s in get_subs())
    return jsonify({
        "name": c_info.get('name', 'Unknown Channel'),
        "icon": c_info.get('icon', ''),
        "is_subbed": is_subbed
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
        return render_template('partials/video_cards.html', videos=videos, show_date=True)
        
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
        sync_video_dates(videos)
        return render_template('partials/video_cards.html', videos=videos, show_date=False)
        
    elif req_type == 'search' and query:
        start = (page - 1) * per_page + 1
        end = page * per_page
        ydl_opts = {'extract_flat': 'in_playlist', 'quiet': True, 'no_warnings': True, 'ignoreerrors': True, 'playlist_items': f'{start}-{end}'}
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(f"ytsearch{end}:{query}", download=False)
            if info:
                videos = info.get('entries', [])
        sync_video_dates(videos)
        return render_template('partials/video_cards.html', videos=videos, show_date=True)
        
    elif req_type == 'suggested' and query:
        start = (page - 1) * per_page + 1
        end = page * per_page
        ydl_opts = {'extract_flat': 'in_playlist', 'quiet': True, 'no_warnings': True, 'ignoreerrors': True, 'playlist_items': f'{start}-{end}'}
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(f"ytsearch{end}:{query}", download=False)
            videos = info.get('entries', []) if info else []
        return render_template('partials/suggested_cards.html', videos=videos)

    return render_template('partials/video_cards.html', videos=[])


@app.route('/api/comments')
def api_comments():
    url = request.args.get('url')
    page = int(request.args.get('page', 1))
    sort = request.args.get('sort', 'top')  # Default to top
    per_page = 15

    if not url: return "No URL provided", 400
    if sort not in ('top', 'new'): sort = 'top'

    target_start = (page - 1) * per_page
    target_end = page * per_page
    
    # Create a unique cache key based on URL AND sort order
    cache_key = f"{url}|{sort}"

    with COMMENTS_LOCK:
        # Safe memory cleanup: close old yt-dlp sessions
        if len(COMMENTS_CACHE) > 50:
            for c_item in COMMENTS_CACHE.values():
                if c_item.get('ydl'):
                    try: c_item['ydl'].close()
                    except Exception: pass
            COMMENTS_CACHE.clear()

        # If we don't have a live session for this exact URL+Sort combination, set one up
        if cache_key not in COMMENTS_CACHE:
            ydl_opts = {
                'quiet': True,
                'no_warnings': True,
                'ignoreerrors': True,
                'ignore_no_formats_error': True,
                'getcomments': True,
                'skip_download': True,
                'format': 'none', 
                'extractor_args': {
                    'youtube': {
                        'comment_sort': [sort],
                        'max-comments': ['all,all'] # Fetches top-level AND nested replies lazily
                    }
                }
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

                COMMENTS_CACHE[cache_key] = {
                    'lazy_list': lazy_list,
                    'ydl': ydl,
                    'exhausted': False
                }
            except Exception as e:
                ydl.close()
                return f"<p style='color:var(--accent);'>Error initializing comments: {e}</p>"

        cache_data = COMMENTS_CACHE[cache_key]

    # Outside the lock, slice the LazyList. 
    try:
        chunk_plus_one = cache_data['lazy_list'][target_start : target_end + 1]
    except Exception as e:
        return f"<p style='color:var(--accent);'>Error loading comments: {e}</p>"

    chunk = chunk_plus_one[:per_page]

    with COMMENTS_LOCK:
        if len(chunk_plus_one) <= per_page:
            cache_data['exhausted'] = True

    if not chunk:
        return "" if page > 1 else "<p style='color:var(--text-muted);'>No comments found.</p>"

    return render_template('partials/comments.html', comments=chunk)


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
            subs = [s for s in subs if s['url'] != url]
            save_subs(subs)
        elif action == 'update_settings':
            try:
                app_settings['background_interval_mins'] = int(request.form.get('background_interval_mins', 30))
                app_settings['per_page'] = int(request.form.get('per_page', 15))
                save_settings(app_settings)
            except ValueError:
                pass
                
        return redirect(request.referrer or url_for('settings_page'))

    return render_template('settings.html', subs=subs, app_settings=app_settings)

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5000)