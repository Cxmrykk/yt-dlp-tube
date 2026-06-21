class MenuSystem {
    constructor(player) {
        this.player = player;
        this.ui = player.ui;
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
               this.ui.cacheMenu.classList.contains('open');
    }

    openSettingsMenu() { 
        this.closeCcMenu(); 
        this.player.cache.closeCacheMenu();
        this.ui.settingsMenu.classList.add('open'); 
        this.ui.settingsBtn.classList.add('active-menu-btn'); 
        this.player.container.classList.add('menu-open'); 
        this.setMenuHeight(document.getElementById('mainPane'), this.ui.settingsMenu); 
    }
    
    closeSettingsMenu() {
        this.ui.settingsMenu.classList.remove('open'); 
        this.ui.settingsBtn.classList.remove('active-menu-btn'); 
        if(!this.ui.ccMenu.classList.contains('open') && !this.ui.cacheMenu.classList.contains('open')) {
            this.player.container.classList.remove('menu-open');
        }
        setTimeout(() => { 
            this.ui.settingsMenu.classList.remove('show-submenu'); 
            this.setMenuHeight(document.getElementById('mainPane'), this.ui.settingsMenu); 
        }, 300); 
    }

    openCcMenu() {
        this.closeSettingsMenu(); 
        this.player.cache.closeCacheMenu();
        this.ui.ccMenu.classList.add('open');
        this.player.container.classList.add('menu-open');
        this.setMenuHeight(document.getElementById('ccMainPane'), this.ui.ccMenu);
    }

    closeCcMenu() {
        this.ui.ccMenu.classList.remove('open');
        if(!this.ui.settingsMenu.classList.contains('open') && !this.ui.cacheMenu.classList.contains('open')) {
            this.player.container.classList.remove('menu-open');
        }
        setTimeout(() => { 
            this.ui.ccMenu.classList.remove('show-submenu', 'show-options'); 
            this.setMenuHeight(document.getElementById('ccMainPane'), this.ui.ccMenu); 
        }, 300);
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

        this.bodyMenuClick = (e) => { 
            if (!this.ui.settingsMenu.contains(e.target) && !this.ui.settingsBtn.contains(e.target)) this.closeSettingsMenu(); 
            if (!this.ui.ccMenu.contains(e.target) && !this.ui.ccBtn.contains(e.target)) this.closeCcMenu();
        };
        document.addEventListener('click', this.bodyMenuClick);

        document.querySelectorAll('.settings-item:not(#downloadCacheBtn)').forEach(item => {
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

        // Volume Controls
        this.ui.muteBtn.addEventListener('click', () => this.player.toggleMute());
        this.ui.volumeSlider.addEventListener('input', (e) => {
            this.ui.mainVideo.volume = e.target.value; 
            this.ui.audio.volume = e.target.value;
            this.ui.mainVideo.muted = e.target.value === '0'; 
            this.ui.audio.muted = this.ui.mainVideo.muted; 
            this.player.updateVolumeIcons();
        });

        // Fullscreen Controls
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