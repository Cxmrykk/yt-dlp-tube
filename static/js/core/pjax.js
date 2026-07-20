document.addEventListener('click', e => {
    if (window.bulkMode) {
        const card = e.target.closest('.video-card');
        if (card) {
            const a = card.querySelector('a');
            if (a) {
                e.preventDefault();
                e.stopPropagation();
                const url = new URL(a.href, window.location.origin);
                let vid = new URLSearchParams(url.search).get('v');
                if (!vid && url.pathname.includes('/watch')) vid = new URLSearchParams(url.search).get('v');
                if (vid) {
                    if (window.bulkSelection.has(vid)) {
                        window.bulkSelection.delete(vid);
                        card.classList.remove('selected-for-bulk');
                    } else {
                        window.bulkSelection.add(vid);
                        card.classList.add('selected-for-bulk');
                    }
                    if (typeof window.updateBulkNextBtn === 'function') window.updateBulkNextBtn();
                    if (typeof window.saveBulkState === 'function') window.saveBulkState();
                }
                return;
            }
        }
    }

    const a = e.target.closest('a');
    if (!a || !a.href) return;
    const url = new URL(a.href);
    
    if (url.origin !== window.location.origin) return;
    if (a.target === '_blank' || a.hasAttribute('download') || a.hasAttribute('data-no-pjax')) return;
    if (e.ctrlKey || e.metaKey || e.shiftKey) return;

    e.preventDefault();
    navigateTo(url.href, true);
});

document.addEventListener('submit', e => {
    const form = e.target;
    if (form.hasAttribute('data-no-pjax') || form.enctype === 'multipart/form-data') return;
    e.preventDefault();

    const actionPath = form.getAttribute('action');
    const url = new URL(actionPath || window.location.href, window.location.href);
    const formData = new FormData(form);
    const method = (form.method || 'GET').toUpperCase();

    let fetchOpts = { method };
    if (method === 'GET') {
        const params = new URLSearchParams(formData);
        url.search = params.toString();
    } else {
        fetchOpts.body = new URLSearchParams(formData);
        fetchOpts.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    }

    navigateTo(url.href, true, fetchOpts);
});

window.addEventListener('popstate', (e) => {
    if (e.state && e.state.pjax) {
        navigateTo(window.location.href, false, { _restoreScroll: e.state.scrollPos });
    } else {
        navigateTo(window.location.href, false, { _restoreScroll: 0 });
    }
});

async function navigateTo(url, pushState, fetchOpts = {}) {
    const pb = document.getElementById('pjax-progress');
    pb.style.width = '30%'; pb.style.opacity = '1';
    
    if (window.pageAbortController) window.pageAbortController.abort();
    window.pageAbortController = new AbortController();
    
    if (typeof window.pageTeardown === 'function') window.pageTeardown();
    window.pageTeardown = null; 

    const mainEl = document.getElementById('main-content');
    if (pushState) {
        history.replaceState({ scrollPos: mainEl.scrollTop, pjax: true }, '', window.location.href);
    }

    try {
        fetchOpts.signal = window.pageAbortController.signal;
        const resp = await fetch(url, fetchOpts);
        const finalUrl = resp.url;

        pb.style.width = '70%';
        const html = await resp.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const newContent = doc.querySelector('#main-content');
        
        if (!newContent) throw new Error('No main content found');

        mainEl.innerHTML = newContent.innerHTML;
        document.title = doc.title;
        
        if (pushState) history.pushState({ scrollPos: 0, pjax: true }, '', finalUrl);
        
        if (typeof window.syncBulkSelectionUI === 'function') window.syncBulkSelectionUI(); 

        pb.style.width = '100%';
        setTimeout(() => { pb.style.opacity = '0'; setTimeout(() => pb.style.width = '0%', 300); }, 300);

        const scripts = mainEl.querySelectorAll('script');
        scripts.forEach(oldScript => {
            const newScript = document.createElement('script');
            if (oldScript.src) newScript.src = oldScript.src;
            else newScript.textContent = oldScript.textContent;
            oldScript.parentNode.replaceChild(newScript, oldScript);
        });
        
        mainEl.scrollTop = fetchOpts._restoreScroll || 0;

    } catch(e) {
        if (e.name !== 'AbortError') {
            console.error("PJAX Navigation failed, hard loading...", e);
            window.location.href = url;
        }
    }
}

document.addEventListener("DOMContentLoaded", () => {
    const sidebar = document.getElementById('sidebar');
    if (sidebar) {
        let scrollTimeout;
        sidebar.addEventListener('scroll', function() {
            clearTimeout(scrollTimeout);
            scrollTimeout = setTimeout(() => { sessionStorage.setItem('sidebarScrollPos', sidebar.scrollTop); }, 100);
        });
        const scrollPos = sessionStorage.getItem('sidebarScrollPos');
        if (scrollPos) sidebar.scrollTop = parseInt(scrollPos, 10);
    }
});
