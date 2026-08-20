import yt_dlp
import time
import re
import threading
import concurrent.futures
import os
import glob
import shutil
import uuid
import zipfile
import queue
import itertools
import requests
from collections import defaultdict
from storage import (
    get_subs, save_subs, get_settings,
    get_cache_manifest, save_cache_manifest,
    get_feed_state, save_feed_state, new_feed_state
)
from config import CACHE_DIR
from utils import extract_video_id, is_probable_video_id

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
        ydl_opts['js_runtimes'] = {'deno': {}}
        
    ydl_opts['remote_components'] = ['ejs:github', 'ejs:npm']
        
    return ydl_opts

feed_cache = {'data': [], 'last_update': 0}
COMMENTS_CACHE = {} 
COMMENTS_LOCK = threading.Lock()
CHANNEL_ICON_CACHE = {}
FEED_UPDATE_LOCK = threading.Lock()
FEED_STATE_LOCK = threading.RLock()

BULK_TASKS = {}
FORMAT_TASKS = {}

MEDIA_QUEUE = queue.PriorityQueue()
PREVIEW_QUEUE = queue.Queue()
QUEUED_KEYS = set()
QUEUE_LOCK = threading.Lock()
_JOB_SEQ = itertools.count()
_WORKERS_STARTED = False

PRIORITY = {'manual': 0, 'auto': 1}
KIND_EVICTION_RANK = {'preview': 0, 'auto': 1, 'manual': 2}
CACHE_HOT_WINDOW_SECS = 300

# Upper bound on how many video IDs we remember per channel. The fetch window is
# ~50 entries, so this leaves an enormous margin before anything is forgotten.
KNOWN_ID_CAP = 1000

# Videos discovered in the same poll all share a wall-clock timestamp. Nudging
# each one by its position keeps the channel's own ordering intact in the feed.
NEW_DISCOVERY_EPSILON = 0.001


class YTDLPLogger:
    def debug(self, msg):
        if not msg.startswith('[download]'):
            print(f"[yt-dlp DEBUG] {msg}")
            
    def info(self, msg):
        pass
        
    def warning(self, msg):
        print(f"[yt-dlp WARNING] {msg}")
        
    def error(self, msg):
        print(f"[yt-dlp ERROR] {msg}")


def norm_url(url):
    if not url:
        return ''
    return url.strip('/').split('?')[0].lower()


# ----------------------------------------------------------------------
# Per-channel feed state
# ----------------------------------------------------------------------

def _feed_state():
    """Caller should hold FEED_STATE_LOCK for any read-modify-write sequence."""
    st = get_feed_state()
    if not isinstance(st.get('channels'), dict):
        st['channels'] = {}
    return st


def _channel_entry(st, n_url, create=False):
    ch = st['channels'].get(n_url)
    if ch is None and create:
        ch = {
            'baseline_at': 0.0,
            'last_fetch_at': 0.0,
            'last_seen_ts': 0.0,
            'known': {}
        }
        st['channels'][n_url] = ch
    return ch


def mark_channel_seen(url, ts=None):
    n = norm_url(url)
    if not n:
        return
    with FEED_STATE_LOCK:
        st = _feed_state()
        ch = _channel_entry(st, n, create=True)
        ch['last_seen_ts'] = ts or time.time()
        save_feed_state(st)


def get_new_channel_urls():
    with FEED_STATE_LOCK:
        channels = dict(_feed_state()['channels'])

    out = set()
    for v in feed_cache.get('data', []):
        c_url = v.get('channel_url') or v.get('uploader_url')
        if not c_url:
            continue
        n = norm_url(c_url)
        seen = (channels.get(n) or {}).get('last_seen_ts', 0) or 0
        if (v.get('timestamp') or 0) > seen:
            out.add(n)
    return out


def forget_channel_state(url):
    n = norm_url(url)
    if not n:
        return
    with FEED_STATE_LOCK:
        st = _feed_state()
        if n in st['channels']:
            del st['channels'][n]
            save_feed_state(st)


def purge_channel_from_feed(url):
    if not url: return
    n_url = norm_url(url)
    feed_cache['data'] = [
        v for v in feed_cache.get('data', [])
        if norm_url(v.get('channel_url', '')) != n_url
    ]
    forget_channel_state(url)


def reset_feed_baseline():
    with FEED_STATE_LOCK:
        save_feed_state(new_feed_state())
    feed_cache['data'] = []
    feed_cache['last_update'] = 0


def get_cached_icon(url):
    if not url: return ""
    n_url = norm_url(url)
    for s in get_subs():
        if norm_url(s['url']) == n_url:
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


def _clean_channel_entries(entries, sub):
    out = []
    seen = set()
    for e in entries or []:
        if not e:
            continue
        if e.get('_type') == 'playlist':
            continue

        vid = extract_video_id(e.get('id'), e.get('url'))
        if not is_probable_video_id(vid):
            continue
        if vid in seen:
            continue

        seen.add(vid)
        e['id'] = vid
        e['channel_name'] = sub['name']
        e['channel_icon'] = sub.get('icon', '')
        e['channel_url'] = sub['url']
        out.append(e)
    return out


def _reconcile_channel(ch, entries, now, burst_limit):
    known = ch.get('known') or {}
    ids = [e['id'] for e in entries]
    fetched = set(ids)
    unknown = [v for v in ids if v not in known]

    first_run = not ch.get('baseline_at')
    burst = (not first_run) and len(unknown) > burst_limit

    merged = dict(known)

    if first_run or burst:
        for v in ids:
            merged.setdefault(v, 0.0)
        if first_run:
            ch['baseline_at'] = now
        else:
            ch['last_rebaseline_at'] = now
            print(
                f"[feed] {len(unknown)} unseen IDs on an already-tracked channel "
                f"(limit {burst_limit}); re-baselining instead of adding them to the feed."
            )
    else:
        for idx, v in enumerate(ids):
            if v not in merged:
                merged[v] = now - (idx * NEW_DISCOVERY_EPSILON)

    if len(merged) > KNOWN_ID_CAP:
        droppable = [v for v in merged if v not in fetched]
        droppable.sort(key=lambda v: merged[v])
        for v in droppable:
            if len(merged) <= KNOWN_ID_CAP:
                break
            del merged[v]

    ch['known'] = merged
    ch['last_fetch_at'] = now
    return merged


def update_feed_now():
    if not FEED_UPDATE_LOCK.acquire(blocking=False):
        return 
    try:
        subs = get_subs()
        settings = get_settings()
        fetch_limit = max(50, settings['per_page'] * 3)

        try:
            burst_limit = max(1, int(settings.get('feed_new_burst_limit', 15) or 15))
        except (TypeError, ValueError):
            burst_limit = 15
        try:
            retention_days = float(settings.get('feed_retention_days', 14) or 14)
        except (TypeError, ValueError):
            retention_days = 14.0
        try:
            max_items = int(settings.get('feed_max_items', 300) or 300)
        except (TypeError, ValueError):
            max_items = 300

        def fetch_flat(sub):
            ydl_opts = {'extract_flat': 'in_playlist', 'playlistend': fetch_limit, 'quiet': True, 'no_warnings': True, 'ignoreerrors': True}
            inject_deno(ydl_opts)
            try:
                with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                    info = ydl.extract_info(fix_youtube_url(sub['url']), download=False)
                    if info is not None:
                        new_icon = info.get('thumbnails', [{'url': ''}])[-1]['url'] if info.get('thumbnails') else ''
                        if new_icon and sub.get('icon') != new_icon:
                            sub['icon'] = new_icon
                            sub['icon_updated'] = True

                        return sub, _clean_channel_entries(info.get('entries', []), sub), True
            except Exception as e: 
                print(f"Background fetch failed for {sub['url']}: {e}")
            return sub, [], False

        with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
            results = list(executor.map(fetch_flat, subs))
            
        subs_updated = False
        for s in subs:
            if s.pop('icon_updated', False):
                subs_updated = True
                
        if subs_updated:
            save_subs(subs)

        now = time.time()
        cutoff = now - (retention_days * 86400) if retention_days > 0 else 0

        fresh = []
        succeeded = set()

        with FEED_STATE_LOCK:
            st = _feed_state()
            for sub, entries, ok in results:
                if not ok:
                    continue

                n_url = norm_url(sub['url'])
                if not n_url:
                    continue
                succeeded.add(n_url)

                ch = _channel_entry(st, n_url, create=True)
                merged = _reconcile_channel(ch, entries, now, burst_limit)

                for e in entries:
                    ts = merged.get(e['id'], 0.0)
                    if ts > 0 and ts >= cutoff:
                        e['timestamp'] = ts
                        e['is_new'] = True
                        fresh.append(e)

            save_feed_state(st)

        carried = []
        for v in feed_cache.get('data', []):
            n = norm_url(v.get('channel_url') or v.get('uploader_url') or '')
            if not n or n in succeeded:
                continue
            if (v.get('timestamp') or 0) >= cutoff:
                carried.append(v)

        combined = {}
        for e in fresh + carried:
            vid = e.get('id')
            if vid and vid not in combined:
                combined[vid] = e

        merged_feed = list(combined.values())
        merged_feed.sort(key=lambda x: x.get('timestamp') or 0, reverse=True)
        if max_items > 0:
            merged_feed = merged_feed[:max_items]

        feed_cache['data'] = merged_feed
        feed_cache['last_update'] = time.time()
    finally:
        FEED_UPDATE_LOCK.release()


def _download_task(vid_id, resolution, metadata, size_limit_mb=None, kind='manual', audio_format_id=None):
    cache_key = f"{vid_id}_{resolution}"
    manifest = get_cache_manifest()

    is_preview = (kind == 'preview')

    existing = manifest.get(cache_key)
    if existing and existing.get('status') == 'complete':
        current_kind = existing.get('cache_kind') or ('preview' if existing.get('is_preview') else 'manual')
        if not is_preview and current_kind == 'preview':
            existing['cache_kind'] = kind
            existing['is_preview'] = False
            existing['last_accessed'] = time.time()
            save_cache_manifest(manifest)
        return 

    manifest[cache_key] = {
        'vid_id': vid_id,
        'resolution': resolution,
        'status': 'downloading',
        'ratio': 0.0,
        'last_accessed': time.time(),
        'cache_kind': kind,
        'is_preview': is_preview,
        'audio_format_id': audio_format_id,
        **metadata
    }
    save_cache_manifest(manifest)
    
    last_save = [time.time()]

    def progress_hook(d):
        current_manifest = get_cache_manifest()
        if cache_key not in current_manifest or current_manifest[cache_key].get('status') == 'cancelled':
            raise ValueError("Download cancelled by user")

        if size_limit_mb is not None:
            max_bytes = size_limit_mb * 1024 * 1024
            total = d.get('total_bytes') or d.get('total_bytes_estimate') or 0
            dl = d.get('downloaded_bytes', 0)
            if total > max_bytes or dl > max_bytes:
                raise ValueError("Size limit exceeded")

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

    if audio_format_id:
        fmt_str = (f'bestvideo[height<={resolution}][ext=mp4]+{audio_format_id}/'
                   f'bestvideo[height<={resolution}][ext=webm]+{audio_format_id}/'
                   f'bestvideo[height<={resolution}]+{audio_format_id}/'
                   f'best[height<={resolution}]/best')
    else:
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
        print(f"[DEBUG] Starting yt-dlp extraction/download for {vid_id} at <= {resolution}p ({kind})")
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(f"https://www.youtube.com/watch?v={vid_id}", download=True)
            
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
                    manifest[cache_key]['last_accessed'] = time.time()
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
        elif str(e) == "Size limit exceeded":
            print(f"[DEBUG] Download for {vid_id} aborted: Size limit exceeded.")
            manifest = get_cache_manifest()
            if cache_key in manifest:
                manifest[cache_key]['status'] = 'error_size_limit'
                save_cache_manifest(manifest)
            for f in glob.glob(os.path.join(CACHE_DIR, f"{cache_key}*")):
                try: os.remove(f)
                except: pass
        else:
            print(f"[DEBUG] Value error: {e}")
    except Exception as e:
        print(f"[DEBUG] Caching threw exception for {vid_id}: {e}")
        manifest = get_cache_manifest()
        if cache_key in manifest and manifest[cache_key].get('status') != 'cancelled':
            manifest[cache_key]['status'] = 'error'
            save_cache_manifest(manifest)


def _media_worker():
    while True:
        try:
            _prio, _seq, job = MEDIA_QUEUE.get()
        except Exception:
            continue
        try:
            _download_task(job['vid_id'], job['resolution'], job['metadata'],
                           job.get('size_limit_mb'), job.get('kind', 'manual'), job.get('audio_format_id'))
        except Exception as e:
            print(f"[Cache worker] Unhandled error: {e}")
        finally:
            with QUEUE_LOCK:
                QUEUED_KEYS.discard(job['cache_key'])
            MEDIA_QUEUE.task_done()


def _preview_worker():
    while True:
        job = PREVIEW_QUEUE.get()
        try:
            _download_task(job['vid_id'], job['resolution'], job['metadata'],
                           job.get('size_limit_mb'), 'preview', job.get('audio_format_id'))
        except Exception as e:
            print(f"[Preview worker] Unhandled error: {e}")
        finally:
            with QUEUE_LOCK:
                QUEUED_KEYS.discard(job['cache_key'])
            PREVIEW_QUEUE.task_done()


def start_cache_workers():
    global _WORKERS_STARTED
    if _WORKERS_STARTED:
        return
    _WORKERS_STARTED = True
    threading.Thread(target=_media_worker, daemon=True).start()
    threading.Thread(target=_preview_worker, daemon=True).start()


def start_caching_media(vid_id, resolution, metadata, size_limit_mb=None, kind=None, audio_format_id=None):
    if not vid_id or not resolution:
        return
    if kind is None:
        kind = 'preview' if size_limit_mb is not None else 'manual'

    cache_key = f"{vid_id}_{resolution}"

    with QUEUE_LOCK:
        if cache_key in QUEUED_KEYS:
            return
        QUEUED_KEYS.add(cache_key)

    job = {
        'cache_key': cache_key,
        'vid_id': vid_id,
        'resolution': resolution,
        'metadata': metadata or {},
        'size_limit_mb': size_limit_mb,
        'kind': kind,
        'audio_format_id': audio_format_id
    }

    start_cache_workers()

    if kind == 'preview':
        PREVIEW_QUEUE.put(job)
    else:
        MEDIA_QUEUE.put((PRIORITY.get(kind, 1), next(_JOB_SEQ), job))


def queue_auto_cache(vid_id, resolution, metadata, audio_format_id=None):
    if not vid_id or not resolution:
        return False
    cache_key = f"{vid_id}_{resolution}"
    manifest = get_cache_manifest()
    entry = manifest.get(cache_key)
    if entry and entry.get('status') in ('complete', 'downloading'):
        return False
    with QUEUE_LOCK:
        if cache_key in QUEUED_KEYS:
            return False
    start_caching_media(vid_id, resolution, metadata, kind='auto', audio_format_id=audio_format_id)
    return True


def remove_from_cache(vid_id, resolution):
    manifest = get_cache_manifest()
    cache_key = f"{vid_id}_{resolution}"
    
    if cache_key in manifest:
        manifest[cache_key]['status'] = 'cancelled'
        del manifest[cache_key]
        save_cache_manifest(manifest)
        print(f"[DEBUG] Marked cache key {cache_key} as cancelled/removed.")

    with QUEUE_LOCK:
        QUEUED_KEYS.discard(cache_key)

    for f in glob.glob(os.path.join(CACHE_DIR, f"{cache_key}*")):
        try:
            if os.path.isfile(f):
                os.remove(f)
                print(f"[DEBUG] Purged file: {f}")
        except Exception as e: 
            print(f"[DEBUG] Error removing file {f}: {e}")


def _entry_kind(entry):
    return entry.get('cache_kind') or ('preview' if entry.get('is_preview') else 'manual')


def _entry_size(entry):
    path = entry.get('file_path')
    if path and os.path.exists(path):
        try:
            return os.path.getsize(path)
        except OSError:
            return 0
    return 0


def sweep_cache():
    manifest = get_cache_manifest()
    settings = get_settings()
    ttl_seconds = settings.get('cache_ttl_hours', 24) * 3600
    max_bytes = settings.get('cache_max_size_gb', 5) * 1024 * 1024 * 1024
    auto_max_bytes = settings.get('auto_cache_max_size_gb', 3) * 1024 * 1024 * 1024

    now = time.time()
    changed = False
    to_delete = set()

    def is_hot(entry):
        return (now - entry.get('last_accessed', 0)) < CACHE_HOT_WINDOW_SECS

    for h, data in list(manifest.items()):
        if is_hot(data):
            continue
        if now - data.get('last_accessed', 0) > ttl_seconds:
            to_delete.add(h)

    disposable = [
        h for h, d in manifest.items()
        if h not in to_delete and _entry_kind(d) in ('preview', 'auto')
    ]
    disposable_size = sum(_entry_size(manifest[h]) for h in disposable)
    if disposable_size > auto_max_bytes:
        disposable.sort(key=lambda x: (
            KIND_EVICTION_RANK.get(_entry_kind(manifest[x]), 1),
            manifest[x].get('last_accessed', 0)
        ))
        for h in disposable:
            if disposable_size <= auto_max_bytes:
                break
            if is_hot(manifest[h]):
                continue
            to_delete.add(h)
            disposable_size -= _entry_size(manifest[h])

    total_size = sum(_entry_size(d) for h, d in manifest.items() if h not in to_delete)
    if total_size > max_bytes:
        remaining = [h for h in manifest.keys() if h not in to_delete]
        remaining.sort(key=lambda x: (
            KIND_EVICTION_RANK.get(_entry_kind(manifest[x]), 2),
            manifest[x].get('last_accessed', 0)
        ))
        for h in remaining:
            if total_size <= max_bytes:
                break
            if is_hot(manifest[h]):
                continue
            to_delete.add(h)
            total_size -= _entry_size(manifest[h])

    for h in to_delete:
        if h in manifest:
            del manifest[h]
            changed = True
        for f in glob.glob(os.path.join(CACHE_DIR, f"{h}*")):
            try: os.remove(f)
            except: pass

    if changed:
        save_cache_manifest(manifest)

    for tid in list(FORMAT_TASKS.keys()):
        if now - FORMAT_TASKS[tid].get('last_accessed', now) > 7200:
            del FORMAT_TASKS[tid]
            
    for tid in list(BULK_TASKS.keys()):
        if now - BULK_TASKS[tid].get('last_accessed', now) > 7200:
            clear_bulk_task(tid)

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
                if icon: CHANNEL_ICON_CACHE[norm_url(curl)] = icon
    for v in videos:
        c_url = v.get('channel_url') or v.get('uploader_url')
        if c_url:
            icon = get_cached_icon(c_url)
            if icon: v['channel_icon'] = icon

def _extract_formats_for_video(vid):
    ydl_opts = {
        'quiet': True, 'no_warnings': True, 'ignoreerrors': True,
        'writesubtitles': True, 'allsubtitles': True
    }
    inject_deno(ydl_opts)
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(f"https://www.youtube.com/watch?v={vid}", download=False)
            if not info: return None
            
            res_heights = set()
            for f in info.get('formats', []):
                h = f.get('height')
                if h and f.get('vcodec') != 'none':
                    res_heights.add(h)
                    
            has_subs = False
            if info.get('subtitles') or info.get('automatic_captions'):
                has_subs = True
                
            return {
                'id': vid,
                'heights': res_heights,
                'has_subs': has_subs
            }
    except:
        return None

def start_format_task(video_ids):
    task_id = str(uuid.uuid4())
    FORMAT_TASKS[task_id] = {
        'status': 'processing',
        'current': 0,
        'total': len(video_ids),
        'result': None,
        'cancelled': False,
        'last_accessed': time.time()
    }
    threading.Thread(target=_format_worker, args=(task_id, video_ids), daemon=True).start()
    return task_id

def cancel_format_task(task_id):
    if task_id in FORMAT_TASKS:
        FORMAT_TASKS[task_id]['cancelled'] = True
        FORMAT_TASKS[task_id]['last_accessed'] = time.time()

def _format_worker(task_id, video_ids):
    results = []
    
    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
        futures = {executor.submit(_extract_formats_for_video, vid): vid for vid in video_ids}
        for i, future in enumerate(concurrent.futures.as_completed(futures)):
            if FORMAT_TASKS[task_id].get('cancelled'):
                break
            r = future.result()
            if r: results.append(r)
            FORMAT_TASKS[task_id]['current'] = i + 1
            
    if FORMAT_TASKS[task_id].get('cancelled'):
        FORMAT_TASKS[task_id]['status'] = 'cancelled'
        return
            
    height_counts = defaultdict(int)
    subs_count = 0
    total = len(video_ids)
    
    for r in results:
        for h in r['heights']:
            height_counts[h] += 1
        if r['has_subs']:
            subs_count += 1
            
    video_formats = []
    for h in sorted(height_counts.keys(), reverse=True):
        if h in [2160, 1440, 1080, 720, 480]:
            video_formats.append({
                'label': f"{h}p MP4",
                'val': str(h),
                'count': height_counts[h]
            })
            
    audio_formats = [
        {'label': 'MP3 (Highest)', 'val': 'mp3', 'count': total},
        {'label': 'M4A (Highest)', 'val': 'm4a', 'count': total}
    ]
    
    sub_formats = []
    if subs_count > 0:
        sub_formats = [
            {'label': 'TXT (Continuous Text)', 'val': 'txt', 'count': subs_count},
            {'label': 'VTT (Original)', 'val': 'vtt', 'count': subs_count}
        ]
        
    FORMAT_TASKS[task_id]['result'] = {
        'total': total,
        'video': video_formats,
        'audio': audio_formats,
        'subtitles': sub_formats
    }
    FORMAT_TASKS[task_id]['status'] = 'complete'

def start_bulk_task(video_ids, dl_type, dl_format):
    task_id = str(uuid.uuid4())
    BULK_TASKS[task_id] = {
        'status': 'processing',
        'dl_type': dl_type,
        'total': len(video_ids),
        'current': 0,
        'fractional_progress': 0.0,
        'errors': [],
        'warnings': [],
        'zip_file': None,
        'cancelled': False,
        'last_accessed': time.time()
    }
    threading.Thread(target=_bulk_worker, args=(task_id, video_ids, dl_type, dl_format), daemon=True).start()
    return task_id

def cancel_bulk_task(task_id):
    if task_id in BULK_TASKS:
        BULK_TASKS[task_id]['cancelled'] = True
        BULK_TASKS[task_id]['last_accessed'] = time.time()

def clear_bulk_task(task_id):
    task = BULK_TASKS.get(task_id)
    if task:
        zip_file = task.get('zip_file')
        if zip_file and os.path.exists(zip_file):
            try: os.remove(zip_file)
            except: pass
            
        temp_dir = os.path.join(CACHE_DIR, f"bulk_{task_id}")
        if os.path.exists(temp_dir):
            try: shutil.rmtree(temp_dir)
            except: pass
            
        del BULK_TASKS[task_id]

def get_best_subtitle_url(info):
    subs = info.get('subtitles', {})
    autos = info.get('automatic_captions', {})
    
    def extract_vtt_url(fmts):
        if not fmts: return None
        vtt = next((f for f in fmts if f.get('ext') == 'vtt'), None)
        if not vtt: vtt = fmts[-1]
        url = vtt.get('url')
        if url and 'youtube.com/api/timedtext' in url and 'fmt=vtt' not in url:
            url += '&fmt=vtt'
        return url

    for lang, fmts in subs.items():
        if lang.startswith('en'):
            u = extract_vtt_url(fmts)
            if u: return u
            
    for lang, fmts in subs.items():
        if 'live_chat' not in lang:
            u = extract_vtt_url(fmts)
            if u: return u
            
    for lang, fmts in autos.items():
        if lang.startswith('en') and '-orig' not in lang:
            u = extract_vtt_url(fmts)
            if u: return u
            
    for lang, fmts in autos.items():
        u = extract_vtt_url(fmts)
        if u: return u
        
    return None

def process_subtitle_text(raw_text, out_format):
    if out_format == 'vtt':
        return raw_text
        
    processed = []
    for line in raw_text.split('\n'):
        line = line.strip()
        if not line: continue
        if line.startswith('WEBVTT') or line.startswith('Kind:') or line.startswith('Language:'): continue
        if '-->' in line: continue
        line = re.sub(r'<[^>]+>', '', line)
        line = line.replace('&gt;', '>').replace('&lt;', '<').replace('&amp;', '&').replace('&nbsp;', ' ')
        line = re.sub(r'^>>\s*', '', line).strip()
        if line and not re.match(r'^\d+$', line):
            processed.append(line)
            
    final_lines = []
    for line in processed:
        if not final_lines:
            final_lines.append(line)
            continue
        last = final_lines[-1]
        if line == last: continue
        if line.startswith(last):
            final_lines[-1] = line
            continue
        if last.startswith(line):
            continue
        final_lines.append(line)
        
    return ' '.join(final_lines)

def _bulk_worker(task_id, video_ids, dl_type, dl_format):
    temp_dir = os.path.join(CACHE_DIR, f"bulk_{task_id}")
    os.makedirs(temp_dir, exist_ok=True)
    ffmpeg_path = shutil.which('ffmpeg')
    
    def progress_hook(d):
        if BULK_TASKS[task_id].get('cancelled'):
            raise ValueError("Download cancelled by user")
        if d['status'] == 'downloading':
            total = d.get('total_bytes') or d.get('total_bytes_estimate') or 1
            dl = d.get('downloaded_bytes', 0)
            BULK_TASKS[task_id]['fractional_progress'] = min(dl / total, 1.0)
    
    for i, vid in enumerate(video_ids):
        if BULK_TASKS[task_id].get('cancelled'):
            break
            
        BULK_TASKS[task_id]['current'] = i + 1
        BULK_TASKS[task_id]['fractional_progress'] = 0.0
        
        ydl_opts = {
            'outtmpl': os.path.join(temp_dir, '%(title)s [%(id)s].%(ext)s'),
            'quiet': True,
            'no_warnings': True,
            'ignoreerrors': True,
            'progress_hooks': [progress_hook],
            'logger': YTDLPLogger()
        }
        if ffmpeg_path:
            ydl_opts['ffmpeg_location'] = ffmpeg_path
        inject_deno(ydl_opts)
        
        title = vid
        if dl_type == 'subtitles':
            ydl_opts['skip_download'] = True
            ydl_opts['writesubtitles'] = False
            
            try:
                with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                    info = ydl.extract_info(f"https://www.youtube.com/watch?v={vid}", download=False)
                    if not info: raise Exception("No video metadata could be extracted")
                    
                    title = info.get('title', vid)
                    sub_url = get_best_subtitle_url(info)
                    if not sub_url:
                        raise Exception("No subtitles available for this video")
                        
                    BULK_TASKS[task_id]['fractional_progress'] = 0.5
                    
                    r = requests.get(sub_url, timeout=15)
                    r.raise_for_status()
                    
                    safe_title = "".join([c for c in title if c.isalpha() or c.isdigit() or c == ' ']).rstrip().replace(' ', '_')
                    filename = f"{safe_title}_[{vid}].{dl_format}"
                    
                    final_text = process_subtitle_text(r.text, dl_format)
                    
                    with open(os.path.join(temp_dir, filename), 'w', encoding='utf-8') as f:
                        f.write(final_text)
                        
                    BULK_TASKS[task_id]['fractional_progress'] = 1.0
                    
            except Exception as e:
                err_str = str(e).split('\n')[0].replace('ERROR: ', '').strip()
                print(f"[Bulk Download] Error fetching subtitles for {vid}: {err_str}")
                BULK_TASKS[task_id]['errors'].append({'id': vid, 'title': title, 'reason': err_str})
                
        else:
            if dl_type == 'video':
                res = dl_format
                ydl_opts['format'] = f'bestvideo[ext=mp4][height<={res}]+bestaudio[ext=m4a]/bestvideo[height<={res}]+bestaudio/best[height<={res}]/best'
                ydl_opts['merge_output_format'] = 'mp4/webm'
            elif dl_type == 'audio':
                ydl_opts['format'] = 'bestaudio/best'
                ydl_opts['postprocessors'] = [{
                    'key': 'FFmpegExtractAudio',
                    'preferredcodec': dl_format,
                }]
                
            try:
                with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                    info = ydl.extract_info(f"https://www.youtube.com/watch?v={vid}", download=True)
                    if info:
                        title = info.get('title', vid)
                        if dl_type == 'video':
                            requested_res = int(dl_format)
                            actual_res = info.get('height')
                            if not actual_res and 'requested_downloads' in info and info['requested_downloads']:
                                actual_res = info['requested_downloads'][0].get('height')
                            
                            if actual_res and actual_res < requested_res:
                                BULK_TASKS[task_id]['warnings'].append({
                                    'id': vid,
                                    'title': title,
                                    'reason': f"Fell back to {actual_res}p (Requested {requested_res}p)"
                                })
            except ValueError as e:
                if str(e) == "Download cancelled by user":
                    print(f"[Bulk Download] Aborting video {vid} due to cancellation.")
                    break
            except Exception as e:
                err_str = str(e).split('\n')[0].replace('ERROR: ', '').strip()
                print(f"[Bulk Download] Error downloading {vid}: {err_str}")
                BULK_TASKS[task_id]['errors'].append({'id': vid, 'title': title, 'reason': err_str})
            
    if BULK_TASKS[task_id].get('cancelled'):
        try: shutil.rmtree(temp_dir)
        except: pass
        BULK_TASKS[task_id]['status'] = 'cancelled'
        return

    zip_base = os.path.join(CACHE_DIR, f"bulk_{task_id}.zip")
    try:
        with zipfile.ZipFile(zip_base, 'w', zipfile.ZIP_DEFLATED) as zipf:
            for root, _, files in os.walk(temp_dir):
                for file in files:
                    if BULK_TASKS[task_id].get('cancelled'):
                        raise ValueError("Cancelled during zip")
                    file_path = os.path.join(root, file)
                    arcname = os.path.relpath(file_path, temp_dir)
                    zipf.write(file_path, arcname)
                    
        shutil.rmtree(temp_dir)
        BULK_TASKS[task_id]['zip_file'] = zip_base
        BULK_TASKS[task_id]['status'] = 'complete'
    except ValueError:
        try: 
            shutil.rmtree(temp_dir)
            if os.path.exists(zip_base): os.remove(zip_base)
        except: pass
        BULK_TASKS[task_id]['status'] = 'cancelled'
    except Exception as e:
        print(f"Zipping failed: {e}")
        BULK_TASKS[task_id]['status'] = 'error'
