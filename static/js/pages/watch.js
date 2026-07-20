(function() {
    const videoUrl = window.WATCH_CONFIG.videoUrl;
    window.resumeTime = window.WATCH_CONFIG.resumeTime;
    let currentChannel = {};
    const checkIcon = `<img src="/static/icons/check.svg" style="width: 18px; height: 18px; margin-left: 4px;" alt="Subscribed">`;

    function getImgProxyUrl(url) {
        if(!url) return '';
        if(url.startsWith('/proxy/') || url.startsWith('data:')) return url;
        return `/proxy/image?url=${encodeURIComponent(url)}`;
    }

    function initDescription() {
        const fade = document.getElementById('descFade');
        if (fade.scrollHeight <= fade.clientHeight + 2) {
            fade.style.webkitMaskImage = 'none';
            fade.style.maskImage = 'none';
            fade.parentElement.style.cursor = 'auto';
            fade.parentElement.onclick = null;
        } else {
            fade.style.webkitMaskImage = 'linear-gradient(to bottom, black calc(100% - 40px), transparent 100%)';
            fade.style.maskImage = 'linear-gradient(to bottom, black calc(100% - 40px), transparent 100%)';
            fade.parentElement.style.cursor = 'pointer';
            fade.parentElement.onclick = function() { this.classList.toggle('expanded'); };
        }
    }

    function getRelativeYtUrl(fullUrl) {
        if(!fullUrl) return fullUrl;
        try {
            let u = new URL(fullUrl);
            if (u.hostname.includes('youtu.be')) return '/watch?v=' + u.pathname.substring(1);
            if (u.hostname.includes('youtube.com')) return u.pathname + u.search;
        } catch(e) {}
        return fullUrl;
    }

    let suggestedPage = 0; let suggestedLoading = false; let suggestedQuery = ""; let currentVideoId = "";
    const suggestedSentinel = document.getElementById('suggested-sentinel');
    const commentsSentinel = document.getElementById('comments-sentinel');
    
    function pingHistory() {
        if (!window.ytPlayer || !window.ytPlayer.ui || !window.ytPlayer.ui.mainVideo) return;
        const p = window.ytPlayer;
        if (p.ui.mainVideo.readyState >= 1 && currentVideoId) {
            const th_url = `https://i.ytimg.com/vi/${currentVideoId}/hqdefault.jpg`;
            const duration = p.getValidDuration() || 0;
            
            fetch('/api/history/update', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    id: currentVideoId,
                    title: document.getElementById('ui-title').innerText,
                    uploader: document.getElementById('ui-channel-name').innerText,
                    uploader_url: document.getElementById('ui-channel-link').href,
                    channel_icon: currentChannel.icon,
                    thumbnail: th_url,
                    duration: duration,
                    current_time: p.ui.mainVideo.currentTime
                }),
                keepalive: true
            }).catch(()=>{});
        }
    }

    window.appFetch(`/api/info?url=${encodeURIComponent(videoUrl)}`)
        .then(r => r.json())
        .then(data => {
            if(data.error) {
                const skel = document.getElementById('video-skeleton');
                skel.innerText = "Error: " + data.error;
                skel.style.alignItems = "center";
                skel.style.justifyContent = "center";
                return;
            }

            document.getElementById('ui-desc-label').style.display = 'block';
            document.getElementById('ui-comments-header').style.display = 'flex';
            document.getElementById('ui-upnext-header').style.display = 'block';

            const titleEl = document.getElementById('ui-title');
            titleEl.innerText = data.title;
            titleEl.classList.remove('skeleton-box', 'skel-line');
            titleEl.style.width = 'auto';
            titleEl.style.height = 'auto';

            const nameEl = document.getElementById('ui-channel-name');
            nameEl.innerText = data.uploader;
            nameEl.classList.remove('skeleton-box', 'skel-line');
            nameEl.style.width = 'auto';
            nameEl.style.color = 'white';
            nameEl.style.textDecoration = 'none';
            nameEl.style.fontWeight = 'bold';
            nameEl.style.fontSize = '1.1rem';
            nameEl.style.lineHeight = '1.2';
            nameEl.href = getRelativeYtUrl(data.uploader_url);
            
            document.getElementById('ui-channel-link').href = getRelativeYtUrl(data.uploader_url);
            
            const subsEl = document.getElementById('ui-channel-subs');
            if (data.subscriber_count) {
                subsEl.innerText = data.subscriber_count + ' subscribers';
                subsEl.classList.remove('skeleton-box', 'skel-line');
                subsEl.style.width = 'auto';
                subsEl.style.height = 'auto';
                subsEl.style.color = 'var(--text-muted)';
                subsEl.style.fontSize = '0.85rem';
            } else {
                subsEl.style.display = 'none';
            }
            
            const rawFallback = `https://ui-avatars.com/api/?name=${encodeURIComponent(data.uploader)}&background=333&color=fff`;
            const iconWrap = document.getElementById('ui-channel-link');
            iconWrap.innerHTML = `<img id="ui-channel-icon" src="${getImgProxyUrl(data.channel_icon || rawFallback)}" style="width: 44px; height: 44px; border-radius: 50%; object-fit: cover; background: #333;">`;
            currentChannel = { url: data.uploader_url, name: data.uploader, icon: data.channel_icon || rawFallback };
            
            updateSubButton(data.is_subbed);
            
            if (!data.channel_icon) {
                window.appFetch(`/api/channel_info?url=${encodeURIComponent(data.uploader_url)}`)
                    .then(r => r.json())
                    .then(cData => {
                        if (cData.icon) {
                            document.getElementById('ui-channel-icon').src = getImgProxyUrl(cData.icon);
                            currentChannel.icon = cData.icon; 
                        }
                    }).catch(e => { if (e.name !== 'AbortError') console.error("Icon fetch failed:", e); });
            }
            
            let stats = [];
            if(data.view_count) stats.push(`${data.view_count} views`);
            if(data.time_ago) stats.push(data.time_ago);
            
            const statsEl = document.getElementById('ui-video-stats');
            statsEl.innerText = stats.join(' • ');
            statsEl.classList.remove('skeleton-box');
            statsEl.style.width = 'auto';
            statsEl.style.height = 'auto';
            statsEl.style.color = 'var(--text-muted)';
            statsEl.style.fontSize = '0.95rem';
            statsEl.style.fontWeight = '500';
            statsEl.style.background = '#222';
            statsEl.style.padding = '6px 12px';

            document.getElementById('ui-desc').innerText = data.description || "No description provided.";
            initDescription();

            if (typeof window.initializePlayer === 'function') window.initializePlayer(data);

            suggestedQuery = data.search_query || data.id;
            currentVideoId = data.id;
            
            suggObserver.observe(suggestedSentinel);
            commentsObserver.observe(commentsSentinel);

            if (!suggestedLoading) loadSuggestedVideos();
            if (!commentsLoading && !commentsFinished) loadComments();

            if (window.historyInterval) clearInterval(window.historyInterval);
            window.historyInterval = setInterval(() => {
                const p = window.ytPlayer;
                if (p && p.ui && p.ui.mainVideo && !p.ui.mainVideo.paused && !p.state.isScrubbing) {
                    pingHistory();
                }
            }, 10000);
        })
        .catch(err => {
            if (err.name === 'AbortError') return;
            const skel = document.getElementById('video-skeleton');
            skel.innerText = "Failed to fetch video data.";
            skel.style.alignItems = "center";
            skel.style.justifyContent = "center";
        });

    function updateSubButton(isSubbed) {
        const btn = document.getElementById('ui-sub-btn');
        btn.style.display = 'inline-flex';
        if (isSubbed) {
            btn.className = 'btn'; btn.innerHTML = 'Subscribed ' + checkIcon;
        } else {
            btn.className = 'btn btn-danger'; btn.innerHTML = 'Subscribe';
        }
        btn.dataset.subbed = isSubbed;
    }

    window.toggleSubscribe = function() {
        const btn = document.getElementById('ui-sub-btn');
        const isSubbed = btn.dataset.subbed === 'true';
        btn.innerHTML = 'Saving...';
        
        window.appFetch('/api/toggle_sub', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(currentChannel)
        }).then(r => r.json()).then(res => {
            updateSubButton(res.is_subbed);
        }).catch(err => {
            if (err.name === 'AbortError') return;
            alert("Error toggling subscription");
            updateSubButton(isSubbed);
        });
    }

    function revealStaggeredSuggested() {
        const unrevealed = document.querySelectorAll('#suggested-grid .unrevealed');
        unrevealed.forEach((card, index) => {
            setTimeout(() => {
                if (window.pageAbortController && window.pageAbortController.signal.aborted) return;
                card.classList.remove('unrevealed');
                card.classList.add('reveal-anim');
            }, index * 80);
        });
    }
    
    function loadSuggestedVideos() {
        if (!suggestedQuery || suggestedLoading) return;
        suggestedLoading = true; 
        suggestedPage++;
        
        suggestedSentinel.style.opacity = '1';
        
        window.appFetch(`/api/videos?type=suggested&query=${encodeURIComponent(suggestedQuery)}&page=${suggestedPage}&current_id=${encodeURIComponent(currentVideoId)}`)
            .then(r => r.text())
            .then(html => {
                if(html.trim() !== '') {
                    suggestedSentinel.insertAdjacentHTML('beforebegin', html);
                    suggestedSentinel.style.opacity = '0';
                    
                    if (typeof window.syncBulkSelectionUI === 'function') window.syncBulkSelectionUI();
                    
                    const newCardsCount = document.getElementById('suggested-grid').querySelectorAll('.unrevealed').length;
                    const unlockDelay = (newCardsCount * 80) + 400;
                    
                    revealStaggeredSuggested();
                    
                    setTimeout(() => {
                        if (window.pageAbortController && window.pageAbortController.signal.aborted) return;
                        
                        suggestedLoading = false;
                        
                        const scrollArea = document.getElementById('suggested-scroll');
                        if (suggestedSentinel.getBoundingClientRect().top <= scrollArea.getBoundingClientRect().bottom + 200) {
                            loadSuggestedVideos();
                        }
                    }, unlockDelay);
                } else { 
                    suggestedSentinel.innerHTML = `
                        <div class="s-thumb" style="background: transparent; border: 2px dashed #333; display: flex; flex-direction: column; align-items: center; justify-content: center;">
                            <img src="/static/icons/no-more.svg" style="width: 32px; height: 32px;" alt="No more">
                        </div>
                        <div class="s-info" style="justify-content: center;">
                            <span class="s-channel" style="color: #555; font-weight: bold;">No more videos</span>
                        </div>
                    `;
                    suggestedSentinel.style.opacity = '1';
                    revealStaggeredSuggested();
                }
            }).catch(err => { 
                if(err.name === 'AbortError') return; 
                suggestedSentinel.style.opacity = '0';
                suggestedLoading = false;
                suggestedPage--;
            });
    }

    const suggObserver = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting && !suggestedLoading && suggestedQuery) loadSuggestedVideos();
    }, { root: document.getElementById('suggested-scroll'), rootMargin: "200px" });

    let commentsPage = 1; let commentsLoading = false; let commentsFinished = false;
    window.commentThreadMap = window.commentThreadMap || {};

    window.changeCommentSort = function() {
        commentsPage = 1; commentsFinished = false; commentsLoading = false;
        window.commentThreadMap = {};
        document.getElementById('comments-container').innerHTML = ''; loadComments();
    }

    function loadComments() {
        if (commentsFinished) return;
        commentsLoading = true;
        
        const container = document.getElementById('comments-container');
        if (commentsPage === 1) container.innerHTML = '';
        commentsSentinel.style.opacity = '1';
        
        const sortMode = document.getElementById('comment-sort').value;
        
        window.appFetch(`/api/comments?url=${encodeURIComponent(videoUrl)}&page=${commentsPage}&sort=${sortMode}`)
            .then(r => { if (!r.ok) throw new Error("Server Error"); return r.text(); })
            .then(html => {
                if (html.includes("comment-error")) {
                    commentsFinished = true;
                    if (commentsPage === 1) {
                        container.innerHTML = html;
                        commentsSentinel.style.display = 'none';
                    } else {
                        commentsSentinel.innerHTML = html;
                        commentsSentinel.style.opacity = '1';
                    }
                } else if (html.trim() !== '') {
                    const temp = document.createElement('div');
                    temp.innerHTML = html;
                    
                    const comments = Array.from(temp.querySelectorAll('.comment'));
                    
                    comments.forEach(c => {
                        const pId = c.getAttribute('data-parent');
                        if (!pId || pId === 'root' || pId === 'None') {
                            const cId = c.id.replace('comment-', '');
                            window.commentThreadMap[cId] = cId;
                        }
                    });

                    comments.forEach(comment => {
                        const cId = comment.id.replace('comment-', '');
                        let parentId = comment.getAttribute('data-parent');
                        
                        if (parentId && parentId !== 'root' && parentId !== 'None') {
                            let rootId = parentId;
                            let maxDepth = 10;
                            
                            while (maxDepth > 0) {
                                if (window.commentThreadMap[rootId] === rootId) break;
                                if (window.commentThreadMap[rootId]) {
                                    rootId = window.commentThreadMap[rootId];
                                    continue;
                                }
                                
                                let el = document.getElementById('comment-' + rootId) || temp.querySelector('#comment-' + rootId);
                                if (el) {
                                    let nextP = el.getAttribute('data-parent');
                                    if (nextP && nextP !== 'root' && nextP !== 'None') {
                                        rootId = nextP;
                                    } else {
                                        window.commentThreadMap[rootId] = rootId;
                                        break;
                                    }
                                } else {
                                    break;
                                }
                                maxDepth--;
                            }
                            
                            window.commentThreadMap[cId] = rootId; 

                            const parentBox = document.getElementById('replies-box-' + rootId) || temp.querySelector('#replies-box-' + rootId);
                            const parentContainer = document.getElementById('replies-container-' + rootId) || temp.querySelector('#replies-container-' + rootId);
                            const countEl = document.getElementById('reply-count-' + rootId) || temp.querySelector('#reply-count-' + rootId);
                            
                            if (parentContainer) {
                                comment.style.marginBottom = '12px';
                                comment.style.marginTop = '10px';
                                const img = comment.querySelector('img');
                                if (img) { img.style.width = '28px'; img.style.height = '28px'; }
                                
                                parentContainer.appendChild(comment);
                                if (parentBox) parentBox.style.display = 'block';
                                if (countEl) countEl.innerText = (parseInt(countEl.innerText) || 0) + 1;
                            } else {
                                container.appendChild(comment);
                            }
                        }
                    });
                    
                    Array.from(temp.children).forEach(child => {
                        container.appendChild(child);
                    });

                    commentsSentinel.style.opacity = '0';

                    setTimeout(() => {
                        if (window.pageAbortController && window.pageAbortController.signal.aborted) return;
                        commentsPage++; 
                        commentsLoading = false;
                    }, 300);
                } else {
                    commentsFinished = true;
                    if (commentsPage > 1) {
                        commentsSentinel.innerHTML = `<div style="padding: 10px 0; color: var(--text-muted); font-weight: bold; width: 100%;">No more comments</div>`;
                        commentsSentinel.style.opacity = '1';
                    } else {
                        commentsSentinel.style.display = 'none';
                    }
                }
            }).catch(err => {
                if(err.name === 'AbortError') return;
                commentsSentinel.style.opacity = '0';
                commentsLoading = false; 
            });
    }

    const commentsObserver = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting && !commentsLoading && !commentsFinished && suggestedQuery) loadComments();
    }, { rootMargin: "200px" });

    const handleCardHover = (e) => {
        const card = e.target.closest('.s-card');
        if (card && !card.dataset.hoverSetup) {
            card.dataset.hoverSetup = 'true';
            
            card.addEventListener('mouseenter', function() {
                const wrapper = this.querySelector('.marquee-wrapper');
                const text = this.querySelector('.marquee-text');
                if (!wrapper || !text) return;
                
                wrapper.classList.add('scrolling');
                const dist = text.scrollWidth - wrapper.clientWidth;
                
                if (dist > 0) {
                    const duration = Math.max(1.5, dist / 30);
                    text.style.transition = `transform ${duration}s linear`;
                    text.style.transform = `translateX(-${dist}px)`;
                } else {
                    wrapper.classList.remove('scrolling');
                }
            });
            
            card.addEventListener('mouseleave', function() {
                const wrapper = this.querySelector('.marquee-wrapper');
                const text = this.querySelector('.marquee-text');
                if (!wrapper || !text) return;
                
                text.style.transition = 'none';
                text.style.transform = 'translateX(0)';
                wrapper.classList.remove('scrolling');
            });
            
            card.dispatchEvent(new Event('mouseenter'));
        }
    };
    
    document.addEventListener('mouseover', handleCardHover);

    document.getElementById('comments-scroll').addEventListener('click', function(e) {
        if (e.target && e.target.classList.contains('comment-timestamp')) {
            e.preventDefault();
            let parts = e.target.innerText.split(':').map(Number);
            let secs = 0;
            if (parts.length === 3) {
                secs = parts[0] * 3600 + parts[1] * 60 + parts[2];
            } else if (parts.length === 2) {
                secs = parts[0] * 60 + parts[1];
            }
            if (window.ytPlayer) {
                window.ytPlayer.ui.mainVideo.currentTime = secs;
                if (window.ytPlayer.state.isDualAudio) {
                    window.ytPlayer.ui.audio.currentTime = secs;
                }
                window.ytPlayer.ui.mainVideo.play().catch(()=>{});
                
                const vidContainer = document.getElementById('videoContainer');
                if (vidContainer) {
                    vidContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
            }
        }
    });

    window.pageTeardown = function() {
        pingHistory(); 
        if (window.historyInterval) clearInterval(window.historyInterval);
        suggObserver.disconnect();
        commentsObserver.disconnect();
        document.removeEventListener('mouseover', handleCardHover);
        
        if (typeof window.playerCleanup === 'function') window.playerCleanup();
    };
})();
