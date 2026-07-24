window.pageAbortController = new AbortController();

window.appFetch = function(url, options = {}) {
    return fetch(url, { ...options, signal: window.pageAbortController.signal });
};

document.addEventListener('DOMContentLoaded', () => {
    const logo = document.querySelector('nav a.logo');
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');

    if (logo && sidebar && overlay) {
        logo.addEventListener('click', (e) => {
            // Check if we are in mobile portrait mode
            const isPortraitMobile = window.matchMedia('(max-width: 768px) and (orientation: portrait)').matches;
            
            if (isPortraitMobile) {
                e.preventDefault();
                e.stopPropagation(); // Prevent PJAX from intercepting the link click
                sidebar.classList.toggle('open');
                overlay.classList.toggle('open');
            }
        });

        overlay.addEventListener('click', () => {
            sidebar.classList.remove('open');
            overlay.classList.remove('open');
        });
        
        document.addEventListener('click', (e) => {
            const isPortraitMobile = window.matchMedia('(max-width: 768px) and (orientation: portrait)').matches;
            
            if (isPortraitMobile && sidebar.classList.contains('open')) {
                const a = e.target.closest('a');
                if (a && a !== logo && sidebar.contains(a)) {
                    sidebar.classList.remove('open');
                    overlay.classList.remove('open');
                }
            }
        });
    }
});
