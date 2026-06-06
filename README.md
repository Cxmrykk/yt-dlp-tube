# yt-dlp Tube

A self-hosted, lightweight YouTube web client

---

## Architecture & Design Philosophy

1. **Zero-Block Rendering**: Main page routes (`/watch`, `/channel`, `/`) return layout shells instantly. Heavy metadata extraction via `yt-dlp` is offloaded to background API tasks, with the UI populated dynamically via vanilla JavaScript.
2. **Vanilla Frontend**: Built entirely with native HTML5, vanilla JavaScript, and plain CSS. It avoids heavy frontend frameworks and animation libraries to keep page loads small and responsive.
3. **Decoupled Background Engine**: An internal scheduler runs in a background thread to poll subscriptions, sorting and matching upload times with a local database (`video_dates.json`) to highlight new uploads without stalling user interactions.
4. **Local Database & Cache**: Subscriptions, application settings, and video timestamps are stored in secure local JSON databases protected by thread-safe file locks.

---

## Features

- **Custom HTML5 Dual-Stream Player**:
  - Combined and split video/audio stream handling.
  - Adaptive playback sync loop that dynamically micro-adjusts playback rates to reconcile drifting audio and video tracks instead of hard-seeking.
  - Real-time hovering seek previews utilizing a background metadata video element.
  - Chapters extraction and visualization on the timeline.
- **Subtitles & Closed Captions**:
  - Automatic and manual subtitle format extraction.
  - Custom dynamic styling (font family, size, background opacity, and color).
  - Direct synchronization delay controls (fine-tuning offset limits up to $\pm$5s).
- **Subscriptions Engine**:
  - Local subscription tracking.
  - Import/Export capability using standard JSON array structures.
  - Subscription feed populated only with genuine new uploads to minimize bandwidth.
  - Unread notification indicators on the sidebar for channels with new uploads.
- **Paginated Comments Section**:
  - Paginated comments fetching matching "Top" or "Newest" sort orders.
  - Hierarchical tree construction on the client side to map and display nested comment replies.
- **Privacy-Enhancing Proxies**:
  - Image, subtitle, and media proxies that route external Google/YouTube assets through the host server to block trackers and prevent mixed-content warnings.
- **Security & Authentication**:
  - Standard session-key authentication restricting UI, API, and proxy endpoints.
  - Auto-generated cryptographically secure secret token on first boot.

---

## Requirements

- Python 3.8+
- `pip` (Python package manager)
- Active internet connection for stream extraction

---

## Installation & Setup

1. **Clone the repository**:

   ```bash
   git clone <repository-url>
   cd yt-dlp-tube
   ```

2. **Install dependencies**:

   ```bash
   pip install -r requirements.txt
   ```

   _(Ensure `Flask`, `yt-dlp`, and `requests` are installed if a requirements file is not used)._

3. **Run the application**:

   ```bash
   python app.py
   ```

4. **Retrieve Secret Key**:
   On the initial startup, a secure authentication key is generated and printed directly to the terminal console. Copy this key to log in to the web interface. This key is saved in `secret.key` for persistent access.

5. **Access the Web UI**:
   Open your browser and navigate to `http://localhost:5000`.

---

## Configuration

All local states and settings are stored as JSON files within the application's root directory:

- `subscriptions.json`: List of subscribed channel URLs, names, and cached icons.
- `settings.json`: Configuration values for the background poll intervals, pagination sizes, description container heights, and keyboard shortcuts.
- `video_dates.json`: Database recording publication history used to calculate "new upload" status.
- `secret.key`: Generated token used for session authentication.

### Keyboard Shortcuts

Default player controls can be bound to alternative key sequences under the **Settings** menu:

- **Play/Pause**: `Space`
- **Seek Forward (10s)**: `ArrowRight`
- **Seek Backward (10s)**: `ArrowLeft`
- **Mute/Unmute**: `m`
- **Next Chapter**: `PageUp`
- **Previous Chapter**: `PageDown`
