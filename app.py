from flask import Flask, render_template, request, redirect, url_for, jsonify
import yt_dlp
import json
import os
import concurrent.futures
import itertools
from datetime import datetime
import time

app = Flask(__name__)
SUBS_FILE = 'subscriptions.json'
SETTINGS_FILE = 'settings.json'

DEFAULT_SETTINGS = {
    'concurrent_requests': 3,
    'min_delay_ms': 150,
    'per_page': 15
}

feed_cache = {'data': [], 'expires': 0}

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
    # Invalidate feed cache on subscription change
    feed_cache['expires'] = 0

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

def get_flat_feed(page=1):
    settings = get_settings()
    per_page = settings['per_page']
    
    if time.time() > feed_cache['expires']:
        subs = get_subs()
        
        needs_save = False
        for sub in subs:
            if not sub.get('id'):
                c_info = fetch_channel_info(sub['url'])
                sub['id'] = c_info.get('id', '')
                sub['icon'] = c_info.get('icon', sub.get('icon', ''))
                sub['name'] = c_info.get('name', sub.get('name', 'Unknown'))
                needs_save = True
                
        if needs_save:
            save_subs(subs)

        def fetch_flat(sub):
            ydl_opts = {'extract_flat': 'in_playlist', 'playlistend': max(20, per_page), 'quiet': True, 'no_warnings': True, 'ignoreerrors': True}
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
        
        feed_cache['data'] = interleaved
        feed_cache['expires'] = time.time() + 600

    all_videos = feed_cache['data']
    start = (page - 1) * per_page
    end = page * per_page
    return all_videos[start:end]

@app.template_filter('format_time')
def format_time(s):
    if not s: return "0:00"
    try:
        m, s = divmod(int(float(s)), 60)
        h, m = divmod(m, 60)
        if h > 0: return f"{h}:{m:02d}:{s:02d}"
        return f"{m}:{s:02d}"
    except (ValueError, TypeError):
        return "0:00"

@app.template_filter('format_views')
def format_views(num):
    if num is None or num == '': return None
    try:
        num = int(num)
        if num >= 1_000_000_000: return f"{num/1_000_000_000:.1f}B".replace(".0B", "B")
        if num >= 1_000_000: return f"{num/1_000_000:.1f}M".replace(".0M", "M")
        if num >= 1_000: return f"{num/1_000:.1f}K".replace(".0K", "K")
        return str(num)
    except:
        return str(num)

@app.template_filter('time_ago')
def time_ago(timestamp):
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

    ydl_opts = {'quiet': True, 'no_warnings': True, 'ignoreerrors': True}
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(video_url, download=False)
    except Exception as e:
        return f"Error loading video: {e}", 500

    if not info:
        return "Video unavailable (may be members-only or deleted).", 404

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
    for s in get_subs():
        if info.get('uploader_url') and s['url'].strip('/') == info['uploader_url'].strip('/'):
            channel_icon = s.get('icon', '')

    settings = get_settings()
    suggested = []
    try:
        with yt_dlp.YoutubeDL({'extract_flat': 'in_playlist', 'quiet': True, 'no_warnings': True, 'ignoreerrors': True, 'playlistend': settings['per_page']}) as ydl:
            search_query = f"ytsearch{settings['per_page']}:{info.get('uploader', '')} {info.get('title', '')}"
            s_info = ydl.extract_info(search_query, download=False)
            if s_info:
                suggested = [e for e in s_info.get('entries', []) if e['id'] != info['id']]
    except Exception: pass

    return render_template('watch.html', video=info, resolutions=resolutions, 
                           resolutions_json=json.dumps(resolutions_list), 
                           best_audio=best_audio, suggested=suggested, channel_icon=channel_icon)

@app.route('/channel')
def channel():
    channel_url = request.args.get('url')
    if not channel_url: return "Channel URL required", 400

    c_info = fetch_channel_info(channel_url)
    channel_name = c_info.get('name', 'Unknown Channel')
    channel_icon = c_info.get('icon', '')
    is_subbed = any(s['url'] == channel_url for s in get_subs())
    
    return render_template('channel.html', channel_name=channel_name, 
                           url=channel_url, is_subbed=is_subbed, channel_icon=channel_icon, type="channel")

@app.route('/api/videos_list')
def api_videos_list():
    page = int(request.args.get('page', 1))
    req_type = request.args.get('type', 'feed')
    query = request.args.get('query', '')
    
    settings = get_settings()
    per_page = settings['per_page']
    
    videos = []
    if req_type == 'feed':
        videos = get_flat_feed(page)
    elif req_type == 'search' and query:
        start = (page - 1) * per_page + 1
        end = page * per_page
        ydl_opts = {'extract_flat': 'in_playlist', 'quiet': True, 'no_warnings': True, 'ignoreerrors': True, 'playlist_items': f'{start}-{end}'}
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(f"ytsearch{end}:{query}", download=False)
            videos = info.get('entries', []) if info else []
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

    sanitized = []
    for v in videos:
        if v:
            sanitized.append({
                'id': v.get('id'),
                'url': v.get('url'),
                'channel_name': v.get('channel_name'),
                'channel_icon': v.get('channel_icon'),
                'channel_url': v.get('channel_url')
            })
            
    return jsonify(sanitized)

@app.route('/api/video_card')
def api_video_card():
    url = request.args.get('url')
    if not url: return "", 400
    
    channel_name = request.args.get('channel_name', '')
    channel_icon = request.args.get('channel_icon', '')
    channel_url = request.args.get('channel_url', '')

    ydl_opts = {'quiet': True, 'no_warnings': True, 'ignoreerrors': True}
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
            if info:
                if channel_name: info['channel_name'] = channel_name
                if channel_icon: info['channel_icon'] = channel_icon
                if channel_url: info['channel_url'] = channel_url
                
                if not info.get('timestamp') and info.get('upload_date'):
                    info['timestamp'] = info['upload_date']
                    
                return render_template('partials/video_cards.html', videos=[info])
    except Exception:
        pass
    return ""

@app.route('/api/videos')
def api_videos():
    page = int(request.args.get('page', 1))
    req_type = request.args.get('type', 'feed')
    query = request.args.get('query', '')
    settings = get_settings()
    per_page = settings['per_page']
    
    videos = []
    if req_type == 'suggested' and query:
        start = (page - 1) * per_page + 1
        end = page * per_page
        with yt_dlp.YoutubeDL({'extract_flat': 'in_playlist', 'quiet': True, 'no_warnings': True, 'ignoreerrors': True, 'playlist_items': f'{start}-{end}'}) as ydl:
            info = ydl.extract_info(f"ytsearch{end}:{query}", download=False)
            videos = info.get('entries', []) if info else []
        return render_template('partials/suggested_cards.html', videos=videos)

    return render_template('partials/video_cards.html', videos=[])

@app.route('/api/comments')
def api_comments():
    url = request.args.get('url')
    if not url: return "No URL provided", 400
    ydl_opts = {
        'quiet': True, 
        'no_warnings': True,
        'ignoreerrors': True,
        'getcomments': True,
        'extractor_args': {'youtube': ['max-comments=40']}
    }
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
            if not info: return "Error loading comments", 500
            comments_raw = info.get('comments', [])
            
            comments_dict = {}
            tree = []
            
            for c in comments_raw:
                c['replies'] = []
                comments_dict[c['id']] = c
                
            for c in comments_raw:
                parent_id = c.get('parent')
                if parent_id == 'root' or not parent_id:
                    tree.append(c)
                else:
                    if parent_id in comments_dict:
                        comments_dict[parent_id]['replies'].append(c)
                    else:
                        tree.append(c)
                        
            return render_template('partials/comments.html', comments=tree)
    except Exception as e:
        return f"<p style='color:var(--accent);'>Error loading comments: {e}</p>"

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
                app_settings['concurrent_requests'] = int(request.form.get('concurrent_requests', 3))
                app_settings['min_delay_ms'] = int(request.form.get('min_delay_ms', 150))
                app_settings['per_page'] = int(request.form.get('per_page', 15))
                save_settings(app_settings)
            except ValueError:
                pass
                
        return redirect(request.referrer or url_for('settings_page'))

    return render_template('settings.html', subs=subs, app_settings=app_settings)

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5000)