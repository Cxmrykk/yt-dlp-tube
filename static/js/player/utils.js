window.PlayerUtils = {
    getValidDuration: function(vid) {
        return (vid && typeof vid.duration === 'number' && !isNaN(vid.duration) && isFinite(vid.duration)) ? vid.duration : 0;
    },
    formatTime: function(seconds) {
        if (isNaN(seconds)) return "0:00";
        const minutes = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${minutes}:${secs < 10 ? '0' : ''}${secs}`;
    },
    getMediaProxyUrl: function(url) {
        if(!url) return '';
        if(url.startsWith('/proxy/')) return url;
        return `/proxy/media?url=${encodeURIComponent(url)}`;
    },
    getSubProxyUrl: function(url) {
        if(!url) return '';
        if(url.startsWith('/proxy/')) return url;
        return `/proxy/subtitles?url=${encodeURIComponent(url)}`;
    },
    hex2rgb: function(hex) {
        const match = hex.replace('#','').match(/.{1,2}/g);
        return {
            r: parseInt(match[0], 16),
            g: parseInt(match[1], 16),
            b: parseInt(match[2], 16)
        };
    }
};