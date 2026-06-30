import time
import json
import concurrent.futures
import threading
from urllib.parse import urlparse
from flask import Blueprint, render_template, request, redirect, url_for, session, Response

from storage import get_history, save_history, get_subs, save_subs, get_settings, save_settings, save_video_dates, get_cache_manifest
from youtube import feed_cache, fetch_channel_info, purge_channel_from_feed, update_feed_now

views_bp = Blueprint('views', __name__)

@views_bp.route('/')
def feed():
    resp = render_template('feed.html', title="New Uploads", type="feed", query="")
    session['last_feed_view'] = time.time()
    return resp

@views_bp.route('/history')
def history_page():
    history = get_history()
    history.sort(key=lambda x: x.get('last_viewed', 0), reverse=True)
    
    manifest = get_cache_manifest()
    cached_vids = {v['vid_id'] for v in manifest.values() if v.get('status') == 'complete' and 'vid_id' in v}
    
    return render_template('history.html', history=history, cached_vids=cached_vids)

@views_bp.route('/history/export')
def export_history():
    return Response(
        response=json.dumps(get_history(), indent=4),
        status=200,
        mimetype='application/json',
        headers={"Content-disposition": "attachment; filename=history.json"}
    )

@views_bp.route('/history/import', methods=['POST'])
def import_history():
    file = request.files.get('import_file')
    if file and file.filename.endswith('.json'):
        try:
            imported_hist = json.load(file)
            if isinstance(imported_hist, list):
                current_hist = get_history()
                hist_map = {item['id']: item for item in current_hist}
                
                for item in imported_hist:
                    if not isinstance(item, dict) or 'id' not in item: continue
                    vid = item['id']
                    if vid in hist_map:
                        if item.get('last_viewed', 0) > hist_map[vid].get('last_viewed', 0):
                            hist_map[vid].update(item)
                    else:
                        hist_map[vid] = item
                        
                new_hist = list(hist_map.values())
                new_hist.sort(key=lambda x: x.get('last_viewed', 0), reverse=True)
                if len(new_hist) > 500: new_hist = new_hist[:500]
                save_history(new_hist)
        except Exception as e: print(f"History import error: {e}")
    return redirect(url_for('views.history_page'))

@views_bp.route('/search')
def search():
    query = request.args.get('q')
    if not query: return redirect(url_for('views.feed'))
    return render_template('feed.html', title=f"Search: {query}", type="search", query=query)

@views_bp.route('/watch')
def watch():
    v = request.args.get('v')
    video_url = request.args.get('url')
    if v: video_url = f"https://www.youtube.com/watch?v={v}"
    if not video_url: return "Video URL required", 400

    vid_id = v
    if not vid_id:
        parsed = urlparse(video_url)
        if 'v=' in parsed.query:
            vid_id = dict(q.split('=') for q in parsed.query.split('&')).get('v')
        elif 'youtu.be' in parsed.netloc:
            vid_id = parsed.path.strip('/')

    resume_time = 0
    if vid_id:
        hist = get_history()
        existing = next((item for item in hist if item['id'] == vid_id), None)
        if existing and existing.get('watch_duration'):
            resume_time = existing['watch_duration']
            if existing.get('duration') and (existing['duration'] - resume_time < 5):
                resume_time = 0

    return render_template('watch.html', video_url=video_url, resume_time=resume_time)

@views_bp.route('/shorts/<video_id>')
def shorts_redirect(video_id):
    return redirect(f'/watch?v={video_id}')

@views_bp.route('/@<handle>')
@views_bp.route('/channel/<channel_id>')
@views_bp.route('/c/<channel_name>')
@views_bp.route('/user/<username>')
def channel_page_routed(handle=None, channel_id=None, channel_name=None, username=None):
    if handle: yt_url = f"https://www.youtube.com/@{handle}"
    elif channel_id: yt_url = f"https://www.youtube.com/channel/{channel_id}"
    elif channel_name: yt_url = f"https://www.youtube.com/c/{channel_name}"
    elif username: yt_url = f"https://www.youtube.com/user/{username}"
    else: return "Invalid channel", 400
    return render_channel(yt_url)

@views_bp.route('/channel')
def channel():
    channel_url = request.args.get('url')
    if not channel_url: return "Channel URL required", 400
    return render_channel(channel_url)

def render_channel(channel_url):
    subs = get_subs()
    n_url = channel_url.strip('/').split('?')[0].lower()
    sub = next((s for s in subs if s['url'].strip('/').split('?')[0].lower() == n_url), None)
    return render_template('channel.html', url=channel_url, channel_name=sub['name'] if sub else "Loading...", channel_icon=sub['icon'] if sub else "", is_subbed=bool(sub), needs_fetch=not bool(sub))

@views_bp.route('/settings/export')
def export_subs():
    urls = [s['url'] for s in get_subs()]
    return Response(response=json.dumps(urls, indent=4), status=200, mimetype='application/json', headers={"Content-disposition": "attachment; filename=subscriptions.json"})

@views_bp.route('/settings', methods=['GET', 'POST'])
def settings_page():
    from storage import DEFAULT_SETTINGS
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
                                from flask import current_app
                                app_instance = current_app._get_current_object()
                                with app_instance.app_context(): 
                                    update_feed_now()
                            threading.Thread(target=background_feed_update).start()
                except Exception as e: print(f"Import error: {e}")
                    
        elif action == 'reset_subs':
            save_subs([])
            feed_cache['data'] = []
            save_video_dates({}) 
            
        elif action == 'update_settings':
            try:
                app_settings['background_interval_mins'] = int(request.form.get('background_interval_mins', 30))
                app_settings['per_page'] = int(request.form.get('per_page', 15))
                app_settings['desc_preview_height'] = int(request.form.get('desc_preview_height', 100))
                save_settings(app_settings)
            except ValueError: pass

        elif action == 'update_sb_settings':
            app_settings['sb_enabled'] = request.form.get('sb_enabled') == 'on'
            app_settings['sb_action'] = request.form.get('sb_action', 'auto_skip')
            app_settings['sb_categories'] = request.form.getlist('sb_categories')
            
            from storage import DEFAULT_SETTINGS
            if 'sb_colors' not in app_settings:
                app_settings['sb_colors'] = DEFAULT_SETTINGS['sb_colors'].copy()
                
            for k in DEFAULT_SETTINGS['sb_colors'].keys():
                col = request.form.get(f'sb_color_{k}')
                if col:
                    app_settings['sb_colors'][k] = col
                    
            save_settings(app_settings)

        elif action == 'update_cache_settings':
            try:
                app_settings['cache_max_size_gb'] = float(request.form.get('cache_max_size_gb', 5))
                app_settings['cache_ttl_hours'] = float(request.form.get('cache_ttl_hours', 24))
                save_settings(app_settings)
            except ValueError: pass
                
        elif action == 'update_shortcuts':
            app_settings['shortcut_pause'] = request.form.get('shortcut_pause', 'Space')
            app_settings['shortcut_seek_fwd'] = request.form.get('shortcut_seek_fwd', 'ArrowRight')
            app_settings['shortcut_seek_bwd'] = request.form.get('shortcut_seek_bwd', 'ArrowLeft')
            app_settings['shortcut_mute'] = request.form.get('shortcut_mute', 'm')
            app_settings['shortcut_cc'] = request.form.get('shortcut_cc', 'v')
            app_settings['shortcut_chap_next'] = request.form.get('shortcut_chap_next', 'PageUp')
            app_settings['shortcut_chap_prev'] = request.form.get('shortcut_chap_prev', 'PageDown')
            app_settings['shortcut_speed_up'] = request.form.get('shortcut_speed_up', 'ArrowUp')
            app_settings['shortcut_speed_down'] = request.form.get('shortcut_speed_down', 'ArrowDown')
            save_settings(app_settings)

        elif action == 'update_cc_settings':
            try:
                app_settings['cc_font'] = request.form.get('cc_font', app_settings.get('cc_font'))
                app_settings['cc_color'] = request.form.get('cc_color', app_settings.get('cc_color'))
                app_settings['cc_bg'] = request.form.get('cc_bg', app_settings.get('cc_bg'))
                app_settings['cc_bg_op'] = float(request.form.get('cc_bg_op', app_settings.get('cc_bg_op')))
                app_settings['cc_scale'] = float(request.form.get('cc_scale', app_settings.get('cc_scale')))
                app_settings['cc_v_offset'] = float(request.form.get('cc_v_offset', app_settings.get('cc_v_offset')))
                save_settings(app_settings)
            except ValueError: pass
            
        elif action == 'add_font':
            name = request.form.get('font_name')
            val = request.form.get('font_value')
            if name and val:
                fonts = app_settings.get('cc_custom_fonts', DEFAULT_SETTINGS['cc_custom_fonts'])
                fonts.append({"name": name, "value": val})
                app_settings['cc_custom_fonts'] = fonts
                save_settings(app_settings)
                
        elif action == 'delete_font':
            idx = int(request.form.get('font_index', -1))
            fonts = app_settings.get('cc_custom_fonts', DEFAULT_SETTINGS['cc_custom_fonts'])
            if 0 <= idx < len(fonts) and len(fonts) > 1:
                fonts.pop(idx)
                app_settings['cc_custom_fonts'] = fonts
                save_settings(app_settings)
                
        elif action == 'import_fonts':
            file = request.files.get('import_file')
            if file and file.filename.endswith('.json'):
                try:
                    imported_fonts = json.load(file)
                    if isinstance(imported_fonts, list):
                        fonts = app_settings.get('cc_custom_fonts', DEFAULT_SETTINGS['cc_custom_fonts'])
                        for f in imported_fonts:
                            if isinstance(f, dict) and 'name' in f and 'value' in f:
                                fonts.append({"name": f["name"], "value": f["value"]})
                        app_settings['cc_custom_fonts'] = fonts
                        save_settings(app_settings)
                except Exception as e: print(f"Font import error: {e}")
                
        return redirect(request.referrer or url_for('views.settings_page'))
    return render_template('settings.html', subs=subs, app_settings=app_settings)
