class CacheManager {
    constructor(player) {
        this.player = player;
        this.ui = player.ui;
        this.cacheInterval = null;
        this.progressCached = document.getElementById('progressCached');
        this.cacheIconDefault = document.getElementById('cacheIconDefault');
        this.cacheIconDone = document.getElementById('cacheIconDone');
        this.downloadCacheBtn = document.getElementById('downloadCacheBtn');
        this.removeCacheBtn = document.getElementById('removeCacheBtn');

        this.bindEvents();
    }

    openCacheMenu() {
        this.player.menus.closeSettingsMenu();
        this.player.menus.closeCcMenu();
        this.ui.cacheMenu.classList.add('open');
        this.ui.cacheBtn.classList.add('active-menu-btn');
        this.player.container.classList.add('menu-open');
    }

    closeCacheMenu() {
        this.ui.cacheMenu.classList.remove('open');
        this.ui.cacheBtn.classList.remove('active-menu-btn');
        if(!this.ui.ccMenu.classList.contains('open') && !this.ui.settingsMenu.classList.contains('open')) {
            this.player.container.classList.remove('menu-open');
        }
    }

    startCachePolling(vidId, targetRes, lowestRes = null) {
        if(this.cacheInterval) clearInterval(this.cacheInterval);
        let previewDone = false;
        
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
                        this.cacheIconDefault.style.display = 'none';
                        this.cacheIconDone.style.display = 'block';
                        this.ui.cacheBtn.classList.remove('active');
                        this.player.container.classList.add('is-cached');
                        
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
                            
                            // Don't override previewVideo if it already has a seek-specific local resolution loaded
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
                        this.cacheIconDefault.style.display = 'block';
                        this.cacheIconDone.style.display = 'none';
                        this.ui.cacheBtn.classList.add('active');
                        this.player.container.classList.remove('is-cached');
                    } else {
                        this.player.state.isCurrentResCached = false;
                        this.cacheIconDefault.style.display = 'block';
                        this.cacheIconDone.style.display = 'none';
                        this.ui.cacheBtn.classList.remove('active');
                        this.player.container.classList.remove('is-cached');
                    }
                }).catch(()=>{});

            if (!previewDone && lowestRes && lowestRes !== targetRes) {
                window.appFetch(`/api/cache/status?vid_id=${encodeURIComponent(vidId)}&resolution=${encodeURIComponent(lowestRes)}`)
                    .then(r => r.json())
                    .then(d => {
                        if (d.ratio >= 1.0 && d.status === 'complete') {
                            previewDone = true;
                            const localUrl = `/proxy/local?key=${vidId}_${lowestRes}`;
                            this.ui.previewVideo.src = localUrl;
                            
                            const resObj = this.player.state.resolutionsList.find(r => r.height === parseInt(lowestRes));
                            if (resObj) {
                                resObj.url = localUrl;
                                resObj.is_cached = true;
                            }
                        }
                    }).catch(()=>{});
            }
        };
        
        this.cacheInterval = setInterval(poll, 3000);
        poll();
    }

    bindEvents() {
        this.ui.cacheBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if(!this.player.state.currentVideoId) return;
            
            const resStr = document.getElementById('lbl-quality').textContent;
            const resMatch = resStr.match(/(\d+)p/);
            const targetRes = resMatch ? parseInt(resMatch[1]) : 720;
            
            const lowestResObj = this.player.state.resolutionsList.length ? this.player.state.resolutionsList[this.player.state.resolutionsList.length - 1] : null;
            const lowestRes = lowestResObj ? lowestResObj.height : null;
            
            if (this.player.state.isCurrentResCached) {
                if (this.ui.cacheMenu.classList.contains('open')) this.closeCacheMenu();
                else this.openCacheMenu();
                return;
            }

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
                    this.cacheIconDefault.style.display = 'block';
                    this.cacheIconDone.style.display = 'none';
                    this.progressCached.style.width = '0%';
                    this.player.container.classList.remove('is-cached');
                });
                
                if (lowestRes && lowestRes !== targetRes) {
                    window.appFetch('/api/cache/remove', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({ vid_id: this.player.state.currentVideoId, resolution: lowestRes })
                    });
                }
                return;
            }
            
            this.ui.cacheBtn.classList.add('active');
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
                this.startCachePolling(this.player.state.currentVideoId, targetRes, lowestRes);
            }).catch(err => {
                if (err.name !== 'AbortError') alert("Failed to start caching");
                this.ui.cacheBtn.classList.remove('active');
            });

            if (lowestRes && lowestRes !== targetRes) {
                window.appFetch('/api/cache/start', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ vid_id: this.player.state.currentVideoId, resolution: lowestRes, metadata: meta })
                });
            }
        });

        this.downloadCacheBtn.addEventListener('click', (e) => {
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

        if (this.removeCacheBtn) {
            this.removeCacheBtn.addEventListener('click', (e) => {
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
                    this.cacheIconDefault.style.display = 'block';
                    this.cacheIconDone.style.display = 'none';
                    this.progressCached.style.width = '0%';
                    this.player.container.classList.remove('is-cached');
                    
                    // Immediately downgrade out of local fallback if currently playing the removed cache file
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
        }

        this.bodyClick = (e) => {
            if (!this.ui.cacheMenu.contains(e.target) && !this.ui.cacheBtn.contains(e.target)) {
                this.closeCacheMenu();
            }
        };
        document.addEventListener('click', this.bodyClick);
    }

    destroy() {
        if(this.cacheInterval) clearInterval(this.cacheInterval);
        document.removeEventListener('click', this.bodyClick);
    }
}