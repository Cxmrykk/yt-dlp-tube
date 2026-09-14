(function() {
    window.FeedManager = {
        page: 1,
        loading: false,
        reqType: window.FEED_CONFIG.type,
        reqQuery: window.FEED_CONFIG.query,
        reqTab: window.FEED_CONFIG.tab || "",
        sentinel: document.getElementById('sentinel-card'),
        observer: null,
        currentRequestNum: 0,
        
        revealStaggered: function() {
            const unrevealed = document.querySelectorAll('.unrevealed');
            unrevealed.forEach((card, index) => {
                setTimeout(() => {
                    if (window.pageAbortController && window.pageAbortController.signal.aborted) return;
                    card.classList.remove('unrevealed');
                    card.classList.add('reveal-anim');
                }, index * 80);
            });
        },
        
        loadVideos: function() {
            if (this.loading) return;
            this.loading = true;
            this.sentinel.style.opacity = '1';
            
            const reqNum = ++this.currentRequestNum;
            
            let apiUrl = `/api/videos?type=${this.reqType}&query=${encodeURIComponent(this.reqQuery)}&page=${this.page}`;
            if (this.reqTab) {
                apiUrl += `&tab=${encodeURIComponent(this.reqTab)}`;
            }
            
            window.appFetch(apiUrl)
                .then(r => r.text())
                .then(html => {
                    if (this.currentRequestNum !== reqNum) return;
                    
                    if(html.trim() !== '') {
                        this.page++; 
                        
                        this.sentinel.insertAdjacentHTML('beforebegin', html);
                        this.sentinel.style.opacity = '0';
                        
                        if (typeof window.syncBulkSelectionUI === 'function') window.syncBulkSelectionUI();
                        
                        const newCardsCount = document.querySelectorAll('.unrevealed').length;
                        const unlockDelay = (newCardsCount * 80) + 400; 
                        
                        this.revealStaggered();
                        
                        setTimeout(() => {
                            if (window.pageAbortController && window.pageAbortController.signal.aborted) return;
                            if (this.currentRequestNum !== reqNum) return;
                            
                            this.loading = false;
                            
                            const rect = this.sentinel.getBoundingClientRect();
                            if (rect.top <= window.innerHeight + 200) {
                                this.loadVideos();
                            }
                        }, unlockDelay);
                    } else {
                        let noMoreText = "No more videos";
                        if (this.reqTab === 'shorts') noMoreText = "No shorts found";
                        else if (this.reqTab === 'streams') noMoreText = "No livestreams found";
                        else if (this.reqTab === 'releases') noMoreText = "No releases found";
                        else if (this.reqTab === 'podcasts') noMoreText = "No podcasts found";
                        
                        this.sentinel.innerHTML = `
                            <div class="thumbnail" style="background: transparent; border: 2px dashed #333; display: flex; flex-direction: column; align-items: center; justify-content: center;">
                                ${window.icon('no-more', '', 'width:48px;height:48px;margin-bottom:8px;color:#444;')}
                                <span style="color: #555; font-weight: bold; font-size: 1.1rem; text-align: center;">${noMoreText}</span>
                            </div>
                        `;
                        this.sentinel.style.opacity = '1';
                        this.loading = true;
                    }
                })
                .catch(err => {
                    if (this.currentRequestNum !== reqNum) return;
                    if (err.name === 'AbortError') return;
                    this.sentinel.innerHTML = `<div style="padding: 20px; text-align: center; color: var(--text-muted); font-weight: bold;">Error loading videos.</div>`;
                    this.sentinel.style.opacity = '1';
                    this.loading = false;
                });
        },

        init: function() {
            this.observer = new IntersectionObserver((entries) => {
                if (entries[0].isIntersecting && !this.loading) {
                    this.loadVideos();
                }
            }, { rootMargin: "200px" });

            this.observer.observe(this.sentinel);

            const oldTeardown = window.pageTeardown;
            window.pageTeardown = () => {
                if (oldTeardown) oldTeardown();
                if (this.observer) this.observer.disconnect();
            };
        },

        resetTab: function(newTab) {
            this.currentRequestNum++;
            this.reqTab = newTab;
            this.page = 1;
            this.loading = false;
            
            const grid = document.getElementById('video-grid');
            const cards = grid.querySelectorAll('.video-card:not(#sentinel-card)');
            cards.forEach(c => c.remove());
            
            this.sentinel.style.opacity = '1';
            this.sentinel.innerHTML = `
                <div class="thumbnail skeleton-box"></div>
                <div class="video-info">
                    <div class="skel-line skeleton-box title"></div>
                    <div class="skel-row">
                        <div class="channel-avatar skeleton-box skel-circle"></div>
                        <div class="skel-col">
                            <div class="skel-line skeleton-box"></div>
                            <div class="skel-line skeleton-box short"></div>
                        </div>
                    </div>
                </div>
            `;
            
            this.loadVideos();
        }
    };

    window.FeedManager.init();
})();
