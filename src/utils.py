from datetime import datetime

def format_time_str(s):
    if not s: return "0:00"
    try:
        m, s = divmod(int(float(s)), 60)
        h, m = divmod(m, 60)
        if h > 0: return f"{h}:{m:02d}:{s:02d}"
        return f"{m}:{s:02d}"
    except (ValueError, TypeError): 
        return "0:00"

def format_views_str(num):
    if num is None or num == '': return None
    try:
        num = int(num)
        if num >= 1_000_000_000: return f"{num/1_000_000_000:.1f}B".replace(".0B", "B")
        if num >= 1_000_000: return f"{num/1_000_000:.1f}M".replace(".0M", "M")
        if num >= 1_000: return f"{num/1_000:.1f}K".replace(".0K", "K")
        return str(num)
    except: 
        return str(num)

def time_ago_str(timestamp):
    if not timestamp: return ""
    try:
        timestamp = str(timestamp)
        if len(timestamp) == 8 and timestamp.isdigit(): 
            dt = datetime.strptime(timestamp, "%Y%m%d")
        else: 
            dt = datetime.fromtimestamp(float(timestamp))
        diff = (datetime.now() - dt).total_seconds()
        
        if diff < 60: return "just now"
        if diff < 3600:
            val = int(diff//60)
            return f"{val} min{'s' if val != 1 else ''} ago"
        if diff < 86400:
            val = int(diff//3600)
            return f"{val} hour{'s' if val != 1 else ''} ago"
        if diff < 2592000:
            val = int(diff//86400)
            return f"{val} day{'s' if val != 1 else ''} ago"
        if diff < 31536000:
            val = int(diff//2592000)
            return f"{val} month{'s' if val != 1 else ''} ago"
        val = int(diff//31536000)
        return f"{val} year{'s' if val != 1 else ''} ago"
    except: 
        return ""
