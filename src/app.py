import os
import sys
import threading
from datetime import timedelta
from flask import Flask

# Resolve the 'src' directory path and add it to sys.path
# This preserves the original module imports without modifications
src_dir = os.path.dirname(os.path.abspath(__file__))
if src_dir not in sys.path:
    sys.path.insert(0, src_dir)

# Import sub-modules and blueprints
from auth import auth_bp, init_auth
from proxy import proxy_bp
from api import api_bp
from views import views_bp
from filters import register_filters
from youtube import bg_worker_loop

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

# Register Custom Filters & Context Processors
register_filters(app)

# Start background sync thread (Prevents running twice in debug auto-reload mode)
if os.environ.get('WERKZEUG_RUN_MAIN') == 'true' or not app.debug:
    threading.Thread(target=bg_worker_loop, args=(app,), daemon=True).start()

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5000, threaded=True)