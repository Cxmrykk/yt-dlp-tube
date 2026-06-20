import os

# Use DATA_DIR from environment or default to a 'data' folder in the project root
DATA_DIR = os.environ.get('DATA_DIR', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data'))
CACHE_DIR = os.path.join(DATA_DIR, 'cache')

# Ensure the target directories exist before the app tries to read/write to it
os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(CACHE_DIR, exist_ok=True)
