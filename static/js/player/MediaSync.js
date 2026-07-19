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

        // Only adjust sync if both streams are actively buffered and ready in memory
        if (mainVideo.readyState >= 3 && audio.readyState >= 3) {
            const diff = mainVideo.currentTime - audio.currentTime;
            
            // Hard sync only for massive drift (e.g., stalled buffer for > 2 seconds)
            if (Math.abs(diff) > 2.0) {
                audio.currentTime = mainVideo.currentTime;
            } else {
                // Gentle speed modifier for seamless, crunch-free catch-up
                if (diff > 0.15) audio.playbackRate = mainVideo.playbackRate + 0.1;
                else if (diff < -0.15) audio.playbackRate = Math.max(0.1, mainVideo.playbackRate - 0.1);
                else if (audio.playbackRate !== mainVideo.playbackRate) audio.playbackRate = mainVideo.playbackRate;
            }
        } else if (audio.readyState < 3 && !mainVideo.paused) {
            // Audio ran out of buffer while the video was playing. Group Play Lock!
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

        // Explicitly tie hard seeking ONLY to user timeline scrubbing
        mainVideo.addEventListener('seeking', forceSync);
        mainVideo.addEventListener('seeked', forceSync);
        
        // If main video natively buffers, pause audio so it doesn't run ahead
        mainVideo.addEventListener('waiting', () => {
            if (this.player.state.isDualAudio) audio.pause();
        });

        // When main video naturally resumes, resume audio
        mainVideo.addEventListener('playing', () => { 
            if (this.player.state.isDualAudio && audio.paused && !mainVideo.paused) {
                audio.play().catch(()=>{});
            }
        });
        
        // If audio natively buffers, pause the video and show loading (Group Lock)
        audio.addEventListener('waiting', () => {
            if (this.player.state.isDualAudio && !mainVideo.paused) {
                mainVideo.pause();
                this.player.container.classList.add('buffering');
            }
        });

        // When audio regains its buffer, unlock the video and resume both
        audio.addEventListener('canplay', () => {
            if (this.player.state.isDualAudio && mainVideo.paused && !this.player.container.classList.contains('paused') && !this.player.state.isScrubbing) {
                this.player.container.classList.remove('buffering');
                mainVideo.play().catch(()=>{});
                audio.play().catch(()=>{});
            }
        });

        this.syncInterval = setInterval(() => {
            if (this.player.state.isDualAudio && !mainVideo.paused && !this.player.state.isScrubbing) {
                this.syncAudio();
            }
        }, 500);
    }

    destroy() {
        if (this.syncInterval) clearInterval(this.syncInterval);
    }
}
