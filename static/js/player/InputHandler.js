class InputHandler {
    constructor(player) {
        this.player = player;
        this.shortcuts = window.APP_CONFIG.shortcuts;
        this.inactivityTimeout = null;

        this.bindEvents();
    }

    resetInactivity() {
        this.player.container.classList.add('user-active');
        this.player.container.classList.remove('hide-cursor');
        clearTimeout(this.inactivityTimeout);
        
        const timeoutDuration = window.APP_CONFIG.overlayTimeout || 500;
        
        this.inactivityTimeout = setTimeout(() => {
            if (!this.player.ui.mainVideo.paused && !this.player.menus.isAnyMenuOpen()) {
                this.player.container.classList.remove('user-active'); 
                this.player.container.classList.add('hide-cursor');
            }
        }, timeoutDuration);
    }

    handleGlobalKeydown(e) {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
        let key = e.key === ' ' ? 'Space' : e.key;
        const mainVideo = this.player.ui.mainVideo;

        if (key === 'Enter') {
            if (this.player.sponsorBlock && this.player.sponsorBlock.activeSegment && this.player.sponsorBlock.sessionEnabled) {
                e.preventDefault();
                this.player.sponsorBlock.skipSegment(this.player.sponsorBlock.activeSegment);
                return;
            }
        }

        if (key && key === this.shortcuts.pause) {
            e.preventDefault(); 
            this.player.togglePlay(); 
            this.player.showOverlay(mainVideo.paused ? `<img src="/static/icons/pause.svg" class="overlay-icon" alt="Pause">` : `<img src="/static/icons/play.svg" class="overlay-icon" alt="Play">`);
        } else if (key && key === this.shortcuts.seekFwd) {
            e.preventDefault(); 
            const dur = this.player.getValidDuration();
            if (dur > 0) { 
                mainVideo.currentTime = Math.min(dur, mainVideo.currentTime + 10); 
                if(this.player.state.isDualAudio) this.player.ui.audio.currentTime = mainVideo.currentTime; 
                this.player.showOverlay(`<img src="/static/icons/fwd.svg" class="overlay-icon" alt="Fwd">`); 
            }
        } else if (key && key === this.shortcuts.seekBwd) {
            e.preventDefault(); 
            const dur = this.player.getValidDuration();
            if (dur > 0) { 
                mainVideo.currentTime = Math.max(0, mainVideo.currentTime - 10); 
                if(this.player.state.isDualAudio) this.player.ui.audio.currentTime = mainVideo.currentTime; 
                this.player.showOverlay(`<img src="/static/icons/bwd.svg" class="overlay-icon" alt="Bwd">`); 
            }
        } else if (key && key === this.shortcuts.mute) {
            e.preventDefault(); 
            this.player.toggleMute();
            if (mainVideo.muted || mainVideo.volume === 0) this.player.showOverlay(`<img src="/static/icons/vol-muted.svg" class="overlay-icon" alt="Mute">`);
            else if (mainVideo.volume > 0.5) this.player.showOverlay(`<img src="/static/icons/vol-high.svg" class="overlay-icon" alt="Vol">`); 
            else this.player.showOverlay(`<img src="/static/icons/vol-low.svg" class="overlay-icon" alt="Vol Low">`);
        } else if (key && key === this.shortcuts.cc) {
            e.preventDefault(); 
            this.player.subtitles.toggleCc();
        } else if (key && key === this.shortcuts.speedUp) {
            e.preventDefault();
            this.player.menus.changeSpeed(1);
        } else if (key && key === this.shortcuts.speedDown) {
            e.preventDefault();
            this.player.menus.changeSpeed(-1);
        } else if (key && key === this.shortcuts.chapNext) {
            e.preventDefault();
            const chapters = this.player.state.videoChapters;
            if (chapters.length > 0) {
                const dur = this.player.getValidDuration();
                const curr = mainVideo.currentTime;
                const nextCh = chapters.find(ch => ch.start_time > curr + 1);
                if (nextCh) {
                    mainVideo.currentTime = nextCh.start_time;
                    if(this.player.state.isDualAudio) this.player.ui.audio.currentTime = nextCh.start_time;
                    this.player.showOverlay(`<img src="/static/icons/fwd.svg" class="overlay-icon" alt="Fwd">`);
                } else if (dur > 0) {
                    mainVideo.currentTime = dur;
                    if(this.player.state.isDualAudio) this.player.ui.audio.currentTime = dur;
                }
            }
        } else if (key && key === this.shortcuts.chapPrev) {
            e.preventDefault();
            const chapters = this.player.state.videoChapters;
            if (chapters.length > 0) {
                const curr = mainVideo.currentTime;
                let currentChIdx = 0;
                for (let i = 0; i < chapters.length; i++) {
                    if (curr >= chapters[i].start_time) currentChIdx = i;
                }
                if (curr > chapters[currentChIdx].start_time + 3) {
                    mainVideo.currentTime = chapters[currentChIdx].start_time;
                } else {
                    const prevChIdx = Math.max(0, currentChIdx - 1);
                    mainVideo.currentTime = chapters[prevChIdx].start_time;
                }
                if(this.player.state.isDualAudio) this.player.ui.audio.currentTime = mainVideo.currentTime;
                this.player.showOverlay(`<img src="/static/icons/bwd.svg" class="overlay-icon" alt="Bwd">`);
            }
        }
    }

    bindEvents() {
        this.mousemove = () => this.resetInactivity();
        this.mousedown = () => this.resetInactivity();
        this.touchstart = () => this.resetInactivity();
        this.mouseleave = () => {
            if (!this.player.ui.mainVideo.paused && !this.player.menus.isAnyMenuOpen()) {
                this.player.container.classList.remove('user-active');
            }
        };
        this.keydown = (e) => this.handleGlobalKeydown(e);

        this.player.container.addEventListener('mousemove', this.mousemove);
        this.player.container.addEventListener('mousedown', this.mousedown);
        this.player.container.addEventListener('touchstart', this.touchstart);
        this.player.container.addEventListener('mouseleave', this.mouseleave);
        document.addEventListener('keydown', this.keydown);

        const controlsContainer = this.player.container.querySelector('.controls-container');
        if (controlsContainer) {
            controlsContainer.addEventListener('mouseenter', () => {
                clearTimeout(this.inactivityTimeout); 
                this.player.container.classList.add('user-active'); 
                this.player.container.classList.remove('hide-cursor');
            });
            controlsContainer.addEventListener('mouseleave', () => this.resetInactivity());
        }
    }

    destroy() {
        clearTimeout(this.inactivityTimeout);
        document.removeEventListener('keydown', this.keydown);
    }
}
