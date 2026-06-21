class MediaSync {
    constructor(player) {
        this.player = player;
        this.syncInterval = null;
        this.setupMediaSync();
    }

    syncAudio() {
        if (!this.player.state.isDualAudio) return;
        const mainVideo = this.player.ui.mainVideo;
        const audio = this.player.ui.audio;

        if (isFinite(mainVideo.currentTime) && isFinite(audio.currentTime)) {
            const diff = mainVideo.currentTime - audio.currentTime;
            
            if (Math.abs(diff) > 1.0) {
                audio.currentTime = mainVideo.currentTime;
            } else if (audio.readyState >= 3) {
                if (diff > 0.15) audio.playbackRate = mainVideo.playbackRate + 0.1;
                else if (diff < -0.15) audio.playbackRate = Math.max(0.1, mainVideo.playbackRate - 0.1);
                else if (audio.playbackRate !== mainVideo.playbackRate) audio.playbackRate = mainVideo.playbackRate;
            }
        }
    }

    setupMediaSync() {
        const mainVideo = this.player.ui.mainVideo;
        const audio = this.player.ui.audio;

        const forceSync = () => {
            if (this.player.state.isDualAudio) audio.currentTime = mainVideo.currentTime;
        };

        mainVideo.addEventListener('seeking', forceSync);
        mainVideo.addEventListener('seeked', forceSync);
        
        mainVideo.addEventListener('waiting', () => {
            if (this.player.state.isDualAudio) audio.pause();
        });
        mainVideo.addEventListener('playing', () => { 
            if (this.player.state.isDualAudio && audio.paused && !mainVideo.paused) {
                audio.play().catch(()=>{});
            }
        });
        
        this.syncInterval = setInterval(() => {
            if (this.player.state.isDualAudio && !mainVideo.paused && !this.player.state.isScrubbing && mainVideo.readyState >= 3) {
                this.syncAudio();
            }
        }, 500);
    }

    destroy() {
        if (this.syncInterval) clearInterval(this.syncInterval);
    }
}