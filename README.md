# yt-dlp Tube

A self-hosted, lightweight YouTube web frontend powered by `yt-dlp` and Flask. 

## Why use this over YouTube?
* **Zero Algorithm:** The feed is strictly chronological and only displays videos from channels you manually subscribe to. No recommendations, no Shorts, no engagement traps.
* **No Ads or Tracking:** Direct media stream extraction. No Google account required.
* **Native SponsorBlock:** Skip, vote, and submit sponsor segments directly inside the player.
* **Bypass Throttling:** Pre-load and cache videos directly to your server to bypass YouTube's bandwidth throttling and ensure buffer-free playback.
* **Data Ownership:** Your subscriptions, watch history, and settings are stored locally as plain JSON files.

## Features
* **Custom HTML5 Player:** Supports dual-audio sync (video + audio streams), chapter markers, and customizable keyboard shortcuts.
* **Edge Caching:** Downloads media locally via `ffmpeg`. Includes automated cache sweeping based on user-defined TTL and max size limits.
* **Advanced Subtitles:** WebVTT support, UI customization, and raw text extraction (copy to clipboard or download).
* **PJAX Navigation:** SPA-like page loading speeds without heavy frontend JavaScript frameworks.
* **Import/Export:** Full JSON import/export support for watch history and subscriptions.

## Limitations
* **No detailed feed metadata:** To ensure fast background scraping without rate limits, the home feed uses flat playlist extraction. View counts and exact upload dates are not visible on the home page. Feed sorting is based on when the server first detected the video.
* **Playback delay:** Resolving raw streams on-the-fly via `yt-dlp` takes a few seconds before playback can begin.
* **Polling-based updates:** Subscriptions are checked via a background worker interval (default 30 minutes). New videos do not appear instantly.
* **No Shorts or Live Streams:** The feed explicitly targets standard Video-on-Demand (VOD) uploads.
* **API Fragility:** Strictly dependent on `yt-dlp`. When YouTube updates their internal mechanics, video extraction will break until `yt-dlp` releases a patch.

## Requirements
* **Python 3.8+**
* **`ffmpeg`**: Required by `yt-dlp` to merge video and audio streams.
* **`deno`**: Required by `yt-dlp` to solve YouTube's JavaScript ciphers.

## Installation & Usage

1. Install system dependencies (`ffmpeg` and `deno`):
   ```bash
   # Debian/Ubuntu example
   sudo apt install ffmpeg
   curl -fsSL https://deno.land/install.sh | sh
   ```
2. Clone the repository and install Python dependencies:
   ```bash
   pip install -r requirements.txt
   ```
3. Run the application:
   ```bash
   python src/app.py
   ```
4. **Authentication:** On the very first run, the app will generate a secure `secret.key` and print a token to the console. Copy this token to log in via the web interface. 

By default, the server runs on `http://0.0.0.0:5000`.

## Architecture & Storage
There is no database. All state is stored in the `data/` directory at the project root:
* `data/*.json`: Flat files for settings, history, and subscriptions.
* `data/cache/`: Downloaded media files and ffmpeg segments.