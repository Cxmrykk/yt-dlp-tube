(function() {
    const container = document.getElementById('videoContainer');
    if (container && typeof PlayerCore !== 'undefined') {
        window.ytPlayer = new PlayerCore(container);
    } else {
        console.error("PlayerCore class not found. Ensure JS files are loaded in base.html.");
    }
    
    window.initializePlayer = function(data) {
        if (window.ytPlayer) window.ytPlayer.loadVideoData(data);
    };
    
    window.playerCleanup = function() {
        if (window.ytPlayer) {
            window.ytPlayer.destroy();
            window.ytPlayer = null;
        }
    };
    
    window.updateCcStyles = function() {
        if (window.ytPlayer) window.ytPlayer.subtitles.updateCcStyles();
    };
})();
