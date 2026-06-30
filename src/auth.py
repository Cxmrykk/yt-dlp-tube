import os
import secrets
import time
from flask import Blueprint, request, session, redirect, url_for, render_template, jsonify
from config import DATA_DIR

auth_bp = Blueprint('auth', __name__)

AUTH_FILE = os.path.join(DATA_DIR, 'secret.key')
APP_SECRET_TOKEN = None

def init_auth():
    global APP_SECRET_TOKEN
    if os.path.exists(AUTH_FILE):
        try:
            with open(AUTH_FILE, 'r') as f:
                APP_SECRET_TOKEN = f.read().strip()
        except Exception as e:
            print(f"Error reading auth file: {e}")
            
    if not APP_SECRET_TOKEN:
        APP_SECRET_TOKEN = secrets.token_urlsafe(32)
        try:
            with open(AUTH_FILE, 'w') as f:
                f.write(APP_SECRET_TOKEN)
            print("\n" + "="*70)
            print("🔒 YT-DLP TUBE: AUTHENTICATION SECRET KEY GENERATED 🔒")
            print("This is your ONE-TIME display of the secret key.")
            print(f"\nSecret Key: {APP_SECRET_TOKEN}\n")
            print(f"To reset, delete the '{AUTH_FILE}' file and restart the server.")
            print("="*70 + "\n")
        except Exception as e:
            print(f"Error writing auth file: {e}")
            
    return APP_SECRET_TOKEN

@auth_bp.before_app_request
def require_auth():
    if request.endpoint == 'auth.login' or (request.endpoint and request.endpoint.startswith('static')):
        return

    if not session.get('authenticated'):
        if request.path.startswith('/api/') or request.path.startswith('/proxy/'):
            return jsonify({"error": "Unauthorized"}), 401
        return redirect(url_for('auth.login'))

@auth_bp.route('/login', methods=['GET', 'POST'])
def login():
    if session.get('authenticated'):
        return redirect(url_for('views.feed'))
        
    error = None
    if request.method == 'POST':
        provided_key = request.form.get('secret_key', '').strip()
        if provided_key == APP_SECRET_TOKEN:
            session.permanent = True
            session['authenticated'] = True
            if 'last_feed_view' not in session:
                session['last_feed_view'] = time.time()
            return redirect(url_for('views.feed'))
        else:
            error = "Invalid secret key. Please check your console."
            
    return render_template('login.html', error=error)

@auth_bp.route('/logout')
def logout():
    session.clear()
    return redirect(url_for('auth.login'))