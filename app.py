from flask import Flask, render_template, request, redirect, url_for
import yt_dlp
import json
import os
import concurrent.futures
import itertools

app = Flask(__name__)
SUBS_FILE = 'subscriptions.json'

def get_subs():
    if os.path.exists(SUBS_FILE):
        with open(SUBS_FILE, 'r') as f:
            return json.load(f)
    return []

def save_subs(subs):
    with open(SUBS_FILE, 'w') as f:
        json.dump(subs, f)

def fix_youtube_url(url):
    if 'youtube.com' in url and ('/@' in url or '/c/' in url or '/channel/' in url):
        if '/videos' not in url and '/shorts' not in url and '/streams' not in url:
            return url.rstrip('/') + '/videos'
    return url

def fetch_channel_info(url):
    ydl_opts = {'extract_flat': True, 'playlistend': 1, 'quiet': True}
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
            icon = info.get('thumbnails', [{'url': ''}])[-1]['url']
            title = info.get('title', 'Unknown Channel')
            if title.endswith(' - Videos'): title = title[:-9]
            return {"name": title, "url": url, "icon": icon}
    except Exception:
        return {"name": "Unknown", "url": url, "icon": ""}

def get_feed_videos(page=1):
    subs = get_subs()
    per_channel = 6
    start = (page - 1) * per_channel + 1
    end = page * per_channel
    ydl_opts = {
        'extract_flat': 'in_playlist',
        'playlist_items': f'{start}-{end}',
        'quiet': True
    }
    
    def fetch_sub(sub):
        vids = []
        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(fix_youtube_url(sub['url']), download=False)
                for entry in info.get('entries', []):
                    if entry and entry.get('_type') != 'playlist':
                        entry['channel_name'] = sub['name']
                        entry['channel_icon'] = sub.get('icon', '')
                        entry['channel_url'] = sub['url']
                        vids.append(entry)
        except Exception:
            pass
        return vids

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
        results = list(executor.map(fetch_sub, subs))
        
    interleaved = [v for v in itertools.chain.from_iterable(itertools.zip_longest(*results)) if v]
    return interleaved

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

@app.context_processor
def inject_subs():
    return dict(subs=get_subs())

@app.route('/')
def feed():
    return render_template('feed.html', videos=get_feed_videos(page=1), title="Your Feed", type="feed", query="")

@app.route('/search')
def search():
    query = request.args.get('q')
    if not query: return redirect(url_for('feed'))
    
    ydl_opts = {'extract_flat': 'in_playlist', 'quiet': True, 'playlistend': 15}
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(f"ytsearch15:{query}", download=False)
        videos = info.get('entries', [])
    return render_template('feed.html', videos=videos, title=f"Search: {query}", type="search", query=query)

@app.route('/watch')
def watch():
    video_url = request.args.get('url')
    if not video_url:
        if request.args.get('v'):
            video_url = f"https://www.youtube.com/watch?v={request.args.get('v')}"
        else:
            return "Video URL required", 400

    # Removed 'getcomments': True to drastically speed up extraction and prevent hangs
    ydl_opts = {'quiet': True}
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(video_url, download=False)
    except Exception as e:
        return f"Error loading video: {e}", 500

    # Separate audio and video formats to enable 1080p+ streaming via dual-sync
    audio_formats = [f for f in info.get('formats', []) if f.get('vcodec') == 'none' and f.get('acodec') != 'none']
    video_formats = [f for f in info.get('formats', []) if f.get('vcodec') != 'none' and f.get('ext') in ['mp4', 'webm']]
    
    best_audio = sorted(audio_formats, key=lambda x: x.get('abr', 0), reverse=True)[0] if audio_formats else None

    # Deduplicate video resolutions, keeping the highest bitrate version of each height
    unique_resolutions = {}
    for f in sorted(video_formats, key=lambda x: (x.get('height', 0), x.get('tbr', 0)), reverse=True):
        h = f.get('height')
        if h and h not in unique_resolutions:
            unique_resolutions[h] = f

    resolutions = sorted(unique_resolutions.values(), key=lambda x: x.get('height', 0), reverse=True)

    channel_icon = ""
    for s in get_subs():
        if info.get('uploader_url') and s['url'].strip('/') == info['uploader_url'].strip('/'):
            channel_icon = s.get('icon', '')

    suggested = []
    try:
        with yt_dlp.YoutubeDL({'extract_flat': True, 'quiet': True, 'playlistend': 12}) as ydl:
            search_query = f"ytsearch12:{info.get('uploader', '')} {info.get('title', '')}"
            s_info = ydl.extract_info(search_query, download=False)
            suggested = [e for e in s_info.get('entries', []) if e['id'] != info['id']]
    except Exception: pass

    return render_template('watch.html', video=info, resolutions=resolutions, best_audio=best_audio, suggested=suggested, channel_icon=channel_icon)

@app.route('/channel')
def channel():
    channel_url = request.args.get('url')
    if not channel_url: return "Channel URL required", 400

    ydl_opts = {'extract_flat': 'in_playlist', 'quiet': True, 'playlistend': 20}
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(fix_youtube_url(channel_url), download=False)
            channel_name = info.get('title', 'Unknown Channel').replace(' - Videos', '')
            videos = []
            channel_icon = info.get('thumbnails', [{'url': ''}])[-1]['url'] if info.get('thumbnails') else ''
            
            for entry in info.get('entries', []):
                if entry and entry.get('_type') != 'playlist':
                    entry['channel_name'] = channel_name
                    entry['channel_icon'] = channel_icon
                    entry['channel_url'] = channel_url
                    videos.append(entry)
                    
    except Exception as e:
        return f"Error loading channel: {e}", 500

    is_subbed = any(s['url'] == channel_url for s in get_subs())
    return render_template('channel.html', videos=videos, channel_name=channel_name, 
                           url=channel_url, is_subbed=is_subbed, channel_icon=channel_icon, type="channel")

@app.route('/api/videos')
def api_videos():
    page = int(request.args.get('page', 1))
    req_type = request.args.get('type', 'feed')
    query = request.args.get('query', '')
    
    videos = []
    if req_type == 'feed':
        videos = get_feed_videos(page)
    elif req_type == 'search' and query:
        start = (page - 1) * 15 + 1
        end = page * 15
        with yt_dlp.YoutubeDL({'extract_flat': 'in_playlist', 'quiet': True, 'playlist_items': f'{start}-{end}'}) as ydl:
            info = ydl.extract_info(f"ytsearch{end}:{query}", download=False)
            videos = info.get('entries', [])
    elif req_type == 'channel' and query:
        start = (page - 1) * 20 + 1
        end = page * 20
        with yt_dlp.YoutubeDL({'extract_flat': 'in_playlist', 'quiet': True, 'playlist_items': f'{start}-{end}'}) as ydl:
            info = ydl.extract_info(fix_youtube_url(query), download=False)
            channel_name = info.get('title', 'Unknown Channel').replace(' - Videos', '')
            channel_icon = info.get('thumbnails', [{'url': ''}])[-1]['url'] if info.get('thumbnails') else ''
            
            for entry in info.get('entries', []):
                if entry and entry.get('_type') != 'playlist':
                    entry['channel_name'] = channel_name
                    entry['channel_icon'] = channel_icon
                    entry['channel_url'] = query
                    videos.append(entry)

    return render_template('partials/video_cards.html', videos=videos)

@app.route('/settings', methods=['GET', 'POST'])
def settings():
    subs = get_subs()
    if request.method == 'POST':
        action = request.form.get('action')
        url = request.form.get('url')
        
        if action == 'add' and url:
            if not any(s['url'] == url for s in subs):
                c_info = fetch_channel_info(url)
                subs.append({"name": c_info['name'], "url": url, "icon": c_info['icon']})
        elif action == 'remove' and url:
            subs = [s for s in subs if s['url'] != url]
            
        save_subs(subs)
        return redirect(request.referrer or url_for('settings'))

    return render_template('settings.html', subs=subs)

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5000)