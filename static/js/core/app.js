window.pageAbortController = new AbortController();

window.appFetch = function(url, options = {}) {
    return fetch(url, { ...options, signal: window.pageAbortController.signal });
};
