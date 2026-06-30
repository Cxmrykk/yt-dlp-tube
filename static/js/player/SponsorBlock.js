class SponsorBlock {
    constructor(player) {
        this.player = player;
        this.config = window.APP_CONFIG.sbSettings || { enabled: false, action: 'auto_skip', categories: [], colors: {}, userID: '' };
        
        this.sessionEnabled = this.config.enabled;
        
        this.segments = [];
        this.skippedUUIDs = new Set();
        this.activeSegment = null;
        this.lastPassedSegment = null; 
        this.isMutingSegment = false;
        
        this.ui = {
            container: document.getElementById('progressSb'),
            skipBtnContainer: document.getElementById('sbSkipContainer'),
            skipBtn: document.getElementById('sbSkipBtn')
        };
        
        this.colors = this.config.colors || {};
        if (!this.colors.sponsor) this.colors.sponsor = '#00d400';

        this.bindEvents();
    }

    bindEvents() {
        this.player.ui.mainVideo.addEventListener('loadedmetadata', () => this.drawMarkers());
        this.player.ui.mainVideo.addEventListener('durationchange', () => this.drawMarkers());
        this.player.ui.mainVideo.addEventListener('timeupdate', () => this.checkSegments());
        
        this.ui.skipBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this.activeSegment) this.skipSegment(this.activeSegment);
        });
    }

    load(videoId) {
        this.segments = [];
        this.skippedUUIDs.clear();
        this.activeSegment = null;
        this.lastPassedSegment = null;
        this.isMutingSegment = false;
        this.ui.container.innerHTML = '';
        this.hideSkipButton();
        
        if (!this.sessionEnabled || !this.config.categories || this.config.categories.length === 0) return;
        
        const params = new URLSearchParams({ videoID: videoId });
        // The SponsorBlock API requires repeated singular keys for arrays
        this.config.categories.forEach(c => params.append('category', c));
        params.append('actionType', 'skip');
        params.append('actionType', 'mute');
        
        fetch(`https://sponsor.ajay.app/api/skipSegments?${params.toString()}`)
            .then(r => {
                if (r.status === 404) return []; 
                if (!r.ok) throw new Error("SB API Failed");
                return r.json();
            })
            .then(data => {
                this.segments = data || [];
                if (this.player.getValidDuration() > 0) this.drawMarkers();
            })
            .catch(e => console.warn('SponsorBlock error:', e));
    }

    toggle(isEnabled) {
        this.sessionEnabled = isEnabled;
        if (!isEnabled) {
            this.hideSkipButton();
            this.ui.container.innerHTML = '';
            if (this.isMutingSegment) {
                this.isMutingSegment = false;
                if (this.player.ui.volumeSlider.value !== '0') {
                    this.player.ui.mainVideo.muted = false;
                    this.player.updateVolumeIcons();
                }
            }
        } else if (this.segments.length === 0 && this.player.state.currentVideoId) {
            this.load(this.player.state.currentVideoId);
        } else {
            this.drawMarkers();
        }
    }

    drawMarkers() {
        this.ui.container.innerHTML = '';
        if (!this.sessionEnabled || this.segments.length === 0) return;
        
        const dur = this.player.getValidDuration();
        if (dur <= 0) return;
        
        this.segments.forEach(seg => {
            const start = seg.segment[0];
            const end = seg.segment[1];
            if (start >= dur) return;
            
            const marker = document.createElement('div');
            marker.className = 'sb-marker';
            marker.style.left = `${(start / dur) * 100}%`;
            marker.style.width = `${((end - start) / dur) * 100}%`;
            marker.style.backgroundColor = this.colors[seg.category.toLowerCase()] || '#ffffff';
            this.ui.container.appendChild(marker);
        });
    }

    checkSegments() {
        if (!this.sessionEnabled || this.player.state.isScrubbing || this.segments.length === 0) {
            this.hideSkipButton();
            this.activeSegment = null;
            if (this.isMutingSegment) {
                this.isMutingSegment = false;
                if (this.player.ui.volumeSlider.value !== '0') {
                    this.player.ui.mainVideo.muted = false;
                    this.player.updateVolumeIcons();
                }
            }
            return;
        }

        const time = this.player.ui.mainVideo.currentTime;
        let active = null;
        
        for (let seg of this.segments) {
            if (time >= seg.segment[0] && time < seg.segment[1]) {
                active = seg;
                break;
            }
        }

        if (active) {
            this.lastPassedSegment = active;
            
            if (active.actionType === 'mute') {
                if (!this.isMutingSegment) {
                    this.isMutingSegment = true;
                    this.player.ui.mainVideo.muted = true;
                    this.player.updateVolumeIcons();
                    const catName = active.category.charAt(0).toUpperCase() + active.category.slice(1);
                    this.player.showOverlay(`<div style="font-weight:bold; font-size:1.1rem; color:white; border-radius: 8px;">Muting ${catName}</div>`);
                }
                this.activeSegment = active;
            } else {
                if (this.config.action === 'auto_skip') {
                    if (!this.skippedUUIDs.has(active.UUID)) {
                        this.skipSegment(active);
                    }
                } else {
                    this.activeSegment = active;
                    this.showSkipButton(active);
                }
            }
        } else {
            this.activeSegment = null;
            this.hideSkipButton();
            if (this.isMutingSegment) {
                this.isMutingSegment = false;
                if (this.player.ui.volumeSlider.value !== '0') {
                    this.player.ui.mainVideo.muted = false;
                    this.player.updateVolumeIcons();
                }
            }
        }
    }

    skipSegment(seg) {
        this.skippedUUIDs.add(seg.UUID);
        this.player.ui.mainVideo.currentTime = seg.segment[1];
        if (this.player.state.isDualAudio) {
            this.player.ui.audio.currentTime = seg.segment[1];
        }
        
        const catName = seg.category.charAt(0).toUpperCase() + seg.category.slice(1);
        this.player.showOverlay(`<div style="font-weight:bold; font-size:1.1rem; color:white; border-radius: 8px;">Skipped ${catName}</div>`);
        this.hideSkipButton();
        this.reportView(seg.UUID);
    }
    
    async reportView(uuid) {
        try { await fetch(`https://sponsor.ajay.app/api/viewedVideoSponsorTime?UUID=${uuid}`, { method: 'POST' }); } catch(e){}
    }
    
    async vote(uuid, isUpvote) {
        if (!this.config.userID) return false;
        const type = isUpvote ? 1 : 0;
        const url = `https://sponsor.ajay.app/api/voteOnSponsorTime?UUID=${uuid}&userID=${this.config.userID}&type=${type}`;
        try { 
            await fetch(url, { method: 'POST' }); 
            return true;
        } catch(e) { return false; }
    }
    
    async submitSegment(start, end, category) {
        if (!this.config.userID) return false;
        const body = {
            videoID: this.player.state.currentVideoId,
            userID: this.config.userID,
            userAgent: "ytdlptube/1.0",
            segments: [{ segment: [start, end], category: category, actionType: "skip" }]
        };
        try { 
            const r = await fetch('https://sponsor.ajay.app/api/skipSegments', {
                method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)
            });
            return r.ok;
        } catch(e) { return false; }
    }

    showSkipButton(seg) {
        const btn = this.ui.skipBtn;
        const catName = seg.category.charAt(0).toUpperCase() + seg.category.slice(1);
        btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="white" width="18px" height="18px"><path d="M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z"/></svg> Skip ${catName} (Enter)`;
        this.ui.skipBtnContainer.style.display = 'block';
    }

    hideSkipButton() {
        this.ui.skipBtnContainer.style.display = 'none';
    }

    destroy() {
        this.segments = [];
        this.skippedUUIDs.clear();
        this.ui.container.innerHTML = '';
        this.hideSkipButton();
    }
}