import json
import os
import threading
import secrets
from config import DATA_DIR

SUBS_FILE = os.path.join(DATA_DIR, 'subscriptions.json')
SETTINGS_FILE = os.path.join(DATA_DIR, 'settings.json')
HISTORY_FILE = os.path.join(DATA_DIR, 'history.json')
CACHE_MANIFEST_FILE = os.path.join(DATA_DIR, 'cache_manifest.json')
FEED_STATE_FILE = os.path.join(DATA_DIR, 'feed_state.json')

# Retired in favour of the per-channel baseline held in FEED_STATE_FILE. The old
# file stored a sticky per-video "is_new" flag that was never cleared, which made
# the home feed grow without bound. It is renamed aside on first boot so the data
# is recoverable but can never be read back in.
LEGACY_VIDEO_DATES_FILE = os.path.join(DATA_DIR, 'video_dates.json')

FILE_LOCK = threading.Lock()
_CACHE_MANIFEST = None
_FEED_STATE = None

FEED_STATE_VERSION = 2

DEFAULT_SETTINGS = {
    'background_interval_mins': 30,
    'per_page': 15,
    'desc_preview_height': 100,
    'overlay_timeout_ms': 500,
    'feed_retention_days': 14,
    'feed_max_items': 300,
    'feed_new_burst_limit': 15,
    'cache_ttl_hours': 24,
    'cache_max_size_gb': 20,
    'preview_cache_size_mb': 100,
    'cache_auto_switch_threshold': 720,
    'auto_cache_watched': False,
    'auto_cache_immediate': True,
    'auto_cache_threshold_secs': 30,
    'auto_cache_max_size_gb': 10,
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


def _write_json_atomic(path, data):
    """Caller is responsible for holding FILE_LOCK."""
    tmp_file = path + '.tmp'
    with open(tmp_file, 'w') as f:
        json.dump(data, f)
    os.replace(tmp_file, path)


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
            _write_json_atomic(SETTINGS_FILE, data)

        return data

def save_settings(settings):
    with FILE_LOCK:
        _write_json_atomic(SETTINGS_FILE, settings)

def get_subs():
    with FILE_LOCK:
        if os.path.exists(SUBS_FILE):
            try:
                with open(SUBS_FILE, 'r') as f: return json.load(f)
            except: pass
        return []

def save_subs(subs):
    with FILE_LOCK:
        _write_json_atomic(SUBS_FILE, subs)

def get_history():
    with FILE_LOCK:
        if os.path.exists(HISTORY_FILE):
            try:
                with open(HISTORY_FILE, 'r') as f: return json.load(f)
            except: pass
        return []

def save_history(history):
    with FILE_LOCK:
        _write_json_atomic(HISTORY_FILE, history)

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
        _write_json_atomic(CACHE_MANIFEST_FILE, manifest)


# ----------------------------------------------------------------------
# Feed state
#
# Shape (version 2):
#
#   {
#     "version": 2,
#     "channels": {
#       "<normalised channel url>": {
#         "baseline_at":       float,   # when this channel was first catalogued
#         "last_rebaseline_at": float,  # optional, set by the burst guard
#         "last_fetch_at":     float,
#         "last_seen_ts":      float,   # drives the sidebar new-upload dot
#         "known": { "<video id>": float }   # 0.0 == baseline, >0 == discovered at
#       }
#     }
#   }
#
# A video only reaches the home feed if its "known" value is greater than zero,
# i.e. it appeared *after* the channel had already been catalogued. A channel
# seen for the first time contributes nothing, which is what makes a wiped data
# directory produce an empty feed instead of the first N videos of everything.
# ----------------------------------------------------------------------

def new_feed_state():
    return {'version': FEED_STATE_VERSION, 'channels': {}}


def _normalise_channel_entry(raw):
    if not isinstance(raw, dict):
        return {'baseline_at': 0.0, 'last_seen_ts': 0.0, 'known': {}}

    def _f(key):
        try:
            return float(raw.get(key) or 0)
        except (TypeError, ValueError):
            return 0.0

    known = {}
    raw_known = raw.get('known')
    if isinstance(raw_known, dict):
        for vid, ts in raw_known.items():
            if not isinstance(vid, str):
                continue
            try:
                known[vid] = float(ts or 0)
            except (TypeError, ValueError):
                known[vid] = 0.0

    entry = {
        'baseline_at': _f('baseline_at'),
        'last_fetch_at': _f('last_fetch_at'),
        'last_seen_ts': _f('last_seen_ts'),
        'known': known
    }
    if raw.get('last_rebaseline_at'):
        entry['last_rebaseline_at'] = _f('last_rebaseline_at')
    return entry


def _migrate_feed_state(raw):
    """Accepts anything previously written to disk and returns a valid v2 dict."""
    if not isinstance(raw, dict):
        return new_feed_state()

    if raw.get('version') == FEED_STATE_VERSION and isinstance(raw.get('channels'), dict):
        return {
            'version': FEED_STATE_VERSION,
            'channels': {
                k: _normalise_channel_entry(v)
                for k, v in raw['channels'].items() if isinstance(k, str)
            }
        }

    # Version 1 was a flat map of normalised url -> {"last_seen_ts": float}. The
    # watermark is worth keeping; there was no baseline, so every channel gets
    # re-catalogued on the next poll and the feed starts clean.
    channels = {}
    for k, v in raw.items():
        if k in ('version', 'channels') or not isinstance(k, str):
            continue
        channels[k] = _normalise_channel_entry(
            {'last_seen_ts': v.get('last_seen_ts') if isinstance(v, dict) else 0}
        )
    return {'version': FEED_STATE_VERSION, 'channels': channels}


def _retire_legacy_video_dates():
    """Caller is responsible for holding FILE_LOCK."""
    if not os.path.exists(LEGACY_VIDEO_DATES_FILE):
        return
    target = LEGACY_VIDEO_DATES_FILE + '.retired'
    try:
        if os.path.exists(target):
            os.remove(LEGACY_VIDEO_DATES_FILE)
        else:
            os.replace(LEGACY_VIDEO_DATES_FILE, target)
        print("[feed] Retired legacy video_dates.json; the feed now uses per-channel baselines.")
    except Exception as e:
        print(f"[feed] Could not retire legacy video_dates.json: {e}")


def get_feed_state():
    global _FEED_STATE
    with FILE_LOCK:
        if _FEED_STATE is None:
            raw = None
            if os.path.exists(FEED_STATE_FILE):
                try:
                    with open(FEED_STATE_FILE, 'r') as f:
                        raw = json.load(f)
                except:
                    raw = None

            migrated = _migrate_feed_state(raw)
            _FEED_STATE = migrated

            if not isinstance(raw, dict) or raw.get('version') != FEED_STATE_VERSION:
                try:
                    _write_json_atomic(FEED_STATE_FILE, migrated)
                except Exception as e:
                    print(f"[feed] Could not persist migrated feed state: {e}")

            _retire_legacy_video_dates()

        return _FEED_STATE


def save_feed_state(state):
    global _FEED_STATE
    if not isinstance(state, dict) or 'channels' not in state:
        state = new_feed_state()
    state['version'] = FEED_STATE_VERSION
    with FILE_LOCK:
        _FEED_STATE = state
        _write_json_atomic(FEED_STATE_FILE, state)
