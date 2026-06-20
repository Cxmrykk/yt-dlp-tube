import hashlib
import requests
import os
import re
from flask import Blueprint, request, Response
from urllib.parse import urlparse
from storage import get_cache_manifest
from config import CACHE_DIR

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

@proxy_bp.route('/proxy/local')
def proxy_local():
    """Serves the merged, complete media file directly from our edge cache."""
    key = request.args.get('key')
    download_flag = request.args.get('download') == '1'
    title_arg = request.args.get('title', 'Video')
    
    manifest = get_cache_manifest()
    entry = manifest.get(key)
    
    if not entry or 'file_path' not in entry or not os.path.exists(entry['file_path']):
        return "Not found in cache", 404
        
    file_path = entry['file_path']
    file_size = os.path.getsize(file_path)
    res = entry.get('resolution', '')
    
    # Sanitize title for filename
    safe_title = "".join([c for c in title_arg if c.isalpha() or c.isdigit() or c == ' ']).rstrip()
    filename = f"{safe_title}_{res}p.mp4".replace(' ', '_')
    disposition = f'attachment; filename="{filename}"' if download_flag else 'inline'
    
    range_header = request.headers.get('Range', None)
    
    if range_header:
        match = re.search(r'bytes=(\d+)-(\d*)', range_header)
        if match:
            start = int(match.group(1))
            end_val = match.group(2)
            end = int(end_val) if end_val else file_size - 1
            length = end - start + 1
            
            def generate():
                with open(file_path, 'rb') as f:
                    f.seek(start)
                    remaining = length
                    while remaining > 0:
                        chunk = f.read(min(65536, remaining))
                        if not chunk: break
                        remaining -= len(chunk)
                        yield chunk
                        
            resp = Response(generate(), status=206)
            resp.headers['Content-Range'] = f'bytes {start}-{end}/{file_size}'
            resp.headers['Accept-Ranges'] = 'bytes'
            resp.headers['Content-Length'] = str(length)
            resp.headers['Content-Type'] = 'video/mp4'
            resp.headers['Content-Disposition'] = disposition
            if not download_flag:
                resp.headers['Cache-Control'] = 'public, max-age=31536000'
            return resp
            
    def generate_full():
        with open(file_path, 'rb') as f:
            while chunk := f.read(65536):
                yield chunk
                
    resp = Response(generate_full(), status=200)
    resp.headers['Content-Length'] = str(file_size)
    resp.headers['Content-Type'] = 'video/mp4'
    resp.headers['Content-Disposition'] = disposition
    if not download_flag:
        resp.headers['Cache-Control'] = 'public, max-age=31536000'
    return resp

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
            if key in r.headers: forward_headers[key] = r.headers[key]
                
        forward_headers['Cache-Control'] = 'public, max-age=31536000'
        return Response(generate(), status=r.status_code, headers=forward_headers)
    except Exception as e:
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