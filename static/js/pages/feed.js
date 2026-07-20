(function() {
    let page = 1;
    let loading = false;
    const reqType = window.FEED_CONFIG.type;
    const reqQuery = window.FEED_CONFIG.query;
    const sentinel = document.getElementById('sentinel-card');
    
    function revealStaggered() {
        const unrevealed = document.querySelectorAll('.unrevealed');
        unrevealed.forEach((card, index) => {
            setTimeout(() => {
                if (window.pageAbortController && window.pageAbortController.signal.aborted) return;
                card.classList.remove('unrevealed');
                card.classList.add('reveal-anim');
            }, index * 80);
        });
    }
    
    function loadVideos() {
        if (loading) return;
        loading = true;
        sentinel.style.opacity = '1';
        
        window.appFetch(`/api/videos?type=${reqType}&query=${encodeURIComponent(reqQuery)}&page=${page}`)
            .then(r => r.text())
            .then(html => {
                if(html.trim() !== '') {
                    page++; 
                    
                    sentinel.insertAdjacentHTML('beforebegin', html);
                    sentinel.style.opacity = '0';
                    
                    if (typeof window.syncBulkSelectionUI === 'function') window.syncBulkSelectionUI();
                    
                    const newCardsCount = document.querySelectorAll('.unrevealed').length;
                    const unlockDelay = (newCardsCount * 80) + 400; 
                    
                    revealStaggered();
                    
                    setTimeout(() => {
                        if (window.pageAbortController && window.pageAbortController.signal.aborted) return;
                        
                        loading = false;
                        
                        const rect = sentinel.getBoundingClientRect();
                        if (rect.top <= window.innerHeight + 200) {
                            loadVideos();
                        }
                    }, unlockDelay);
                } else {
                    sentinel.innerHTML = `
                        <div class="thumbnail" style="background: transparent; border: 2px dashed #333; display: flex; flex-direction: column; align-items: center; justify-content: center;">
                            <img src="/static/icons/no-more.svg" style="width: 48px; height: 48px; margin-bottom: 8px;" alt="No more">
                            <span style="color: #555; font-weight: bold; font-size: 1.1rem; text-align: center;">No more videos</span>
                        </div>
                    `;
                    sentinel.style.opacity = '1';
                    loading = true; 
                }
            })
            .catch(err => {
                if (err.name === 'AbortError') return;
                sentinel.innerHTML = `<div style="padding: 20px; text-align: center; color: var(--text-muted); font-weight: bold;">Error loading videos.</div>`;
                sentinel.style.opacity = '1';
                loading = false;
            });
    }

    const observer = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting && !loading) {
            loadVideos();
        }
    }, { rootMargin: "200px" });

    observer.observe(sentinel);

    window.pageTeardown = function() {
        observer.disconnect();
    };
})();
