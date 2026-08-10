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
            videoChapters: [],
            bestAudioUrl: '',
            isCurrentResCached: false,
            isScrubbing: false,
            // Resume position arrives with the video payload (see loadVideoData).
            // It is deliberately NOT read from a global at construction time —
            // the player is constructed before the page script that used to set it.
            resumeTime: 0,
            currentVideoHeight: 0,
            currentResolution: null,
            // Authoritative "the user wants this paused" flag. The `paused` CSS class
            // is presentation only and can't be trusted by the sync layer.
            userPaused: false
        };

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
                this.ui.mainVideo.muted = false;
                this.ui.audio.muted = false;
                if (this.ui.mainVideo.volume === 0) {
                    this.ui.mainVideo.volume = 1;
                    this.ui.audio.volume = 1;
                    this.ui.volumeSlider.value = 1;
                }
                this.container.classList.remove('autoplay-muted');
                this.updateVolumeIcons();
            });
        }
    }

    isAborted() {
        return window.pageAbortController && window.pageAbortController.signal.aborted;
    }

    getValidDuration() {
        return PlayerUtils.getValidDuration(this.ui.mainVideo);
    }

    /**
     * Resolve once the element reaches `level` readiness.
     *
     * Critically this checks readyState *first*. The previous code attached
     * `loadedmetadata` listeners after assigning `src`, which silently never fired
     * for locally cached files that were already parsed — that was the real cause
     * of "sometimes it just doesn't autoplay".
     */
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
        const vol = this.ui.mainVideo.muted ? 0 : this.ui.mainVideo.volume;
        this.ui.volHighIcon.style.display = vol > 0.5 ? 'block' : 'none';
        this.ui.volLowIcon.style.display = (vol > 0 && vol <= 0.5) ? 'block' : 'none';
        this.ui.volMutedIcon.style.display = vol === 0 ? 'block' : 'none';
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
        this.ui.mainVideo.muted = !this.ui.mainVideo.muted;
        this.ui.audio.muted = this.ui.mainVideo.muted;
        if (!this.ui.mainVideo.muted) this.container.classList.remove('autoplay-muted');
        this.updateVolumeIcons();
    }

    seekTo(secs) {
        if (!isFinite(secs)) return;
        this.ui.mainVideo.currentTime = secs;
        if (this.state.isDualAudio) this.ui.audio.currentTime = secs;
        if (this.state.userPaused) return;
        this.ui.mainVideo.play().catch(() => {});
        if (this.state.isDualAudio) this.ui.audio.play().catch(() => {});
    }

    /**
     * Single entry point for starting playback.
     *
     * Both elements are brought to a known-ready state and seeked before either is
     * told to play, which removes the window where video runs and audio is still
     * buffering — the "momentary desync" that could become permanent.
     */
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
            a.muted = v.muted;
            a.volume = v.volume;
            a.playbackRate = v.playbackRate;

            // Wait for BOTH to have enough data before starting either.
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
                // Browser blocked unmuted autoplay. Fall back to muted playback and
                // surface an explicit unmute affordance rather than silently sitting paused.
                v.muted = true;
                a.muted = true;
                try {
                    await v.play();
                    if (this.state.isDualAudio && a.src) await a.play().catch(() => {});
                    this.container.classList.add('autoplay-muted');
                    this.updateVolumeIcons();
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

    /**
     * The scrub preview stream and the background preview-cache job both compete for
     * bandwidth with the stream we're actually trying to start. Defer them until
     * playback is under way.
     */
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

    changeResolution(url, label) {
        const resMatch = label.match(/(\d+)p/);
        const targetRes = resMatch ? parseInt(resMatch[1]) : 720;
        
        const isCached = url.includes('/proxy/local');
        const resObj = this.state.resolutionsList.find(r => (isCached ? r.url : PlayerUtils.getMediaProxyUrl(r.url)) === url);
        this.state.isDualAudio = resObj ? !resObj.has_audio : false;
        this.state.currentResolution = targetRes;
        
        if (isCached) this.container.classList.add('is-cached');
        else this.container.classList.remove('is-cached');
        
        const currentTime = this.ui.mainVideo.currentTime;
        const wasPlaying = !this.ui.mainVideo.paused;
        const currentRate = this.ui.mainVideo.playbackRate;
        const currentSub = this.subtitles.currentSubVal;
        
        this.container.classList.add('buffering');
        this.ui.mainVideo.src = url;

        if (this.state.isDualAudio && this.state.bestAudioUrl) {
            if (!this.ui.audio.src) this.ui.audio.src = this.state.bestAudioUrl;
        } else {
            this.ui.audio.pause();
        }

        document.getElementById('progressCached').style.width = '0%';
        this.ui.cacheBtn.classList.remove('active');
        document.getElementById('cacheIconDefault').style.display = 'block';
        document.getElementById('cacheIconDone').style.display = 'none';
        
        if(this.state.currentVideoId) this.cache.startCachePolling(this.state.currentVideoId, targetRes);

        // readyState-first, so a cached file that is already parsed doesn't strand us.
        this.waitReady(this.ui.mainVideo, 1).then(ok => {
            if (this.isAborted()) return;

            if (ok && isFinite(currentTime)) {
                this.ui.mainVideo.currentTime = currentTime; 
                this.ui.mainVideo.dispatchEvent(new Event('timeupdate'));
                this.ui.mainVideo.playbackRate = currentRate;

                if (this.state.isDualAudio) {
                    this.ui.audio.currentTime = currentTime; 
                    this.ui.audio.dispatchEvent(new Event('timeupdate'));
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
        this.state.videoChapters = data.chapters || [];
        this.state.bestAudioUrl = data.best_audio ? PlayerUtils.getMediaProxyUrl(data.best_audio) : '';
        this.state.resumeTime = data.resume_time || 0;
        
        this.sponsorBlock.load(data.id);
        
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
        
        // Defer preview loading so it doesn't fight with the main video stream
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
            this.state.isDualAudio = !bestMatch.has_audio;
            this.state.currentResolution = bestMatch.height;
            this.menus.menuData.quality.current = bestMatch.url;
            document.getElementById('lbl-quality').textContent = bestMatch.label;
            
            if (bestMatch.url.includes('/proxy/local')) this.container.classList.add('is-cached');
            else this.container.classList.remove('is-cached');
            
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

        // Autoplay!
        this.state.userPaused = false;
        this.startPlayback(this.state.resumeTime).then(() => {
            // Once playback begins (or fails into paused), initialize the preview video
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
