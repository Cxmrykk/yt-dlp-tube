class CacheManager {
    constructor(player) {
        this.player = player;
        this.ui = player.ui;
        this.cacheInterval = null;
        this.previewInterval = null;
        this.progressCached = document.getElementById('progressCached');
        this.cacheIconDefault = document.getElementById('cacheIconDefault');
        this.cacheIconDone = document.getElementById('cacheIconDone');
        
        // New Menu DOM Elements
        this.menuCacheActionBtn = document.getElementById('menuCacheActionBtn');
        this.menuCacheActionText = document.getElementById('menuCacheActionText');
        this.menuCacheDownloadBtn = document.getElementById('menuCacheDownloadBtn');
        this.menuCacheRemoveBtn = document.getElementById('menuCacheRemoveBtn');
        this.menuSubtitlesBtn = document.getElementById('menuSubtitlesBtn');
        
        this.selectedSubFormat = 'vtt';
        
        this.bindEvents();
    }

    openCacheMenu() {
        this.player.menus.closeSettingsMenu();
        this.player.menus.closeCcMenu();
        this.player.menus.closeSbMenu();
        this.ui.cacheMenu.classList.add('open');
        this.ui.cacheBtn.classList.add('active-menu-btn');
        this.player.container.classList.add('menu-open');
        this.updateCacheUI();
    }

    closeCacheMenu() {
        this.ui.cacheMenu.classList.remove('open');
        this.ui.cacheBtn.classList.remove('active-menu-btn');
        if(!this.player.menus.isAnyMenuOpen()) {
            this.player.container.classList.remove('menu-open');
        }
        setTimeout(() => {
            this.ui.cacheMenu.classList.remove('show-format', 'show-action');
            if (document.getElementById('cacheMainPane')) {
                this.player.menus.setMenuHeight(document.getElementById('cacheMainPane'), this.ui.cacheMenu);
            }
        }, 300);
    }

    updateCacheUI() {
        if (this.player.state.isCurrentResCached) {
            this.menuCacheActionBtn.style.display = 'none';
            this.menuCacheDownloadBtn.style.display = 'flex';
            this.menuCacheRemoveBtn.style.display = 'flex';
            this.cacheIconDefault.style.display = 'none';
            this.cacheIconDone.style.display = 'block';
            this.ui.cacheBtn.classList.remove('active');
        } else if (this.ui.cacheBtn.classList.contains('active')) {
            // Downloading
            this.menuCacheActionBtn.style.display = 'flex';
            this.menuCacheActionText.textContent = "Cancel Caching";
            this.menuCacheDownloadBtn.style.display = 'none';
            this.menuCacheRemoveBtn.style.display = 'none';
            this.cacheIconDefault.style.display = 'block';
            this.cacheIconDone.style.display = 'none';
        } else {
            // Default
            this.menuCacheActionBtn.style.display = 'flex';
            this.menuCacheActionText.textContent = "Preload/Cache Video";
            this.menuCacheDownloadBtn.style.display = 'none';
            this.menuCacheRemoveBtn.style.display = 'none';
            this.cacheIconDefault.style.display = 'block';
            this.cacheIconDone.style.display = 'none';
        }
        
        // Ensure menu height is correct if we are on the main pane
        if (this.ui.cacheMenu.classList.contains('open') && 
            !this.ui.cacheMenu.classList.contains('show-format') && 
            !this.ui.cacheMenu.classList.contains('show-action')) {
            this.player.menus.setMenuHeight(document.getElementById('cacheMainPane'), this.ui.cacheMenu);
        }
    }

    startAutoPreviewCache(vidId, resolution) {
        if (!vidId || !resolution) return;
        
        const meta = {
            title: document.getElementById('ui-title') ? document.getElementById('ui-title').textContent : 'Video',
            uploader: document.getElementById('ui-channel-name') ? document.getElementById('ui-channel-name').textContent : 'Unknown',
            uploader_url: document.getElementById('ui-channel-link') ? document.getElementById('ui-channel-link').href : '',
            channel_icon: document.getElementById('ui-channel-icon') ? document.getElementById('ui-channel-icon').src : '',
            duration: this.player.getValidDuration() || 0
        };
        
        const sizeLimit = window.APP_CONFIG.previewCacheSizeMb || 100;
        
        window.appFetch('/api/cache/start', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ vid_id: vidId, resolution: resolution, metadata: meta, size_limit_mb: sizeLimit })
        }).then(() => {
            this.pollAutoPreview(vidId, resolution);
        }).catch(()=>{});
    }

    pollAutoPreview(vidId, resolution) {
        if (this.previewInterval) clearInterval(this.previewInterval);
        
        this.previewInterval = setInterval(() => {
            if (window.pageAbortController && window.pageAbortController.signal.aborted) {
                clearInterval(this.previewInterval); return;
            }
            window.appFetch(`/api/cache/status?vid_id=${encodeURIComponent(vidId)}&resolution=${encodeURIComponent(resolution)}`)
                .then(r => r.json())
                .then(data => {
                    if (data.status === 'complete' && data.ratio >= 1.0) {
                        clearInterval(this.previewInterval);
                        const localUrl = `/proxy/local?key=${vidId}_${resolution}`;
                        
                        if (this.ui.previewVideo && this.ui.previewVideo.src !== localUrl && !this.ui.previewVideo.src.includes('/proxy/local')) {
                            const currentTime = this.ui.previewVideo.currentTime;
                            this.ui.previewVideo.src = localUrl;
                            if (isFinite(currentTime)) {
                                this.ui.previewVideo.currentTime = currentTime;
                            }
                        }
                        
                        const resObj = this.player.state.resolutionsList.find(r => r.height === parseInt(resolution));
                        if (resObj) {
                            resObj.url = localUrl;
                            resObj.is_cached = true;
                        }
                    } else if (data.status === 'error_size_limit' || data.status === 'error' || data.status === 'cancelled') {
                        clearInterval(this.previewInterval);
                    }
                }).catch(()=>{});
        }, 5000);
    }

    startCachePolling(vidId, targetRes) {
        if(this.cacheInterval) clearInterval(this.cacheInterval);
        
        const poll = () => {
            if(window.pageAbortController && window.pageAbortController.signal.aborted) {
                clearInterval(this.cacheInterval); return;
            }
            window.appFetch(`/api/cache/status?vid_id=${encodeURIComponent(vidId)}&resolution=${encodeURIComponent(targetRes)}`)
                .then(r => r.json())
                .then(data => {
                    const ratio = data.ratio;
                    this.progressCached.style.width = `${ratio * 100}%`;
                    
                    if (ratio >= 1.0 && data.status === 'complete') {
                        this.player.state.isCurrentResCached = true;
                        clearInterval(this.cacheInterval);
                        this.player.container.classList.add('is-cached');
                        this.updateCacheUI();
                        
                        if (this.ui.mainVideo.src && !this.ui.mainVideo.src.includes('/proxy/local')) {
                            const currTime = this.ui.mainVideo.currentTime;
                            const wasPlaying = !this.ui.mainVideo.paused;
                            const currRate = this.ui.mainVideo.playbackRate;
                            
                            this.player.state.isDualAudio = false;
                            if(this.ui.audio) {
                                this.ui.audio.pause();
                                this.ui.audio.removeAttribute('src');
                                this.ui.audio.load();
                            }
                            
                            const localUrl = `/proxy/local?key=${vidId}_${targetRes}`;
                            
                            if (!this.ui.previewVideo.src.includes('/proxy/local')) {
                                this.ui.previewVideo.src = localUrl;
                            }
                            
                            this.ui.mainVideo.src = localUrl;
                            this.ui.mainVideo.addEventListener('loadedmetadata', () => {
                                this.ui.mainVideo.currentTime = currTime;
                                this.ui.mainVideo.playbackRate = currRate;
                                if(wasPlaying) this.ui.mainVideo.play().catch(()=>{});
                            }, {once: true});
                            
                            const resObj = this.player.state.resolutionsList.find(r => r.height === parseInt(targetRes));
                            if(resObj) {
                                resObj.url = localUrl;
                                resObj.has_audio = true;
                                resObj.is_cached = true;
                                const menuOpt = this.player.menus.menuData.quality.options.find(o => o.label.includes(targetRes + 'p'));
                                if(menuOpt) {
                                    menuOpt.value = resObj.url;
                                }
                            }
                        }
                    } else if (ratio > 0 || data.status === 'downloading') {
                        this.player.state.isCurrentResCached = false;
                        this.ui.cacheBtn.classList.add('active');
                        this.player.container.classList.remove('is-cached');
                        this.updateCacheUI();
                    } else {
                        this.player.state.isCurrentResCached = false;
                        this.ui.cacheBtn.classList.remove('active');
                        this.player.container.classList.remove('is-cached');
                        this.updateCacheUI();
                    }
                }).catch(()=>{});
        };
        
        this.cacheInterval = setInterval(poll, 3000);
        poll();
    }

    // --- Subtitle Extraction & Processing Logic ---
    
    processSubtitle(text, format) {
        if (!text) return "";

        if (format === 'txt') {
            let rawLines = text.split('\n');
            let processedLines = [];

            // 1. Initial Strip & Clean
            for (let line of rawLines) {
                line = line.trim();
                if (!line) continue;
                if (line.startsWith('WEBVTT')) continue;
                if (line.startsWith('Kind:')) continue;
                if (line.startsWith('Language:')) continue;
                if (line.includes('-->')) continue; // Drop timeline

                // Strip inline timing tags e.g., <00:00:01.520> and formatting tags <b>
                line = line.replace(/<[^>]+>/g, '');
                
                // Unescape
                line = line.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ');
                
                // Strip structural speaker arrows '>> ' for clean continuous reading
                line = line.replace(/^>>\s*/g, '');
                
                line = line.trim();
                // Prevent capturing solitary VTT block IDs
                if (line && !/^\d+$/.test(line)) {
                    processedLines.push(line);
                }
            }

            // 2. Sliding-Window Deduplication (The Fix for YouTube's Rolling Captions)
            let finalLines = [];
            for (let line of processedLines) {
                if (finalLines.length === 0) {
                    finalLines.push(line);
                    continue;
                }
                
                let last = finalLines[finalLines.length - 1];
                
                // Skip exact duplicate
                if (line === last) continue;
                
                // If the new line is an expansion of the last line (typing effect)
                // e.g. "I went" -> "I went to the store"
                if (line.startsWith(last)) {
                    finalLines[finalLines.length - 1] = line;
                    continue;
                }
                
                // If the last line already fully contains this string (backwards overlapping cues)
                if (last.startsWith(line)) {
                    continue;
                }
                
                finalLines.push(line);
            }

            // Join all survived unique statements into a beautiful continuous paragraph
            return finalLines.join(' ');
        }
        
        // Fallback (.vtt format returns completely raw & unaltered)
        return text;
    }

    async getSubtitleContent() {
        let subUrl = null;
        let subLabel = "Subtitle";
        
        // 1. Check if a track is actively showing
        const tracks = this.player.ui.mainVideo.textTracks;
        for (let i = 0; i < tracks.length; i++) {
            if (tracks[i].mode === 'showing') {
                const trackEl = this.player.ui.mainVideo.querySelector(`track[srclang="${tracks[i].language}"][label="${tracks[i].label}"]`);
                if (trackEl) {
                    subUrl = trackEl.src;
                    subLabel = tracks[i].label;
                    break;
                }
            }
        }
        
        // 2. If nothing is showing, fallback to our standard 'best fit' default logic
        if (!subUrl) {
            const bestVal = this.player.subtitles.getBestSubVal(); 
            if (bestVal !== "off") {
                const [lang, label] = bestVal.split('|');
                const trackEl = this.player.ui.mainVideo.querySelector(`track[srclang="${lang}"]`);
                if (trackEl) {
                    subUrl = trackEl.src;
                    subLabel = label;
                }
            }
        }
        
        if (!subUrl) {
            alert("No subtitles available for this video.");
            return null;
        }
        
        try {
            const resp = await fetch(subUrl);
            const text = await resp.text();
            return { text: this.processSubtitle(text, this.selectedSubFormat), label: subLabel };
        } catch (e) {
            alert("Failed to fetch subtitles. Are you offline?");
            return null;
        }
    }

    bindEvents() {
        // Main Toolbar Button -> Just toggles the menu now
        this.ui.cacheBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this.ui.cacheMenu.classList.contains('open')) {
                this.closeCacheMenu();
            } else {
                this.openCacheMenu();
            }
        });

        // 1. Edge Cache Video Action
        this.menuCacheActionBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if(!this.player.state.currentVideoId) return;
            
            const resStr = document.getElementById('lbl-quality').textContent;
            const resMatch = resStr.match(/(\d+)p/);
            const targetRes = resMatch ? parseInt(resMatch[1]) : 720;
            
            if (this.ui.cacheBtn.classList.contains('active')) {
                // Cancel ongoing download
                window.appFetch('/api/cache/remove', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ vid_id: this.player.state.currentVideoId, resolution: targetRes })
                }).then(() => {
                    if (this.cacheInterval) clearInterval(this.cacheInterval);
                    this.player.state.isCurrentResCached = false;
                    this.ui.cacheBtn.classList.remove('active');
                    this.progressCached.style.width = '0%';
                    this.player.container.classList.remove('is-cached');
                    this.updateCacheUI();
                });
                return;
            }
            
            this.ui.cacheBtn.classList.add('active');
            this.updateCacheUI();
            
            const meta = {
                title: document.getElementById('ui-title').textContent,
                uploader: document.getElementById('ui-channel-name').textContent,
                uploader_url: document.getElementById('ui-channel-link').href,
                channel_icon: document.getElementById('ui-channel-icon').src,
                duration: this.player.getValidDuration() || 0
            };
            
            window.appFetch('/api/cache/start', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ vid_id: this.player.state.currentVideoId, resolution: targetRes, metadata: meta })
            }).then(() => {
                this.startCachePolling(this.player.state.currentVideoId, targetRes);
            }).catch(err => {
                if (err.name !== 'AbortError') alert("Failed to start caching");
                this.ui.cacheBtn.classList.remove('active');
                this.updateCacheUI();
            });
        });

        // Download Complete Cache to Device
        this.menuCacheDownloadBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if(!this.player.state.currentVideoId) return;
            
            const resStr = document.getElementById('lbl-quality').textContent;
            const resMatch = resStr.match(/(\d+)p/);
            const targetRes = resMatch ? parseInt(resMatch[1]) : 720;
            
            const title = document.getElementById('ui-title').textContent || 'Video';
            const dlUrl = `/proxy/local?key=${this.player.state.currentVideoId}_${targetRes}&download=1&title=${encodeURIComponent(title)}`;
            
            window.open(dlUrl, '_blank');
            this.closeCacheMenu();
        });

        // Remove from Edge Cache
        this.menuCacheRemoveBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!this.player.state.currentVideoId) return;
            
            const resStr = document.getElementById('lbl-quality').textContent;
            const resMatch = resStr.match(/(\d+)p/);
            const targetRes = resMatch ? parseInt(resMatch[1]) : 720;
            
            const lowestResObj = this.player.state.resolutionsList.length ? this.player.state.resolutionsList[this.player.state.resolutionsList.length - 1] : null;
            const lowestRes = lowestResObj ? lowestResObj.height : null;
            
            window.appFetch('/api/cache/remove', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ vid_id: this.player.state.currentVideoId, resolution: targetRes })
            }).then(() => {
                this.closeCacheMenu();
                this.player.state.isCurrentResCached = false;
                this.ui.cacheBtn.classList.remove('active');
                this.progressCached.style.width = '0%';
                this.player.container.classList.remove('is-cached');
                this.updateCacheUI();
                
                // Downgrade playing track off of localhost immediately
                const resObj = this.player.state.resolutionsList.find(r => r.height === targetRes);
                if (resObj && resObj.original_url && this.ui.mainVideo.src.includes('/proxy/local')) {
                    const proxyUrl = PlayerUtils.getMediaProxyUrl(resObj.original_url);
                    resObj.url = proxyUrl;
                    resObj.has_audio = resObj.original_has_audio !== undefined ? resObj.original_has_audio : resObj.has_audio;
                    resObj.is_cached = false;
                    
                    const menuOpt = this.player.menus.menuData.quality.options.find(o => o.label.includes(targetRes + 'p'));
                    if (menuOpt) menuOpt.value = proxyUrl;
                    
                    this.player.changeResolution(proxyUrl, menuOpt ? menuOpt.label : targetRes + 'p');
                }
            });
            
            if (lowestRes && lowestRes !== targetRes) {
                window.appFetch('/api/cache/remove', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ vid_id: this.player.state.currentVideoId, resolution: lowestRes })
                });
                
                const resObj = this.player.state.resolutionsList.find(r => r.height === lowestRes);
                if (resObj && resObj.original_url) {
                    resObj.url = resObj.original_url;
                    resObj.is_cached = false;
                    this.ui.previewVideo.src = PlayerUtils.getMediaProxyUrl(resObj.original_url);
                }
            }
        });

        // --- Subtitle Menu Navigation & Actions ---

        this.menuSubtitlesBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.ui.cacheMenu.classList.add('show-format');
            this.player.menus.setMenuHeight(document.getElementById('cacheFormatPane'), this.ui.cacheMenu);
        });

        document.getElementById('cacheFormatBackBtn').addEventListener('click', (e) => {
            e.stopPropagation();
            this.ui.cacheMenu.classList.remove('show-format');
            this.player.menus.setMenuHeight(document.getElementById('cacheMainPane'), this.ui.cacheMenu);
        });

        document.querySelectorAll('#cacheFormatPane .submenu-option').forEach(opt => {
            opt.addEventListener('click', (e) => {
                e.stopPropagation();
                this.selectedSubFormat = opt.getAttribute('data-format');
                
                // Update checkmarks visually
                document.querySelectorAll('#cacheFormatPane .submenu-option').forEach(o => o.classList.remove('selected'));
                opt.classList.add('selected');

                this.ui.cacheMenu.classList.add('show-action');
                this.player.menus.setMenuHeight(document.getElementById('cacheActionPane'), this.ui.cacheMenu);
            });
        });

        document.getElementById('cacheActionBackBtn').addEventListener('click', (e) => {
            e.stopPropagation();
            this.ui.cacheMenu.classList.remove('show-action');
            this.player.menus.setMenuHeight(document.getElementById('cacheFormatPane'), this.ui.cacheMenu);
        });

        // Action: Copy to Clipboard
        document.getElementById('cacheCopyBtn').addEventListener('click', async (e) => {
            e.stopPropagation();
            const textSpan = e.currentTarget.querySelector('span');
            const origText = textSpan.textContent;
            textSpan.textContent = "Processing...";
            
            const data = await this.getSubtitleContent();
            if (data) {
                try {
                    await navigator.clipboard.writeText(data.text);
                    textSpan.textContent = "Copied to Clipboard!";
                } catch (err) {
                    textSpan.textContent = "Clipboard Error";
                }
            } else {
                textSpan.textContent = "Subtitle Error";
            }
            setTimeout(() => { textSpan.textContent = origText; }, 2000);
        });

        // Action: Download File
        document.getElementById('cacheDownloadFileBtn').addEventListener('click', async (e) => {
            e.stopPropagation();
            const textSpan = e.currentTarget.querySelector('span');
            const origText = textSpan.textContent;
            textSpan.textContent = "Processing...";
            
            const data = await this.getSubtitleContent();
            if (data) {
                const blob = new Blob([data.text], { type: "text/plain" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                
                const rawTitle = document.getElementById('ui-title').textContent || "Video";
                const safeTitle = rawTitle.replace(/[^a-z0-9 ]/gi, '').trim().replace(/ /g, '_');
                
                a.download = `${safeTitle}_${data.label}.${this.selectedSubFormat}`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                
                textSpan.textContent = "Downloaded!";
            } else {
                textSpan.textContent = "Subtitle Error";
            }
            setTimeout(() => { textSpan.textContent = origText; }, 2000);
        });

        // Global Body Click to Close
        this.bodyClick = (e) => {
            if (!this.ui.cacheMenu.contains(e.target) && !this.ui.cacheBtn.contains(e.target)) {
                if (this.ui.cacheMenu.classList.contains('open')) {
                    this.closeCacheMenu();
                }
            }
        };
        document.addEventListener('click', this.bodyClick);
    }

    destroy() {
        if(this.cacheInterval) clearInterval(this.cacheInterval);
        if(this.previewInterval) clearInterval(this.previewInterval);
        document.removeEventListener('click', this.bodyClick);
    }
}
