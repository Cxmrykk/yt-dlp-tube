class PlayerCore {
    constructor(container) {
        this.container = container;
        this.ui = {
            mainVideo: document.getElementById('vid-player'),
            audio: document.getElementById('aud-player'),
            previewVideo: document.getElementById('previewVideo'),
            playPauseBtn: document.getElementById('playPauseBtn'),
            playIcon: document.getElementById('playIcon'),
            pauseIcon: document.getElementById('pauseIcon'),
            progressArea: document.getElementById('progressArea'),
            progressBar: document.getElementById('progressBar'),
            progressLoaded: document.getElementById('progressLoaded'),
            progressThumb: document.getElementById('progressThumb'),
            progressTrack: document.getElementById('progressTrack'),
            hoverTooltip: document.getElementById('hoverTooltip'),
            hoverTime: document.getElementById('hoverTime'),
            hoverChapter: document.getElementById('hoverChapter'),
            muteBtn: document.getElementById('muteBtn'),
            volumeSlider: document.getElementById('volumeSlider'),
            volHighIcon: document.getElementById('volHighIcon'),
            volLowIcon: document.getElementById('volLowIcon'),
            volMutedIcon: document.getElementById('volMutedIcon'),
            currentTime: document.getElementById('currentTime'),
            duration: document.getElementById('duration'),
            fullscreenBtn: document.getElementById('fullscreenBtn'),
            fsIconEnter: document.getElementById('fsIconEnter'),
            fsIconExit: document.getElementById('fsIconExit'),
            ccBtn: document.getElementById('ccBtn'),
            ccMenu: document.getElementById('ccMenu'),
            settingsBtn: document.getElementById('settingsBtn'),
            settingsMenu: document.getElementById('settingsMenu'),
            cacheBtn: document.getElementById('cacheBtn'),
            cacheMenu: document.getElementById('cacheMenu'),
        };

        this.state = {
            currentVideoId: null,
            isDualAudio: false,
            resolutionsList: [],
            videoChapters: [],
            bestAudioUrl: '',
            isCurrentResCached: false,
            isScrubbing: false,
            resumeTime: window.resumeTime || 0,
            currentVideoHeight: 0
        };

        this.sync = new MediaSync(this);
        this.progress = new ProgressControls(this);
        this.subtitles = new Subtitles(this);
        this.menus = new MenuSystem(this);
        this.cache = new CacheManager(this);
        this.input = new InputHandler(this);

        this.resizeObs = new ResizeObserver(entries => {
            for (let entry of entries) {
                this.state.currentVideoHeight = entry.contentRect.height;
                this.subtitles.updateCcStyles();
            }
        });
        this.resizeObs.observe(this.container);

        this.bindEvents();
    }

    bindEvents() {
        this.ui.playPauseBtn.addEventListener('click', () => this.togglePlay());
        this.ui.mainVideo.addEventListener('click', () => {
            if (!this.menus.isAnyMenuOpen()) this.togglePlay();
        });
        this.ui.mainVideo.addEventListener('waiting', () => this.container.classList.add('buffering'));
        this.ui.mainVideo.addEventListener('playing', () => this.container.classList.remove('buffering'));
        this.ui.mainVideo.addEventListener('canplay', () => this.container.classList.remove('buffering'));
    }

    getValidDuration() {
        return PlayerUtils.getValidDuration(this.ui.mainVideo);
    }

    showOverlay(htmlContent) {
        const overlay = document.getElementById('shortcutOverlay');
        overlay.innerHTML = htmlContent; 
        overlay.classList.remove('show');
        void overlay.offsetWidth; 
        overlay.classList.add('show');
        clearTimeout(overlay.timeout); 
        overlay.timeout = setTimeout(() => overlay.classList.remove('show'), 400);
    }

    updateVolumeIcons() {
        const vol = this.ui.mainVideo.muted ? 0 : this.ui.mainVideo.volume;
        this.ui.volHighIcon.style.display = vol > 0.5 ? 'block' : 'none';
        this.ui.volLowIcon.style.display = (vol > 0 && vol <= 0.5) ? 'block' : 'none';
        this.ui.volMutedIcon.style.display = vol === 0 ? 'block' : 'none';
    }

    togglePlay() {
        if (this.ui.mainVideo.paused) {
            let p1 = this.ui.mainVideo.play();
            let p2;
            if (this.state.isDualAudio && this.ui.audio.paused) p2 = this.ui.audio.play();
            
            if(p1) p1.catch(()=>{});
            if(p2) p2.catch((e)=>{ console.warn("Background audio suppressed", e); });

            this.ui.playIcon.style.display = 'none'; 
            this.ui.pauseIcon.style.display = 'block';
            this.container.classList.remove('paused'); 
            this.input.resetInactivity();
        } else {
            this.ui.mainVideo.pause(); 
            if (this.state.isDualAudio) this.ui.audio.pause();
            
            this.ui.playIcon.style.display = 'block'; 
            this.ui.pauseIcon.style.display = 'none';
            this.container.classList.add('paused'); 
            this.input.resetInactivity();
        }
    }

    toggleMute() {
        this.ui.mainVideo.muted = !this.ui.mainVideo.muted; 
        this.ui.audio.muted = this.ui.mainVideo.muted;
        this.ui.volumeSlider.value = this.ui.mainVideo.muted ? 0 : (this.ui.mainVideo.volume || 1); 
        this.updateVolumeIcons();
    }

    changeResolution(url, label) {
        const resMatch = label.match(/(\d+)p/);
        const targetRes = resMatch ? parseInt(resMatch[1]) : 720;
        
        const isCached = url.includes('/proxy/local');
        const resObj = this.state.resolutionsList.find(r => (isCached ? r.url : PlayerUtils.getMediaProxyUrl(r.url)) === url);
        this.state.isDualAudio = resObj ? !resObj.has_audio : false;
        
        const currentTime = this.ui.mainVideo.currentTime;
        const isPaused = this.ui.mainVideo.paused;
        const currentRate = this.ui.mainVideo.playbackRate;
        const currentSub = this.subtitles.currentSubVal;
        
        this.container.classList.add('buffering');
        this.ui.mainVideo.src = url;

        document.getElementById('progressCached').style.width = '0%';
        this.ui.cacheBtn.classList.remove('active');
        document.getElementById('cacheIconDefault').style.display = 'block';
        document.getElementById('cacheIconDone').style.display = 'none';
        if(this.state.currentVideoId) this.cache.startCachePolling(this.state.currentVideoId, targetRes);
        
        this.ui.mainVideo.addEventListener('loadedmetadata', () => {
            if (isFinite(currentTime)) {
                this.ui.mainVideo.currentTime = currentTime; 
                this.ui.mainVideo.playbackRate = currentRate;
                if (this.state.isDualAudio) {
                    if (!this.ui.audio.src) this.ui.audio.src = this.state.bestAudioUrl;
                    this.ui.audio.currentTime = currentTime; 
                    this.ui.audio.muted = this.ui.mainVideo.muted;
                    this.ui.audio.volume = this.ui.mainVideo.volume; 
                    this.ui.audio.playbackRate = currentRate;
                } else { 
                    this.ui.audio.pause(); 
                }
            }
            
            if (currentSub && currentSub !== "off") {
                for (let i = 0; i < this.ui.mainVideo.textTracks.length; i++) {
                    const t = this.ui.mainVideo.textTracks[i];
                    const tVal = `${t.language}|${t.label}`;
                    if (tVal === currentSub) t.mode = 'showing';
                    else t.mode = 'disabled';
                }
            } else {
                for (let i = 0; i < this.ui.mainVideo.textTracks.length; i++) {
                    this.ui.mainVideo.textTracks[i].mode = 'disabled';
                }
            }
            
            document.getElementById('lbl-quality').textContent = label;
            if (!isPaused) { 
                let p1 = this.ui.mainVideo.play(); 
                let p2; 
                if (this.state.isDualAudio) p2 = this.ui.audio.play();
                if(p1) p1.catch(()=>{});
                if(p2) p2.catch(()=>{});
            }
            this.container.classList.remove('buffering');
        }, { once: true });
    }

    loadVideoData(data) {
        this.state.currentVideoId = data.id;
        this.state.resolutionsList = data.resolutions;
        this.state.videoChapters = data.chapters || [];
        this.state.bestAudioUrl = data.best_audio ? PlayerUtils.getMediaProxyUrl(data.best_audio) : '';
        
        let targetRes = localStorage.getItem('prefRes') || 'auto';
        if (targetRes === 'auto') targetRes = window.screen.height * window.devicePixelRatio;
        else targetRes = parseInt(targetRes, 10);
        
        this.menus.menuData.quality.options = [];
        let bestMatch = null;
        let highestCachedMatch = null;

        for (let r of this.state.resolutionsList) {
            const isCached = r.is_cached || r.url.includes('/proxy/local');
            const lbl = `${r.height}p${r.fps > 30 ? ' ' + r.fps + 'fps' : ''} ${r.has_audio && !isCached ? '(Combined)' : ''}`;
            const proxyUrl = isCached ? r.url : PlayerUtils.getMediaProxyUrl(r.url);
            
            this.menus.menuData.quality.options.push({ label: lbl, value: proxyUrl });
            
            if (isCached && (!highestCachedMatch || r.height > highestCachedMatch.height)) {
                highestCachedMatch = { url: proxyUrl, label: lbl, has_audio: r.has_audio, height: r.height };
            }
            
            if (!bestMatch && r.height <= targetRes) {
                bestMatch = { url: proxyUrl, label: lbl, has_audio: r.has_audio, height: r.height };
            }
        }
        
        if (highestCachedMatch) {
            bestMatch = highestCachedMatch;
        } else if (!bestMatch && this.state.resolutionsList.length > 0) {
            let r = this.state.resolutionsList[this.state.resolutionsList.length - 1];
            bestMatch = { url: PlayerUtils.getMediaProxyUrl(r.url), label: `${r.height}p`, has_audio: r.has_audio, height: r.height };
        }

        if (highestCachedMatch) {
            this.ui.previewVideo.src = highestCachedMatch.url;
        } else if (this.state.resolutionsList.length > 0) {
            this.ui.previewVideo.src = PlayerUtils.getMediaProxyUrl(this.state.resolutionsList[this.state.resolutionsList.length - 1].url);
        }

        if (bestMatch) {
            this.state.isDualAudio = !bestMatch.has_audio;
            this.menus.menuData.quality.current = bestMatch.url;
            document.getElementById('lbl-quality').textContent = bestMatch.label;
            this.ui.mainVideo.src = bestMatch.url;
            this.cache.startCachePolling(this.state.currentVideoId, bestMatch.height);
        }

        if (this.state.bestAudioUrl && this.state.isDualAudio) {
            this.ui.audio.src = this.state.bestAudioUrl;
        } else {
            this.ui.audio.removeAttribute('src'); 
            this.state.isDualAudio = false; 
        }

        this.subtitles.buildMenu(data.subtitles || []);

        document.getElementById('video-skeleton').style.display = 'none';
        this.ui.mainVideo.style.display = 'block';

        this.updateVolumeIcons();

        this.ui.mainVideo.addEventListener('loadedmetadata', () => {
            if (this.state.resumeTime && this.state.resumeTime > 0) {
                const targetTime = this.state.resumeTime;
                this.ui.mainVideo.currentTime = targetTime;
                
                if (this.state.isDualAudio) {
                    const syncInit = () => { this.ui.audio.currentTime = targetTime; };
                    if (this.ui.audio.readyState >= 1) syncInit();
                    else this.ui.audio.addEventListener('loadedmetadata', syncInit, {once: true});
                }
                this.state.resumeTime = 0; 
            }
            
            this.ui.playIcon.style.display = 'block';
            this.ui.pauseIcon.style.display = 'none';
            this.container.classList.add('paused');
        }, {once: true});
    }

    destroy() {
        if (this.resizeObs) this.resizeObs.disconnect();
        
        this.sync.destroy();
        this.progress.destroy();
        this.subtitles.destroy();
        this.menus.destroy();
        this.cache.destroy();
        this.input.destroy();

        if (this.ui.mainVideo) {
            this.ui.mainVideo.pause();
            this.ui.mainVideo.removeAttribute('src');
            this.ui.mainVideo.load();
        }
        if (this.ui.audio) {
            this.ui.audio.pause();
            this.ui.audio.removeAttribute('src');
            this.ui.audio.load();
        }
        if (this.ui.previewVideo) {
            this.ui.previewVideo.pause();
            this.ui.previewVideo.removeAttribute('src');
            this.ui.previewVideo.load();
        }
    }
}