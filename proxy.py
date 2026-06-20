import hashlib
import requests
from flask import Blueprint, request, Response
from urllib.parse import urlparse

proxy_bp = Blueprint('proxy', __name__)

SESSION = requests.Session()
adapter = requests.adapters.HTTPAdapter(pool_connections=200, pool_maxsize=200, max_retries=1)
SESSION.mount('http://', adapter)
SESSION.mount('https://', adapter)

ALLOWED_DOMAINS = ['ytimg.com', 'ggpht.com', 'googleusercontent.com', 'youtube.com', 'googlevideo.com', 'ui-avatars.com']

def is_safe_url(url):
    try:
        domain = urlparse(url).netloc.lower()
        return any(domain == d or domain.endswith('.' + d) for d in ALLOWED_DOMAINS)
    except:
        return False

@proxy_bp.route('/proxy/image')
def proxy_image():
    url = request.args.get('url')
    if not url or not is_safe_url(url):
        return "Invalid or unsafe URL", 400
        
    etag = hashlib.md5(url.encode('utf-8')).hexdigest()
    
    if request.headers.get('If-None-Match') == f'"{etag}"':
        resp = Response(status=304)
        resp.headers['Cache-Control'] = 'public, max-age=31536000, immutable'
        resp.headers['ETag'] = f'"{etag}"'
        return resp
        
    try:
        headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}
        r = SESSION.get(url, headers=headers, timeout=10)
        
        resp = Response(r.content, content_type=r.headers.get('Content-Type', 'image/jpeg'))
        resp.headers['Cache-Control'] = 'public, max-age=31536000, immutable'
        resp.headers['ETag'] = f'"{etag}"'
        return resp
    except Exception:
        return "Image proxy failed", 500

@proxy_bp.route('/proxy/media')
def proxy_media():
    url = request.args.get('url')
    if not url or not is_safe_url(url):
        return "Invalid or unsafe URL", 400
        
    headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}
    if 'Range' in request.headers:
        headers['Range'] = request.headers['Range']
        
    try:
        r = SESSION.get(url, headers=headers, stream=True, timeout=(5, 15))
        
        def generate():
            try:
                for chunk in r.iter_content(chunk_size=81920):
                    if chunk: yield chunk
            except Exception: pass
            finally: r.close()
                
        forward_headers = {}
        for key in ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges']:
            if key in r.headers:
                forward_headers[key] = r.headers[key]
                
        forward_headers['Cache-Control'] = 'public, max-age=31536000'
        return Response(generate(), status=r.status_code, headers=forward_headers)
        
    except Exception as e:
        print(f"Proxy streaming failed: {e}")
        return str(e), 500

@proxy_bp.route('/proxy/subtitles')
def proxy_subtitles():
    url = request.args.get('url')
    if not url or not is_safe_url(url):
        return "Invalid or unsafe URL", 400
        
    try:
        headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}
        r = SESSION.get(url, headers=headers, timeout=10)
        text = r.text
        
        import re
        text = re.sub(r'(-->\s*\d{2}:\d{2}:\d{2}\.\d{3}).*', r'\1', text)
        text = re.sub(r'</?c[^>]*>', '', text)
        
        resp = Response(text, content_type='text/vtt')
        resp.headers['Cache-Control'] = 'public, max-age=31536000, immutable'
        return resp
    except Exception as e:
        return str(e), 500