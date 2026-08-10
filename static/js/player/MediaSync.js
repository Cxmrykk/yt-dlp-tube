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

        if (mainVideo.readyState >= 3 && audio.readyState >= 3) {
            const diff = mainVideo.currentTime - audio.currentTime;
            
            if (Math.abs(diff) > 2.0) {
                audio.currentTime = mainVideo.currentTime;
            } else {
                if (diff > 0.15) audio.playbackRate = mainVideo.playbackRate + 0.1;
                else if (diff < -0.15) audio.playbackRate = Math.max(0.1, mainVideo.playbackRate - 0.1);
                else if (audio.playbackRate !== mainVideo.playbackRate) audio.playbackRate = mainVideo.playbackRate;
            }
        } else if (audio.readyState < 3 && !mainVideo.paused) {
            mainVideo.pause();
            this.player.container.classList.add('buffering');
        }
    }

    setupMediaSync() {
        const mainVideo = this.player.ui.mainVideo;
        const audio = this.player.ui.audio;

        const forceSync = () => {
            if (this.player.state.isDualAudio) {
                audio.currentTime = mainVideo.currentTime;
            }
        };

        mainVideo.addEventListener('seeking', forceSync);
        mainVideo.addEventListener('seeked', forceSync);
        
        mainVideo.addEventListener('waiting', () => {
            if (this.player.state.isDualAudio) audio.pause();
        });

        mainVideo.addEventListener('playing', () => { 
            if (this.player.state.isDualAudio && audio.paused && !mainVideo.paused && !this.player.state.userPaused) {
                audio.play().catch(()=>{});
            }
        });
        
        audio.addEventListener('waiting', () => {
            if (this.player.state.isDualAudio && !mainVideo.paused) {
                mainVideo.pause();
                this.player.container.classList.add('buffering');
            }
        });

        audio.addEventListener('canplay', () => {
            if (this.player.state.isDualAudio && mainVideo.paused && !this.player.state.userPaused && !this.player.state.isScrubbing) {
                this.player.container.classList.remove('buffering');
                mainVideo.play().catch(()=>{});
                audio.play().catch(()=>{});
            }
        });

        this.syncInterval = setInterval(() => {
            if (this.player.state.isDualAudio) {
                if (!mainVideo.paused && audio.paused && !this.player.state.userPaused) {
                    audio.currentTime = mainVideo.currentTime;
                    audio.play().catch(() => {});
                }

                if (!mainVideo.paused && !this.player.state.isScrubbing) {
                    this.syncAudio();
                }
            }
        }, 500);
    }

    destroy() {
        if (this.syncInterval) clearInterval(this.syncInterval);
    }
}
