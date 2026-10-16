(function() {
    'use strict';

    const FILE_TTL_SECS = 600;
    const POLL_MS = 1500;
    const FLAG_CHECK_DEBOUNCE_MS = 500;

    let flagCheckTimer = null;
    let flagCheckSeq = 0;

    // ------------------------------------------------------------------
    // Flag helpers
    // ------------------------------------------------------------------

    function readFlagInputs() {
        const sel = document.getElementById('fetchImpersonate');
        const inp = document.getElementById('fetchExtraFlags');
        return {
            impersonate: sel ? (sel.value || '').trim() : '',
            extraFlags: inp ? (inp.value || '').trim() : ''
        };
    }

    function hasFlags(flags) {
        return !!(flags && (flags.impersonate || flags.extraFlags));
    }

    function flagChips(flags) {
        const chips = [];
        if (!flags) return chips;
        if (flags.impersonate) chips.push('--impersonate ' + flags.impersonate);
        if (flags.extraFlags) chips.push(flags.extraFlags);
        return chips;
    }

    function addOption(parent, value, label) {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = label;
        parent.appendChild(opt);
        return opt;
    }

    function capitalize(s) {
        return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
    }

    // ------------------------------------------------------------------
    // Fetch job card
    // ------------------------------------------------------------------

    class FetchJob {
        constructor(url, proxyUrl, proxyMode, customProxy, flags = null, existingData = null) {
            if (existingData) {
                this.id = 'job_' + Math.random().toString(36).substr(2, 9);
                this.url = existingData.url;
                this.proxyUrl = existingData.proxy_url;
                this.proxyMode = null;
                this.customProxy = null;
                this.flags = {
                    impersonate: existingData.impersonate || '',
                    extraFlags: existingData.extra_flags || ''
                };
                this.taskId = existingData.taskId;
                this.state = 'analyze';

                this.createDOM();
                this.ui.title.textContent = existingData.title || existingData.url;
                
                if (existingData.status === 'processing') {
                    FetchManager.track(this);
                }
                this.onPollUpdate(existingData);
            } else {
                this.id = 'job_' + Math.random().toString(36).substr(2, 9);
                this.url = url;
                this.proxyUrl = proxyUrl;
                this.proxyMode = proxyMode;
                this.customProxy = customProxy;
                this.flags = {
                    impersonate: (flags && flags.impersonate) || '',
                    extraFlags: (flags && flags.extraFlags) || ''
                };
                this.taskId = null;
                this.state = 'analyze';

                this.createDOM();
                this.startAnalyze();
            }
        }

        createDOM() {
            const template = document.getElementById('fetch-job-template');
            const clone = template.content.cloneNode(true);
            
            this.el = clone.querySelector('.fetch-card');
            this.el.id = this.id;
            
            this.ui = {
                title: this.el.querySelector('.card-title'),
                closeBtn: this.el.querySelector('.card-close'),
                flags: this.el.querySelector('.card-flags'),
                
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
            this.renderFlags();
            
            this.ui.closeBtn.onclick = () => this.dismiss();
            this.ui.startBtn.onclick = () => this.startDownload();
            this.ui.abortBtn.onclick = () => this.cancel();
            this.ui.saveBtn.onclick = () => this.saveToDevice();

            document.getElementById('fetch-queue').prepend(this.el);
        }

        renderFlags() {
            const box = this.ui.flags;
            if (!box) return;
            box.innerHTML = '';
            const chips = flagChips(this.flags);
            if (chips.length === 0) {
                box.style.display = 'none';
                return;
            }
            chips.forEach(text => {
                const chip = document.createElement('span');
                chip.className = 'flag-chip';
                chip.textContent = text;
                chip.title = text;
                box.appendChild(chip);
            });
            box.style.display = 'flex';
        }

        flagPayload() {
            return {
                impersonate: this.flags.impersonate || '',
                extra_flags: this.flags.extraFlags || ''
            };
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
                    body: JSON.stringify({ 
                        url: this.url, 
                        proxy_url: this.proxyUrl,
                        proxy_mode: this.proxyMode,
                        custom_proxy: this.customProxy,
                        ...this.flagPayload()
                    })
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

            const prevTaskId = this.taskId;

            try {
                const r = await window.appFetch('/api/fetch/start', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        url: this.url, 
                        dl_type: type, 
                        dl_format: val, 
                        proxy_url: this.proxyUrl,
                        proxy_mode: this.proxyMode,
                        custom_proxy: this.customProxy,
                        title: this.ui.title.textContent,
                        analyze_task_id: prevTaskId,
                        ...this.flagPayload()
                    })
                });
                const data = await r.json();
                if (data.task_id) {
                    if (prevTaskId) FetchManager.untrack(prevTaskId);
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
                if (data.type === 'analyze') {
                    this.switchState('analyze');
                } else if (data.type === 'download') {
                    this.switchState('download');
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
                // Intentionally do NOT clear this.taskId here, so it is available
                // for deletion/cancellation if the user dismisses the card.
            } else if (data.status === 'expired') {
                this.stopExpiry();
                this.showError(data.error || "File expired.");
                this.taskId = null;
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

    // ------------------------------------------------------------------
    // Advanced options panel: impersonation + extra flags
    // ------------------------------------------------------------------

    function updateAdvancedBadge() {
        const badge = document.getElementById('advancedBadge');
        if (!badge) return;
        const flags = readFlagInputs();
        const parts = [];
        if (flags.impersonate) parts.push('Impersonating ' + flags.impersonate);
        if (flags.extraFlags) parts.push('Custom flags');
        if (parts.length) {
            badge.textContent = parts.join(' · ');
            badge.style.display = 'inline-block';
        } else {
            badge.style.display = 'none';
        }
    }

    function showFlagsFeedback(result) {
        const box = document.getElementById('flagsFeedback');
        if (!box) return;
        box.innerHTML = '';
        box.classList.remove('ok', 'err');

        if (!result) {
            box.style.display = 'none';
            return;
        }
        box.style.display = 'block';

        if (result.ok) {
            box.classList.add('ok');
            const applied = result.applied || [];
            const head = document.createElement('div');
            head.textContent = applied.length
                ? 'These yt-dlp options will be applied:'
                : 'These flags don\'t change any options.';
            box.appendChild(head);

            if (applied.length) {
                const ul = document.createElement('ul');
                applied.forEach(item => {
                    const li = document.createElement('li');
                    const key = document.createElement('code');
                    key.textContent = item.key;
                    li.appendChild(key);
                    li.appendChild(document.createTextNode(' = ' + item.value));
                    ul.appendChild(li);
                });
                box.appendChild(ul);
            }
        } else {
            box.classList.add('err');
            box.textContent = result.error || 'These flags were rejected.';
        }
    }

    async function checkFlags(flags) {
        const seq = ++flagCheckSeq;
        if (!hasFlags(flags)) {
            showFlagsFeedback(null);
            return { ok: true, applied: [] };
        }

        let result;
        try {
            const r = await window.appFetch('/api/fetch/validate_flags', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    impersonate: flags.impersonate,
                    extra_flags: flags.extraFlags
                })
            });
            result = await r.json();
        } catch (err) {
            if (err.name === 'AbortError') throw err;
            result = { ok: false, error: 'Could not check the flags (network error).' };
        }

        // Ignore answers to checks that have since been superseded.
        if (seq === flagCheckSeq) showFlagsFeedback(result);
        return result;
    }

    function scheduleFlagCheck() {
        updateAdvancedBadge();
        clearTimeout(flagCheckTimer);
        flagCheckTimer = setTimeout(() => {
            checkFlags(readFlagInputs()).catch(() => {});
        }, FLAG_CHECK_DEBOUNCE_MS);
    }

    async function loadCapabilities() {
        const sel = document.getElementById('fetchImpersonate');
        const status = document.getElementById('impersonateStatus');
        if (!sel) return;

        const saved = sel.getAttribute('data-saved') || '';

        try {
            const r = await window.appFetch('/api/fetch/capabilities');
            const caps = await r.json();
            const imp = caps.impersonation || {};
            const current = sel.value || saved;

            sel.innerHTML = '';
            addOption(sel, '', 'Off');

            const clients = imp.clients || [];
            if (clients.length) {
                const group = document.createElement('optgroup');
                group.label = 'Browser (any version)';
                clients.forEach(c => addOption(group, c, capitalize(c)));
                sel.appendChild(group);
            }

            const targets = imp.targets || [];
            if (targets.length) {
                const group = document.createElement('optgroup');
                group.label = 'Specific targets';
                targets.forEach(t => addOption(group, t, t));
                sel.appendChild(group);
            }

            if (current && !Array.from(sel.options).some(o => o.value === current)) {
                addOption(sel, current, current + ' (unavailable)');
            }
            sel.value = current;

            if (status) {
                let msg = imp.message || '';
                if (caps.ffmpeg === false) {
                    msg += ' ffmpeg was not found, so merging formats and audio extraction won\'t work.';
                }
                status.textContent = msg.trim();
                status.classList.toggle('warn', !imp.available || caps.ffmpeg === false);
            }
        } catch (err) {
            if (err.name === 'AbortError') return;
            if (status) {
                status.textContent = 'Could not check impersonation support on the server.';
                status.classList.add('warn');
            }
        }

        updateAdvancedBadge();
        const flags = readFlagInputs();
        if (hasFlags(flags)) checkFlags(flags).catch(() => {});
    }

    function bindFlagInputs() {
        const sel = document.getElementById('fetchImpersonate');
        const inp = document.getElementById('fetchExtraFlags');
        if (sel) sel.addEventListener('change', scheduleFlagCheck);
        if (inp) inp.addEventListener('input', scheduleFlagCheck);
    }

    // ------------------------------------------------------------------
    // Form submission
    // ------------------------------------------------------------------

    window.handleFetchSubmit = async function(e) {
        if (e && e.preventDefault) e.preventDefault();
        
        const urlInput = document.getElementById('fetchUrl');
        const proxyModeSel = document.getElementById('fetchProxyMode');
        const proxyInput = document.getElementById('customProxy');
        const analyzeBtn = document.getElementById('fetchAnalyzeBtn');
        
        const url = (urlInput.value || '').trim();
        if (!/^https?:\/\//i.test(url)) {
            alert("Only http:// and https:// URLs can be fetched.");
            return false;
        }

        let proxyUrl = undefined;
        let proxyMode = proxyModeSel.value;
        let customProxy = proxyInput.value.trim();

        const container = document.getElementById('proxyContainer');
        if (container && container.classList.contains('open')) {
            if (proxyMode === 'none') {
                proxyUrl = ""; 
            } else if (proxyMode === 'saved') {
                proxyUrl = proxyModeSel.getAttribute('data-saved') || "";
            } else if (proxyMode === 'custom') {
                proxyUrl = customProxy;
            }
        }

        // Flags apply whether or not the panel is open; the badge on the toggle
        // makes it obvious when they're active.
        const flags = readFlagInputs();
        if (hasFlags(flags)) {
            const origText = analyzeBtn ? analyzeBtn.textContent : '';
            if (analyzeBtn) {
                analyzeBtn.disabled = true;
                analyzeBtn.textContent = 'Checking flags...';
            }

            let result;
            try {
                clearTimeout(flagCheckTimer);
                result = await checkFlags(flags);
            } catch (err) {
                if (err.name === 'AbortError') return false;
                result = { ok: false, error: 'Could not check the flags.' };
                showFlagsFeedback(result);
            } finally {
                if (analyzeBtn) {
                    analyzeBtn.disabled = false;
                    analyzeBtn.textContent = origText;
                }
            }

            if (!result || !result.ok) {
                if (container) container.classList.add('open');
                const inp = document.getElementById('fetchExtraFlags');
                if (inp) inp.focus();
                return false;
            }
        }

        new FetchJob(url, proxyUrl, proxyMode, customProxy, flags);
        urlInput.value = '';
        return false;
    };
    
    async function hydrateFetchQueue() {
        try {
            const r = await window.appFetch('/api/fetch/list');
            const tasks = await r.json();
            
            const taskArray = Object.entries(tasks).map(([taskId, data]) => {
                data.taskId = taskId;
                return data;
            });
            
            taskArray.sort((a, b) => (a.started_at || 0) - (b.started_at || 0));
            
            for (const data of taskArray) {
                new FetchJob(null, null, null, null, null, data);
            }
        } catch(e) {
            if (e.name !== 'AbortError') console.error("Failed to hydrate fetch queue", e);
        }
    }
    
    bindFlagInputs();
    updateAdvancedBadge();
    loadCapabilities();
    hydrateFetchQueue();

    window.pageTeardown = function() {
        clearTimeout(flagCheckTimer);
        FetchManager.destroy();
    };

})();
