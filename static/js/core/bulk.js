window.bulkMode = false;
window.bulkSelection = new Set();

window.formatTaskId = null;
window.formatInterval = null;
window.bulkFormatData = null;
// Signature of the selection that bulkFormatData describes, and the one the
// in-flight task is scanning. Lets us reuse results without rescanning while
// still invalidating them the moment the selection changes.
window.bulkFormatSig = null;
window.formatTaskSig = null;
// Which type pane the user is waiting on, if any.
window.pendingFormatType = null;

window.bulkTaskId = null;
window.bulkInterval = null;

window.bulkSelectionSig = function() {
    return Array.from(window.bulkSelection).sort().join(',');
};

window.saveBulkState = function() {
    localStorage.setItem('bulkModeState', window.bulkMode);
    localStorage.setItem('bulkSelection', JSON.stringify(Array.from(window.bulkSelection)));
    if (window.bulkTaskId) localStorage.setItem('bulkTaskId', window.bulkTaskId);
    else localStorage.removeItem('bulkTaskId');
    if (window.formatTaskId) localStorage.setItem('formatTaskId', window.formatTaskId);
    else localStorage.removeItem('formatTaskId');
};

document.addEventListener("DOMContentLoaded", () => {
    const savedMode = localStorage.getItem('bulkModeState') === 'true';
    const savedSel = JSON.parse(localStorage.getItem('bulkSelection') || '[]');
    const bTaskId = localStorage.getItem('bulkTaskId');
    const fTaskId = localStorage.getItem('formatTaskId');

    if (savedMode) {
        window.bulkMode = true;
        window.bulkSelection = new Set(savedSel);
        document.getElementById('bulk-btn').style.display = 'none';
        document.getElementById('bulk-cancel-btn').style.display = 'flex';
        document.getElementById('bulk-next-btn').style.display = 'flex';
        window.updateBulkNextBtn();
        window.syncBulkSelectionUI();
    }

    if (bTaskId) {
        window.bulkTaskId = bTaskId;
        document.getElementById('bulk-active-btn').style.display = 'flex';
        document.getElementById('bulk-progress').style.opacity = '1';
        window.bulkInterval = setInterval(window.pollBulkTask, 1500);
        window.pollBulkTask(); 
    }

    if (fTaskId) {
        window.formatTaskId = fTaskId;
        // The task was started against whatever was selected when the page was
        // last open, which is exactly what we just restored.
        window.formatTaskSig = window.bulkSelectionSig();
        window.formatInterval = setInterval(window.pollFormatTask, 1000);
    }
});

window.toggleBulkMode = function() {
    window.bulkMode = true;
    document.getElementById('bulk-btn').style.display = 'none';
    document.getElementById('bulk-cancel-btn').style.display = 'flex';
    document.getElementById('bulk-next-btn').style.display = 'flex';
    window.updateBulkNextBtn();
    window.saveBulkState();
};

window.cancelBulkMode = function() {
    window.bulkMode = false;
    window.bulkSelection.clear();
    document.getElementById('bulk-btn').style.display = 'flex';
    document.getElementById('bulk-cancel-btn').style.display = 'none';
    document.getElementById('bulk-next-btn').style.display = 'none';
    if (window.formatTaskId) window.cancelFormatCheck();
    window.bulkFormatData = null;
    window.bulkFormatSig = null;
    window.pendingFormatType = null;
    window.closeBulkMenu();
    window.syncBulkSelectionUI();
    window.saveBulkState();
};

window.updateBulkNextBtn = function() {
    const nextBtn = document.getElementById('bulk-next-btn');
    if (window.bulkSelection.size > 0) {
        nextBtn.style.pointerEvents = 'auto';
        nextBtn.style.opacity = '1';
    } else {
        nextBtn.style.pointerEvents = 'none';
        nextBtn.style.opacity = '0.5';
    }
};

window.syncBulkSelectionUI = function() {
    document.querySelectorAll('.video-card').forEach(card => {
        const a = card.querySelector('a');
        if (!a) return;
        const url = new URL(a.href, window.location.origin);
        let vid = new URLSearchParams(url.search).get('v');
        if (!vid && url.pathname.includes('/watch')) vid = new URLSearchParams(url.search).get('v');
        if (vid && window.bulkSelection.has(vid)) {
            card.classList.add('selected-for-bulk');
        } else {
            card.classList.remove('selected-for-bulk');
        }
    });
};

window.setMenuHeight = function(paneEl, menuEl) {
    menuEl.style.height = `${paneEl.offsetHeight}px`;
};

window.openBulkMenu = function(e) {
    e.stopPropagation();
    const menu = document.getElementById('bulkMenu');
    if (menu.classList.contains('open')) {
        window.closeBulkMenu();
        return;
    }

    // Any cached format data is only valid for the exact set it was scanned from.
    const sig = window.bulkSelectionSig();
    if (window.bulkFormatSig !== sig) {
        window.bulkFormatData = null;
        window.bulkFormatSig = null;
        if (window.formatTaskId && window.formatTaskSig !== sig) window.cancelFormatCheck();
    }

    window.pendingFormatType = null;
    menu.classList.remove('show-submenu');
    menu.classList.add('open');
    window.setMenuHeight(document.getElementById('bulkMainPane'), menu);
};

window.startFormatFetch = function() {
    const sig = window.bulkSelectionSig();

    if (window.formatTaskId) {
        if (window.formatTaskSig === sig) return;
        window.cancelFormatCheck();
    }
    if (window.bulkFormatData && window.bulkFormatSig === sig) return;

    const ids = Array.from(window.bulkSelection);
    if (ids.length === 0) return;

    fetch('/api/bulk/formats/start', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ video_ids: ids })
    }).then(r => r.json()).then(data => {
        if (data.task_id) {
            window.formatTaskId = data.task_id;
            window.formatTaskSig = sig;
            window.saveBulkState();
            if (window.formatInterval) clearInterval(window.formatInterval);
            window.formatInterval = setInterval(window.pollFormatTask, 1000);
        } else {
            window.showBulkFormatError('Error starting format check.');
        }
    }).catch(e => {
        window.showBulkFormatError('Error starting format check.');
    });
};

window.showBulkFormatLoading = function() {
    document.getElementById('bulkFormatLoading').style.display = 'block';
    document.getElementById('bulkFormatLoadingText').innerText =
        `Fetching available formats... (0/${window.bulkSelection.size})`;
    document.getElementById('bulkFormatContent').innerHTML = '';
    document.getElementById('bulkFormatFooter').style.display = 'none';
    window.setMenuHeight(document.getElementById('bulkFormatPane'), document.getElementById('bulkMenu'));
};

window.showBulkFormatError = function(msg) {
    document.getElementById('bulkFormatLoading').style.display = 'none';
    document.getElementById('bulkFormatContent').innerHTML =
        `<div style="color:#ff4a4a; padding: 20px; text-align:center;">${msg}</div>`;
    document.getElementById('bulkFormatFooter').style.display = 'none';
    window.setMenuHeight(document.getElementById('bulkFormatPane'), document.getElementById('bulkMenu'));
};

window.pollFormatTask = function() {
    if (!window.formatTaskId) return;
    fetch('/api/bulk/formats/status?task_id=' + window.formatTaskId)
        .then(r => r.json())
        .then(data => {
            if (data.status === 'processing') {
                const txt = document.getElementById('bulkFormatLoadingText');
                if (txt) txt.innerText = `Fetching available formats... (${data.current}/${data.total})`;
            } else if (data.status === 'complete') {
                clearInterval(window.formatInterval);
                window.formatTaskId = null;
                window.bulkFormatData = data.result;
                window.bulkFormatSig = window.formatTaskSig;
                window.saveBulkState();

                if (window.pendingFormatType) {
                    window.renderBulkFormats(window.pendingFormatType);
                }
            } else if (data.status === 'error' || data.status === 'cancelled') {
                clearInterval(window.formatInterval);
                window.formatTaskId = null;
                window.formatTaskSig = null;
                window.saveBulkState();
                if (window.pendingFormatType) {
                    window.showBulkFormatError(data.status === 'cancelled' ? 'Cancelled.' : 'Error fetching formats.');
                }
            }
        }).catch(e => {});
};

window.cancelFormatCheck = function() {
    if (!window.formatTaskId) return;
    fetch('/api/bulk/formats/cancel', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ task_id: window.formatTaskId })
    });
    clearInterval(window.formatInterval);
    window.formatTaskId = null;
    window.formatTaskSig = null;
    window.saveBulkState();
};

window.closeBulkMenu = function() {
    const menu = document.getElementById('bulkMenu');
    menu.classList.remove('open');
    setTimeout(() => {
        menu.classList.remove('show-submenu');
        window.pendingFormatType = null;
        if (document.getElementById('bulkMainPane')) {
            window.setMenuHeight(document.getElementById('bulkMainPane'), menu);
        }
    }, 300);
};

window.bulkShowFormats = function(type) {
    const menu = document.getElementById('bulkMenu');
    window.pendingFormatType = type;

    document.getElementById('bulkFormatTitle').innerText =
        `${type.charAt(0).toUpperCase() + type.slice(1)} Format`;
    menu.classList.add('show-submenu');

    const sig = window.bulkSelectionSig();
    if (window.bulkFormatData && window.bulkFormatSig === sig) {
        window.renderBulkFormats(type);
    } else {
        window.showBulkFormatLoading();
        window.startFormatFetch();
    }
};

window.renderBulkFormats = function(type) {
    const menu = document.getElementById('bulkMenu');
    const formatDiv = document.getElementById('bulkFormatContent');
    const footer = document.getElementById('bulkFormatFooter');

    document.getElementById('bulkFormatLoading').style.display = 'none';
    formatDiv.innerHTML = '';

    if (!window.bulkFormatData) return;

    const total = window.bulkFormatData.total;
    const items = window.bulkFormatData[type] || [];
    let hasWarnings = false;
    
    let iconName = 'quality';
    if (type === 'audio') iconName = 'vol-high';
    if (type === 'subtitles') iconName = 'cc-outline';
    
    if (items.length === 0) {
        formatDiv.innerHTML = '<div style="padding: 15px; color: #aaa; text-align: center;">No formats available.</div>';
    } else {
        items.forEach(f => {
            const btn = document.createElement('div');
            btn.className = 'settings-item';
            
            let availabilityHtml = '';
            if (f.count < total) {
                availabilityHtml = `<span class="format-availability">${f.count}/${total} available</span>`;
                hasWarnings = true;
            }
            
            btn.innerHTML = `
                <div class="settings-label">
                    ${window.icon(iconName)}
                    <span>${f.label}</span>
                </div>
                ${availabilityHtml}
            `;
            btn.onclick = () => window.submitBulkTask(type, f.val);
            formatDiv.appendChild(btn);
        });
    }
    
    if (type === 'video') {
        footer.innerText = "Missing videos will fall back to their highest available resolution.";
    } else if (type === 'audio') {
        footer.innerText = "Missing tracks will fall back to their highest available quality.";
    } else if (type === 'subtitles') {
        footer.innerText = "Videos without subtitles will simply be skipped.";
    }
    
    footer.style.display = hasWarnings ? 'block' : 'none';
    window.setMenuHeight(document.getElementById('bulkFormatPane'), menu);
};

window.bulkGoBack = function() {
    const menu = document.getElementById('bulkMenu');
    window.pendingFormatType = null;
    menu.classList.remove('show-submenu');
    window.setMenuHeight(document.getElementById('bulkMainPane'), menu);
};

window.submitBulkTask = function(type, format) {
    window.closeBulkMenu();
    const pb = document.getElementById('bulk-progress');
    pb.style.opacity = '1';
    pb.style.width = '0%';
    
    document.getElementById('bulkProgressView').style.display = 'block';
    document.getElementById('bulkCompleteView').style.display = 'none';
    document.getElementById('bulkDetailsContainer').style.display = 'none';
    document.getElementById('bulkProgressWarning').style.display = 'none';
    document.getElementById('bulkProgressHeaderTxt').innerText = 'Compiling Archive...';
    
    const headerIcon = document.getElementById('bulkProgressHeaderIcon');
    window.setIcon(headerIcon, 'spinner');
    headerIcon.classList.add('nav-spinner');
    
    const activeBtn = document.getElementById('bulk-active-btn');
    activeBtn.style.display = 'flex';
    activeBtn.innerHTML = window.icon('spinner', 'nav-spinner');
    
    const ids = Array.from(window.bulkSelection);
    window.cancelBulkMode(); 
    
    fetch('/api/bulk/start', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ video_ids: ids, dl_type: type, dl_format: format })
    }).then(r => r.json()).then(data => {
        if (data.task_id) {
            window.bulkTaskId = data.task_id;
            window.saveBulkState();
            if(window.bulkInterval) clearInterval(window.bulkInterval);
            window.bulkInterval = setInterval(window.pollBulkTask, 1500);
        } else {
            pb.style.opacity = '0';
            activeBtn.style.display = 'none';
            headerIcon.classList.remove('nav-spinner');
            alert(data.error || "Failed to start task.");
        }
    }).catch(e => {
        pb.style.opacity = '0';
        document.getElementById('bulk-active-btn').style.display = 'none';
        headerIcon.classList.remove('nav-spinner');
        alert("Network error. Could not start task.");
    });
};

window.openBulkProgressMenu = function(e) {
    e.stopPropagation();
    const menu = document.getElementById('bulkProgressMenu');
    if (menu.classList.contains('open')) {
        menu.classList.remove('open');
    } else {
        menu.classList.add('open');
        window.setMenuHeight(document.getElementById('bulkProgressPane'), menu);
    }
};

window.pollBulkTask = function() {
    if (!window.bulkTaskId) return;
    fetch('/api/bulk/status?task_id=' + window.bulkTaskId)
        .then(r => r.json())
        .then(data => {
            const pb = document.getElementById('bulk-progress');
            const pbInner = document.getElementById('bulk-progress-bar-inner');
            const txt = document.getElementById('bulk-progress-text');
            const warnDiv = document.getElementById('bulkProgressWarning');
            const headerIcon = document.getElementById('bulkProgressHeaderIcon');
            const activeBtn = document.getElementById('bulk-active-btn');
            
            let dlNoun = "videos";
            if (data.dl_type === 'audio') dlNoun = "audio tracks";
            if (data.dl_type === 'subtitles') dlNoun = "subtitles";
            
            if (data.status === 'processing') {
                const preciseProgress = ((data.current - 1) + data.fractional_progress) / data.total;
                const pct = Math.min(100, Math.max(5, preciseProgress * 100));
                
                pb.style.width = pct + '%';
                pbInner.style.width = pct + '%';
                
                let actionVerb = "Downloading";
                if (data.dl_type === 'audio') actionVerb = "Extracting";
                if (data.dl_type === 'subtitles') actionVerb = "Fetching";
                
                txt.innerText = `${actionVerb} ${data.current} of ${data.total} ${dlNoun}...`;
                
                const errs = data.errors ? data.errors.length : 0;
                const warns = data.warnings ? data.warnings.length : 0;
                
                if (errs > 0 || warns > 0) {
                    warnDiv.style.display = 'flex';
                    let msg = [];
                    if (errs > 0) msg.push(`${errs} Errors`);
                    if (warns > 0) msg.push(`${warns} Warnings`);
                    document.getElementById('bulkProgressWarningTxt').innerText = msg.join(' | ');
                } else {
                    warnDiv.style.display = 'none';
                }
                
            } else if (data.status === 'complete') {
                clearInterval(window.bulkInterval);
                pb.style.opacity = '0'; pb.style.width = '0%';
                headerIcon.classList.remove('nav-spinner');
                
                document.getElementById('bulkProgressView').style.display = 'none';
                document.getElementById('bulkCompleteView').style.display = 'block';
                
                const errs = data.errors || [];
                const warns = data.warnings || [];
                
                const detCont = document.getElementById('bulkDetailsContainer');
                const errCont = document.getElementById('bulkCompleteErrors');
                const warnCont = document.getElementById('bulkCompleteWarnings');
                
                if (errs.length > 0 || warns.length > 0) {
                    detCont.style.display = 'block';
                    document.getElementById('bulkProgressHeaderTxt').innerText = errs.length > 0 ? 'Completed with Errors' : 'Completed with Warnings';
                    window.setIcon(headerIcon, errs.length > 0 ? 'warning' : 'cloud-check');
                    headerIcon.style.color = errs.length > 0 ? '#f39c12' : '#4aff4a';
                    
                    if (errs.length > 0) {
                        errCont.style.display = 'block';
                        errCont.innerHTML = '<strong style="color:#ff4a4a; font-size:12px; display:block; margin-bottom:4px;">Errors:</strong>' + errs.map(e => `<div style="font-size:11px; color:#ffb3b3; margin-bottom:4px; line-height:1.3;"><strong>${e.title}</strong>: ${e.reason}</div>`).join('');
                        activeBtn.innerHTML = window.icon('warning', '', 'width:24px;height:24px;color:#f39c12;');
                    } else {
                        errCont.style.display = 'none';
                        activeBtn.innerHTML = window.icon('cloud-check', '', 'width:24px;height:24px;color:#4aff4a;');
                    }
                    
                    if (warns.length > 0) {
                        warnCont.style.display = 'block';
                        warnCont.innerHTML = '<strong style="color:#f39c12; font-size:12px; display:block; margin-bottom:4px;">Warnings:</strong>' + warns.map(w => `<div style="font-size:11px; color:#fbe0b6; margin-bottom:4px; line-height:1.3;"><strong>${w.title}</strong>: ${w.reason}</div>`).join('');
                    } else {
                        warnCont.style.display = 'none';
                    }
                    warnDiv.style.display = 'none';
                } else {
                    document.getElementById('bulkProgressHeaderTxt').innerText = 'Zip Archive Ready';
                    window.setIcon(headerIcon, 'cloud-check');
                    headerIcon.style.color = '#4aff4a';
                    detCont.style.display = 'none';
                    warnDiv.style.display = 'none';
                    activeBtn.innerHTML = window.icon('cloud-check', '', 'width:24px;height:24px;color:#4aff4a;');
                }
                
                activeBtn.style.animation = 'none'; 
                
                const menu = document.getElementById('bulkProgressMenu');
                if (menu.classList.contains('open')) {
                    window.setMenuHeight(document.getElementById('bulkProgressPane'), menu);
                }
                
            } else if (data.status === 'cancelled') {
                clearInterval(window.bulkInterval);
                pb.style.opacity = '0'; pb.style.width = '0%';
                headerIcon.classList.remove('nav-spinner');
                activeBtn.style.display = 'none';
                document.getElementById('bulkProgressMenu').classList.remove('open');
                window.bulkTaskId = null;
                window.saveBulkState();
                
            } else if (data.status === 'error') {
                clearInterval(window.bulkInterval);
                pb.style.opacity = '0'; pb.style.width = '0%';
                headerIcon.classList.remove('nav-spinner');
                activeBtn.style.display = 'none';
                document.getElementById('bulkProgressMenu').classList.remove('open');
                window.bulkTaskId = null;
                window.saveBulkState();
                alert("Bulk download failed. See server logs for details.");
            }
        }).catch(e => {});
};

window.cancelBulkDownload = function() {
    if (!window.bulkTaskId) return;
    fetch('/api/bulk/cancel', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ task_id: window.bulkTaskId })
    }).then(() => {
        document.getElementById('bulk-progress-text').innerText = "Cancelling... waiting for current file to finish.";
    }).catch(e => console.error(e));
};

window.downloadBulkFile = function() {
    if (!window.bulkTaskId) return;
    window.location.href = '/api/bulk/download?task_id=' + window.bulkTaskId;
};

window.clearBulkDownload = function() {
    if (!window.bulkTaskId) return;
    fetch('/api/bulk/clear', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ task_id: window.bulkTaskId })
    }).then(() => {
        document.getElementById('bulk-active-btn').style.display = 'none';
        document.getElementById('bulkProgressMenu').classList.remove('open');
        window.bulkTaskId = null;
        window.saveBulkState();
    }).catch(e => console.error(e));
};

document.addEventListener('click', e => {
    const menu1 = document.getElementById('bulkMenu');
    const btn1 = document.getElementById('bulk-next-btn');
    if (menu1 && menu1.classList.contains('open') && !menu1.contains(e.target) && !btn1.contains(e.target)) {
        window.closeBulkMenu();
    }
    
    const menu2 = document.getElementById('bulkProgressMenu');
    const btn2 = document.getElementById('bulk-active-btn');
    if (menu2 && menu2.classList.contains('open') && !menu2.contains(e.target) && !btn2.contains(e.target)) {
        menu2.classList.remove('open');
    }
});
