(function() {
    'use strict';

    // Mirrors FETCH_FILE_TTL_SECS in src/youtube.py. Counted down client-side so
    // the Save button is never left pointing at a file the server already deleted.
    const FILE_TTL_SECS = 600;
    const POLL_MS = 1000;

    let analyzeTaskId = null;
    let downloadTaskId = null;
    let pollTimer = null;
    let expiryTimer = null;
    let targetUrl = "";
    let busy = false;

    const elInput = document.getElementById('fetch-step-input');
    const elLoading = document.getElementById('fetch-step-loading');
    const elSelect = document.getElementById('fetch-step-select');
    const elProgress = document.getElementById('fetch-step-progress');
    const elComplete = document.getElementById('fetch-step-complete');
    const elError = document.getElementById('fetchErrorBox');

    const urlInput = document.getElementById('fetchUrl');
    const loadingText = document.getElementById('fetchLoadingText');
    const analyzeBtn = document.getElementById('fetchAnalyzeBtn');
    const saveBtn = document.getElementById('fetchSaveBtn');
    const expiryText = document.getElementById('fetchExpiryText');
    const progressBar = document.getElementById('fetchProgressBar');
    const progressText = document.getElementById('fetchProgressText');
    const titleEl = document.getElementById('fetchTargetTitle');
    const listEl = document.getElementById('fetchFormatList');

    function isAbort(err) {
        return !!err && err.name === 'AbortError';
    }

    function showError(msg) {
        elError.textContent = msg;
        elError.style.display = 'block';
    }

    function hideError() {
        elError.style.display = 'none';
        elError.textContent = '';
    }

    function stopPolling() {
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
    }

    function poll(fn) {
        stopPolling();
        pollTimer = setInterval(fn, POLL_MS);
    }

    function stopExpiry() {
        if (expiryTimer) {
            clearInterval(expiryTimer);
            expiryTimer = null;
        }
    }

    function setBusy(state) {
        busy = state;
        if (!analyzeBtn) return;
        analyzeBtn.disabled = state;
        analyzeBtn.textContent = state ? 'Analyzing...' : 'Analyze Links';
    }

    function switchStep(stepEl) {
        hideError();
        [elInput, elLoading, elSelect, elProgress, elComplete].forEach(el => el.style.display = 'none');
        stepEl.style.display = 'block';
        if (stepEl !== elComplete) stopExpiry();
        if (stepEl !== elLoading) setBusy(false);
    }

    function setSaveEnabled(state) {
        if (!saveBtn) return;
        saveBtn.disabled = !state;
        saveBtn.style.opacity = state ? '' : '0.5';
        saveBtn.style.cursor = state ? '' : 'not-allowed';
    }

    function startExpiryCountdown() {
        stopExpiry();
        setSaveEnabled(true);

        // Expire slightly ahead of the server so the button never goes dead
        // while it still looks alive.
        let remaining = FILE_TTL_SECS - 10;

        const render = () => {
            if (remaining <= 0) {
                stopExpiry();
                setSaveEnabled(false);
                if (expiryText) {
                    expiryText.textContent = "This file has been deleted from the server. Fetch the URL again to download it.";
                }
                return;
            }
            if (expiryText) {
                const mins = Math.floor(remaining / 60);
                const secs = remaining % 60;
                expiryText.textContent = "This file will be permanently deleted from the server in "
                    + mins + ":" + String(secs).padStart(2, '0') + ".";
            }
            remaining--;
        };

        render();
        expiryTimer = setInterval(render, 1000);
    }

    window.analyzeUrl = function(e) {
        if (e && e.preventDefault) e.preventDefault();
        if (busy) return false;

        const value = (urlInput.value || '').trim();
        if (!value) {
            showError("Paste a URL to analyze first.");
            return false;
        }
        if (!/^https?:\/\//i.test(value)) {
            showError("Only http:// and https:// URLs can be fetched.");
            return false;
        }

        targetUrl = value;
        setBusy(true);
        switchStep(elLoading);
        loadingText.textContent = "Parsing available formats...";

        window.appFetch('/api/fetch/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: targetUrl })
        })
        .then(r => r.json())
        .then(data => {
            if (data.task_id) {
                analyzeTaskId = data.task_id;
                poll(pollAnalyzeStatus);
            } else {
                switchStep(elInput);
                showError(data.error || "Failed to start the analysis.");
            }
        })
        .catch(err => {
            if (isAbort(err)) return;
            switchStep(elInput);
            showError("Network error. Could not contact the server.");
        });

        return false;
    };

    function pollAnalyzeStatus() {
        if (!analyzeTaskId) {
            stopPolling();
            return;
        }

        window.appFetch('/api/fetch/analyze/status?task_id=' + encodeURIComponent(analyzeTaskId))
            .then(r => r.json())
            .then(data => {
                if (data.status === 'processing') return;

                stopPolling();
                analyzeTaskId = null;

                if (data.status === 'complete' && data.result) {
                    renderFormats(data.result);
                } else if (data.status === 'cancelled') {
                    switchStep(elInput);
                } else {
                    switchStep(elInput);
                    showError(data.error || "No media could be read from that URL.");
                }
            })
            .catch(err => {
                // A single failed poll is transient; keep trying.
                if (isAbort(err)) stopPolling();
            });
    }

    function renderFormats(result) {
        titleEl.textContent = result.title || 'Untitled';
        listEl.innerHTML = '';

        const allFormats = (result.video || []).concat(result.audio || []);
        if (allFormats.length === 0) {
            switchStep(elInput);
            showError("No downloadable formats were found for that URL.");
            return;
        }

        allFormats.forEach(fmt => {
            const item = document.createElement('div');
            item.className = 'format-item';

            const iconName = fmt.type === 'audio' ? 'vol-high' : 'quality';
            item.innerHTML = `
                <div class="format-label">
                    ${window.icon(iconName)}
                    <span class="format-name"></span>
                </div>
                <svg class="ic" style="width:16px;height:16px;color:#aaa;" aria-hidden="true"><use href="#ic-chevron-right"></use></svg>
            `;
            // Labels and titles come from a third-party site, so they go in as text.
            item.querySelector('.format-name').textContent = fmt.label;

            item.onclick = () => startDownload(fmt.type, fmt.val);
            listEl.appendChild(item);
        });

        switchStep(elSelect);
    }

    function startDownload(dlType, dlFormat) {
        stopPolling();
        switchStep(elProgress);
        progressBar.style.width = '0%';
        progressText.textContent = 'Starting download...';

        window.appFetch('/api/fetch/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: targetUrl, dl_type: dlType, dl_format: dlFormat })
        })
        .then(r => r.json())
        .then(data => {
            if (data.task_id) {
                downloadTaskId = data.task_id;
                poll(pollDownloadStatus);
            } else {
                switchStep(elSelect);
                showError(data.error || "Failed to start the download.");
            }
        })
        .catch(err => {
            if (isAbort(err)) return;
            switchStep(elSelect);
            showError("Network error. Could not contact the server.");
        });
    }

    function pollDownloadStatus() {
        if (!downloadTaskId) {
            stopPolling();
            return;
        }

        window.appFetch('/api/fetch/status?task_id=' + encodeURIComponent(downloadTaskId))
            .then(r => r.json())
            .then(data => {
                if (data.status === 'processing') {
                    const pct = Math.min(100, Math.max(0, (data.progress || 0) * 100));
                    progressBar.style.width = pct + '%';
                    progressText.textContent = Math.round(pct) + '%';
                    return;
                }

                stopPolling();

                if (data.status === 'complete') {
                    progressBar.style.width = '100%';
                    progressText.textContent = '100%';
                    switchStep(elComplete);
                    startExpiryCountdown();
                    return;
                }

                downloadTaskId = null;
                switchStep(elInput);
                if (data.status === 'cancelled') {
                    showError("Download cancelled.");
                } else {
                    showError(data.error || "Download failed. Check the server logs for details.");
                }
            })
            .catch(err => {
                if (isAbort(err)) stopPolling();
            });
    }

    window.cancelFetch = function() {
        if (!downloadTaskId) {
            resetFetch();
            return;
        }

        stopPolling();
        progressText.textContent = "Cancelling...";

        const id = downloadTaskId;
        downloadTaskId = null;

        window.appFetch('/api/fetch/cancel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ task_id: id })
        })
        .catch(() => {})
        .then(() => resetFetch());
    };

    window.saveToDevice = function() {
        if (!downloadTaskId || (saveBtn && saveBtn.disabled)) return;
        window.location.href = '/api/fetch/download?task_id=' + encodeURIComponent(downloadTaskId);
    };

    window.resetFetch = function() {
        stopPolling();
        stopExpiry();
        analyzeTaskId = null;
        downloadTaskId = null;
        targetUrl = "";
        urlInput.value = "";
        setSaveEnabled(true);
        switchStep(elInput);
        try { urlInput.focus(); } catch (err) {}
    };

    window.pageTeardown = function() {
        stopPolling();
        stopExpiry();
        // The server-side task is deliberately left alone so you can navigate away
        // and come back; it cleans itself up on its own timer either way.
    };

    switchStep(elInput);
    try { urlInput.focus(); } catch (err) {}
})();
