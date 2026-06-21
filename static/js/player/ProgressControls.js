class ProgressControls {
    constructor(player) {
        this.player = player;
        this.ui = player.ui;
        this.wasPausedBeforeScrub = false;
        this.lastPreviewUpdate = 0;

        this.bindEvents();
    }

    bindEvents() {
        this.ui.mainVideo.addEventListener('loadedmetadata', () => {
            this.ui.duration.textContent = PlayerUtils.formatTime(this.player.getValidDuration());
            this.drawChapterMarkers();
        });

        this.ui.mainVideo.addEventListener('progress', () => this.updateBuffer());
        this.ui.mainVideo.addEventListener('timeupdate', () => {
            this.updateBuffer();
            const dur = this.player.getValidDuration();
            if (!this.player.state.isScrubbing && dur > 0) {
                const percent = (this.ui.mainVideo.currentTime / dur) * 100;
                this.ui.progressBar.style.width = `${percent}%`;
                this.ui.progressThumb.style.left = `${percent}%`;
                this.ui.currentTime.textContent = PlayerUtils.formatTime(this.ui.mainVideo.currentTime);
            }
        });

        this.ui.progressArea.addEventListener('mousedown', (e) => {
            this.player.state.isScrubbing = true;
            this.wasPausedBeforeScrub = this.ui.mainVideo.paused;
            this.player.container.classList.add('scrubbing');
            this.ui.mainVideo.pause();
            if (this.player.state.isDualAudio) this.ui.audio.pause();
            this.handleScrub(e);
        });

        this.globalMousemove = (e) => {
            if (this.player.state.isScrubbing) this.handleScrub(e);
        };
        this.globalMouseup = () => {
            if (this.player.state.isScrubbing) {
                this.player.state.isScrubbing = false;
                this.player.container.classList.remove('scrubbing');
                if (!this.wasPausedBeforeScrub) {
                    let p1 = this.ui.mainVideo.play();
                    let p2;
                    if (this.player.state.isDualAudio) p2 = this.ui.audio.play();
                    if (p1) p1.catch(()=>{});
                    if (p2) p2.catch(()=>{});
                    this.ui.playIcon.style.display = 'none';
                    this.ui.pauseIcon.style.display = 'block';
                    this.player.container.classList.remove('paused');
                }
            }
        };

        document.addEventListener('mousemove', this.globalMousemove);
        document.addEventListener('mouseup', this.globalMouseup);

        this.ui.progressArea.addEventListener('mousemove', (e) => this.handleHover(e));
    }

    updateBuffer() {
        const dur = this.player.getValidDuration();
        const mainVideo = this.ui.mainVideo;
        if (dur > 0 && mainVideo.buffered.length > 0) {
            for (let i = 0; i < mainVideo.buffered.length; i++) {
                if (mainVideo.buffered.start(mainVideo.buffered.length - 1 - i) <= mainVideo.currentTime) {
                    const bufferedEnd = mainVideo.buffered.end(mainVideo.buffered.length - 1 - i);
                    this.ui.progressLoaded.style.width = `${(bufferedEnd / dur) * 100}%`;
                    break;
                }
            }
        }
    }

    handleScrub(e) {
        const dur = this.player.getValidDuration();
        if (dur <= 0) return;
        const rect = this.ui.progressArea.getBoundingClientRect();
        let percent = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        
        this.ui.progressBar.style.width = `${percent * 100}%`;
        this.ui.progressThumb.style.left = `${percent * 100}%`;
        
        const scrubTime = percent * dur;
        if (isFinite(scrubTime)) {
            this.ui.mainVideo.currentTime = scrubTime;
            if (this.player.state.isDualAudio) this.ui.audio.currentTime = scrubTime;
            this.ui.currentTime.textContent = PlayerUtils.formatTime(scrubTime);
        }
    }

    handleHover(e) {
        const dur = this.player.getValidDuration();
        const rect = this.ui.progressArea.getBoundingClientRect();
        let percent = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const hoverTime = percent * dur;
        
        this.ui.hoverTime.textContent = PlayerUtils.formatTime(hoverTime);
        
        const chapters = this.player.state.videoChapters;
        if (chapters && chapters.length > 0) {
            let currentCh = chapters[0];
            for (let i = 0; i < chapters.length; i++) {
                if (hoverTime >= chapters[i].start_time) currentCh = chapters[i];
                else break;
            }
            this.ui.hoverChapter.textContent = currentCh.title;
        } else {
            this.ui.hoverChapter.textContent = '';
        }

        const tooltipWidth = 200;
        let pixelPos = percent * rect.width;
        let clampedPos = Math.max(tooltipWidth / 2, Math.min(rect.width - (tooltipWidth / 2), pixelPos));
        this.ui.hoverTooltip.style.left = `${clampedPos}px`;
        
        if (isFinite(hoverTime) && !this.ui.previewVideo.seeking && Date.now() - this.lastPreviewUpdate > 100 && this.ui.previewVideo.readyState >= 1) {
            this.ui.previewVideo.currentTime = hoverTime;
            this.lastPreviewUpdate = Date.now();
        }
    }

    drawChapterMarkers() {
        const dur = this.player.getValidDuration();
        if (dur <= 0 || !this.player.state.videoChapters || this.player.state.videoChapters.length === 0) return;
        
        this.ui.progressTrack.querySelectorAll('.chapter-marker').forEach(e => e.remove());
        
        this.player.state.videoChapters.forEach(ch => {
            const percent = (ch.start_time / dur) * 100;
            if (percent > 0 && percent < 100) {
                const marker = document.createElement('div');
                marker.className = 'chapter-marker';
                marker.style.left = `${percent}%`;
                this.ui.progressTrack.appendChild(marker);
            }
        });
    }

    destroy() {
        document.removeEventListener('mousemove', this.globalMousemove);
        document.removeEventListener('mouseup', this.globalMouseup);
    }
}