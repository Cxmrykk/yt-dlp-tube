from flask import Flask, render_template, request, redirect, url_for
import yt_dlp
import json
import os
import concurrent.futures
import xml.etree.ElementTree as ET
import urllib.request
import itertools
from datetime import datetime

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
    ydl_opts = {'extract_flat': 'in_playlist', 'playlistend': 1, 'quiet': True, 'no_warnings': True, 'ignoreerrors': True}
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(fix_youtube_url(url), download=False)
            if not info:
                return {"name": "Unknown", "url": url, "icon": "", "id": ""}
                
            icon = info.get('thumbnails', [{'url': ''}])[-1]['url'] if info.get('thumbnails') else ''
            title = info.get('title', 'Unknown Channel').replace(' - Videos', '')
            
            # YouTube requires a UC... ID for RSS feeds. Extract it safely.
            channel_id = info.get('channel_id') or info.get('playlist_channel_id') or info.get('playlist_id') or info.get('id', '')
            if channel_id.startswith('UU'):  # Convert Uploads playlist ID to Channel ID
                channel_id = 'UC' + channel_id[2:]
                
            return {"name": title, "url": url, "icon": icon, "id": channel_id}
    except Exception:
        return {"name": "Unknown", "url": url, "icon": "", "id": ""}

def fetch_rss_videos(sub):
    """Bypass yt-dlp entirely and fetch blazing fast XML metadata for a channel"""
    vids = []
    if not sub.get('id'):
        return vids
        
    url = f"https://www.youtube.com/feeds/videos.xml?channel_id={sub['id']}"
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=5) as resp:
            xml_data = resp.read()
            
        root = ET.fromstring(xml_data)
        ns = {
            'atom': 'http://www.w3.org/2005/Atom',
            'yt': 'http://www.youtube.com/xml/schemas/2015',
            'media': 'http://search.yahoo.com/mrss/'
        }
        
        for entry in root.findall('atom:entry', ns):
            vid_id = entry.find('yt:videoId', ns).text
            title = entry.find('atom:title', ns).text
            published = entry.find('atom:published', ns).text
            
            try:
                # Safely parse date by stripping out the timezone and T character
                # Format: 2024-05-25T13:54:04+00:00 -> 2024-05-25 13:54:04
                dt_str = published[:19].replace('T', ' ')
                timestamp = datetime.strptime(dt_str, "%Y-%m-%d %H:%M:%S").timestamp()
            except:
                timestamp = 0

            media_group = entry.find('media:group', ns)
            thumbnail = ""
            views = None
            
            if media_group is not None:
                thumb_node = media_group.find('media:thumbnail', ns)
                if thumb_node is not None:
                    thumbnail = thumb_node.attrib.get('url', '')
                
                # Carefully traverse nodes to avoid ElementTree path issues
                community_node = media_group.find('media:community', ns)
                if community_node is not None:
                    stats_node = community_node.find('media:statistics', ns)
                    if stats_node is not None:
                        views = stats_node.attrib.get('views')

            vids.append({
                'id': vid_id,
                'title': title,
                'thumbnail': thumbnail,
                'view_count': int(views) if views else None,
                'duration': None,
                'timestamp': timestamp,
                'url': f"https://www.youtube.com/watch?v={vid_id}",
                'channel_name': sub['name'],
                'channel_icon': sub.get('icon', ''),
                'channel_url': sub['url']
            })
    except Exception:
        pass
    return vids

def get_feed_videos(page=1):
    subs = get_subs()
    
    # Check if we need to migrate/repair any missing IDs
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

    # ONLY use RSS feeds for the home page for guaranteed speed and robust timestamps
    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:
        results = list(executor.map(fetch_rss_videos, subs))
        
    all_videos = [v for sublist in results for v in sublist if v]
    all_videos.sort(key=lambda x: x.get('timestamp', 0) or 0, reverse=True)
    
    # Slice the master feed list for pagination natively
    per_page = 20
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
def inject_subs():
    return dict(subs=get_subs())

@app.route('/')
def feed():
    return render_template('feed.html', videos=get_feed_videos(page=1), title="Your Feed", type="feed", query="")

@app.route('/search')
def search():
    query = request.args.get('q')
    if not query: return redirect(url_for('feed'))
    
    ydl_opts = {'extract_flat': 'in_playlist', 'quiet': True, 'no_warnings': True, 'ignoreerrors': True, 'playlistend': 15}
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(f"ytsearch15:{query}", download=False)
        videos = info.get('entries', []) if info else []
    return render_template('feed.html', videos=videos, title=f"Search: {query}", type="search", query=query)

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

    suggested = []
    try:
        with yt_dlp.YoutubeDL({'extract_flat': 'in_playlist', 'quiet': True, 'no_warnings': True, 'ignoreerrors': True, 'playlistend': 12}) as ydl:
            search_query = f"ytsearch12:{info.get('uploader', '')} {info.get('title', '')}"
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

    ydl_opts = {'extract_flat': 'in_playlist', 'quiet': True, 'no_warnings': True, 'ignoreerrors': True, 'playlistend': 15}
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(fix_youtube_url(channel_url), download=False)
            if not info: return "Error loading channel", 500
            
            channel_name = info.get('title', 'Unknown Channel').replace(' - Videos', '')
            videos = []
            channel_icon = info.get('thumbnails', [{'url': ''}])[-1]['url'] if info.get('thumbnails') else ''
            
            channel_id = info.get('channel_id') or info.get('playlist_channel_id') or info.get('playlist_id') or info.get('id', '')
            if channel_id.startswith('UU'):
                channel_id = 'UC' + channel_id[2:]
            
            # 1. Use RSS for the first page for fast, accurate dates and view counts
            if channel_id:
                sub_mock = {'id': channel_id, 'name': channel_name, 'icon': channel_icon, 'url': channel_url}
                videos = fetch_rss_videos(sub_mock)
                
            # 2. Fallback to yt-dlp flat playlist if RSS fails or has 0 items
            if not videos:
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
        with yt_dlp.YoutubeDL({'extract_flat': 'in_playlist', 'quiet': True, 'no_warnings': True, 'ignoreerrors': True, 'playlist_items': f'{start}-{end}'}) as ydl:
            info = ydl.extract_info(f"ytsearch{end}:{query}", download=False)
            videos = info.get('entries', []) if info else []
    elif req_type == 'channel' and query:
        # Seamlessly handoff to yt-dlp since RSS only supplies the first 15 videos
        per_page = 15
        start = (page - 1) * per_page + 1
        end = page * per_page
        
        with yt_dlp.YoutubeDL({'extract_flat': 'in_playlist', 'quiet': True, 'no_warnings': True, 'ignoreerrors': True, 'playlist_items': f'{start}-{end}'}) as ydl:
            info = ydl.extract_info(fix_youtube_url(query), download=False)
            if info:
                channel_name = info.get('title', 'Unknown Channel').replace(' - Videos', '')
                channel_icon = info.get('thumbnails', [{'url': ''}])[-1]['url'] if info.get('thumbnails') else ''
                for entry in info.get('entries', []):
                    if entry and entry.get('_type') != 'playlist':
                        entry['channel_name'] = channel_name
                        entry['channel_icon'] = channel_icon
                        entry['channel_url'] = query
                        videos.append(entry)
    elif req_type == 'suggested' and query:
        start = (page - 1) * 12 + 1
        end = page * 12
        with yt_dlp.YoutubeDL({'extract_flat': 'in_playlist', 'quiet': True, 'no_warnings': True, 'ignoreerrors': True, 'playlist_items': f'{start}-{end}'}) as ydl:
            info = ydl.extract_info(f"ytsearch{end}:{query}", download=False)
            videos = info.get('entries', []) if info else []
        return render_template('partials/suggested_cards.html', videos=videos)

    return render_template('partials/video_cards.html', videos=videos)

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
            
            # Construct Hierarchical Tree
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
def settings():
    subs = get_subs()
    if request.method == 'POST':
        action = request.form.get('action')
        url = request.form.get('url')
        
        if action == 'add' and url:
            if not any(s['url'] == url for s in subs):
                c_info = fetch_channel_info(url)
                subs.append({"name": c_info['name'], "url": url, "icon": c_info['icon'], "id": c_info.get('id', '')})
        elif action == 'remove' and url:
            subs = [s for s in subs if s['url'] != url]
            
        save_subs(subs)
        return redirect(request.referrer or url_for('settings'))

    return render_template('settings.html', subs=subs)

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5000)