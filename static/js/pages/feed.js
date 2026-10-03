(function() {
    // How many consecutive pages may come back entirely made of duplicates before
    // we give up and treat the list as finished. Prevents an infinite fetch loop.
    const MAX_EMPTY_PAGES = 3;

    window.FeedManager = {
        page: 1,
        loading: false,
        reqType: window.FEED_CONFIG.type,
        reqQuery: window.FEED_CONFIG.query,
        reqTab: window.FEED_CONFIG.tab || "",
        sentinel: document.getElementById('sentinel-card'),
        observer: null,
        currentRequestNum: 0,
        seenIds: new Set(),
        emptyPages: 0,
        
        getVideoId: function(card) {
            const a = card.querySelector('a[href]');
            if (!a) return null;
            try {
                const url = new URL(a.getAttribute('href'), window.location.origin);
                return url.searchParams.get('v');
            } catch (e) {
                return null;
            }
        },

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

        showNoMore: function() {
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
                    
                    if (html.trim() === '') {
                        this.showNoMore();
                        return;
                    }

                    this.page++;

                    // Parse off-DOM and drop any card whose video is already on screen.
                    const tpl = document.createElement('template');
                    tpl.innerHTML = html;
                    let added = 0;
                    tpl.content.querySelectorAll('.video-card').forEach(card => {
                        const vid = this.getVideoId(card);
                        if (vid) {
                            if (this.seenIds.has(vid)) {
                                card.remove();
                                return;
                            }
                            this.seenIds.add(vid);
                        }
                        added++;
                    });

                    if (added === 0) {
                        // The whole page was duplicates; that is not the end of the
                        // list, so move on to the next page instead.
                        this.emptyPages++;
                        this.loading = false;
                        if (this.emptyPages >= MAX_EMPTY_PAGES) {
                            this.showNoMore();
                        } else {
                            this.loadVideos();
                        }
                        return;
                    }
                    this.emptyPages = 0;

                    this.sentinel.parentNode.insertBefore(tpl.content, this.sentinel);
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
            this.seenIds = new Set();
            this.emptyPages = 0;
            
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
