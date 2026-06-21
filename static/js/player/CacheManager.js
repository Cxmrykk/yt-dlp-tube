class CacheManager {
    constructor(player) {
        this.player = player;
        this.ui = player.ui;
        this.cacheInterval = null;
        this.progressCached = document.getElementById('progressCached');
        this.cacheIconDefault = document.getElementById('cacheIconDefault');
        this.cacheIconDone = document.getElementById('cacheIconDone');
        this.downloadCacheBtn = document.getElementById('downloadCacheBtn');

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

    startCachePolling(vidId, resolution) {
        if(this.cacheInterval) clearInterval(this.cacheInterval);
        
        const poll = () => {
            if(window.pageAbortController && window.pageAbortController.signal.aborted) {
                clearInterval(this.cacheInterval); return;
            }
            window.appFetch(`/api/cache/status?vid_id=${encodeURIComponent(vidId)}&resolution=${encodeURIComponent(resolution)}`)
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
                            
                            const localUrl = `/proxy/local?key=${vidId}_${resolution}`;
                            this.ui.previewVideo.src = localUrl;
                            this.ui.mainVideo.src = localUrl;
                            this.ui.mainVideo.addEventListener('loadedmetadata', () => {
                                this.ui.mainVideo.currentTime = currTime;
                                this.ui.mainVideo.playbackRate = currRate;
                                if(wasPlaying) this.ui.mainVideo.play().catch(()=>{});
                            }, {once: true});
                            
                            const resObj = this.player.state.resolutionsList.find(r => r.height === parseInt(resolution));
                            if(resObj) {
                                resObj.url = localUrl;
                                resObj.has_audio = true;
                                const menuOpt = this.player.menus.menuData.quality.options.find(o => o.label.includes(resolution + 'p'));
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
                    } else {
                        this.player.state.isCurrentResCached = false;
                        this.cacheIconDefault.style.display = 'block';
                        this.cacheIconDone.style.display = 'none';
                        this.ui.cacheBtn.classList.remove('active');
                    }
                }).catch(()=>{});
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
            
            if (this.player.state.isCurrentResCached) {
                if (this.ui.cacheMenu.classList.contains('open')) this.closeCacheMenu();
                else this.openCacheMenu();
                return;
            }
            
            this.ui.cacheBtn.classList.add('active');
            
            window.appFetch('/api/cache/start', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ 
                    vid_id: this.player.state.currentVideoId, 
                    resolution: targetRes,
                    metadata: {
                        title: document.getElementById('ui-title').textContent,
                        uploader: document.getElementById('ui-channel-name').textContent,
                        uploader_url: document.getElementById('ui-channel-link').href,
                        channel_icon: document.getElementById('ui-channel-icon').src,
                        duration: this.player.getValidDuration() || 0
                    }
                })
            }).then(() => {
                this.startCachePolling(this.player.state.currentVideoId, targetRes);
            }).catch(err => {
                if (err.name !== 'AbortError') alert("Failed to start caching");
                this.ui.cacheBtn.classList.remove('active');
            });
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