(function() {
    'use strict';

    const POLL_MS = 2000;
    const RETRY_MS = 5000;
    const MAX_ENTRIES = 4000;
    const FOLLOW_THRESHOLD_PX = 40;
    const SEARCH_DEBOUNCE_MS = 150;
    const PREFS_KEY = 'logViewPrefs';
    const LEVEL_RANK = { debug: 0, info: 1, warning: 2, error: 3 };

    const view = document.getElementById('logView');
    if (!view) return;

    const levelSel = document.getElementById('logLevel');
    const sourceSel = document.getElementById('logSource');
    const searchInp = document.getElementById('logSearch');
    const hideHttpChk = document.getElementById('logHideHttp');
    const pauseBtn = document.getElementById('logPauseBtn');
    const copyBtn = document.getElementById('logCopyBtn');
    const clearBtn = document.getElementById('logClearBtn');
    const jumpBtn = document.getElementById('logJumpBtn');
    const countEl = document.getElementById('logCount');
    const liveEl = document.getElementById('logLive');

    let entries = [];
    let lastSeq = 0;
    let epoch = null;
    let generation = 0;
    let loaded = false;
    let paused = false;
    let follow = true;
    let stopped = false;
    let inFlight = false;
    let pollTimer = null;
    let searchTimer = null;
    let shownCount = 0;
    let unseenCount = 0;
    const sources = new Set();

    // ------------------------------------------------------------------
    // Preferences (per browser)
    // ------------------------------------------------------------------

    function loadPrefs() {
        try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {}; }
        catch (e) { return {}; }
    }

    function savePrefs() {
        try {
            localStorage.setItem(PREFS_KEY, JSON.stringify({
                level: levelSel.value,
                source: sourceSel.value,
                hideHttp: hideHttpChk.checked
            }));
        } catch (e) {}
    }

    const prefs = loadPrefs();
    if (prefs.level && LEVEL_RANK[prefs.level] !== undefined) levelSel.value = prefs.level;
    if (typeof prefs.hideHttp === 'boolean') hideHttpChk.checked = prefs.hideHttp;
    if (prefs.source) sources.add(prefs.source);
    refreshSourceOptions(prefs.source || '');

    let filters = readFilters();

    // ------------------------------------------------------------------
    // Formatting
    // ------------------------------------------------------------------

    function pad(n, width) {
        return String(n).padStart(width || 2, '0');
    }

    function fmtTime(ts) {
        const d = new Date(ts * 1000);
        return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
    }

    function fmtDateTime(ts) {
        const d = new Date(ts * 1000);
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${fmtTime(ts)}`;
    }

    function formatLine(e) {
        return `${fmtDateTime(e.ts)} ${String(e.level).toUpperCase().padEnd(7)} [${e.source}] ${e.msg}`;
    }

    function marker(msg) {
        return { marker: true, msg: msg, ts: Date.now() / 1000, level: 'info', source: '' };
    }

    // ------------------------------------------------------------------
    // Filtering
    // ------------------------------------------------------------------

    function readFilters() {
        return {
            minLevel: LEVEL_RANK[levelSel.value] !== undefined ? LEVEL_RANK[levelSel.value] : 0,
            source: sourceSel.value,
            text: searchInp.value.trim().toLowerCase(),
            hideHttp: hideHttpChk.checked
        };
    }

    function matches(e) {
        if (e.marker) return true;
        const rank = LEVEL_RANK[e.level] !== undefined ? LEVEL_RANK[e.level] : 1;
        if (rank < filters.minLevel) return false;
        if (filters.source && e.source !== filters.source) return false;
        if (filters.hideHttp && e.source === 'http' && filters.source !== 'http') return false;
        if (filters.text) {
            const hay = (e.msg + ' ' + e.source).toLowerCase();
            if (!hay.includes(filters.text)) return false;
        }
        return true;
    }

    function refreshSourceOptions(selected) {
        const sorted = Array.from(sources).sort((a, b) => a.localeCompare(b));
        sourceSel.innerHTML = '';
        const all = document.createElement('option');
        all.value = '';
        all.textContent = 'All sources';
        sourceSel.appendChild(all);
        sorted.forEach(s => {
            const opt = document.createElement('option');
            opt.value = s;
            opt.textContent = s;
            sourceSel.appendChild(opt);
        });
        sourceSel.value = sources.has(selected) ? selected : '';
    }

    // ------------------------------------------------------------------
    // Rendering
    // ------------------------------------------------------------------

    function span(cls, text) {
        const el = document.createElement('span');
        el.className = cls;
        el.textContent = text;
        return el;
    }

    function buildRow(e) {
        if (e.marker) {
            const div = document.createElement('div');
            div.className = 'log-marker';
            div.textContent = e.msg;
            return div;
        }

        const level = LEVEL_RANK[e.level] !== undefined ? e.level : 'info';
        const row = document.createElement('div');
        row.className = 'log-row lvl-' + level;

        const meta = document.createElement('span');
        meta.className = 'log-meta';

        const time = span('log-time', fmtTime(e.ts));
        time.title = fmtDateTime(e.ts);
        const lvl = span('log-level', level);
        const src = span('log-source', e.source);
        src.title = e.source;

        meta.append(time, lvl, src);
        row.append(meta, span('log-msg', e.msg));
        return row;
    }

    function showPlaceholder() {
        const div = document.createElement('div');
        div.className = 'log-empty';
        if (!loaded) div.textContent = 'Loading logs…';
        else if (entries.some(e => !e.marker)) div.textContent = 'No lines match the current filters.';
        else div.textContent = 'No log output yet.';
        view.appendChild(div);
    }

    function removePlaceholder() {
        const p = view.querySelector('.log-empty');
        if (p) p.remove();
    }

    function isNearBottom() {
        return view.scrollHeight - view.scrollTop - view.clientHeight < FOLLOW_THRESHOLD_PX;
    }

    function scrollToBottom() {
        view.scrollTop = view.scrollHeight;
    }

    function updateCount() {
        if (!loaded) {
            countEl.textContent = 'Loading…';
            return;
        }
        const total = entries.reduce((n, e) => n + (e.marker ? 0 : 1), 0);
        countEl.textContent = `${shownCount.toLocaleString()} shown · ${total.toLocaleString()} buffered`;
    }

    function updateJump() {
        if (unseenCount > 0 && !follow) {
            jumpBtn.textContent = `↓ ${unseenCount.toLocaleString()} new line${unseenCount === 1 ? '' : 's'}`;
            jumpBtn.classList.add('show');
        } else {
            jumpBtn.classList.remove('show');
        }
    }

    function renderAll() {
        const frag = document.createDocumentFragment();
        shownCount = 0;
        for (const e of entries) {
            if (!matches(e)) continue;
            frag.appendChild(buildRow(e));
            if (!e.marker) shownCount++;
        }
        view.textContent = '';
        if (frag.childNodes.length) view.appendChild(frag);
        else showPlaceholder();

        updateCount();
        if (follow) scrollToBottom();
    }

    function appendEntries(list) {
        if (!list.length) return;

        let newSource = false;
        for (const e of list) {
            if (e.source && !sources.has(e.source)) {
                sources.add(e.source);
                newSource = true;
            }
            entries.push(e);
        }
        if (newSource) refreshSourceOptions(sourceSel.value);

        if (entries.length > MAX_ENTRIES) {
            entries = entries.slice(entries.length - MAX_ENTRIES);
            renderAll();
            return;
        }

        const frag = document.createDocumentFragment();
        let added = 0;
        for (const e of list) {
            if (!matches(e)) continue;
            frag.appendChild(buildRow(e));
            if (!e.marker) added++;
        }

        if (frag.childNodes.length) {
            removePlaceholder();
            view.appendChild(frag);
        }

        shownCount += added;
        updateCount();

        if (added) {
            if (follow) {
                scrollToBottom();
            } else {
                unseenCount += added;
                updateJump();
            }
        }
    }

    // ------------------------------------------------------------------
    // Polling
    // ------------------------------------------------------------------

    function setLive(state) {
        liveEl.classList.remove('paused', 'offline');
        if (state === 'paused') {
            liveEl.classList.add('paused');
            liveEl.textContent = 'Paused';
        } else if (state === 'offline') {
            liveEl.classList.add('offline');
            liveEl.textContent = 'Disconnected, retrying…';
        } else {
            liveEl.textContent = 'Live';
        }
    }

    function schedule(delay) {
        if (stopped) return;
        clearTimeout(pollTimer);
        pollTimer = setTimeout(poll, delay);
    }

    function handleResponse(data) {
        const incoming = Array.isArray(data.entries) ? data.entries : [];

        if (data.epoch !== epoch) {
            // First load, a clear from another tab, or a server restart.
            const hadEpoch = epoch !== null;
            epoch = data.epoch;
            entries = [];
            if (hadEpoch) entries.push(marker('Log buffer was reset (cleared, or the server restarted).'));
            for (const e of incoming) {
                if (e.source) sources.add(e.source);
                entries.push(e);
            }
            if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
            refreshSourceOptions(sourceSel.value);
            lastSeq = data.last_seq || 0;
            loaded = true;
            renderAll();
            return;
        }

        loaded = true;
        if (data.skipped > 0) {
            appendEntries([marker(`${data.skipped.toLocaleString()} line(s) were dropped before they could be shown.`)]);
        }
        lastSeq = data.last_seq || lastSeq;
        appendEntries(incoming);
    }

    function poll() {
        pollTimer = null;
        if (stopped || inFlight) return;
        if (paused || document.hidden) {
            schedule(POLL_MS);
            return;
        }

        inFlight = true;
        const myGen = generation;
        const url = `/api/logs?after=${lastSeq}&epoch=${encodeURIComponent(epoch || '')}`;

        window.appFetch(url)
            .then(r => {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            })
            .then(data => {
                if (stopped || myGen !== generation) return;
                handleResponse(data);
                setLive(paused ? 'paused' : 'live');
            })
            .then(() => {
                inFlight = false;
                schedule(myGen !== generation ? 0 : POLL_MS);
            }, err => {
                inFlight = false;
                if (stopped) return;
                if (err && err.name === 'AbortError') {
                    stopped = true;
                    return;
                }
                setLive('offline');
                schedule(RETRY_MS);
            });
    }

    // ------------------------------------------------------------------
    // Clipboard (navigator.clipboard is unavailable on plain-http LAN hosts)
    // ------------------------------------------------------------------

    function fallbackCopy(text) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '-1000px';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        let ok = false;
        try { ok = document.execCommand('copy'); } catch (e) {}
        ta.remove();
        return ok;
    }

    function copyText(text) {
        if (navigator.clipboard && window.isSecureContext) {
            return navigator.clipboard.writeText(text).then(() => true, () => fallbackCopy(text));
        }
        return Promise.resolve(fallbackCopy(text));
    }

    function flash(btn, text) {
        if (!btn.dataset.label) btn.dataset.label = btn.textContent;
        btn.textContent = text;
        clearTimeout(btn._flashTimer);
        btn._flashTimer = setTimeout(() => { btn.textContent = btn.dataset.label; }, 1500);
    }

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    function onFilterChange() {
        filters = readFilters();
        savePrefs();
        unseenCount = 0;
        updateJump();
        renderAll();
    }

    levelSel.addEventListener('change', onFilterChange);
    sourceSel.addEventListener('change', onFilterChange);
    hideHttpChk.addEventListener('change', onFilterChange);
    searchInp.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(onFilterChange, SEARCH_DEBOUNCE_MS);
    });

    view.addEventListener('scroll', () => {
        follow = isNearBottom();
        if (follow && unseenCount) {
            unseenCount = 0;
            updateJump();
        }
    }, { passive: true });

    jumpBtn.addEventListener('click', () => {
        follow = true;
        unseenCount = 0;
        scrollToBottom();
        updateJump();
    });

    pauseBtn.addEventListener('click', () => {
        paused = !paused;
        pauseBtn.textContent = paused ? 'Resume' : 'Pause';
        setLive(paused ? 'paused' : 'live');
        if (!paused) schedule(0);
    });

    copyBtn.addEventListener('click', () => {
        const text = entries.filter(e => !e.marker && matches(e)).map(formatLine).join('\n');
        if (!text) {
            flash(copyBtn, 'Nothing to copy');
            return;
        }
        copyText(text).then(ok => flash(copyBtn, ok ? 'Copied!' : 'Copy failed'));
    });

    clearBtn.addEventListener('click', () => {
        if (!confirm('Clear the log view? The log file on disk is kept, so Download still includes these lines.')) return;
        clearBtn.disabled = true;
        generation++;

        window.appFetch('/api/logs/clear', { method: 'POST' })
            .then(r => r.json())
            .then(data => {
                if (stopped) return;
                epoch = data.epoch || null;
                lastSeq = 0;
                entries = [];
                unseenCount = 0;
                follow = true;
                updateJump();
                renderAll();
                schedule(0);
            })
            .catch(err => {
                if (err && err.name === 'AbortError') return;
                flash(clearBtn, 'Failed');
            })
            .then(() => { clearBtn.disabled = false; });
    });

    const onVisibility = () => {
        if (!document.hidden) schedule(0);
    };
    document.addEventListener('visibilitychange', onVisibility);

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    const prevTeardown = window.pageTeardown;
    window.pageTeardown = function() {
        if (typeof prevTeardown === 'function') prevTeardown();
        stopped = true;
        clearTimeout(pollTimer);
        clearTimeout(searchTimer);
        document.removeEventListener('visibilitychange', onVisibility);
    };

    renderAll();
    setLive('live');
    poll();
})();
