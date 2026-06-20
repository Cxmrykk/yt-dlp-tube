import time
import yt_dlp
import os
import urllib.parse
from flask import Blueprint, request, jsonify, render_template

from storage import get_history, save_history, get_subs, save_subs, get_settings, get_cache_manifest, save_cache_manifest
from youtube import (
    get_cached_icon, fetch_channel_info, purge_channel_from_feed, 
    get_flat_feed, fix_youtube_url, fetch_missing_icons, 
    parse_chapters_from_desc, start_caching_media, inject_deno,
    COMMENTS_CACHE, COMMENTS_LOCK
)
from utils import format_views_str, time_ago_str

api_bp = Blueprint('api', __name__)

@api_bp.route('/api/history/update', methods=['POST'])
def update_history():
    data = request.get_json()
    if not data or 'id' not in data:
        return jsonify({"error": "Invalid data"}), 400
        
    vid_id = data['id']
    hist = get_history()
    
    existing = next((item for item in hist if item['id'] == vid_id), None)
    now = time.time()
    
    if existing:
        new_duration = existing.get('watch_duration', 0) + data.get('watch_time_increment', 0)
        total_dur = data.get('duration') or existing.get('duration') or 0
        if total_dur and new_duration > total_dur:
            new_duration = total_dur
            
        existing['watch_duration'] = new_duration
        existing['last_viewed'] = now
        existing['title'] = data.get('title', existing.get('title'))
        existing['uploader'] = data.get('uploader', existing.get('uploader'))
        existing['uploader_url'] = data.get('uploader_url', existing.get('uploader_url'))
        existing['thumbnail'] = data.get('thumbnail', existing.get('thumbnail'))
        existing['channel_icon'] = data.get('channel_icon', existing.get('channel_icon'))
        existing['duration'] = total_dur
        
        hist.remove(existing)
        hist.insert(0, existing)
    else:
        item = {
            'id': vid_id,
            'title': data.get('title'),
            'uploader': data.get('uploader'),
            'uploader_url': data.get('uploader_url'),
            'thumbnail': data.get('thumbnail'),
            'channel_icon': data.get('channel_icon'),
            'duration': data.get('duration', 0),
            'watch_duration': data.get('watch_time_increment', 0),
            'last_viewed': now
        }
        hist.insert(0, item)
        
    if len(hist) > 500:
        hist = hist[:500]
        
    save_history(hist)
    return jsonify({"status": "ok"})

@api_bp.route('/api/history/clear', methods=['POST'])
def clear_history():
    save_history([])
    from flask import redirect, url_for
    return redirect(url_for('views.history_page'))

@api_bp.route('/api/info')
def api_info():
    video_url = request.args.get('url')
    if not video_url: return jsonify({"error": "Video URL required"}), 400
    
    ydl_opts = {
        'quiet': True, 'no_warnings': True, 'ignoreerrors': True, 
        'getcomments': False, 'writesubtitles': True, 'allsubtitles': True
    }
    inject_deno(ydl_opts)
    
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
    resolutions_list = [{'height': r.get('height'), 'url': r.get('url'), 'fps': r.get('fps'), 'has_audio': r.get('acodec') != 'none', 'is_cached': False} for r in resolutions]

    # --- Inject Local Cache Overrides ---
    manifest = get_cache_manifest()
    manifest_updated = False
    vid_id = info.get('id')
    
    for r in resolutions_list:
        cache_key = f"{vid_id}_{r['height']}"
        entry = manifest.get(cache_key)
        if entry and entry.get('status') == 'complete':
            if os.path.exists(entry.get('file_path', '')):
                r['url'] = f"/proxy/local?key={cache_key}"
                r['has_audio'] = True  # Native dual-audio bypass
                r['is_cached'] = True  # Signal for auto-selection in frontend
                entry['last_accessed'] = time.time()
                manifest_updated = True
                
    if manifest_updated:
        save_cache_manifest(manifest)

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
                subtitles_list.append({'label': label, 'lang': lang, 'url': vtt_data['url'], 'is_auto': False, 'is_source': False})

    auto_subs = info.get('automatic_captions')
    if isinstance(auto_subs, dict):
        source_lang = None
        for lang in auto_subs.keys():
            if '-orig' in lang:
                source_lang = lang
                break
        for lang, sub_formats in auto_subs.items():
            if not any(s['lang'] == lang and not s['is_auto'] for s in subtitles_list):
                vtt_data = extract_vtt_url(sub_formats)
                if vtt_data:
                    label = vtt_data['name'] or lang
                    if lang == source_lang: label = label.replace('-orig', '').strip()
                    subtitles_list.append({'label': label, 'lang': lang, 'url': vtt_data['url'], 'is_auto': True, 'is_source': (lang == source_lang)})
                    
    subtitles_list.sort(key=lambda x: (x['is_auto'], x['label']))

    return jsonify({
        "id": vid_id, "title": info.get('title', 'Untitled'),
        "uploader": info.get('uploader') or info.get('channel') or 'Unknown', "uploader_url": uploader_url,
        "subscriber_count": format_views_str(info.get('channel_follower_count')), "view_count": format_views_str(info.get('view_count')),
        "time_ago": time_ago_str(info.get('timestamp') or info.get('upload_date')), "description": info.get('description', ''),
        "channel_icon": channel_icon, "is_subbed": is_subbed, "resolutions": resolutions_list,
        "best_audio": best_audio.get('url') if best_audio else None, "chapters": chapters,
        "subtitles": subtitles_list, "search_query": broad_query,
        "duration": info.get('duration', 0)
    })

@api_bp.route('/api/toggle_sub', methods=['POST'])
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
        subs.append({"name": name, "url": url, "icon": icon, "id": ""})
        save_subs(subs)
        return jsonify({"status": "added", "is_subbed": True})

@api_bp.route('/api/channel_info')
def api_channel_info():
    url = request.args.get('url')
    c_info = fetch_channel_info(url)
    n_url = url.strip('/').split('?')[0].lower()
    is_subbed = any(s['url'].strip('/').split('?')[0].lower() == n_url for s in get_subs())
    return jsonify({
        "name": c_info.get('name', 'Unknown Channel'), "icon": c_info.get('icon', ''),
        "is_subbed": is_subbed, "subscriber_count": format_views_str(c_info.get('subscriber_count'))
    })

@api_bp.route('/api/videos')
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
        inject_deno(ydl_opts)
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
        return render_template('partials/video_cards.html', videos=videos, show_date=False, show_channel=False)
    elif req_type == 'search' and query:
        start = (page - 1) * per_page + 1
        end = page * per_page
        ydl_opts = {'extract_flat': 'in_playlist', 'quiet': True, 'no_warnings': True, 'ignoreerrors': True, 'playlist_items': f'{start}-{end}'}
        inject_deno(ydl_opts)
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(f"ytsearch{end}:{query}", download=False)
            if info: videos = info.get('entries', [])
        fetch_missing_icons(videos)
        return render_template('partials/video_cards.html', videos=videos, show_date=True, show_channel=True)
    elif req_type == 'suggested' and query:
        current_id = request.args.get('current_id', '')
        start = (page - 1) * per_page + 1
        end = page * per_page
        fetch_end = end + 2
        ydl_opts = {'extract_flat': 'in_playlist', 'quiet': True, 'no_warnings': True, 'ignoreerrors': True, 'playlist_items': f'{start}-{fetch_end}'}
        inject_deno(ydl_opts)
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(f"ytsearch{fetch_end}:{query}", download=False)
            videos = info.get('entries', []) if info else []
            
        if current_id: videos = [v for v in videos if v.get('id') != current_id]
        videos = videos[:per_page]
        fetch_missing_icons(videos)
        return render_template('partials/suggested_cards.html', videos=videos)
    return render_template('partials/video_cards.html', videos=[])

@api_bp.route('/api/comments')
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
            inject_deno(ydl_opts)
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

@api_bp.route('/api/save_cc_settings', methods=['POST'])
def save_cc_settings():
    data = request.get_json()
    app_settings = get_settings()
    for k in ['cc_font', 'cc_color', 'cc_bg', 'cc_bg_op', 'cc_scale', 'cc_v_offset']:
        if k in data:
            app_settings[k] = data[k]
    save_settings(app_settings)
    return jsonify({"status": "success"})

@api_bp.route('/api/cache/start', methods=['POST'])
def api_cache_start():
    data = request.get_json()
    vid_id = data.get('vid_id')
    res = data.get('resolution')
    metadata = data.get('metadata', {})
    
    # Verify the incoming resolution request from JS
    print(f"[DEBUG - API] Cache request received. Video ID: {vid_id}, Resolution: {res}p")
    
    if vid_id and res:
        start_caching_media(vid_id, res, metadata)
    return jsonify({"status": "started"})

@api_bp.route('/api/cache/status')
def api_cache_status():
    vid_id = request.args.get('vid_id')
    res = request.args.get('resolution')
    
    cache_key = f"{vid_id}_{res}"
    manifest = get_cache_manifest()
    entry = manifest.get(cache_key)
    
    if not entry:
        return jsonify({"ratio": 0.0, "status": "none"})
        
    return jsonify({"ratio": entry.get('ratio', 0.0), "status": entry.get('status', 'downloading')})