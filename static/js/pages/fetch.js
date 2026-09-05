(function() {
    let currentAnalyzeTaskId = null;
    let currentDownloadTaskId = null;
    let pollInterval = null;
    let targetUrl = "";

    const elInput = document.getElementById('fetch-step-input');
    const elLoading = document.getElementById('fetch-step-loading');
    const elSelect = document.getElementById('fetch-step-select');
    const elProgress = document.getElementById('fetch-step-progress');
    const elComplete = document.getElementById('fetch-step-complete');
    const elError = document.getElementById('fetchErrorBox');
    
    const urlInput = document.getElementById('fetchUrl');
    const loadingText = document.getElementById('fetchLoadingText');

    function showError(msg) {
        elError.textContent = msg;
        elError.style.display = 'block';
    }

    function hideError() {
        elError.style.display = 'none';
        elError.textContent = '';
    }

    function switchStep(stepEl) {
        hideError();
        [elInput, elLoading, elSelect, elProgress, elComplete].forEach(el => el.style.display = 'none');
        stepEl.style.display = 'block';
    }

    window.analyzeUrl = function(e) {
        e.preventDefault();
        targetUrl = urlInput.value.trim();
        if (!targetUrl) return;

        switchStep(elLoading);
        loadingText.textContent = "Parsing available formats...";

        fetch('/api/fetch/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: targetUrl })
        })
        .then(r => r.json())
        .then(data => {
            if (data.task_id) {
                currentAnalyzeTaskId = data.task_id;
                pollInterval = setInterval(pollAnalyzeStatus, 1000);
            } else {
                switchStep(elInput);
                showError(data.error || "Failed to start analysis.");
            }
        })
        .catch(err => {
            if (err.name !== 'AbortError') {
                switchStep(elInput);
                showError("Network error. Could not contact server.");
            }
        });
    };

    function pollAnalyzeStatus() {
        if (!currentAnalyzeTaskId) return;

        fetch('/api/fetch/analyze/status?task_id=' + currentAnalyzeTaskId)
            .then(r => r.json())
            .then(data => {
                if (data.status === 'complete') {
                    clearInterval(pollInterval);
                    currentAnalyzeTaskId = null;
                    renderFormats(data.result);
                } else if (data.status === 'error') {
                    clearInterval(pollInterval);
                    currentAnalyzeTaskId = null;
                    switchStep(elInput);
                    showError(data.error || "Failed to extract media from this URL.");
                }
            })
            .catch(() => {});
    }

    function renderFormats(result) {
        document.getElementById('fetchTargetTitle').textContent = result.title;
        const listEl = document.getElementById('fetchFormatList');
        listEl.innerHTML = '';

        const allFormats = (result.video || []).concat(result.audio || []);

        allFormats.forEach(fmt => {
            const item = document.createElement('div');
            item.className = 'format-item';
            
            const iconName = fmt.type === 'audio' ? 'vol-high' : 'quality';
            
            item.innerHTML = `
                <div class="format-label">
                    ${window.icon(iconName)}
                    <span>${fmt.label}</span>
                </div>
                <svg class="ic" style="width:16px;height:16px;color:#aaa;" aria-hidden="true"><use href="#ic-chevron-right"></use></svg>
            `;
            
            item.onclick = () => startDownload(fmt.type, fmt.val);
            listEl.appendChild(item);
        });

        switchStep(elSelect);
    }

    function startDownload(dlType, dlFormat) {
        switchStep(elProgress);
        document.getElementById('fetchProgressBar').style.width = '0%';
        document.getElementById('fetchProgressText').textContent = 'Starting download...';

        fetch('/api/fetch/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: targetUrl, dl_type: dlType, dl_format: dlFormat })
        })
        .then(r => r.json())
        .then(data => {
            if (data.task_id) {
                currentDownloadTaskId = data.task_id;
                pollInterval = setInterval(pollDownloadStatus, 1000);
            } else {
                switchStep(elSelect);
                showError(data.error || "Failed to start download task.");
            }
        })
        .catch(err => {
            if (err.name !== 'AbortError') {
                switchStep(elSelect);
                showError("Network error. Could not contact server.");
            }
        });
    }

    function pollDownloadStatus() {
        if (!currentDownloadTaskId) return;

        fetch('/api/fetch/status?task_id=' + currentDownloadTaskId)
            .then(r => r.json())
            .then(data => {
                if (data.status === 'processing') {
                    const pct = Math.min(100, Math.max(0, data.progress * 100));
                    document.getElementById('fetchProgressBar').style.width = pct + '%';
                    document.getElementById('fetchProgressText').textContent = Math.round(pct) + '%';
                } else if (data.status === 'complete') {
                    clearInterval(pollInterval);
                    switchStep(elComplete);
                } else if (data.status === 'error' || data.status === 'cancelled') {
                    clearInterval(pollInterval);
                    currentDownloadTaskId = null;
                    switchStep(elInput);
                    showError(data.status === 'cancelled' ? "Download cancelled." : (data.error || "Download failed. Check server logs."));
                }
            })
            .catch(() => {});
    }

    window.cancelFetch = function() {
        if (!currentDownloadTaskId) {
            resetFetch();
            return;
        }
        document.getElementById('fetchProgressText').textContent = "Cancelling...";
        fetch('/api/fetch/cancel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ task_id: currentDownloadTaskId })
        }).then(() => resetFetch()).catch(() => resetFetch());
    };

    window.saveToDevice = function() {
        if (!currentDownloadTaskId) return;
        window.location.href = '/api/fetch/download?task_id=' + currentDownloadTaskId;
    };

    window.resetFetch = function() {
        if (pollInterval) clearInterval(pollInterval);
        currentAnalyzeTaskId = null;
        currentDownloadTaskId = null;
        targetUrl = "";
        urlInput.value = "";
        switchStep(elInput);
    };

    window.pageTeardown = function() {
        if (pollInterval) clearInterval(pollInterval);
        // We do NOT explicitly cancel the task on unmount so they can navigate away and 
        // back without it dying, though it will naturally abort if it hits the 30-min idle timeout.
    };

})();
