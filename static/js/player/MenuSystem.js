class MenuSystem {
    constructor(player) {
        this.player = player;
        this.ui = player.ui;
        this.sbTempStart = null;
        this.menuData = {
            speed: {
                title: "Playback speed",
                options: [
                    { label: "0.25", value: 0.25 }, { label: "0.5", value: 0.5 }, { label: "0.75", value: 0.75 },
                    { label: "Normal", value: 1 }, { label: "1.25", value: 1.25 }, { label: "1.5", value: 1.5 },
                    { label: "1.75", value: 1.75 }, { label: "2", value: 2 }
                ],
                current: 1, 
                onSelect: (val, label) => {
                    this.ui.mainVideo.playbackRate = val;
                    this.ui.audio.playbackRate = val;
                    document.getElementById('lbl-speed').textContent = label;
                }
            },
            quality: { 
                title: "Quality", 
                options: [], 
                current: "", 
                onSelect: (val, label) => this.player.changeResolution(val, label) 
            }
        };

        this.bindEvents();
    }

    setMenuHeight(paneElement, menuElement) {
        menuElement.style.height = `${paneElement.offsetHeight}px`;
    }

    isAnyMenuOpen() {
        return this.ui.settingsMenu.classList.contains('open') || 
               this.ui.ccMenu.classList.contains('open') || 
               this.ui.cacheMenu.classList.contains('open') ||
               (this.ui.sbMenu && this.ui.sbMenu.classList.contains('open'));
    }

    changeSpeed(direction) {
        const data = this.menuData.speed;
        let idx = data.options.findIndex(o => o.value === data.current);
        if (idx === -1) idx = 3; 
        idx += direction;
        
        if (idx < 0) idx = 0;
        if (idx >= data.options.length) idx = data.options.length - 1;
        
        const opt = data.options[idx];
        data.current = opt.value;
        data.onSelect(opt.value, opt.label);
        
        const overlayText = opt.label === 'Normal' ? '1x' : opt.label + 'x';
        this.player.showOverlay(`<div style="font-weight:bold; font-size:1.2rem; color:white;">${overlayText}</div>`);
    }

    openSettingsMenu() { 
        this.closeCcMenu(); 
        this.player.cache.closeCacheMenu();
        this.closeSbMenu();
        this.ui.settingsMenu.classList.add('open'); 
        this.ui.settingsBtn.classList.add('active-menu-btn'); 
        this.player.container.classList.add('menu-open'); 
        this.setMenuHeight(document.getElementById('mainPane'), this.ui.settingsMenu); 
    }
    
    closeSettingsMenu() {
        this.ui.settingsMenu.classList.remove('open'); 
        this.ui.settingsBtn.classList.remove('active-menu-btn'); 
        if(!this.isAnyMenuOpen()) this.player.container.classList.remove('menu-open');
        setTimeout(() => { 
            this.ui.settingsMenu.classList.remove('show-submenu'); 
            this.setMenuHeight(document.getElementById('mainPane'), this.ui.settingsMenu); 
        }, 300); 
    }

    openCcMenu() {
        this.closeSettingsMenu(); 
        this.player.cache.closeCacheMenu();
        this.closeSbMenu();
        this.ui.ccMenu.classList.add('open');
        this.player.container.classList.add('menu-open');
        this.setMenuHeight(document.getElementById('ccMainPane'), this.ui.ccMenu);
    }

    closeCcMenu() {
        this.ui.ccMenu.classList.remove('open');
        if(!this.isAnyMenuOpen()) this.player.container.classList.remove('menu-open');
        setTimeout(() => { 
            this.ui.ccMenu.classList.remove('show-submenu', 'show-options'); 
            this.setMenuHeight(document.getElementById('ccMainPane'), this.ui.ccMenu); 
        }, 300);
    }
    
    openSbMenu() {
        this.closeSettingsMenu(); 
        this.closeCcMenu(); 
        this.player.cache.closeCacheMenu();
        this.ui.sbMenu.classList.add('open');
        this.ui.sbBtn.classList.add('active-menu-btn');
        this.player.container.classList.add('menu-open');
        this.renderSbMenu();
    }
    
    closeSbMenu() {
        if (!this.ui.sbMenu) return;
        this.sbTempStart = null;
        this.ui.sbMenu.classList.remove('open');
        this.ui.sbBtn.classList.remove('active-menu-btn');
        if (!this.isAnyMenuOpen()) this.player.container.classList.remove('menu-open');
        setTimeout(() => {
            this.ui.sbMenu.classList.remove('show-submit');
            this.setMenuHeight(document.getElementById('sbMainPane'), this.ui.sbMenu);
        }, 300);
    }
    
    renderSbMenu() {
        const sb = this.player.sponsorBlock;
        const pane = document.getElementById('sbMainPane');
        pane.innerHTML = '';
        
        const toggleDiv = document.createElement('div');
        toggleDiv.className = 'settings-item';
        toggleDiv.innerHTML = `
            <div class="settings-label">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#ffffff" width="20px" height="20px"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z"/></svg>
                <span>SponsorBlock</span>
            </div>
            <div class="settings-value">${sb.sessionEnabled ? 'Enabled' : 'Disabled'}</div>
        `;
        toggleDiv.addEventListener('click', (e) => {
            e.stopPropagation();
            sb.toggle(!sb.sessionEnabled);
            this.renderSbMenu();
        });
        pane.appendChild(toggleDiv);

        if (!sb.sessionEnabled) {
            this.setMenuHeight(pane, this.ui.sbMenu);
            return;
        }

        let submitText = this.sbTempStart !== null ? "End Segment" : "Start Segment";

        const submitDiv = document.createElement('div');
        submitDiv.className = 'settings-item';
        submitDiv.innerHTML = `
            <div class="settings-label">
                <span style="margin-left: 32px;">${submitText}</span>
            </div>
            <div class="settings-value"><img src="/static/icons/chevron-right.svg" class="settings-chevron" alt=">"></div>
        `;
        submitDiv.addEventListener('click', (e) => {
            e.stopPropagation();
            
            if (this.sbTempStart === null) {
                this.sbTempStart = this.player.ui.mainVideo.currentTime;
                this.renderSbMenu();
            } else {
                const endVal = this.player.ui.mainVideo.currentTime;
                const startVal = this.sbTempStart;
                this.sbTempStart = null; 

                if (endVal <= startVal) {
                    alert("End time must be greater than start time.");
                    this.renderSbMenu();
                    return;
                }

                this.ui.sbMenu.classList.add('show-submit');
                this.setMenuHeight(document.getElementById('sbSubmitPane'), this.ui.sbMenu);
                this.renderSbSubmitMenu(startVal, endVal);
            }
        });
        pane.appendChild(submitDiv);

        const activeSeg = sb.activeSegment || sb.lastPassedSegment;
        if (activeSeg) {
            const catName = activeSeg.category.charAt(0).toUpperCase() + activeSeg.category.slice(1);
            
            const infoDiv = document.createElement('div');
            infoDiv.style.padding = '15px';
            infoDiv.style.borderTop = '1px solid rgba(255,255,255,0.1)';
            
            infoDiv.innerHTML = `
                <div style="font-weight: bold; margin-bottom: 8px; color: ${sb.colors[activeSeg.category] || '#fff'};">Segment: ${catName}</div>
                <div style="display: flex; gap: 10px;">
                    <button class="btn sb-vote-btn" data-vote="1" style="flex:1; padding:6px; font-size:12px;">👍 Upvote</button>
                    <button class="btn sb-vote-btn" data-vote="0" style="flex:1; padding:6px; font-size:12px;">👎 Downvote</button>
                </div>
            `;
            pane.appendChild(infoDiv);
            
            infoDiv.querySelectorAll('.sb-vote-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    sb.vote(activeSeg.UUID, btn.dataset.vote === "1");
                    btn.innerText = "Voted!";
                    btn.disabled = true;
                    btn.style.opacity = '0.5';
                });
            });
        }
        
        this.setMenuHeight(pane, this.ui.sbMenu);
    }
    
    renderSbSubmitMenu(startVal, endVal) {
        document.getElementById('sbSubmitBackBtn').onclick = (e) => {
            e.stopPropagation();
            this.ui.sbMenu.classList.remove('show-submit');
            this.setMenuHeight(document.getElementById('sbMainPane'), this.ui.sbMenu);
        };
        
        document.getElementById('sbSubmitStartTxt').textContent = PlayerUtils.formatTime(startVal);
        document.getElementById('sbSubmitEndTxt').textContent = PlayerUtils.formatTime(endVal);
        
        document.getElementById('sbSubmitFinalBtn').onclick = async (e) => {
            e.stopPropagation();
            const cat = document.getElementById('sbSubmitCategory').value;
            const btn = document.getElementById('sbSubmitFinalBtn');
            btn.textContent = "Submitting...";
            btn.disabled = true;
            
            const success = await this.player.sponsorBlock.submitSegment(startVal, endVal, cat);
            if (success) {
                btn.textContent = "Submitted!";
                setTimeout(() => {
                    this.ui.sbMenu.classList.remove('show-submit');
                    this.setMenuHeight(document.getElementById('sbMainPane'), this.ui.sbMenu);
                    btn.textContent = "Submit to API";
                    btn.disabled = false;
                }, 1500);
            } else {
                btn.textContent = "Failed. Try Again.";
                setTimeout(() => {
                    btn.textContent = "Submit to API";
                    btn.disabled = false;
                }, 2000);
            }
        };
    }

    bindEvents() {
        this.ui.settingsBtn.addEventListener('click', (e) => { 
            e.stopPropagation(); 
            if (this.ui.settingsMenu.classList.contains('open')) this.closeSettingsMenu(); 
            else this.openSettingsMenu(); 
        });
        this.ui.ccBtn.addEventListener('click', (e) => { 
            e.stopPropagation(); 
            if (this.ui.ccMenu.classList.contains('open')) this.closeCcMenu(); 
            else this.openCcMenu(); 
        });
        if (this.ui.sbBtn) {
            this.ui.sbBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (this.ui.sbMenu.classList.contains('open')) this.closeSbMenu();
                else this.openSbMenu();
            });
        }

        this.bodyMenuClick = (e) => { 
            if (!this.ui.settingsMenu.contains(e.target) && !this.ui.settingsBtn.contains(e.target)) this.closeSettingsMenu(); 
            if (!this.ui.ccMenu.contains(e.target) && !this.ui.ccBtn.contains(e.target)) this.closeCcMenu();
            if (this.ui.sbMenu && !this.ui.sbMenu.contains(e.target) && !this.ui.sbBtn.contains(e.target)) this.closeSbMenu();
        };
        document.addEventListener('click', this.bodyMenuClick);

        document.querySelectorAll('.settings-item:not(#downloadCacheBtn):not(#removeCacheBtn)').forEach(item => {
            if(!item.hasAttribute('data-menu')) return;
            item.addEventListener('click', (e) => {
                e.stopPropagation(); 
                const menuType = item.getAttribute('data-menu'); 
                const data = this.menuData[menuType];
                const submenuTitle = document.getElementById('submenuTitle');
                const submenuContent = document.getElementById('submenuContent');
                const mainPane = document.getElementById('mainPane');
                const subPane = document.getElementById('subPane');

                submenuTitle.textContent = data.title; 
                submenuContent.innerHTML = ''; 

                data.options.forEach(opt => {
                    const isSelected = data.current === opt.value;
                    const optionDiv = document.createElement('div');
                    optionDiv.className = `submenu-option ${isSelected ? 'selected' : ''}`;
                    optionDiv.innerHTML = `<img src="/static/icons/check.svg" class="check-icon" alt="Check"><span>${opt.label}</span>`;
                    optionDiv.addEventListener('click', (eClick) => {
                        eClick.stopPropagation(); 
                        data.current = opt.value; 
                        data.onSelect(opt.value, opt.label);
                        this.ui.settingsMenu.classList.remove('show-submenu'); 
                        this.setMenuHeight(mainPane, this.ui.settingsMenu); 
                        setTimeout(() => this.closeSettingsMenu(), 250); 
                    });
                    submenuContent.appendChild(optionDiv);
                });
                this.ui.settingsMenu.classList.add('show-submenu'); 
                this.setMenuHeight(subPane, this.ui.settingsMenu);
            });
        });

        document.getElementById('submenuBackBtn').addEventListener('click', (e) => { 
            e.stopPropagation(); 
            this.ui.settingsMenu.classList.remove('show-submenu'); 
            this.setMenuHeight(document.getElementById('mainPane'), this.ui.settingsMenu); 
        });
        document.getElementById('ccSubmenuBackBtn').addEventListener('click', (e) => { 
            e.stopPropagation(); 
            this.ui.ccMenu.classList.remove('show-submenu'); 
            this.setMenuHeight(document.getElementById('ccMainPane'), this.ui.ccMenu); 
        });
        document.getElementById('ccOptionsBackBtn').addEventListener('click', (e) => { 
            e.stopPropagation(); 
            this.ui.ccMenu.classList.remove('show-options'); 
            this.setMenuHeight(document.getElementById('ccMainPane'), this.ui.ccMenu); 
        });

        this.ui.muteBtn.addEventListener('click', () => this.player.toggleMute());
        this.ui.volumeSlider.addEventListener('input', (e) => {
            this.ui.mainVideo.volume = e.target.value; 
            this.ui.audio.volume = e.target.value;
            this.ui.mainVideo.muted = e.target.value === '0'; 
            this.ui.audio.muted = this.ui.mainVideo.muted; 
            this.player.updateVolumeIcons();
        });

        this.ui.fullscreenBtn.addEventListener('click', () => {
            if (!document.fullscreenElement && !document.webkitFullscreenElement) {
                if (this.player.container.requestFullscreen) this.player.container.requestFullscreen();
                else if (this.player.container.webkitRequestFullscreen) this.player.container.webkitRequestFullscreen();
            } else {
                if (document.exitFullscreen) document.exitFullscreen();
                else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
            }
        });

        ['fullscreenchange', 'webkitfullscreenchange'].forEach(evt => {
            document.addEventListener(evt, () => {
                const isFS = document.fullscreenElement || document.webkitFullscreenElement;
                if (isFS) {
                    this.player.container.classList.remove('user-active'); 
                    this.player.container.classList.add('hide-cursor');
                    if (this.ui.fsIconEnter) this.ui.fsIconEnter.style.display = 'none'; 
                    if (this.ui.fsIconExit) this.ui.fsIconExit.style.display = 'block';
                } else {
                    if (this.ui.fsIconEnter) this.ui.fsIconEnter.style.display = 'block'; 
                    if (this.ui.fsIconExit) this.ui.fsIconExit.style.display = 'none';
                }
            });
        });
    }

    destroy() {
        document.removeEventListener('click', this.bodyMenuClick);
    }
}