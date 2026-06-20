import yt_dlp
import time
import re
import threading
import concurrent.futures
from urllib.parse import urlparse
from storage import get_subs, get_settings, get_video_dates, save_video_dates

feed_cache = {'data': [], 'last_update': 0}
COMMENTS_CACHE = {} 
COMMENTS_LOCK = threading.Lock()
CHANNEL_ICON_CACHE = {}
FEED_UPDATE_LOCK = threading.Lock()

def sync_video_dates(entries):
    dates_cache = get_video_dates()
    changed = False
    now = time.time()
    
    known_count = sum(1 for e in entries if e and e.get('id') in dates_cache)
    is_baseline_run = (known_count == 0)
    
    for idx, e in enumerate(entries):
        if not e: continue
        vid = e.get('id')
        if not vid: continue
        
        if vid not in dates_cache:
            is_new = False if is_baseline_run else (idx < 5)
            dates_cache[vid] = {"timestamp": now, "is_new": is_new}
            changed = True
        elif isinstance(dates_cache[vid], (int, float)):
            dates_cache[vid] = {"timestamp": dates_cache[vid], "is_new": False}
            changed = True
        elif not isinstance(dates_cache[vid], dict):
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
        return 
    try:
        subs = get_subs()
        settings = get_settings()
        fetch_limit = max(50, settings['per_page'] * 3) 
        
        def fetch_flat(sub):
            ydl_opts = {'extract_flat': 'in_playlist', 'playlistend': fetch_limit, 'quiet': True, 'no_warnings': True, 'ignoreerrors': True}
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
                                valid_entries.append(e)
                        return sub['url'], valid_entries, True 
            except Exception as e: 
                print(f"Background fetch failed for {sub['url']}: {e}")
            return sub['url'], [], False

        with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
            results = list(executor.map(fetch_flat, subs))
            
        all_entries = []
        for url, entries, success in results:
            if success and entries:
                sync_video_dates(entries)
                all_entries.extend(entries)
                
        new_vids = [e for e in all_entries if e.get('is_new')]
        new_vids.sort(key=lambda x: x.get('timestamp') or 0, reverse=True)
        
        feed_cache['data'] = new_vids
        feed_cache['last_update'] = time.time()
    finally:
        FEED_UPDATE_LOCK.release()

def bg_worker_loop(app):
    with app.app_context():
        while True:
            update_feed_now()
            settings = get_settings()
            interval_seconds = settings.get('background_interval_mins', 30) * 60
            time.sleep(interval_seconds)

def get_flat_feed(page=1):
    settings = get_settings()
    per_page = settings['per_page']
    all_videos = feed_cache.get('data', [])
    start = (page - 1) * per_page
    end = page * per_page
    return all_videos[start:end]

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