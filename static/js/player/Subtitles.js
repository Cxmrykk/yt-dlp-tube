class Subtitles {
    constructor(player) {
        this.player = player;
        this.ui = player.ui;
        this.ccSettings = { ...window.APP_CONFIG.ccSettings };
        
        this.currentSubVal = "off";
        this.manualSubs = [];
        this.autoSubs = [];

        this.bindAppearanceOptions();
    }

    getBestSubVal() {
        let prefLang = localStorage.getItem('prefSubLang');
        let browserLang = prefLang || (navigator.language || navigator.userLanguage).split('-')[0].toLowerCase();
        let bestSub = null;

        if (this.manualSubs.length > 0 || this.autoSubs.length > 0) {
            bestSub = this.manualSubs.find(s => s.lang.toLowerCase().startsWith(browserLang));
            if (!bestSub) bestSub = this.autoSubs.find(s => s.is_source && s.lang.toLowerCase().startsWith(browserLang));
            if (!bestSub) bestSub = this.autoSubs.find(s => s.lang.toLowerCase().startsWith(browserLang));
            if (!bestSub) bestSub = this.autoSubs.find(s => s.is_source);
            if (!bestSub) bestSub = this.manualSubs.find(s => s.lang.toLowerCase().startsWith('en'));
            if (!bestSub) bestSub = this.autoSubs.find(s => s.lang.toLowerCase().startsWith('en'));
            if (!bestSub && this.manualSubs.length > 0) bestSub = this.manualSubs[0];
            if (!bestSub && this.autoSubs.length > 0) bestSub = this.autoSubs[0];
        }
        return bestSub ? `${bestSub.lang}|${bestSub.label}` : "off";
    }

    changeSubtitle(val) {
        this.currentSubVal = val;
        let ccOn = false;
        
        for (let i = 0; i < this.ui.mainVideo.textTracks.length; i++) {
            const t = this.ui.mainVideo.textTracks[i];
            const tVal = `${t.language}|${t.label}`;
            if (val !== "off" && tVal === val) {
                t.mode = 'showing';
                ccOn = true;
            } else {
                t.mode = 'disabled';
            }
        }
        
        if (ccOn) this.ui.ccBtn.classList.add('cc-on');
        else this.ui.ccBtn.classList.remove('cc-on');
    }

    setSubtitleOption(val, userInitiated = false) {
        document.querySelectorAll('#ccMenu .submenu-option').forEach(o => o.classList.remove('selected'));
        const opt = document.querySelector(`#ccMenu .submenu-option[data-val="${val.replace(/"/g, '\\"')}"]`);
        if (opt) {
            opt.classList.add('selected');
            const autoCheck = document.getElementById('autoCheckIcon');
            if (autoCheck) autoCheck.style.opacity = (opt.dataset.isAuto === 'true') ? '1' : '0';
        }
        
        if (userInitiated) {
            if (val === 'off') localStorage.setItem('prefSubState', 'off');
            else {
                localStorage.setItem('prefSubState', 'on');
                localStorage.setItem('prefSubLang', val.split('|')[0].toLowerCase());
            }
        }
        this.changeSubtitle(val);
    }

    toggleCc() {
        if (this.currentSubVal === "off") {
            const bestVal = this.getBestSubVal();
            if (bestVal !== "off") {
                this.setSubtitleOption(bestVal, true);
                this.player.showOverlay(`<img src="/static/icons/cc-filled.svg" class="overlay-icon" alt="CC On">`);
            }
        } else {
            this.setSubtitleOption("off", true);
            this.player.showOverlay(`<img src="/static/icons/cc-outline.svg" class="overlay-icon" alt="CC Off">`);
        }
    }

    buildMenu(subsList) {
        const ccMainPane = document.getElementById('ccMainPane');
        const ccSubmenuContent = document.getElementById('ccSubmenuContent');
        ccMainPane.innerHTML = '';
        ccSubmenuContent.innerHTML = '';
        
        Array.from(this.ui.mainVideo.querySelectorAll('track')).forEach(t => t.remove());

        this.manualSubs = [];
        this.autoSubs = [];

        if (subsList.length > 0) {
            this.ui.ccBtn.style.display = 'flex';
            
            subsList.forEach((sub) => {
                const track = document.createElement('track');
                track.kind = 'subtitles';
                track.label = sub.label;
                track.srclang = sub.lang;
                track.src = PlayerUtils.getSubProxyUrl(sub.url); 

                this.ui.mainVideo.appendChild(track);

                if (sub.is_auto) this.autoSubs.push(sub);
                else this.manualSubs.push(sub);
            });

            const createOption = (label, val, isSelected, isAuto) => {
                const div = document.createElement('div');
                div.className = `submenu-option ${isSelected ? 'selected' : ''}`;
                div.innerHTML = `<img src="/static/icons/check.svg" class="check-icon" alt="Check"><span>${label}</span>`;
                div.dataset.val = val;
                div.dataset.isAuto = isAuto;
                return div;
            };

            ccMainPane.appendChild(createOption('Off', 'off', false, false));
            this.manualSubs.forEach(sub => ccMainPane.appendChild(createOption(sub.label, `${sub.lang}|${sub.label}`, false, false)));

            if (this.autoSubs.length > 0) {
                const autoBtn = document.createElement('div');
                autoBtn.className = 'settings-item';
                autoBtn.innerHTML = `
                    <div class="settings-label">
                        <img src="/static/icons/check.svg" class="check-icon" id="autoCheckIcon" style="opacity: 0; width: 20px; height: 20px; margin-right: -4px;" alt="Check">
                        <span>Auto-generated</span>
                    </div>
                    <div class="settings-value"><img src="/static/icons/chevron-right.svg" class="settings-chevron" alt=">"></div>
                `;
                autoBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.ui.ccMenu.classList.add('show-submenu');
                    this.player.menus.setMenuHeight(document.getElementById('ccSubPane'), this.ui.ccMenu);
                });
                ccMainPane.appendChild(autoBtn);

                const sourceAuto = this.autoSubs.find(s => s.is_source);
                const translationSubs = this.autoSubs.filter(s => !s.is_source);

                if (sourceAuto) {
                    ccSubmenuContent.appendChild(createOption(sourceAuto.label, `${sourceAuto.lang}|${sourceAuto.label}`, false, true));
                    if (translationSubs.length > 0) {
                        const divider = document.createElement('div');
                        divider.style.cssText = "height: 1px; background: rgba(255,255,255,0.1); margin: 4px 0;";
                        ccSubmenuContent.appendChild(divider);
                    }
                }

                translationSubs.forEach(sub => ccSubmenuContent.appendChild(createOption(sub.label, `${sub.lang}|${sub.label}`, false, true)));
            }

            const divi = document.createElement('div');
            divi.style.cssText = "height: 1px; background: rgba(255,255,255,0.1); margin: 4px 0;";
            ccMainPane.appendChild(divi);
            
            const optionsBtn = document.createElement('div');
            optionsBtn.className = 'settings-item';
            optionsBtn.innerHTML = `
                <div class="settings-label">
                    <img src="/static/icons/appearance.svg" style="width:20px; height:20px;" alt="Appearance">
                    <span>Appearance</span>
                </div>
                <div class="settings-value"><img src="/static/icons/chevron-right.svg" class="settings-chevron" alt=">"></div>
            `;
            optionsBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.ui.ccMenu.classList.add('show-options');
                this.player.menus.setMenuHeight(document.getElementById('ccOptionsPane'), this.ui.ccMenu);
            });
            ccMainPane.appendChild(optionsBtn);

            document.querySelectorAll('#ccMenu .submenu-option').forEach(opt => {
                opt.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.setSubtitleOption(opt.dataset.val, true);
                    this.player.menus.closeCcMenu();
                });
            });

            let prefState = localStorage.getItem('prefSubState') || 'off';
            let defaultVal = "off";
            if (prefState === 'on') {
                defaultVal = this.getBestSubVal();
            }
            this.setSubtitleOption(defaultVal, false);

        } else {
            this.ui.ccBtn.style.display = 'none';
            this.currentSubVal = "off";
        }
    }

    bindAppearanceOptions() {
        const fontSel = document.getElementById('ccFontSelect');
        const colorInp = document.getElementById('ccColorInput');
        const bgInp = document.getElementById('ccBgInput');
        const opInp = document.getElementById('ccOpacityInput');
        const opVal = document.getElementById('ccOpacityVal');
        const sizeInp = document.getElementById('ccSizeInput');
        const sizeVal = document.getElementById('ccSizeVal');
        const vOffsetInp = document.getElementById('ccVOffsetInput');
        const vOffsetVal = document.getElementById('ccVOffsetVal');
        const resetBtn = document.getElementById('ccResetBtn');
        const saveBtn = document.getElementById('ccSaveBtn');

        this.updateCcStyles = () => {
            const rgb = PlayerUtils.hex2rgb(this.ccSettings.bg);
            const pxOffset = (this.ccSettings.v_offset / 100) * (this.player.state.currentVideoHeight || this.player.container.clientHeight || 500);

            const css = `
                ::cue {
                    background-color: rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${this.ccSettings.bg_op}) !important;
                    color: ${this.ccSettings.color} !important;
                    font-family: ${this.ccSettings.font} !important;
                    font-size: ${this.ccSettings.scale}rem !important;
                    text-shadow: 0 1px 3px rgba(0,0,0,1) !important;
                    text-align: center !important;
                }
                video::-webkit-media-text-track-display {
                    transform: translateY(-${pxOffset}px) !important;
                }
            `;
            document.getElementById('custom-cc-style').innerHTML = css;
        };

        const updateLabels = () => {
            opVal.textContent = Math.round(this.ccSettings.bg_op * 100) + '%';
            sizeVal.textContent = parseFloat(this.ccSettings.scale).toFixed(2) + 'x';
            vOffsetVal.textContent = this.ccSettings.v_offset + '%';
        };

        const syncUI = () => {
            fontSel.value = this.ccSettings.font;
            colorInp.value = this.ccSettings.color;
            bgInp.value = this.ccSettings.bg;
            opInp.value = this.ccSettings.bg_op;
            sizeInp.value = this.ccSettings.scale;
            vOffsetInp.value = this.ccSettings.v_offset;
            updateLabels();
            this.updateCcStyles();
        };

        const triggerUpdate = () => {
            this.ccSettings.font = fontSel.value;
            this.ccSettings.color = colorInp.value;
            this.ccSettings.bg = bgInp.value;
            this.ccSettings.bg_op = parseFloat(opInp.value);
            this.ccSettings.scale = parseFloat(sizeInp.value);
            this.ccSettings.v_offset = parseFloat(vOffsetInp.value);
            updateLabels();
            this.updateCcStyles();
        };

        fontSel.addEventListener('change', triggerUpdate);
        colorInp.addEventListener('input', triggerUpdate);
        bgInp.addEventListener('input', triggerUpdate);
        opInp.addEventListener('input', triggerUpdate);
        sizeInp.addEventListener('input', triggerUpdate);
        vOffsetInp.addEventListener('input', triggerUpdate);

        resetBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.ccSettings = { ...window.APP_CONFIG.ccSettings };
            syncUI();
        });

        saveBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            saveBtn.textContent = 'Saving...';
            window.appFetch('/api/save_cc_settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    cc_font: this.ccSettings.font,
                    cc_color: this.ccSettings.color,
                    cc_bg: this.ccSettings.bg,
                    cc_bg_op: this.ccSettings.bg_op,
                    cc_scale: this.ccSettings.scale,
                    cc_v_offset: this.ccSettings.v_offset
                })
            }).then(() => {
                saveBtn.textContent = 'Saved!';
                window.APP_CONFIG.ccSettings = { ...this.ccSettings };
                setTimeout(() => saveBtn.textContent = 'Save Changes', 2000);
            }).catch(() => {
                saveBtn.textContent = 'Error';
                setTimeout(() => saveBtn.textContent = 'Save Changes', 2000);
            });
        });

        syncUI();
    }
    
    destroy() {}
}