import json
import os
import threading
import secrets
from config import DATA_DIR

SUBS_FILE = os.path.join(DATA_DIR, 'subscriptions.json')
SETTINGS_FILE = os.path.join(DATA_DIR, 'settings.json')
VIDEO_DATES_FILE = os.path.join(DATA_DIR, 'video_dates.json')
HISTORY_FILE = os.path.join(DATA_DIR, 'history.json')
CACHE_MANIFEST_FILE = os.path.join(DATA_DIR, 'cache_manifest.json')

FILE_LOCK = threading.Lock()
_CACHE_MANIFEST = None

DEFAULT_SETTINGS = {
    'background_interval_mins': 30,
    'per_page': 15,
    'desc_preview_height': 100,
    'overlay_timeout_ms': 500,
    'cache_ttl_hours': 24,
    'cache_max_size_gb': 5,
    'shortcut_pause': 'Space',
    'shortcut_seek_fwd': 'ArrowRight',
    'shortcut_seek_bwd': 'ArrowLeft',
    'shortcut_mute': 'm',
    'shortcut_cc': 'v',
    'shortcut_chap_next': 'PageUp',
    'shortcut_chap_prev': 'PageDown',
    'shortcut_speed_up': 'ArrowUp',
    'shortcut_speed_down': 'ArrowDown',
    'cc_font': "'Segoe UI', Tahoma, Geneva, Verdana, sans-serif",
    'cc_color': '#ffffff',
    'cc_bg': '#000000',
    'cc_bg_op': 0.6,
    'cc_scale': 1.4,
    'cc_v_offset': 10,
    'cc_custom_fonts': [
        {"name": "Sans-Serif", "value": "'Segoe UI', Tahoma, Geneva, Verdana, sans-serif"},
        {"name": "Serif", "value": "Georgia, 'Times New Roman', Times, serif"},
        {"name": "Monospace", "value": "'Courier New', Courier, monospace"},
        {"name": "Impact", "value": "Impact, Charcoal, sans-serif"},
        {"name": "Comic Sans", "value": "'Comic Sans MS', cursive, sans-serif"}
    ],
    'sb_enabled': True,
    'sb_action': 'auto_skip',
    'sb_categories': ['sponsor', 'intro', 'outro', 'interaction', 'selfpromo', 'music_offtopic'],
    'sb_colors': {
        'sponsor': '#00d400',
        'intro': '#00ffff',
        'outro': '#0202ed',
        'interaction': '#cc00ff',
        'selfpromo': '#ffff00',
        'music_offtopic': '#ff9900',
        'preview': '#008fd6',
        'poi_highlight': '#ff1684',
        'filler': '#7300FF',
        'exclusive_access': '#008a5c'
    }
}

def get_settings():
    with FILE_LOCK:
        data = DEFAULT_SETTINGS.copy()
        if os.path.exists(SETTINGS_FILE):
            try:
                with open(SETTINGS_FILE, 'r') as f:
                    file_data = json.load(f)
                    for k, v in file_data.items():
                        data[k] = v
            except: pass
            
        needs_save = False
        if 'sb_userid' not in data:
            data['sb_userid'] = secrets.token_hex(16)
            needs_save = True
            
        if 'sb_colors' not in data or not isinstance(data['sb_colors'], dict):
            data['sb_colors'] = DEFAULT_SETTINGS['sb_colors'].copy()
            needs_save = True
            
        if needs_save:
            tmp_file = SETTINGS_FILE + '.tmp'
            with open(tmp_file, 'w') as f: json.dump(data, f)
            os.replace(tmp_file, SETTINGS_FILE)
            
        return data

def save_settings(settings):
    with FILE_LOCK:
        tmp_file = SETTINGS_FILE + '.tmp'
        with open(tmp_file, 'w') as f: json.dump(settings, f)
        os.replace(tmp_file, SETTINGS_FILE)

def get_subs():
    with FILE_LOCK:
        if os.path.exists(SUBS_FILE):
            try:
                with open(SUBS_FILE, 'r') as f: return json.load(f)
            except: pass
        return []

def save_subs(subs):
    with FILE_LOCK:
        tmp_file = SUBS_FILE + '.tmp'
        with open(tmp_file, 'w') as f: json.dump(subs, f)
        os.replace(tmp_file, SUBS_FILE)

def get_video_dates():
    with FILE_LOCK:
        if os.path.exists(VIDEO_DATES_FILE):
            try:
                with open(VIDEO_DATES_FILE, 'r') as f: return json.load(f)
            except: pass
        return {}

def save_video_dates(dates):
    with FILE_LOCK:
        tmp_file = VIDEO_DATES_FILE + '.tmp'
        with open(tmp_file, 'w') as f: json.dump(dates, f)
        os.replace(tmp_file, VIDEO_DATES_FILE)

def get_history():
    with FILE_LOCK:
        if os.path.exists(HISTORY_FILE):
            try:
                with open(HISTORY_FILE, 'r') as f: return json.load(f)
            except: pass
        return []

def save_history(history):
    with FILE_LOCK:
        tmp_file = HISTORY_FILE + '.tmp'
        with open(tmp_file, 'w') as f: json.dump(history, f)
        os.replace(tmp_file, HISTORY_FILE)

def get_cache_manifest():
    global _CACHE_MANIFEST
    with FILE_LOCK:
        if _CACHE_MANIFEST is None:
            if os.path.exists(CACHE_MANIFEST_FILE):
                try:
                    with open(CACHE_MANIFEST_FILE, 'r') as f:
                        _CACHE_MANIFEST = json.load(f)
                except:
                    _CACHE_MANIFEST = {}
            else:
                _CACHE_MANIFEST = {}
        return _CACHE_MANIFEST

def save_cache_manifest(manifest):
    global _CACHE_MANIFEST
    with FILE_LOCK:
        _CACHE_MANIFEST = manifest
        tmp_file = CACHE_MANIFEST_FILE + '.tmp'
        with open(tmp_file, 'w') as f: json.dump(manifest, f)
        os.replace(tmp_file, CACHE_MANIFEST_FILE)
