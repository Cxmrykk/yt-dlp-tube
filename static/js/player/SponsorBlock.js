class SponsorBlock {
    constructor(player) {
        this.player = player;
        this.config = window.APP_CONFIG.sbSettings || { enabled: false, action: 'auto_skip', categories: [] };
        
        // Use a session-level toggle overridable via the menu
        this.sessionEnabled = this.config.enabled;
        
        this.segments = [];
        this.skippedUUIDs = new Set();
        this.activeSegment = null;
        
        this.ui = {
            container: document.getElementById('progressSb'),
            skipBtnContainer: document.getElementById('sbSkipContainer'),
            skipBtn: document.getElementById('sbSkipBtn')
        };
        
        // Standard SponsorBlock hex mappings
        this.colors = {
            sponsor: '#00d400',
            intro: '#00ffff',
            outro: '#0202ed',
            interaction: '#cc00ff',
            selfpromo: '#ffff00',
            music_offtopic: '#ff9900',
            preview: '#008fd6',
            poi_highlight: '#ff1684',
            filler: '#7300FF',
            exclusive_access: '#008a5c'
        };

        this.bindEvents();
    }

    bindEvents() {
        this.player.ui.mainVideo.addEventListener('loadedmetadata', () => this.drawMarkers());
        this.player.ui.mainVideo.addEventListener('timeupdate', () => this.checkSegments());
        
        this.ui.skipBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this.activeSegment) this.skipSegment(this.activeSegment);
        });
    }

    load(videoId) {
        this.segments = [];
        this.skippedUUIDs.clear();
        this.ui.container.innerHTML = '';
        this.hideSkipButton();
        
        if (!this.sessionEnabled || !this.config.categories || this.config.categories.length === 0) return;
        
        const params = new URLSearchParams({ videoID: videoId });
        this.config.categories.forEach(c => params.append('categories', c));
        
        fetch(`https://sponsor.ajay.app/api/skipSegments?${params.toString()}`)
            .then(r => {
                if (r.status === 404) return []; // No segments found
                if (!r.ok) throw new Error("SB API Failed");
                return r.json();
            })
            .then(data => {
                this.segments = data || [];
                // If duration is already valid, draw immediately.
                if (this.player.getValidDuration() > 0) this.drawMarkers();
            })
            .catch(e => console.warn('SponsorBlock error:', e));
    }

    toggle(isEnabled) {
        this.sessionEnabled = isEnabled;
        if (!isEnabled) {
            this.hideSkipButton();
            this.ui.container.innerHTML = '';
        } else if (this.segments.length === 0 && this.player.state.currentVideoId) {
            // Re-fetch if they turned it back on and we haven't loaded them yet
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
            if (this.config.action === 'auto_skip') {
                if (!this.skippedUUIDs.has(active.UUID)) {
                    this.skipSegment(active);
                }
            } else {
                this.activeSegment = active;
                this.showSkipButton(active);
            }
        } else {
            this.activeSegment = null;
            this.hideSkipButton();
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
