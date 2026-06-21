import yt_dlp
import time
import re
import threading
import concurrent.futures
import os
import glob
import shutil
from storage import get_subs, get_settings, get_video_dates, save_video_dates, get_cache_manifest, save_cache_manifest
from config import CACHE_DIR

def inject_deno(ydl_opts):
    """
    Dynamically finds Deno (checking PATH and ~/.deno/bin/deno) and explicitly configures 
    yt-dlp to use it. Also grants permission to download required JS solver scripts.
    """
    deno_path = shutil.which('deno')
    if not deno_path:
        home = os.path.expanduser("~")
        possible_path = os.path.join(home, ".deno", "bin", "deno")
        if os.path.exists(possible_path):
            deno_path = possible_path
    
    if deno_path:
        ydl_opts['js_runtimes'] = {'deno': {'path': deno_path}}
    else:
        # Fallback to standard handling if absolutely no binary is found locally
        ydl_opts['js_runtimes'] = {'deno': {}}
        
    # Explicitly allow yt-dlp to fetch the cipher-solving EJS scripts from GitHub/NPM
    ydl_opts['remote_components'] = ['ejs:github', 'ejs:npm']
        
    return ydl_opts

feed_cache = {'data': [], 'last_update': 0}
COMMENTS_CACHE = {} 
COMMENTS_LOCK = threading.Lock()
CHANNEL_ICON_CACHE = {}
FEED_UPDATE_LOCK = threading.Lock()

class YTDLPLogger:
    """Custom logger to capture exactly what yt-dlp is doing for debugging."""
    def debug(self, msg):
        if not msg.startswith('[download]'):
            print(f"[yt-dlp DEBUG] {msg}")
            
    def info(self, msg):
        pass
        
    def warning(self, msg):
        print(f"[yt-dlp WARNING] {msg}")
        
    def error(self, msg):
        print(f"[yt-dlp ERROR] {msg}")

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
    inject_deno(ydl_opts)
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
            inject_deno(ydl_opts)
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

def _download_task(vid_id, resolution, metadata):
    cache_key = f"{vid_id}_{resolution}"
    manifest = get_cache_manifest()
    
    if cache_key in manifest and manifest[cache_key].get('status') == 'complete':
        return 

    manifest[cache_key] = {
        'vid_id': vid_id,
        'resolution': resolution,
        'status': 'downloading',
        'ratio': 0.0,
        'last_accessed': time.time(),
        **metadata
    }
    save_cache_manifest(manifest)
    
    last_save = [time.time()]

    def progress_hook(d):
        # Abort if the user manually cancelled the download
        current_manifest = get_cache_manifest()
        if cache_key not in current_manifest or current_manifest[cache_key].get('status') == 'cancelled':
            raise ValueError("Download cancelled by user")

        if d['status'] == 'downloading':
            total = d.get('total_bytes') or d.get('total_bytes_estimate') or 1
            dl = d.get('downloaded_bytes', 0)
            
            current_ratio = manifest[cache_key].get('ratio', 0)
            calc_ratio = (dl / total) * 0.95
            
            if calc_ratio < current_ratio and calc_ratio < 0.1:
                calc_ratio = 0.8 + ((dl / total) * 0.15)
            elif calc_ratio < current_ratio:
                calc_ratio = current_ratio

            manifest[cache_key]['ratio'] = calc_ratio
            if time.time() - last_save[0] > 1.0:
                save_cache_manifest(manifest)
                last_save[0] = time.time()

    # Enforce strict container pairings so FFmpeg doesn't convert to mkv
    fmt_str = (f'bestvideo[height<={resolution}][ext=mp4]+bestaudio[ext=m4a]/'
               f'bestvideo[height<={resolution}][ext=webm]+bestaudio[ext=webm]/'
               f'bestvideo[height<={resolution}]+bestaudio/'
               f'best[height<={resolution}]/best')

    ydl_opts = {
        'format': fmt_str,
        'merge_output_format': 'mp4/webm',
        'outtmpl': os.path.join(CACHE_DIR, f"{cache_key}.%(ext)s"),
        'progress_hooks': [progress_hook],
        'logger': YTDLPLogger(),
        'quiet': False, 
        'noprogress': True,
        'ignoreerrors': True
    }
    
    inject_deno(ydl_opts)
    
    ffmpeg_path = shutil.which('ffmpeg')
    if ffmpeg_path:
        ydl_opts['ffmpeg_location'] = ffmpeg_path

    try:
        print(f"[DEBUG] Starting yt-dlp extraction/download for {vid_id} at <= {resolution}p")
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            # download=True blocks until merging is completely finished
            info = ydl.extract_info(f"https://www.youtube.com/watch?v={vid_id}", download=True)
            
            # Prevent updating a cancelled download back to complete
            latest_manifest = get_cache_manifest()
            if cache_key not in latest_manifest or latest_manifest[cache_key].get('status') == 'cancelled':
                return

            if info:
                filepath = None
                
                if 'requested_downloads' in info and len(info['requested_downloads']) > 0:
                    filepath = info['requested_downloads'][0].get('filepath')
                
                if not filepath:
                    filepath = ydl.prepare_filename(info)
                    
                if filepath and not os.path.exists(filepath):
                    base, _ = os.path.splitext(filepath)
                    for ext in ['.mp4', '.webm', '.mkv']:
                        if os.path.exists(base + ext):
                            filepath = base + ext
                            break
                            
                if filepath and os.path.exists(filepath):
                    manifest[cache_key]['file_path'] = filepath
                    manifest[cache_key]['status'] = 'complete'
                    manifest[cache_key]['ratio'] = 1.0
                    print(f"[DEBUG] Caching complete. Final file located at: {filepath}")
                else:
                    print(f"[DEBUG] Download finished, but couldn't locate file at: {filepath}")
                    manifest[cache_key]['status'] = 'error'
            else:
                print(f"[DEBUG] extract_info returned None for {vid_id}. Likely a fatal error.")
                manifest[cache_key]['status'] = 'error'

            save_cache_manifest(manifest)

    except ValueError as e:
        if str(e) == "Download cancelled by user":
            print(f"[DEBUG] Download for {vid_id} gracefully aborted.")
        else:
            print(f"[DEBUG] Value error: {e}")
    except Exception as e:
        print(f"[DEBUG] Caching threw exception for {vid_id}: {e}")
        manifest = get_cache_manifest()
        if cache_key in manifest and manifest[cache_key].get('status') != 'cancelled':
            manifest[cache_key]['status'] = 'error'
            save_cache_manifest(manifest)

def start_caching_media(vid_id, resolution, metadata):
    threading.Thread(target=_download_task, args=(vid_id, resolution, metadata), daemon=True).start()

def remove_from_cache(vid_id, resolution):
    """
    Cancels any active downloads for this target and safely purges all downloaded files.
    """
    manifest = get_cache_manifest()
    cache_key = f"{vid_id}_{resolution}"
    
    if cache_key in manifest:
        manifest[cache_key]['status'] = 'cancelled'
        del manifest[cache_key]
        save_cache_manifest(manifest)
        print(f"[DEBUG] Marked cache key {cache_key} as cancelled/removed.")
        
    for f in glob.glob(os.path.join(CACHE_DIR, f"{cache_key}*")):
        try:
            if os.path.isfile(f):
                os.remove(f)
                print(f"[DEBUG] Purged file: {f}")
        except Exception as e: 
            print(f"[DEBUG] Error removing file {f}: {e}")

def sweep_cache():
    manifest = get_cache_manifest()
    settings = get_settings()
    ttl_seconds = settings.get('cache_ttl_hours', 1) * 3600
    max_bytes = settings.get('cache_max_size_gb', 5) * 1024 * 1024 * 1024
    
    now = time.time()
    changed = False
    to_delete = []
    
    for h, data in list(manifest.items()):
        if now - data.get('last_accessed', 0) > ttl_seconds:
            to_delete.append(h)
            
    # Compute size directly from disk files, ignoring deleted keys
    total_size = 0
    for h, data in manifest.items():
        if h not in to_delete:
            path = data.get('file_path')
            if path and os.path.exists(path):
                total_size += os.path.getsize(path)
                
    if total_size > max_bytes:
        remaining = [h for h in manifest.keys() if h not in to_delete]
        remaining.sort(key=lambda x: manifest[x].get('last_accessed', 0))
        for h in remaining:
            if total_size <= max_bytes: break
            to_delete.append(h)
            path = manifest[h].get('file_path')
            if path and os.path.exists(path):
                total_size -= os.path.getsize(path)
            
    for h in to_delete:
        del manifest[h]
        changed = True
        
        # Glob delete main file + any orphaned ffmpeg .part or .f* segments
        for f in glob.glob(os.path.join(CACHE_DIR, f"{h}*")):
            try: os.remove(f)
            except: pass
                
    if changed:
        save_cache_manifest(manifest)

def bg_worker_loop(app):
    with app.app_context():
        while True:
            update_feed_now()
            sweep_cache()
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