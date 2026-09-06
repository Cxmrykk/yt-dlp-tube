(function() {
    'use strict';

    const FILE_TTL_SECS = 600;
    const POLL_MS = 1500;

    class FetchJob {
        constructor(url, proxyUrl) {
            this.id = 'job_' + Math.random().toString(36).substr(2, 9);
            this.url = url;
            this.proxyUrl = proxyUrl;
            this.taskId = null;
            this.expiryTimer = null;
            this.state = 'analyze';

            this.createDOM();
            this.startAnalyze();
        }

        createDOM() {
            const template = document.getElementById('fetch-job-template');
            const clone = template.content.cloneNode(true);
            
            this.el = clone.querySelector('.fetch-card');
            this.el.id = this.id;
            
            this.ui = {
                title: this.el.querySelector('.card-title'),
                closeBtn: this.el.querySelector('.card-close'),
                
                stateAnalyze: this.el.querySelector('.state-analyze'),
                stateSelect: this.el.querySelector('.state-select'),
                stateDownload: this.el.querySelector('.state-download'),
                stateComplete: this.el.querySelector('.state-complete'),
                stateError: this.el.querySelector('.state-error'),
                
                formatSelect: this.el.querySelector('.format-dropdown'),
                startBtn: this.el.querySelector('.btn-start-dl'),
                
                progressBar: this.el.querySelector('.progress-bar-inner'),
                progressText: this.el.querySelector('.progress-text'),
                abortBtn: this.el.querySelector('.btn-abort'),
                
                expiryText: this.el.querySelector('.expiry-text'),
                saveBtn: this.el.querySelector('.btn-save')
            };

            this.ui.title.textContent = this.url;
            
            this.ui.closeBtn.onclick = () => this.dismiss();
            this.ui.startBtn.onclick = () => this.startDownload();
            this.ui.abortBtn.onclick = () => this.cancel();
            this.ui.saveBtn.onclick = () => this.saveToDevice();

            document.getElementById('fetch-queue').prepend(this.el);
        }

        switchState(stateName) {
            this.state = stateName;
            [
                this.ui.stateAnalyze, 
                this.ui.stateSelect, 
                this.ui.stateDownload, 
                this.ui.stateComplete, 
                this.ui.stateError
            ].forEach(el => el.style.display = 'none');

            if (stateName === 'analyze') this.ui.stateAnalyze.style.display = 'block';
            else if (stateName === 'select') this.ui.stateSelect.style.display = 'block';
            else if (stateName === 'download') this.ui.stateDownload.style.display = 'block';
            else if (stateName === 'complete') this.ui.stateComplete.style.display = 'block';
            else if (stateName === 'error') this.ui.stateError.style.display = 'block';
        }

        showError(msg) {
            this.switchState('error');
            this.ui.stateError.textContent = msg;
        }

        async startAnalyze() {
            try {
                const r = await window.appFetch('/api/fetch/analyze', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url: this.url, proxy_url: this.proxyUrl })
                });
                const data = await r.json();
                if (data.task_id) {
                    this.taskId = data.task_id;
                    FetchManager.track(this);
                } else {
                    this.showError(data.error || "Failed to start analysis.");
                }
            } catch (err) {
                if (err.name !== 'AbortError') this.showError("Network error.");
            }
        }

        renderFormats(result) {
            this.ui.title.textContent = result.title || this.url;
            this.ui.formatSelect.innerHTML = '';

            const addGroup = (label, formats) => {
                if (!formats || formats.length === 0) return;
                const group = document.createElement('optgroup');
                group.label = label;
                formats.forEach(f => {
                    const opt = document.createElement('option');
                    opt.value = JSON.stringify({ type: f.type, val: f.val });
                    opt.textContent = f.label;
                    group.appendChild(opt);
                });
                this.ui.formatSelect.appendChild(group);
            };

            addGroup('Video', result.video);
            addGroup('Audio', result.audio);

            if (this.ui.formatSelect.children.length === 0) {
                this.showError("No downloadable formats were found.");
            } else {
                this.switchState('select');
            }
        }

        async startDownload() {
            const rawVal = this.ui.formatSelect.value;
            if (!rawVal) return;
            const { type, val } = JSON.parse(rawVal);

            this.switchState('download');
            this.ui.progressBar.style.width = '0%';
            this.ui.progressText.textContent = 'Starting...';

            try {
                const r = await window.appFetch('/api/fetch/start', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url: this.url, dl_type: type, dl_format: val, proxy_url: this.proxyUrl })
                });
                const data = await r.json();
                if (data.task_id) {
                    this.taskId = data.task_id;
                    FetchManager.track(this);
                } else {
                    this.showError(data.error || "Failed to start download.");
                }
            } catch (err) {
                if (err.name !== 'AbortError') this.showError("Network error.");
            }
        }

        onPollUpdate(data) {
            if (data.status === 'processing') {
                if (data.type === 'download') {
                    const pct = Math.min(100, Math.max(0, (data.progress || 0) * 100));
                    this.ui.progressBar.style.width = pct + '%';
                    this.ui.progressText.textContent = Math.round(pct) + '%';
                }
                return;
            }

            FetchManager.untrack(this.taskId);

            if (data.status === 'complete') {
                if (data.type === 'analyze') {
                    this.renderFormats(data.result);
                } else if (data.type === 'download') {
                    this.switchState('complete');
                    this.startExpiry(data.expires_at);
                }
                this.taskId = null;
            } else if (data.status === 'expired') {
                this.stopExpiry();
                this.showError(data.error || "File expired.");
            } else if (data.status === 'cancelled') {
                this.showError("Cancelled.");
                this.taskId = null;
            } else {
                this.showError(data.error || "Operation failed.");
                this.taskId = null;
            }
        }

        startExpiry(expiresAtRaw) {
            this.stopExpiry();
            
            const expiresAt = expiresAtRaw || (Date.now() / 1000 + FILE_TTL_SECS);

            const render = () => {
                const remaining = Math.floor(expiresAt - (Date.now() / 1000));
                if (remaining <= 0) {
                    this.stopExpiry();
                    this.ui.saveBtn.disabled = true;
                    this.ui.saveBtn.style.opacity = '0.5';
                    this.ui.expiryText.textContent = "File deleted from server.";
                    return;
                }
                const mins = Math.floor(remaining / 60);
                const secs = remaining % 60;
                this.ui.expiryText.textContent = `Expires in ${mins}:${String(secs).padStart(2, '0')}`;
            };

            render();
            this.expiryTimer = setInterval(render, 1000);
        }

        stopExpiry() {
            if (this.expiryTimer) {
                clearInterval(this.expiryTimer);
                this.expiryTimer = null;
            }
        }

        async cancel() {
            if (!this.taskId) return;
            const id = this.taskId;
            this.taskId = null;
            FetchManager.untrack(id);
            this.ui.progressText.textContent = "Cancelling...";

            try {
                await window.appFetch('/api/fetch/cancel', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ task_id: id })
                });
            } catch(e) {}
            
            this.showError("Download cancelled.");
        }

        saveToDevice() {
            if (!this.taskId || this.ui.saveBtn.disabled) return;
            window.location.href = '/api/fetch/download?task_id=' + encodeURIComponent(this.taskId);
        }

        dismiss() {
            this.cancel();
            this.stopExpiry();
            if (this.el && this.el.parentNode) {
                this.el.parentNode.removeChild(this.el);
            }
        }
    }

    class FetchManagerClass {
        constructor() {
            this.activeJobs = new Map();
            this.pollTimer = null;
            this.bindEvents();
        }

        track(job) {
            if (!job.taskId) return;
            this.activeJobs.set(job.taskId, job);
            this.startPolling();
        }

        untrack(taskId) {
            this.activeJobs.delete(taskId);
            if (this.activeJobs.size === 0) this.stopPolling();
        }

        hasActiveJobs() {
            return this.activeJobs.size > 0;
        }

        startPolling() {
            if (!this.pollTimer) {
                this.pollTimer = setInterval(() => this.pollBatch(), POLL_MS);
            }
        }

        stopPolling() {
            if (this.pollTimer) {
                clearInterval(this.pollTimer);
                this.pollTimer = null;
            }
        }

        async pollBatch() {
            const keys = Array.from(this.activeJobs.keys());
            if (keys.length === 0) return;

            try {
                const r = await window.appFetch('/api/fetch/status_batch', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ task_ids: keys })
                });
                const results = await r.json();

                for (const [taskId, data] of Object.entries(results)) {
                    const job = this.activeJobs.get(taskId);
                    if (job) job.onPollUpdate(data);
                }
            } catch (err) {
                if (err.name === 'AbortError') this.stopPolling();
            }
        }

        bindEvents() {
            this.beforeUnloadHandler = (e) => {
                if (this.hasActiveJobs()) {
                    e.preventDefault();
                    e.returnValue = '';
                }
            };
            window.addEventListener('beforeunload', this.beforeUnloadHandler);
        }

        destroy() {
            this.stopPolling();
            window.removeEventListener('beforeunload', this.beforeUnloadHandler);
        }
    }

    const FetchManager = new FetchManagerClass();

    window.handleFetchSubmit = function(e) {
        if (e && e.preventDefault) e.preventDefault();
        
        const urlInput = document.getElementById('fetchUrl');
        const proxyInput = document.getElementById('customProxy');
        
        const url = (urlInput.value || '').trim();
        if (!/^https?:\/\//i.test(url)) {
            alert("Only http:// and https:// URLs can be fetched.");
            return false;
        }

        let proxyUrl = undefined;
        const container = document.getElementById('proxyContainer');
        if (container && container.classList.contains('open')) {
            proxyUrl = (proxyInput.value || '').trim();
        }

        new FetchJob(url, proxyUrl);
        urlInput.value = '';
        return false;
    };

    window.pageTeardown = function() {
        FetchManager.destroy();
    };

})();
