import os

# Use DATA_DIR from environment or default to a 'data' folder in the project root
DATA_DIR = os.environ.get('DATA_DIR', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data'))

# Ensure the target data directory exists before the app tries to read/write to it
os.makedirs(DATA_DIR, exist_ok=True)