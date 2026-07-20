(function() {
    let currentListeningBtn = null;
    let boundHandler = null;

    function showUnsavedWarning() {
        document.getElementById('unsaved-warning').style.display = 'inline-block';
    }

    window.startListening = function(btn, inputId) {
        if (currentListeningBtn) window.stopListening();
        currentListeningBtn = btn;
        btn.classList.add('listening');
        btn.innerText = "Press any key...";
        
        boundHandler = function(e) {
            e.preventDefault();
            let key = e.key;
            if (key === ' ') key = 'Space';
            
            const inputEl = document.getElementById(inputId);
            if (inputEl.value !== key) {
                inputEl.value = key;
                showUnsavedWarning();
            }
            
            btn.innerText = key;
            window.stopListening();
        };
        
        setTimeout(() => {
            document.addEventListener('keydown', boundHandler);
        }, 10);
    }

    window.stopListening = function() {
        if (currentListeningBtn) {
            currentListeningBtn.classList.remove('listening');
            if (currentListeningBtn.innerText === "Press any key...") {
                const inputId = currentListeningBtn.getAttribute('onclick').match(/'([^']+)'/)[1];
                currentListeningBtn.innerText = document.getElementById(inputId).value || 'Unbound';
            }
            if (boundHandler) {
                document.removeEventListener('keydown', boundHandler);
                boundHandler = null;
            }
            currentListeningBtn = null;
        }
    }
    
    const handleBodyClick = (e) => {
        if (currentListeningBtn && e.target !== currentListeningBtn) {
            window.stopListening();
        }
    };
    document.addEventListener('click', handleBodyClick);

    window.clearShortcut = function(inputId, btnId) {
        window.stopListening();
        const inputEl = document.getElementById(inputId);
        if (inputEl.value !== '') {
            inputEl.value = '';
            document.getElementById(btnId).innerText = 'Unbound';
            showUnsavedWarning();
        }
    }

    const defaults = {
        'inp_pause': 'Space', 'inp_seek_fwd': 'ArrowRight',
        'inp_seek_bwd': 'ArrowLeft', 'inp_mute': 'm', 'inp_cc': 'v',
        'inp_chap_next': 'PageUp', 'inp_chap_prev': 'PageDown',
        'inp_speed_up': 'ArrowUp', 'inp_speed_down': 'ArrowDown'
    };

    window.resetShortcuts = function() {
        window.stopListening();
        let changed = false;
        for (const [id, val] of Object.entries(defaults)) {
            const el = document.getElementById(id);
            if (el.value !== val) {
                el.value = val;
                document.getElementById('btn_' + id.replace('inp_', '')).innerText = val;
                changed = true;
            }
        }
        if (changed) showUnsavedWarning();
    }

    window.pageTeardown = function() {
        document.removeEventListener('click', handleBodyClick);
        if (boundHandler) document.removeEventListener('keydown', boundHandler);
    };
})();
