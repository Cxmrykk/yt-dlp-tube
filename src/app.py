import os
import sys
import threading
from datetime import timedelta

# Resolve the 'src' directory path and add it to sys.path
# This preserves the original module imports without modifications
src_dir = os.path.dirname(os.path.abspath(__file__))
if src_dir not in sys.path:
    sys.path.insert(0, src_dir)

# `python src/app.py` runs under the Werkzeug reloader: a parent process that only
# watches files, plus a child (WERKZEUG_RUN_MAIN=true) that actually serves
# requests. Only the serving process should write the log file or run the
# background workers; previously the parent polled feeds and cached media too.
_IS_RELOADER_PARENT = __name__ == '__main__' and os.environ.get('WERKZEUG_RUN_MAIN') != 'true'

# Log capture is installed before anything else is imported, so output produced
# while the other modules load ends up on the Logs page as well.
from logbuffer import install_log_capture
install_log_capture(persist=not _IS_RELOADER_PARENT)

from flask import Flask

# Import sub-modules and blueprints
from auth import auth_bp, init_auth
from proxy import proxy_bp
from api import api_bp
from views import views_bp
from logs_api import logs_bp
from filters import register_filters
from youtube import bg_worker_loop, start_cache_workers
from ytdlp_support import log_dependency_report

# Define root directory to find templates and static assets
ROOT_DIR = os.path.dirname(src_dir)

# Initialize Flask App with custom folder paths pointing to the project root
app = Flask(
    __name__,
    template_folder=os.path.join(ROOT_DIR, 'templates'),
    static_folder=os.path.join(ROOT_DIR, 'static')
)
app.secret_key = init_auth()
app.config['PERMANENT_SESSION_LIFETIME'] = timedelta(days=365)

# Register Blueprints
app.register_blueprint(auth_bp)
app.register_blueprint(proxy_bp)
app.register_blueprint(api_bp)
app.register_blueprint(views_bp)
app.register_blueprint(logs_bp)

# Register Custom Filters & Context Processors
register_filters(app)

# Start background threads (never in the reloader's watcher process)
if not _IS_RELOADER_PARENT:
    start_cache_workers()
    threading.Thread(target=bg_worker_loop, args=(app,), daemon=True).start()
    # Report ffmpeg / deno / curl_cffi (impersonation) status once at boot.
    threading.Thread(target=log_dependency_report, daemon=True).start()

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5000, threaded=True)
