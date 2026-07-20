(function() {
    const config = window.CHANNEL_CONFIG;
    let currentChannel = { url: config.url, name: config.name, icon: config.icon };
    let isSubbed = config.isSubbed;
    const checkIcon = `<img src="/static/icons/check.svg" style="width: 18px; height: 18px; margin-left: 4px;" alt="Subscribed">`;

    function getImgProxyUrl(url) {
        if(!url) return '';
        if(url.startsWith('/proxy/') || url.startsWith('data:')) return url;
        return `/proxy/image?url=${encodeURIComponent(url)}`;
    }
    
    if (config.needsFetch) {
        window.appFetch(`/api/channel_info?url=${encodeURIComponent(config.url)}`)
            .then(r => r.json())
            .then(data => {
                document.getElementById('ch-name').classList.remove('skeleton-box', 'skel-line');
                document.getElementById('ch-name').style.width = 'auto';
                document.getElementById('ch-name').style.height = 'auto';
                document.getElementById('ch-name').innerText = data.name;
                
                const subsEl = document.getElementById('ch-subs');
                subsEl.classList.remove('skeleton-box', 'skel-line');
                subsEl.style.width = 'auto';
                if (data.subscriber_count) subsEl.innerText = data.subscriber_count + ' subscribers';
                else subsEl.style.display = 'none';

                currentChannel.name = data.name;
                
                const rawFallback = `https://ui-avatars.com/api/?name=${encodeURIComponent(data.name)}&background=333&color=fff`;
                const iconEl = document.getElementById('ch-icon');
                iconEl.src = getImgProxyUrl(data.icon || rawFallback);
                iconEl.style.display = 'block';
                document.getElementById('ch-icon-skel').style.display = 'none';
                
                currentChannel.icon = data.icon || rawFallback;
                
                isSubbed = data.is_subbed;
                updateSubButton();
            }).catch(err => { if (err.name !== 'AbortError') console.error(err); });
    } else {
        updateSubButton();
        window.appFetch(`/api/channel_info?url=${encodeURIComponent(config.url)}`)
            .then(r => r.json())
            .then(data => { if (data.subscriber_count) document.getElementById('ch-subs').innerText = data.subscriber_count + ' subscribers'; })
            .catch(err => { if (err.name !== 'AbortError') console.error(err); });
    }

    function updateSubButton() {
        const btn = document.getElementById('sub-btn');
        btn.style.display = 'inline-flex';
        if (isSubbed) { btn.className = 'btn'; btn.innerHTML = 'Subscribed ' + checkIcon; } 
        else { btn.className = 'btn btn-danger'; btn.innerHTML = 'Subscribe'; }
    }

    window.toggleSubscribe = function() {
        const btn = document.getElementById('sub-btn'); btn.innerHTML = 'Saving...';
        window.appFetch('/api/toggle_sub', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(currentChannel)
        }).then(r => r.json()).then(res => { isSubbed = res.is_subbed; updateSubButton();
        }).catch(err => { 
            if (err.name === 'AbortError') return;
            alert("Error toggling subscription"); updateSubButton(); 
        });
    }

    // Pass off to feed.js logic via simulated config
    window.FEED_CONFIG = { type: "channel", query: config.url };
    const script = document.createElement('script');
    script.src = '/static/js/pages/feed.js';
    document.body.appendChild(script);
})();
