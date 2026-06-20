import time
from flask import session
from urllib.parse import urlparse, quote
from storage import get_subs, get_settings
from youtube import feed_cache
from utils import format_time_str, format_views_str, time_ago_str

def register_filters(app):

    @app.template_filter('proxy_image')
    def proxy_image_filter(url):
        if not url: return ""
        if url.startswith('/proxy/') or url.startswith('data:'): return url
        return f"/proxy/image?url={quote(url)}"

    @app.template_filter('yt_path')
    def yt_path_filter(url):
        if not url: return "/"
        try:
            parsed = urlparse(url)
            if 'youtu.be' in parsed.netloc:
                video_id = parsed.path.strip('/')
                return f"/watch?v={video_id}"
            if 'youtube.com' in parsed.netloc:
                res = parsed.path
                if parsed.query: res += '?' + parsed.query
                return res
        except: pass
        return url

    @app.template_filter('format_time')
    def format_time(s): return format_time_str(s)

    @app.template_filter('format_views')
    def format_views(num): return format_views_str(num)

    @app.template_filter('time_ago')
    def time_ago(timestamp): return time_ago_str(timestamp)

    @app.context_processor
    def inject_globals():
        last_view = session.get('last_feed_view', time.time())
        new_urls = set()
        
        for v in feed_cache.get('data', []):
            if v.get('timestamp', 0) > last_view:
                c_url = v.get('channel_url') or v.get('uploader_url')
                if c_url: new_urls.add(c_url.strip('/').split('?')[0].lower())
                
        subs = get_subs()
        subs_new = []
        subs_normal = []
        for s in subs:
            n_url = s['url'].strip('/').split('?')[0].lower()
            s['has_new'] = n_url in new_urls
            if s['has_new']:
                subs_new.append(s)
            else:
                subs_normal.append(s)
                
        return dict(subs=subs, subs_new=subs_new, subs_normal=subs_normal, app_settings=get_settings())