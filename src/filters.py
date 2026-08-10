from flask import session
from urllib.parse import quote
from storage import get_subs, get_settings
from youtube import get_new_channel_urls, norm_url
from utils import (
    format_time_str, format_views_str, time_ago_str,
    linkify_text, to_internal_path
)

def register_filters(app):

    @app.template_filter('proxy_image')
    def proxy_image_filter(url):
        if not url: return ""
        if url.startswith('/proxy/') or url.startswith('data:'): return url
        return f"/proxy/image?url={quote(url)}"

    @app.template_filter('yt_path')
    def yt_path_filter(url):
        if not url: return "/"
        return to_internal_path(url)

    @app.template_filter('format_time')
    def format_time(s): return format_time_str(s)

    @app.template_filter('format_views')
    def format_views(num): return format_views_str(num)

    @app.template_filter('time_ago')
    def time_ago(timestamp): return time_ago_str(timestamp)

    @app.template_filter('linkify_timestamps')
    def linkify_timestamps(text):
        # Comments now get the same treatment descriptions do: timestamps, URLs,
        # handles and hashtags, all escaped exactly once.
        return linkify_text(text)

    @app.context_processor
    def inject_globals():
        new_urls = get_new_channel_urls()

        subs = get_subs()
        subs_new = []
        subs_normal = []
        for s in subs:
            s['has_new'] = norm_url(s['url']) in new_urls
            if s['has_new']:
                subs_new.append(s)
            else:
                subs_normal.append(s)

        return dict(subs=subs, subs_new=subs_new, subs_normal=subs_normal, app_settings=get_settings())
