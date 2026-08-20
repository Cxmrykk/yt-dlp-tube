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
            sbBtn: document.getElementById('sbBtn'),
            sbMenu: document.getElementById('sbMenu'),
            unmuteBtn: document.getElementById('unmuteBtn'),
        };

        this.state = {
            currentVideoId: null,
            isDualAudio: false,
            resolutionsList: [],
            audioTracksList: [],
            videoChapters: [],
            currentAudioFormatId: null,
            currentAudioUrl: '',
            isCurrentResCached: false,
            isScrubbing: false,
            resumeTime: 0,
            currentVideoHeight: 0,
            currentResolution: null,
            userPaused: false,
            userMuted: false,
            userVolume: parseFloat(this.ui.volumeSlider.value) || 1,
            structuralMute: false
        };

        this.state.userMuted = this.state.userVolume === 0;

        this._pendingPreview = null;
        this._previewInitialised = false;

        this.sync = new MediaSync(this);
        this.progress = new ProgressControls(this);
        this.subtitles = new Subtitles(this);
        this.sponsorBlock = new SponsorBlock(this);
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

        if (this.ui.unmuteBtn) {
            this.ui.unmuteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.state.userMuted = false;
                if (parseFloat(this.state.userVolume) === 0) {
                    this.state.userVolume = 1;
                }
                this.applyVolume();
                this.container.classList.remove('autoplay-muted');
            });
        }
    }

    isAborted() {
        return window.pageAbortController && window.pageAbortController.signal.aborted;
    }

    getValidDuration() {
        return PlayerUtils.getValidDuration(this.ui.mainVideo);
    }

    waitReady(el, level, timeout = 15000) {
        return new Promise(resolve => {
            if (!el) return resolve(false);
            if (el.readyState >= level) return resolve(true);

            let settled = false;
            const events = ['loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough', 'progress'];

            function cleanup() {
                clearTimeout(timer);
                events.forEach(ev => el.removeEventListener(ev, check));
            }
            function finish(ok) {
                if (settled) return;
                settled = true;
                cleanup();
                resolve(ok);
            }
            function check() {
                if (el.readyState >= level) finish(true);
            }

            const timer = setTimeout(() => finish(false), timeout);
            events.forEach(ev => el.addEventListener(ev, check));
        });
    }

    showOverlay(htmlContent) {
        const overlay = document.getElementById('shortcutOverlay');
        overlay.innerHTML = htmlContent; 
        overlay.classList.remove('show');
        void overlay.offsetWidth; 
        overlay.classList.add('show');
        clearTimeout(overlay.timeout); 
        overlay.timeout = setTimeout(() => overlay.classList.remove('show'), 250);
    }

    updateVolumeIcons() {
        const vol = this.state.userMuted ? 0 : (parseFloat(this.state.userVolume) || 0);
        this.ui.volHighIcon.style.display = vol > 0.5 ? 'block' : 'none';
        this.ui.volLowIcon.style.display = (vol > 0 && vol <= 0.5) ? 'block' : 'none';
        this.ui.volMutedIcon.style.display = vol === 0 ? 'block' : 'none';
        this.ui.volumeSlider.value = vol;
    }

    applyVolume() {
        const userVol = parseFloat(this.state.userVolume) || 0;
        
        if (this.state.isDualAudio) {
            this.ui.audio.muted = this.state.userMuted;
            this.ui.audio.volume = userVol;
            
            if (this.state.structuralMute) {
                this.ui.mainVideo.muted = true;
            } else {
                this.ui.mainVideo.muted = this.state.userMuted;
                this.ui.mainVideo.volume = userVol;
            }
        } else {
            this.ui.mainVideo.muted = this.state.userMuted;
            this.ui.mainVideo.volume = userVol;
        }
        
        this.updateVolumeIcons();
    }

    setPlayingUI() {
        this.state.userPaused = false;
        this.ui.playIcon.style.display = 'none';
        this.ui.pauseIcon.style.display = 'block';
        this.container.classList.remove('paused');
        this.input.resetInactivity();
    }

    setPausedUI() {
        this.ui.playIcon.style.display = 'block';
        this.ui.pauseIcon.style.display = 'none';
        this.container.classList.add('paused');
    }

    toggleMute() {
        this.state.userMuted = !this.state.userMuted;
        this.applyVolume();
        if (!this.state.userMuted) this.container.classList.remove('autoplay-muted');
    }

    seekTo(secs) {
        if (!isFinite(secs)) return;
        this.ui.mainVideo.currentTime = secs;
        if (this.state.isDualAudio) this.ui.audio.currentTime = secs;
        if (this.state.userPaused) return;
        this.ui.mainVideo.play().catch(() => {});
        if (this.state.isDualAudio) this.ui.audio.play().catch(() => {});
    }

    async startPlayback(seekTo) {
        const v = this.ui.mainVideo;
        const a = this.ui.audio;

        this.container.classList.add('buffering');

        const gotMeta = await this.waitReady(v, 1);
        if (this.isAborted()) return;
        if (!gotMeta) {
            this.container.classList.remove('buffering');
            this.setPausedUI();
            return;
        }

        if (seekTo && seekTo > 0 && isFinite(seekTo)) {
            v.currentTime = seekTo;
            v.dispatchEvent(new Event('timeupdate'));
        }

        if (this.state.isDualAudio && a.src) {
            await this.waitReady(a, 1);
            if (this.isAborted()) return;
            a.currentTime = v.currentTime;
            a.playbackRate = v.playbackRate;
            this.applyVolume();

            await Promise.all([
                this.waitReady(v, 3, 12000),
                this.waitReady(a, 3, 12000)
            ]);
            if (this.isAborted()) return;
            a.currentTime = v.currentTime;
        }

        this.container.classList.remove('buffering');

        try {
            await v.play();
            if (this.state.isDualAudio && a.src) {
                a.currentTime = v.currentTime;
                await a.play().catch(() => {});
            }
            this.setPlayingUI();
        } catch (err) {
            if (err && err.name === 'NotAllowedError') {
                this.state.userMuted = true;
                this.applyVolume();
                try {
                    await v.play();
                    if (this.state.isDualAudio && a.src) await a.play().catch(() => {});
                    this.container.classList.add('autoplay-muted');
                    this.setPlayingUI();
                    return;
                } catch (e2) {
                    this.state.userPaused = true;
                    this.setPausedUI();
                    return;
                }
            }
            this.state.userPaused = true;
            this.setPausedUI();
        }
    }

    togglePlay() {
        if (this.ui.mainVideo.paused) {
            this.state.userPaused = false;
            this.startPlayback(0);
        } else {
            this.state.userPaused = true;
            this.ui.mainVideo.pause(); 
            if (this.state.isDualAudio) this.ui.audio.pause();
            this.setPausedUI();
            this.input.resetInactivity();
        }
    }

    initPreview() {
        if (this._previewInitialised || !this._pendingPreview || this.isAborted()) return;
        this._previewInitialised = true;

        const p = this._pendingPreview;
        this._pendingPreview = null;

        if (p.src) this.ui.previewVideo.src = p.src;
        if (p.startCache) {
            this.cache.startAutoPreviewCache(this.state.currentVideoId, p.cacheHeight);
        }
    }

    evaluateDualAudioState() {
        if (this.state.audioTracksList.length === 0) {
            this.state.isDualAudio = false;
            this.state.structuralMute = false;
            return;
        }

        const isCached = this.ui.mainVideo.src.includes('/proxy/local');
        if (isCached) {
            this.state.isDualAudio = false;
            this.state.structuralMute = false;
            return;
        }

        const resObj = this.state.resolutionsList.find(r => PlayerUtils.getMediaProxyUrl(r.url) === this.ui.mainVideo.src);
        const videoHasBuiltInAudio = resObj ? resObj.has_audio : false;
        
        const isDefaultAudio = this.state.audioTracksList.find(a => a.format_id === this.state.currentAudioFormatId)?.is_default;
        
        if (videoHasBuiltInAudio && isDefaultAudio) {
            this.state.isDualAudio = false;
            this.state.structuralMute = false;
        } else {
            this.state.isDualAudio = true;
            this.state.structuralMute = videoHasBuiltInAudio;
        }
    }

    changeAudioTrack(formatId, label) {
        if (this.state.currentAudioFormatId === formatId) return;
        
        const trackObj = this.menus.menuData.audio.options.find(o => o.value === formatId);
        if (!trackObj) return;
        
        this.state.currentAudioFormatId = formatId;
        this.state.currentAudioUrl = trackObj.url;
        document.getElementById('lbl-audio').textContent = label;
        
        const currentTime = this.ui.mainVideo.currentTime;
        const wasPlaying = !this.ui.mainVideo.paused;
        
        this.evaluateDualAudioState();
        
        if (this.state.isDualAudio) {
            this.container.classList.add('buffering');
            this.ui.audio.src = this.state.currentAudioUrl;
            this.ui.audio.currentTime = currentTime;
            
            this.waitReady(this.ui.audio, 1).then(ok => {
                if (this.isAborted()) return;
                this.applyVolume();
                this.ui.audio.playbackRate = this.ui.mainVideo.playbackRate;
                
                if (wasPlaying && !this.state.userPaused) {
                    this.startPlayback(currentTime);
                } else {
                    this.container.classList.remove('buffering');
                }
            });
        } else {
            this.ui.audio.pause();
            this.ui.audio.removeAttribute('src');
            this.applyVolume();
        }
    }

    changeResolution(url, label) {
        const resMatch = label.match(/(\d+)p/);
        const targetRes = resMatch ? parseInt(resMatch[1]) : 720;
        
        const isCached = url.includes('/proxy/local');
        this.state.currentResolution = targetRes;
        
        if (isCached) this.container.classList.add('is-cached');
        else this.container.classList.remove('is-cached');
        
        const currentTime = this.ui.mainVideo.currentTime;
        const wasPlaying = !this.ui.mainVideo.paused;
        const currentRate = this.ui.mainVideo.playbackRate;
        const currentSub = this.subtitles.currentSubVal;
        
        this.container.classList.add('buffering');
        this.ui.mainVideo.src = url;

        this.evaluateDualAudioState();

        if (this.state.isDualAudio && this.state.currentAudioUrl) {
            if (!this.ui.audio.src || this.ui.audio.src !== this.state.currentAudioUrl) {
                this.ui.audio.src = this.state.currentAudioUrl;
            }
        } else {
            this.ui.audio.pause();
            this.ui.audio.removeAttribute('src');
        }

        document.getElementById('progressCached').style.width = '0%';
        this.ui.cacheBtn.classList.remove('active');
        document.getElementById('cacheIconDefault').style.display = 'block';
        document.getElementById('cacheIconDone').style.display = 'none';
        
        if(this.state.currentVideoId) this.cache.startCachePolling(this.state.currentVideoId, targetRes);

        this.waitReady(this.ui.mainVideo, 1).then(ok => {
            if (this.isAborted()) return;

            if (ok && isFinite(currentTime)) {
                this.ui.mainVideo.currentTime = currentTime; 
                this.ui.mainVideo.dispatchEvent(new Event('timeupdate'));
                this.ui.mainVideo.playbackRate = currentRate;

                if (this.state.isDualAudio && this.ui.audio.src) {
                    this.ui.audio.currentTime = currentTime; 
                    this.ui.audio.dispatchEvent(new Event('timeupdate'));
                    this.ui.audio.playbackRate = currentRate;
                }
                this.applyVolume();
            }
            
            if (currentSub && currentSub !== "off") {
                for (let i = 0; i < this.ui.mainVideo.textTracks.length; i++) {
                    const t = this.ui.mainVideo.textTracks[i];
                    const tVal = `${t.language}|${t.label}`;
                    t.mode = (tVal === currentSub) ? 'showing' : 'disabled';
                }
            } else {
                for (let i = 0; i < this.ui.mainVideo.textTracks.length; i++) {
                    this.ui.mainVideo.textTracks[i].mode = 'disabled';
                }
            }
            
            document.getElementById('lbl-quality').textContent = label;
            if (!wasPlaying && this.state.userPaused) { 
                this.setPausedUI();
                this.container.classList.remove('buffering');
            } else {
                this.startPlayback(currentTime);
            }
        });
    }

    loadVideoData(data) {
        this.state.currentVideoId = data.id;
        this.state.resolutionsList = data.resolutions;
        this.state.audioTracksList = data.audio_tracks || [];
        this.state.videoChapters = data.chapters || [];
        this.state.resumeTime = data.resume_time || 0;
        
        this.sponsorBlock.load(data.id);
        
        const audioMenu = document.querySelector('[data-menu="audio"]');
        if (this.state.audioTracksList.length === 0) {
            if (audioMenu) audioMenu.style.display = 'none';
        } else {
            if (audioMenu) audioMenu.style.display = 'flex';
        }
        
        this.menus.menuData.audio.options = [];
        let defaultAudio = null;
        
        for (let a of this.state.audioTracksList) {
            const proxyUrl = PlayerUtils.getMediaProxyUrl(a.url);
            this.menus.menuData.audio.options.push({ label: a.label, value: a.format_id, url: proxyUrl });
            if (a.is_default && !defaultAudio) {
                defaultAudio = { format_id: a.format_id, label: a.label, url: proxyUrl };
            }
        }
        
        if (!defaultAudio && this.state.audioTracksList.length > 0) {
            const first = this.state.audioTracksList[0];
            defaultAudio = { format_id: first.format_id, label: first.label, url: PlayerUtils.getMediaProxyUrl(first.url) };
        }

        if (data.resume_audio_format_id) {
            const histAudio = this.state.audioTracksList.find(a => a.format_id === data.resume_audio_format_id);
            if (histAudio) {
                defaultAudio = { format_id: histAudio.format_id, label: histAudio.label, url: PlayerUtils.getMediaProxyUrl(histAudio.url) };
            }
        }

        if (defaultAudio) {
            this.state.currentAudioFormatId = defaultAudio.format_id;
            this.state.currentAudioUrl = defaultAudio.url;
            this.menus.menuData.audio.current = defaultAudio.format_id;
            document.getElementById('lbl-audio').textContent = defaultAudio.label;
        }
        
        let targetRes = localStorage.getItem('prefRes') || 'auto';
        if (targetRes === 'auto') targetRes = window.screen.height * window.devicePixelRatio;
        else targetRes = parseInt(targetRes, 10);
        
        this.menus.menuData.quality.options = [];
        let bestMatch = null;
        let highestCachedMatch = null;

        for (let r of this.state.resolutionsList) {
            if (!r.original_url) r.original_url = r.url;
            if (r.original_has_audio === undefined) r.original_has_audio = r.has_audio;
            
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
        
        const autoSwitchThreshold = window.APP_CONFIG.cacheAutoSwitchThreshold || 720;
        
        if (highestCachedMatch && highestCachedMatch.height >= autoSwitchThreshold) {
            bestMatch = highestCachedMatch;
        } else if (!bestMatch && this.state.resolutionsList.length > 0) {
            let r = this.state.resolutionsList[this.state.resolutionsList.length - 1];
            bestMatch = { url: PlayerUtils.getMediaProxyUrl(r.url), label: `${r.height}p`, has_audio: r.has_audio, height: r.height };
        }

        const lowestResObj = this.state.resolutionsList.length > 0 ? this.state.resolutionsList[this.state.resolutionsList.length - 1] : null;
        
        this._previewInitialised = false;
        if (lowestResObj && (lowestResObj.is_cached || lowestResObj.url.includes('/proxy/local'))) {
            this._pendingPreview = { src: lowestResObj.url, startCache: false };
        } else if (highestCachedMatch && highestCachedMatch.height === lowestResObj.height) {
            this._pendingPreview = { src: highestCachedMatch.url, startCache: false };
        } else if (lowestResObj) {
            this._pendingPreview = { src: PlayerUtils.getMediaProxyUrl(lowestResObj.url), startCache: true, cacheHeight: lowestResObj.height };
        } else {
            this._pendingPreview = null;
        }

        if (bestMatch) {
            this.state.currentResolution = bestMatch.height;
            this.menus.menuData.quality.current = bestMatch.url;
            document.getElementById('lbl-quality').textContent = bestMatch.label;
            
            if (bestMatch.url.includes('/proxy/local')) this.container.classList.add('is-cached');
            else this.container.classList.remove('is-cached');
            
            this.ui.mainVideo.src = bestMatch.url;
            
            this.evaluateDualAudioState();

            if (this.state.isDualAudio && this.state.currentAudioUrl) {
                this.ui.audio.src = this.state.currentAudioUrl;
            } else {
                this.ui.audio.removeAttribute('src'); 
            }
            
            this.applyVolume();

            this.cache.startCachePolling(this.state.currentVideoId, bestMatch.height);
        }

        this.subtitles.buildMenu(data.subtitles || []);

        document.getElementById('video-skeleton').style.display = 'none';
        this.ui.mainVideo.style.display = 'block';

        this.state.userPaused = false;
        this.startPlayback(this.state.resumeTime).then(() => {
            this.initPreview();
        });
    }

    destroy() {
        if (this.resizeObs) this.resizeObs.disconnect();
        
        this.sync.destroy();
        this.progress.destroy();
        this.subtitles.destroy();
        this.sponsorBlock.destroy();
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
