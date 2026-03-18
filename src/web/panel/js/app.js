/* ─────────────────────────────────────────────────────────────────────────
   Bot Panel — app.js  (Redesigned)
   ───────────────────────────────────────────────────────────────────────── */

'use strict';

/* ══════════════════════════════════════════════════════════════
   UTILITIES
══════════════════════════════════════════════════════════════ */

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function stripEmoji(str) {
  if (!str) return '';
  return str.replace(/[\u{1F300}-\u{1FFFF}]|[\u{2600}-\u{27BF}]/gu, '').trim();
}

function fmtDuration(secs) {
  if (!secs && secs !== 0) return '0:00';
  const s = Math.floor(secs), m = Math.floor(s / 60), h = Math.floor(m / 60);
  const ss = String(s % 60).padStart(2, '0'), mm = String(m % 60).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

function fmtHHMMSS(input) {
  if (typeof input === 'string' && input.includes(':')) return input;
  const secs = parseInt(input, 10);
  if (isNaN(secs)) return input || '00:00:00';
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
  return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
}

function fmtTimestamp(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return ts;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }
function getVal(id) { const el = document.getElementById(id); return el ? el.value : ''; }

function serverColor(name) {
  const colors = ['#5865F2','#3ecfbf','#f5a623','#22d172','#f04060','#9b59b6','#e67e22','#3498db'];
  let hash = 0;
  for (let i = 0; i < (name || '').length; i++) hash = (name.charCodeAt(i) + ((hash << 5) - hash)) | 0;
  return colors[Math.abs(hash) % colors.length];
}

function initials(name) {
  if (!name) return '?';
  const words = stripEmoji(name).trim().split(/\s+/);
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/* ══════════════════════════════════════════════════════════════
   CUSTOM CALENDAR PICKER
══════════════════════════════════════════════════════════════ */

const _MONTHS = ['January','February','March','April','May','June',
                 'July','August','September','October','November','December'];
const _DAYS_SHORT = ['Su','Mo','Tu','We','Th','Fr','Sa'];

class CalendarPicker {
  constructor(inputId) {
    this.input = document.getElementById(inputId);
    if (!this.input) return;

    // Hide the native input, store value in it
    this.input.type = 'hidden';

    this.selected = null;  // Date | null
    this.view     = new Date(); this.view.setDate(1);

    // Display button (inserted before input)
    this.btn = document.createElement('button');
    this.btn.type = 'button';
    this.btn.className = 'cdp-btn';
    this.btn.innerHTML = `
      <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
        <rect x="1" y="2" width="12" height="11" rx="2"/>
        <path d="M1 6h12M4 1v2M10 1v2"/>
      </svg>
      <span class="cdp-lbl">Any date</span>`;
    this.input.parentNode.insertBefore(this.btn, this.input);

    // Calendar popup (body-level)
    this.cal = document.createElement('div');
    this.cal.className = 'cdp-cal';
    document.body.appendChild(this.cal);

    this.btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const opening = !this.cal.classList.contains('open');
      document.querySelectorAll('.cdp-cal.open').forEach(c => c.classList.remove('open'));
      if (opening) {
        this._render();
        const r = this.btn.getBoundingClientRect();
        this.cal.style.top  = `${r.bottom + 4}px`;
        this.cal.style.left = `${r.left}px`;
        this.cal.classList.add('open');
      }
    });

    document.addEventListener('click', (e) => {
      if (!this.cal.contains(e.target) && e.target !== this.btn)
        this.cal.classList.remove('open');
    });
  }

  _render() {
    const y = this.view.getFullYear();
    const m = this.view.getMonth();
    const firstDow = new Date(y, m, 1).getDay();
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const today = new Date();

    let html = `<div class="cdp-head">
      <button class="cdp-nav" data-d="-1">&#8249;</button>
      <span class="cdp-month">${_MONTHS[m]} ${y}</span>
      <button class="cdp-nav" data-d="1">&#8250;</button>
    </div><div class="cdp-grid">`;

    _DAYS_SHORT.forEach(d => { html += `<div class="cdp-dow">${d}</div>`; });
    for (let i = 0; i < firstDow; i++) html += `<div class="cdp-day"></div>`;

    for (let d = 1; d <= daysInMonth; d++) {
      const isToday    = d === today.getDate() && m === today.getMonth() && y === today.getFullYear();
      const isSel      = this.selected &&
                         d === this.selected.getDate() &&
                         m === this.selected.getMonth() &&
                         y === this.selected.getFullYear();
      const iso = `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      html += `<div class="cdp-day${isToday?' today':''}${isSel?' sel':''}" data-v="${iso}">${d}</div>`;
    }

    html += `</div>`;
    if (this.selected) html += `<div class="cdp-foot"><button class="cdp-clear-day">Clear</button></div>`;
    this.cal.innerHTML = html;

    this.cal.querySelectorAll('.cdp-nav').forEach(b =>
      b.addEventListener('click', (e) => { e.stopPropagation(); this.view.setMonth(m + parseInt(b.dataset.d)); this._render(); })
    );
    this.cal.querySelectorAll('.cdp-day[data-v]').forEach(cell =>
      cell.addEventListener('click', (e) => { e.stopPropagation(); this._select(cell.dataset.v); })
    );
    this.cal.querySelector('.cdp-clear-day')?.addEventListener('click', (e) => {
      e.stopPropagation(); this.clear(); this.cal.classList.remove('open');
    });
  }

  _select(iso) {
    this.selected = new Date(iso + 'T00:00:00');
    this.input.value = iso;
    this.input.dispatchEvent(new Event('change', { bubbles: true }));
    const d = this.selected;
    this.btn.querySelector('.cdp-lbl').textContent =
      d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    this.btn.classList.add('has-val');
    this.cal.classList.remove('open');
  }

  clear() {
    this.selected = null;
    this.input.value = '';
    this.input.dispatchEvent(new Event('change', { bubbles: true }));
    this.btn.querySelector('.cdp-lbl').textContent = 'Any date';
    this.btn.classList.remove('has-val');
  }

  getValue() { return this.input.value; }
}

/* ══════════════════════════════════════════════════════════════
   CUSTOM SELECT
══════════════════════════════════════════════════════════════ */

const _cselMap = new Map(); // id → CustomSelect instance

class CustomSelect {
  constructor(selectEl) {
    this.sel = selectEl;
    this._buildDOM();
    this._sync();
    // Observe native select mutations (options added/removed)
    new MutationObserver(() => this._sync()).observe(selectEl, { childList: true });
  }

  _buildDOM() {
    const sel = this.sel;
    // Wrap
    const wrap = document.createElement('div');
    wrap.className = 'csel-wrap';
    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel);
    sel.style.display = 'none';

    // Trigger button
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'csel-btn';
    btn.innerHTML = `<span class="csel-label"></span>
      <svg class="csel-chevron" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="2,3.5 5,6.5 8,3.5"/>
      </svg>`;
    wrap.appendChild(btn);

    // Dropdown (appended to body for z-index escape)
    const drop = document.createElement('div');
    drop.className = 'csel-dropdown';
    document.body.appendChild(drop);

    this.btn  = btn;
    this.drop = drop;

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const opening = !drop.classList.contains('open');
      this._closeAll();
      if (opening) { this._open(); }
    });

    document.addEventListener('click', (e) => {
      if (!drop.contains(e.target) && e.target !== btn) this._close();
    });
  }

  _closeAll() {
    document.querySelectorAll('.csel-dropdown.open').forEach(d => d.classList.remove('open'));
    document.querySelectorAll('.csel-btn.open').forEach(b => b.classList.remove('open'));
  }

  _open() {
    const r = this.btn.getBoundingClientRect();
    this.drop.style.top   = `${r.bottom + 4}px`;
    this.drop.style.left  = `${r.left}px`;
    this.drop.style.width = `${Math.max(160, r.width)}px`;
    this.drop.classList.add('open');
    this.btn.classList.add('open');
  }

  _close() {
    this.drop.classList.remove('open');
    this.btn.classList.remove('open');
  }

  _sync() {
    const sel = this.sel;
    // Rebuild options
    this.drop.innerHTML = '';
    Array.from(sel.options).forEach(opt => {
      const item = document.createElement('div');
      item.className = 'csel-option' + (opt.value === '' ? ' placeholder' : '') + (opt.value === sel.value ? ' active' : '');
      item.dataset.value = opt.value;
      item.textContent = opt.text;
      item.addEventListener('click', () => {
        sel.value = opt.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        this._updateLabel();
        this._close();
      });
      this.drop.appendChild(item);
    });
    this._updateLabel();
  }

  _updateLabel() {
    const sel = this.sel;
    const opt = sel.options[sel.selectedIndex];
    const label = this.btn.querySelector('.csel-label');
    if (label) label.textContent = opt ? opt.text : '';
    // Highlight active
    this.drop.querySelectorAll('.csel-option').forEach(item => {
      item.classList.toggle('active', item.dataset.value === sel.value);
    });
  }

  // Called after _fillSelect updates the native select
  refresh() { this._sync(); }
}

function initCustomSelects() {
  document.querySelectorAll('select.filter-select').forEach(sel => {
    if (!sel.id) return;
    const cs = new CustomSelect(sel);
    _cselMap.set(sel.id, cs);
  });
}

/* ══════════════════════════════════════════════════════════════
   STATE
══════════════════════════════════════════════════════════════ */

const state = {
  musicGuildId: null, musicData: {}, musicPaused: false, botAvatar: null,
  modLogs: [], modFiltered: [], modPage: 1, modRpp: 25,
  modSortCol: 'timestamp', modSortDir: 'desc',
  modDateStart: '', modDateEnd: '',
  invLogs: [], invFiltered: [], invPage: 1, invRpp: 25,
  invSortCol: 'timestamp', invSortDir: 'desc',
  invDateStart: '', invDateEnd: '',
  activeTab: 'dashboard',
  pendingServerFilter: '',
};

/* ══════════════════════════════════════════════════════════════
   CUSTOM DATE PICKER
══════════════════════════════════════════════════════════════ */

function _positionPopup(btn, popup) {
  const r = btn.getBoundingClientRect();
  popup.style.top   = `${r.bottom + 6}px`;
  popup.style.left  = 'auto';
  popup.style.right = `${window.innerWidth - r.right}px`;
  popup.style.width = `${Math.max(280, r.width)}px`;
}

function initDatePicker(btnId, popupId, startId, endId, labelId, valId, clearId, applyId, onApply) {
  const btn   = document.getElementById(btnId);
  const popup = document.getElementById(popupId);
  if (!btn || !popup) return;

  // Create custom calendar pickers for the two date inputs
  const startPicker = new CalendarPicker(startId);
  const endPicker   = new CalendarPicker(endId);

  // Move popup to body so it escapes overflow:hidden parents
  document.body.appendChild(popup);

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const opening = !popup.classList.contains('open');
    document.querySelectorAll('.date-picker-popup.open').forEach(p => p.classList.remove('open'));
    document.querySelectorAll('.date-range-btn.active').forEach(b => b.classList.remove('active'));
    if (opening) {
      _positionPopup(btn, popup);
      popup.classList.add('open');
      btn.classList.add('active');
    }
  });

  document.addEventListener('click', (e) => {
    if (!popup.contains(e.target) && e.target !== btn) {
      popup.classList.remove('open');
      btn.classList.remove('active');
    }
  });

  document.getElementById(applyId)?.addEventListener('click', () => {
    const ds = startPicker.getValue();
    const de = endPicker.getValue();
    const label = document.getElementById(labelId);
    const val   = document.getElementById(valId);
    if (ds || de) {
      const fmt = d => d ? new Date(d + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '…';
      if (label) label.style.display = 'none';
      if (val)   { val.style.display = ''; val.textContent = `${fmt(ds)} → ${fmt(de)}`; }
    } else {
      if (label) label.style.display = '';
      if (val)   val.style.display = 'none';
    }
    popup.classList.remove('open');
    btn.classList.remove('active');
    onApply(ds, de);
  });

  document.getElementById(clearId)?.addEventListener('click', () => {
    startPicker.clear();
    endPicker.clear();
    const label = document.getElementById(labelId);
    const val   = document.getElementById(valId);
    if (label) label.style.display = '';
    if (val)   val.style.display = 'none';
    onApply('', '');
  });
}

/* ══════════════════════════════════════════════════════════════
   CUSTOM CONFIRM MODAL
══════════════════════════════════════════════════════════════ */

function showModal(overlayId) {
  const el = document.getElementById(overlayId);
  if (el) el.classList.add('open');
}

function hideModal(overlayId) {
  const el = document.getElementById(overlayId);
  if (el) el.classList.remove('open');
}

/* ══════════════════════════════════════════════════════════════
   TAB SYSTEM
══════════════════════════════════════════════════════════════ */

function switchTab(name) {
  state.activeTab = name;
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === name);
  });
  document.querySelectorAll('.tab-panel').forEach(panel => {
    panel.classList.toggle('active', panel.id === `panel-${name}`);
  });
  if (name === 'music') {
    loadMusic();
  } else if (name === 'moderation') {
    if (state.modLogs.length === 0) {
      loadMod();
    } else {
      // Logs already cached — just populate filters and render
      _populateModFilters();
      _updateModMiniStats();
      applyModFilters();
    }
  } else if (name === 'invites') {
    if (state.invLogs.length === 0) {
      loadInvites();
    } else {
      _populateInvFilters();
      invUpdateStats();
      applyInvFilters();
    }
  }
}

/* ══════════════════════════════════════════════════════════════
   STATUS + BOT INFO
══════════════════════════════════════════════════════════════ */

async function updateStatus() {
  try {
    const t0 = performance.now();
    const res = await fetch('/bot_status');
    const pingMs = Math.round(performance.now() - t0);
    if (!res.ok) throw new Error();
    const data = await res.json();
    const online = !!data.online;

    document.getElementById('sb-dot')?.classList.toggle('online', online);
    setText('sb-status-text', online ? 'Online' : 'Offline');
    document.getElementById('bot-online-dot')?.classList.toggle('online', online);
    setText('bot-status-text', online ? 'Online' : 'Offline');

    const uptime = data.uptime || '—';
    setText('sb-uptime', online ? uptime : '—');
    setText('titlebar-uptime', online ? uptime : '');

    const serverCount = data.servers ?? 0;
    setText('sb-servers', `${serverCount} server${serverCount !== 1 ? 's' : ''}`);
    setText('sb-ping', `${pingMs}ms`);

    if (data.users != null) {
      setText('scv-users', data.users.toLocaleString());
    }
  } catch (e) {}

  try {
    const res2 = await fetch('/api/bot_info');
    if (res2.ok) {
      const info = await res2.json();
      if (info.name) setText('bot-name', info.name);
      if (info.avatar) {
        state.botAvatar = info.avatar;
        const img = document.getElementById('bot-avatar-img');
        const ph  = document.getElementById('bot-avatar-ph');
        if (img && ph) { img.src = info.avatar; img.style.display = 'block'; ph.style.display = 'none'; }
      }
    }
  } catch (e) {}
}

/* ══════════════════════════════════════════════════════════════
   GUILDS
══════════════════════════════════════════════════════════════ */

async function loadGuilds() {
  try {
    const res = await fetch('/api/guilds');
    if (!res.ok) throw new Error();
    const guilds = await res.json();

    // Sidebar server icons
    const row = document.getElementById('server-icons-row');
    if (row) {
      row.innerHTML = '<div class="srv-icon srv-icon-add" title="Add server">+</div>';
      guilds.forEach((guild, idx) => {
        const name = guild.name || `Server ${idx + 1}`;
        const icon = guild.icon || null;
        const el = document.createElement('div');
        el.className = 'srv-icon' + (idx === 0 ? ' active' : '');
        el.title = name;
        if (icon) {
          const img = document.createElement('img');
          img.src = icon; img.alt = name;
          img.onerror = () => { img.remove(); el.textContent = initials(name); el.style.color = serverColor(name); };
          el.appendChild(img);
        } else {
          el.textContent = initials(name); el.style.color = serverColor(name);
        }
        el.addEventListener('click', () => {
          row.querySelectorAll('.srv-icon').forEach(i => i.classList.remove('active'));
          el.classList.add('active');
          _applyServerFilter(name);
        });
        row.insertBefore(el, row.firstChild);
      });
    }

    // Dashboard servers panel
    const dashServers = document.getElementById('dash-servers');
    setText('servers-card-count', `${guilds.length} connected`);
    if (dashServers) {
      if (!guilds.length) {
        dashServers.innerHTML = '<div class="empty-state">No servers</div>';
      } else {
        dashServers.innerHTML = guilds.map(guild => {
          const name = guild.name || 'Unknown';
          const icon = guild.icon || null;
          const members = guild.members || 0;
          const color = serverColor(name);
          const artInner = icon
            ? `<img src="${escapeHtml(icon)}" alt="" onerror="this.style.display='none'">`
            : `<span style="color:${color}">${initials(name)}</span>`;
          return `<div class="srv-list-row">
            <div class="srv-list-av" style="background:${color}22">${artInner}</div>
            <div class="srv-list-info">
              <div class="srv-list-name">${escapeHtml(name)}</div>
              <div class="srv-list-members">${members.toLocaleString()} members</div>
            </div>
            <span class="srv-list-dot" style="background:${color}"></span>
          </div>`;
        }).join('');
      }
    }
  } catch (e) {}
}

function _setSelectValue(id, value) {
  const sel = document.getElementById(id);
  if (!sel) return;
  const opt = Array.from(sel.options).find(o => o.value === value || o.text === value);
  if (opt) {
    sel.value = opt.value;
    _cselMap.get(id)?._updateLabel();  // refresh custom dropdown label
  }
}

function _applyServerFilter(name) {
  state.pendingServerFilter = name;

  // Populate filter dropdowns first (so the option exists to select)
  if (state.modLogs.length > 0) _populateModFilters();
  if (state.invLogs.length > 0) _populateInvFilters();

  // Now set the value (option should exist)
  _setSelectValue('mod-server-filter', name);
  _setSelectValue('inv-server-filter', name);

  if (state.modLogs.length > 0) { _updateModMiniStats(); applyModFilters(); }
  if (state.invLogs.length > 0) { invUpdateStats(); applyInvFilters(); }

  if (!['moderation','invites'].includes(state.activeTab)) switchTab('moderation');
}

/* ══════════════════════════════════════════════════════════════
   DASHBOARD
══════════════════════════════════════════════════════════════ */

async function loadDashboard() {
  let modLogs = state.modLogs, invLogs = state.invLogs;
  try {
    const [mRes, iRes] = await Promise.all([fetch('/api/logs'), fetch('/api/invite_logs')]);
    if (mRes.ok) modLogs = await mRes.json();
    if (iRes.ok) invLogs = await iRes.json();
    if (Array.isArray(modLogs)) state.modLogs = modLogs;
    if (Array.isArray(invLogs)) state.invLogs = invLogs;
  } catch (e) {}

  modLogs = Array.isArray(modLogs) ? modLogs : [];
  invLogs = Array.isArray(invLogs) ? invLogs : [];

  const modCount  = modLogs.length;
  const invCount  = invLogs.length;
  const playCount = modLogs.filter(l => (l.action||'').toLowerCase() === 'play').length;

  setText('scv-mod', modCount.toLocaleString());
  setText('scv-inv', invCount.toLocaleString());
  setText('scv-plays', playCount.toLocaleString());
  setText('sct-plays', playCount > 0 ? `+${playCount}` : '0');

  _setBadge('nb-mod', modCount);
  _setBadge('nb-inv', invCount);

  // Top commands
  const actionCounts = {};
  modLogs.forEach(l => {
    const a = (l.action || 'Unknown').trim();
    actionCounts[a] = (actionCounts[a] || 0) + 1;
  });
  const topActions = Object.entries(actionCounts).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const cmdList = document.getElementById('top-cmd-list');
  if (cmdList) {
    if (!topActions.length) {
      cmdList.innerHTML = '<div class="empty-state">No command data</div>';
    } else {
      const maxVal = topActions[0][1] || 1;
      cmdList.innerHTML = topActions.map(([name, count]) => {
        const pct = Math.round((count / maxVal) * 100);
        return `<div class="cmd-row">
          <span class="cmd-name">/${escapeHtml(name)}</span>
          <div class="cmd-bar-wrap"><div class="cmd-bar" style="width:${pct}%"></div></div>
          <span class="cmd-count">${count.toLocaleString()} uses</span>
        </div>`;
      }).join('');
    }
  }

  // Recent activity
  const combined = [...modLogs.map(l => ({...l, _type:'mod'})), ...invLogs.map(l => ({...l, _type:'inv'}))]
    .filter(l => l.timestamp)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, 20);

  const actEl = document.getElementById('dash-activity');
  if (actEl) {
    actEl.innerHTML = combined.length
      ? combined.map(item => buildActivityRow(item)).join('')
      : '<div class="empty-state">No recent activity</div>';
  }

  // Pre-populate filter dropdowns so they're ready when user switches tabs
  _populateModFilters();
  _populateInvFilters();
  _updateModMiniStats();
  invUpdateStats();
}

function buildActivityRow(item) {
  const isInv = item._type === 'inv';
  const rawUser = item.user || item.member || item.inviter || '?';
  const username = escapeHtml(rawUser);
  const server = escapeHtml(item.server || '');
  const firstLetter = (rawUser[0] || '?').toUpperCase();
  const avatarColor = serverColor(rawUser);
  const d = item.timestamp ? new Date(item.timestamp) : null;
  const timeStr = d ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '—';

  let badgeClass = 'ab-def', badgeLabel = 'Event';
  if (isInv) {
    const evt = (item.event_type || '').toLowerCase();
    badgeClass = evt.includes('join') ? 'ab-join' : 'ab-leave';
    badgeLabel = evt.includes('join') ? 'Join' : 'Leave';
  } else {
    const action = (item.action || '').toLowerCase();
    if      (action === 'play')                           { badgeClass = 'ab-play';    badgeLabel = 'Play'; }
    else if (action === 'skip')                           { badgeClass = 'ab-skip';    badgeLabel = 'Skip'; }
    else if (action === 'stop')                           { badgeClass = 'ab-stop';    badgeLabel = 'Stop'; }
    else if (action === 'pause')                          { badgeClass = 'ab-pause';   badgeLabel = 'Pause'; }
    else if (action === 'resume')                         { badgeClass = 'ab-resume';  badgeLabel = 'Resume'; }
    else if (action === 'shuffle')                        { badgeClass = 'ab-shuffle'; badgeLabel = 'Shuffle'; }
    else if (action === 'loop')                           { badgeClass = 'ab-loop';    badgeLabel = 'Loop'; }
    else if (action === 'volume')                         { badgeClass = 'ab-vol';     badgeLabel = 'Volume'; }
    else if (action.includes('wipe') || action === 'clear_messages') { badgeClass = 'ab-wipe'; badgeLabel = action === 'clear_messages' ? 'Clear Msgs' : 'Wipe'; }
    else if (action === 'clear')                          { badgeClass = 'ab-clear';   badgeLabel = 'Clear'; }
    else if (action === 'ban')                            { badgeClass = 'ab-ban';     badgeLabel = 'Ban'; }
    else if (action === 'kick')                           { badgeClass = 'ab-kick';    badgeLabel = 'Kick'; }
    else if (action === 'mute' || action === 'timeout')   { badgeClass = 'ab-mute';    badgeLabel = 'Mute'; }
    else if (action === 'unmute')                         { badgeClass = 'ab-unmute';  badgeLabel = 'Unmute'; }
    else if (action === 'warn')                           { badgeClass = 'ab-warn';    badgeLabel = 'Warn'; }
    else if (action === 'viewlogs')                       { badgeClass = 'ab-logs';    badgeLabel = 'Logs'; }
    else { badgeLabel = escapeHtml(item.action || 'Event'); }
  }

  let desc = '';
  if (isInv) desc = item.invite_code ? `via code ${escapeHtml(item.invite_code)}` : escapeHtml(item.notes || '');
  else desc = escapeHtml(item.channel || item.details || '');

  return `<div class="act-row">
    <div class="act-av" style="background:${avatarColor}22;border-color:${avatarColor}55;color:${avatarColor}">${firstLetter}</div>
    <span class="act-time">${escapeHtml(timeStr)}</span>
    <span class="act-server">${server}</span>
    <span class="act-user">${username}</span>
    <span class="act-badge ${badgeClass}">${badgeLabel}</span>
    <span class="act-desc">${desc}</span>
  </div>`;
}

function _setBadge(id, count) {
  const el = document.getElementById(id);
  if (!el) return;
  if (count > 0) { el.style.display = ''; el.textContent = count > 999 ? '999+' : String(count); }
  else el.style.display = 'none';
}

/* ══════════════════════════════════════════════════════════════
   NP TICKER  (client-side progress between API refreshes)
══════════════════════════════════════════════════════════════ */

let _npTicker     = null;
let _npTickerPos  = 0;   // server-reported position when ticker was started
let _npTickerRef  = 0;   // Date.now() when ticker was started
let _npTickerDur  = 0;   // track duration

function _startNpTicker(pos, duration, paused) {
  if (_npTicker) { clearInterval(_npTicker); _npTicker = null; }
  _npTickerPos = pos;
  _npTickerDur = duration;
  _npTickerRef = Date.now();

  // Set immediately (don't wait 1s for first tick)
  setText('np-pos', fmtDuration(pos));
  if (duration > 0) {
    const fill = document.getElementById('np-fill');
    if (fill) fill.style.width = `${Math.min(100, (pos / duration) * 100).toFixed(1)}%`;
  }

  if (paused) return; // paused: don't advance, but still showed current position above

  _npTicker = setInterval(() => {
    const elapsed = (Date.now() - _npTickerRef) / 1000;
    const cur = _npTickerDur > 0
      ? Math.min(_npTickerPos + elapsed, _npTickerDur)
      : _npTickerPos + elapsed;
    setText('np-pos', fmtDuration(cur));
    if (_npTickerDur > 0) {
      const fill = document.getElementById('np-fill');
      if (fill) fill.style.width = `${Math.min(100, (cur / _npTickerDur) * 100).toFixed(1)}%`;
      if (cur >= _npTickerDur) { clearInterval(_npTicker); _npTicker = null; }
    }
  }, 1000);
}

function _stopNpTicker() {
  if (_npTicker) { clearInterval(_npTicker); _npTicker = null; }
}

/* ══════════════════════════════════════════════════════════════
   MUSIC
══════════════════════════════════════════════════════════════ */

async function loadMusic() {
  try {
    const res = await fetch('/api/music');
    if (!res.ok) throw new Error();
    const data = await res.json();
    state.musicData = data;
    const guilds = Array.isArray(data) ? data : [];
    const pillRow = document.getElementById('music-guilds');
    if (pillRow && guilds.length > 1) {
      pillRow.innerHTML = guilds.map((g, i) => {
        const gname = escapeHtml(g.guild || `Server ${i + 1}`);
        const gid = String(g.guild_id || '');
        const active = (i === 0 && !state.musicGuildId) || gid === state.musicGuildId ? ' active' : '';
        return `<button class="guild-pill${active}" data-guild-id="${escapeHtml(gid)}">${gname}</button>`;
      }).join('');
      pillRow.querySelectorAll('.guild-pill').forEach(btn => {
        btn.addEventListener('click', () => {
          pillRow.querySelectorAll('.guild-pill').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          state.musicGuildId = btn.dataset.guildId;
          renderMusicGuild(state.musicGuildId, guilds);
        });
      });
    } else if (pillRow) pillRow.innerHTML = '';
    const activeGuildId = state.musicGuildId || (guilds[0] && String(guilds[0].guild_id)) || null;
    if (activeGuildId) state.musicGuildId = activeGuildId;
    renderMusicGuild(activeGuildId, guilds);
  } catch (e) { _showMusicIdle(); }
}

function renderMusicGuild(guildId, guilds) {
  const gData = guilds.find(g => String(g.guild_id) === String(guildId)) || guilds[0];
  if (!gData) { _showMusicIdle(); return; }
  state.musicPaused = !!(gData.paused);
  if (!gData.playing) {
    _showMusicIdle();
    setText('music-page-sub', 'No music playing');
    setText('queue-count', '0 tracks');
    const ql = document.getElementById('queue-list');
    if (ql) ql.innerHTML = '<div class="empty-state">Queue is empty</div>';
    return;
  }
  _showMusicActive();
  const track = gData.now_playing || {};
  const title = track.title || gData.title || 'Unknown Track';
  const author = track.uploader || track.artist || gData.uploader || '';
  const thumb = track.thumbnail || gData.thumbnail || '';
  const duration = track.duration || gData.duration || 0;
  const position = gData.position || 0;
  setText('np-title', title);
  setText('np-sub', author);
  setText('np-dur', duration > 0 ? fmtDuration(duration) : '—');
  _startNpTicker(position, duration, state.musicPaused);
  const volFill = document.getElementById('vol-fill');
  if (volFill) volFill.style.width = `${gData.volume ?? 50}%`;
  const img = document.getElementById('np-img'), artPh = document.getElementById('np-art-ph');
  if (img && artPh) {
    const artSrc = thumb || state.botAvatar || '';
    if (artSrc) {
      img.src = artSrc;
      img.style.display = 'block';
      artPh.style.display = 'none';
      // If no thumbnail, add a blur/dim effect to show it's a fallback avatar
      img.style.opacity = thumb ? '1' : '0.35';
      img.style.filter  = thumb ? 'none' : 'blur(2px) grayscale(0.4)';
    } else {
      img.style.display = 'none';
      artPh.style.display = '';
    }
  }
  _updatePlayBtn(state.musicPaused);
  renderQueue(gData.queue || []);
}

function _showMusicIdle() {
  _stopNpTicker();
  document.getElementById('np-idle').style.display = '';
  document.getElementById('np-active').style.display = 'none';
}
function _showMusicActive() {
  document.getElementById('np-idle').style.display = 'none';
  document.getElementById('np-active').style.display = '';
}
function _updatePlayBtn(paused) {
  const icon = document.getElementById('ctrl-play-icon');
  if (!icon) return;
  icon.innerHTML = paused
    ? '<polygon points="3,2 11,7 3,12" fill="currentColor"/>'
    : '<rect x="2" y="2" width="4" height="10" rx="1"/><rect x="8" y="2" width="4" height="10" rx="1"/>';
}

function renderQueue(queue) {
  const countEl = document.getElementById('queue-count');
  const listEl  = document.getElementById('queue-list');
  if (!listEl) return;
  if (!queue || !queue.length) {
    if (countEl) countEl.textContent = '0 tracks';
    listEl.innerHTML = '<div class="empty-state">Queue is empty</div>';
    return;
  }
  if (countEl) countEl.textContent = `${queue.length} track${queue.length !== 1 ? 's' : ''}`;
  listEl.innerHTML = queue.map((track, i) => {
    const title = escapeHtml(track.title || track.name || 'Unknown');
    const thumb = track.thumbnail || track.artwork || '';
    const dur = track.duration != null ? fmtDuration(track.duration) : '—';
    const requester = escapeHtml(track.requester || '');
    const artInner = thumb ? `<img src="${escapeHtml(thumb)}" alt="" onerror="this.style.display='none'">` : '♫';
    return `<div class="queue-row">
      <span class="q-num">${i + 1}</span>
      <div class="q-art">${artInner}</div>
      <div class="q-info">
        <div class="q-title">${title}</div>
        ${requester ? `<div class="q-requester">${requester}</div>` : ''}
      </div>
      <span class="q-dur">${escapeHtml(dur)}</span>
    </div>`;
  }).join('');
}

/* ══════════════════════════════════════════════════════════════
   MODERATION
══════════════════════════════════════════════════════════════ */

async function loadMod() {
  try {
    const res = await fetch('/api/logs');
    const data = res.ok ? await res.json() : [];
    state.modLogs = Array.isArray(data) ? data : [];
  } catch (e) { state.modLogs = []; }
  _populateModFilters();
  _updateModMiniStats();
  applyModFilters();
}

function _populateModFilters() {
  const logs = state.modLogs;
  _fillSelect('mod-server-filter', [...new Set(logs.map(l => l.server).filter(Boolean))].sort(), 'All Servers');
  _fillSelect('mod-user-filter',   [...new Set(logs.map(l => l.user).filter(Boolean))].sort(),   'All Users');
  _fillSelect('mod-action-filter', [...new Set(logs.map(l => l.action).filter(Boolean))].sort(), 'All Actions');
}

function _fillSelect(id, options, placeholder) {
  const sel = document.getElementById(id);
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = `<option value="">${escapeHtml(placeholder)}</option>` +
    options.map(o => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join('');
  if (cur) sel.value = cur;
  // Refresh custom dropdown if present
  _cselMap.get(id)?.refresh();
}

function _updateModMiniStats() {
  const activeServer = getVal('mod-server-filter');
  const logs = activeServer
    ? state.modLogs.filter(l => l.server === activeServer)
    : state.modLogs;
  const wipes  = logs.filter(l => (l.action || '').toLowerCase().includes('wipe')).length;
  const clears = logs.filter(l => ['clear','clear_messages'].includes((l.action||'').toLowerCase())).length;
  let msgCount = 0;
  logs.forEach(l => {
    let det = l.details;
    if (typeof det === 'string') try { det = JSON.parse(det); } catch(e){}
    if (Array.isArray(det)) msgCount += det.length;
    else if (det?.messages) msgCount += det.messages.length;
  });
  setText('ms-total', logs.length.toLocaleString());
  setText('ms-warn',  wipes.toLocaleString());
  setText('ms-clears',clears.toLocaleString());
  setText('ms-msgs',  msgCount.toLocaleString());
}

function applyModFilters() {
  const q      = getVal('mod-search').toLowerCase().trim();
  const server = getVal('mod-server-filter');
  const user   = getVal('mod-user-filter');
  const action = getVal('mod-action-filter');
  const ds     = state.modDateStart;
  const de     = state.modDateEnd;
  state.modRpp = parseInt(getVal('mod-rpp'), 10) || 25;

  let logs = state.modLogs.slice();
  if (server) logs = logs.filter(l => l.server === server);
  if (user)   logs = logs.filter(l => l.user === user);
  if (action) logs = logs.filter(l => l.action === action);
  if (ds)     logs = logs.filter(l => l.timestamp && new Date(l.timestamp) >= new Date(ds));
  if (de)     logs = logs.filter(l => l.timestamp && new Date(l.timestamp) <= new Date(de + 'T23:59:59'));
  if (q)      logs = logs.filter(l =>
    [l.server, l.user, l.channel, l.action, l.details].some(v => v && String(v).toLowerCase().includes(q))
  );

  state.modFiltered = _sortLogs(logs, state.modSortCol, state.modSortDir);
  state.modPage = 1;
  renderModPage();
}

function renderModPage() {
  const total = state.modFiltered.length;
  const pages = Math.max(1, Math.ceil(total / state.modRpp));
  state.modPage = Math.min(state.modPage, pages);
  const slice = state.modFiltered.slice((state.modPage - 1) * state.modRpp, state.modPage * state.modRpp);
  const tbody = document.getElementById('mod-body');
  if (!tbody) return;
  const activeServer = getVal('mod-server-filter');
  let emptyMsg = 'No logs found';
  if (!slice.length && activeServer) emptyMsg = `No logs for <strong>${escapeHtml(activeServer)}</strong>`;
  tbody.innerHTML = slice.length
    ? slice.map(buildModRow).join('')
    : `<tr><td colspan="6"><div class="empty-state" style="padding:32px 0">${emptyMsg}</div></td></tr>`;
  tbody.querySelectorAll('.expand-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const ml = btn.nextElementSibling;
      if (!ml) return;
      const hidden = ml.classList.toggle('hidden');
      btn.textContent = hidden ? `Show ${btn.dataset.count}` : 'Hide';
    });
  });
  setText('mod-page-info', `Page ${state.modPage} of ${pages}`);
  document.getElementById('mod-prev').disabled = state.modPage <= 1;
  document.getElementById('mod-next').disabled = state.modPage >= pages;
}

function buildModRow(log) {
  const server = escapeHtml(log.server || '—');
  const sColor = serverColor(log.server || '');
  const user   = escapeHtml(log.user || '—');
  const channel= escapeHtml(log.channel || '—');
  const action = log.action || 'Unknown';
  const time   = fmtTimestamp(log.timestamp);
  const badgeCls = _modBadgeClass(action);

  let detailsHtml = '—';
  let det = log.details;
  if (typeof det === 'string') try { det = JSON.parse(det); } catch(e) {}
  if (Array.isArray(det) && det.length > 0) {
    const msgItems = det.map((m, i) => {
      const author  = escapeHtml(m.author || m.username || '?');
      const content = escapeHtml(m.content || m.message || '');
      const mtime   = m.timestamp ? fmtTimestamp(m.timestamp) : '';
      return `<div class="msg-item${i%2===0?' even':''}"><span class="msg-author">${author}</span><span class="msg-content">${content}</span><span class="msg-time">${mtime}</span></div>`;
    }).join('');
    detailsHtml = `<button class="expand-btn" data-count="${det.length}">Show ${det.length}</button><div class="message-list hidden">${msgItems}</div>`;
  } else if (det?.messages?.length) {
    const msgs = det.messages;
    const msgItems = msgs.map((m, i) =>
      `<div class="msg-item${i%2===0?' even':''}"><span class="msg-author">${escapeHtml(m.author||m.username||'?')}</span><span class="msg-content">${escapeHtml(m.content||m.message||'')}</span></div>`
    ).join('');
    detailsHtml = `<button class="expand-btn" data-count="${msgs.length}">Show ${msgs.length}</button><div class="message-list hidden">${msgItems}</div>`;
  } else if (typeof det === 'string' && det.length) {
    detailsHtml = `<span style="color:var(--muted);font-size:12px">${escapeHtml(det)}</span>`;
  } else if (det && typeof det === 'object') {
    detailsHtml = `<pre class="embed-block">${escapeHtml(JSON.stringify(det, null, 2))}</pre>`;
  }

  return `<tr>
    <td><div class="srv-dot-wrap"><span class="srv-dot" style="background:${sColor}"></span><span>${server}</span></div></td>
    <td>${user}</td>
    <td class="channel-cell">${channel}</td>
    <td><span class="tbl-badge ${badgeCls}">${escapeHtml(action)}</span></td>
    <td>${detailsHtml}</td>
    <td class="dim-cell">${escapeHtml(time)}</td>
  </tr>`;
}

function _modBadgeClass(action) {
  const a = (action || '').toLowerCase();
  if (a === 'play')                        return 'tb-play';
  if (a === 'skip')                        return 'tb-skip';
  if (a === 'stop')                        return 'tb-stop';
  if (a === 'pause')                       return 'tb-pause';
  if (a === 'resume')                      return 'tb-resume';
  if (a === 'shuffle')                     return 'tb-shuffle';
  if (a === 'loop')                        return 'tb-loop';
  if (a === 'volume')                      return 'tb-vol';
  if (a.includes('wipe'))                  return 'tb-wipe';
  if (a === 'clear' || a === 'clear_messages') return 'tb-clear';
  if (a === 'ban')                         return 'tb-ban';
  if (a === 'kick')                        return 'tb-kick';
  if (a === 'mute' || a === 'timeout')     return 'tb-mute';
  if (a === 'unmute')                      return 'tb-unmute';
  if (a === 'warn')                        return 'tb-warn';
  if (a === 'viewlogs')                    return 'tb-logs';
  return 'tb-def';
}

function _sortLogs(logs, col, dir) {
  return logs.slice().sort((a, b) => {
    let av = a[col] ?? '', bv = b[col] ?? '';
    if (col === 'timestamp') { av = new Date(av).getTime()||0; bv = new Date(bv).getTime()||0; }
    else { av = String(av).toLowerCase(); bv = String(bv).toLowerCase(); }
    return av < bv ? (dir==='asc'?-1:1) : av > bv ? (dir==='asc'?1:-1) : 0;
  });
}

/* ══════════════════════════════════════════════════════════════
   INVITES
══════════════════════════════════════════════════════════════ */

async function loadInvites() {
  try {
    const res = await fetch('/api/invite_logs');
    state.invLogs = res.ok ? (await res.json()) : [];
  } catch (e) { state.invLogs = []; }
  _populateInvFilters();
  invUpdateStats();
  applyInvFilters();
}

function _populateInvFilters() {
  const logs = state.invLogs;
  _fillSelect('inv-event-filter',   [...new Set(logs.map(l=>l.event_type).filter(Boolean))].sort(), 'All Events');
  _fillSelect('inv-member-filter',  [...new Set(logs.map(l=>l.member).filter(Boolean))].sort(),     'All Members');
  _fillSelect('inv-inviter-filter', [...new Set(logs.map(l=>l.inviter).filter(Boolean))].sort(),    'All Inviters');
  _fillSelect('inv-server-filter',  [...new Set(logs.map(l=>l.server).filter(Boolean))].sort(),     'All Servers');
}

function invUpdateStats() {
  const activeServer = getVal('inv-server-filter');
  const logs = activeServer
    ? state.invLogs.filter(l => l.server === activeServer)
    : state.invLogs;
  const joins  = logs.filter(l => (l.event_type||'').toLowerCase().includes('join')).length;
  const leaves = logs.filter(l => (l.event_type||'').toLowerCase().includes('leave')).length;
  const invCount = {};
  logs.forEach(l => { if (l.inviter) invCount[l.inviter] = (invCount[l.inviter]||0)+1; });
  const top = Object.entries(invCount).sort((a,b)=>b[1]-a[1])[0];
  setText('inv-joins',  joins.toLocaleString());
  setText('inv-leaves', leaves.toLocaleString());
  setText('inv-top',    top ? top[0] : '—');
  setText('inv-total',  logs.length.toLocaleString());
}

function applyInvFilters() {
  const q       = getVal('inv-search').toLowerCase().trim();
  const event   = getVal('inv-event-filter');
  const member  = getVal('inv-member-filter');
  const inviter = getVal('inv-inviter-filter');
  const server  = getVal('inv-server-filter');
  state.invRpp  = parseInt(getVal('inv-rpp'), 10) || 25;

  const ds = state.invDateStart;
  const de = state.invDateEnd;

  let logs = state.invLogs.slice();
  if (event)   logs = logs.filter(l => l.event_type === event);
  if (member)  logs = logs.filter(l => l.member === member);
  if (inviter) logs = logs.filter(l => l.inviter === inviter);
  if (server)  logs = logs.filter(l => l.server === server);
  if (ds)      logs = logs.filter(l => l.timestamp && new Date(l.timestamp) >= new Date(ds));
  if (de)      logs = logs.filter(l => l.timestamp && new Date(l.timestamp) <= new Date(de + 'T23:59:59'));
  if (q)       logs = logs.filter(l =>
    [l.event_type, l.member, l.inviter, l.invite_code, l.server, l.notes, l.source]
      .some(v => v && String(v).toLowerCase().includes(q))
  );

  state.invFiltered = _sortLogs(logs, state.invSortCol, state.invSortDir);
  state.invPage = 1;
  renderInvPage();
}

function renderInvPage() {
  const total = state.invFiltered.length;
  const pages = Math.max(1, Math.ceil(total / state.invRpp));
  state.invPage = Math.min(state.invPage, pages);
  const slice = state.invFiltered.slice((state.invPage-1)*state.invRpp, state.invPage*state.invRpp);
  const tbody = document.getElementById('inv-body');
  if (!tbody) return;
  tbody.innerHTML = slice.length
    ? slice.map(buildInviteRow).join('')
    : '<tr><td colspan="10" style="text-align:center;padding:24px;color:var(--dim)">No events found</td></tr>';
  setText('inv-page-info', `Page ${state.invPage} of ${pages}`);
  document.getElementById('inv-prev').disabled = state.invPage <= 1;
  document.getElementById('inv-next').disabled = state.invPage >= pages;
}

function buildInviteRow(log) {
  const evt = log.event_type || '?';
  const isJoin = evt.toLowerCase().includes('join');
  return `<tr>
    <td><span class="tbl-badge ${isJoin?'tb-join':'tb-leave'}">${escapeHtml(evt)}</span></td>
    <td>${escapeHtml(log.member||'—')}</td>
    <td>${escapeHtml(log.inviter||'—')}</td>
    <td class="dim-cell">${escapeHtml(log.invite_code||'—')}</td>
    <td class="dim-cell">${log.uses??'—'}</td>
    <td style="color:var(--muted);font-size:12px">${log.is_temporary?'Yes':'No'}</td>
    <td class="dim-cell">${escapeHtml(fmtTimestamp(log.timestamp))}</td>
    <td><div class="srv-dot-wrap"><span class="srv-dot" style="background:${serverColor(log.server||'')}"></span><span>${escapeHtml(log.server||'—')}</span></div></td>
    <td style="color:var(--muted);font-size:12px">${escapeHtml(log.source||'—')}</td>
    <td style="color:var(--dim);font-size:11px;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(log.notes||'—')}</td>
  </tr>`;
}

/* ══════════════════════════════════════════════════════════════
   TABLE SORTING
══════════════════════════════════════════════════════════════ */

function initTableSort(tableId, stateKey, renderFn) {
  const table = document.getElementById(tableId);
  if (!table) return;
  table.querySelectorAll('thead th[data-col]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      const isAsc = stateKey === 'mod' ? state.modSortDir : state.invSortDir;
      if (stateKey === 'mod') {
        if (state.modSortCol === col) state.modSortDir = state.modSortDir==='asc'?'desc':'asc';
        else { state.modSortCol = col; state.modSortDir = 'desc'; }
      } else {
        if (state.invSortCol === col) state.invSortDir = state.invSortDir==='asc'?'desc':'asc';
        else { state.invSortCol = col; state.invSortDir = 'desc'; }
      }
      table.querySelectorAll('thead th').forEach(h => h.classList.remove('asc','desc'));
      const dir = stateKey === 'mod' ? state.modSortDir : state.invSortDir;
      th.classList.add(dir);

      if (stateKey === 'mod') {
        state.modFiltered = _sortLogs(state.modFiltered, state.modSortCol, state.modSortDir);
      } else {
        state.invFiltered = _sortLogs(state.invFiltered, state.invSortCol, state.invSortDir);
      }
      renderFn();
    });
  });
}

/* ══════════════════════════════════════════════════════════════
   SMART REFRESH (preserves server filter, only updates if relevant)
══════════════════════════════════════════════════════════════ */

async function _silentRefreshMod() {
  try {
    const res  = await fetch('/api/logs');
    const data = res.ok ? await res.json() : null;
    if (!data || !Array.isArray(data)) return;
    const activeServer = getVal('mod-server-filter');
    const oldCount = activeServer
      ? state.modLogs.filter(l => l.server === activeServer).length
      : state.modLogs.length;
    state.modLogs = data;
    const newCount = activeServer
      ? state.modLogs.filter(l => l.server === activeServer).length
      : state.modLogs.length;
    if (newCount !== oldCount) {
      _populateModFilters();
      _updateModMiniStats();
      applyModFilters();
    }
  } catch (e) {}
}

async function _silentRefreshInv() {
  try {
    const res  = await fetch('/api/invite_logs');
    const data = res.ok ? await res.json() : null;
    if (!data || !Array.isArray(data)) return;
    const activeServer = getVal('inv-server-filter');
    const oldCount = activeServer
      ? state.invLogs.filter(l => l.server === activeServer).length
      : state.invLogs.length;
    state.invLogs = data;
    const newCount = activeServer
      ? state.invLogs.filter(l => l.server === activeServer).length
      : state.invLogs.length;
    if (newCount !== oldCount) {
      _populateInvFilters();
      invUpdateStats();
      applyInvFilters();
    }
  } catch (e) {}
}

/* ══════════════════════════════════════════════════════════════
   WEBSOCKET
══════════════════════════════════════════════════════════════ */

function initWS() {
  try {
    if (!window.io) return;
    const socket = window.io({ transports: ['websocket','polling'] });
    socket.on('connect', updateStatus);
    socket.on('disconnect', () => {
      document.getElementById('sb-dot')?.classList.remove('online');
      setText('sb-status-text', 'Offline');
      document.getElementById('bot-online-dot')?.classList.remove('online');
      setText('bot-status-text', 'Offline');
    });
    socket.on('status_update', updateStatus);
    socket.on('music_update',  () => { if (state.activeTab === 'music') loadMusic(); });
    socket.on('log_update', () => {
      if (state.activeTab === 'moderation') _silentRefreshMod();
      else if (state.activeTab === 'dashboard') loadDashboard();
      else _silentRefreshMod(); // update cache silently even on other tabs
    });
    socket.on('invite_update', () => {
      if (state.activeTab === 'invites') _silentRefreshInv();
      else if (state.activeTab === 'dashboard') loadDashboard();
      else _silentRefreshInv();
    });
    socket.on('logs_cleared',        () => { state.modLogs = []; state.modFiltered = []; if (state.activeTab === 'moderation') { renderModPage(); _updateModMiniStats(); } });
    socket.on('invite_logs_cleared', () => { state.invLogs = []; state.invFiltered = []; if (state.activeTab === 'invites')    { renderInvPage(); invUpdateStats(); } });
  } catch (e) {}
}

/* ══════════════════════════════════════════════════════════════
   MUSIC CONTROLS
══════════════════════════════════════════════════════════════ */

async function musicAction(endpoint) {
  const gid = state.musicGuildId;
  if (!gid) return;
  try { await fetch(`/api/music/${gid}/${endpoint}`, { method: 'POST' }); } catch(e){}
  setTimeout(loadMusic, 500);
}

/* ══════════════════════════════════════════════════════════════
   INIT
══════════════════════════════════════════════════════════════ */

document.addEventListener('DOMContentLoaded', () => {

  /* ── Custom selects (must be first) ── */
  initCustomSelects();

  /* ── Nav ── */
  document.querySelectorAll('.nav-item[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  /* ── Traffic lights ── */
  document.getElementById('tl-close')?.addEventListener('click', () => window.close());
  document.getElementById('tl-max')?.addEventListener('click', () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
    else document.exitFullscreen?.();
  });

  /* ── Music controls ── */
  document.getElementById('ctrl-play')?.addEventListener('click', () => {
    const action = state.musicPaused ? 'resume' : 'pause';
    state.musicPaused = !state.musicPaused;
    _updatePlayBtn(state.musicPaused);
    musicAction(action);
  });
  document.getElementById('ctrl-skip')?.addEventListener('click', () => musicAction('skip'));
  document.getElementById('ctrl-shuffle')?.addEventListener('click', e => {
    e.currentTarget.classList.toggle('active');
    musicAction('shuffle');
  });
  document.getElementById('ctrl-loop')?.addEventListener('click', e => {
    e.currentTarget.classList.toggle('active');
    musicAction('loop');
  });

  /* ── Volume bar click ── */
  document.getElementById('vol-bar')?.addEventListener('click', e => {
    const bar  = e.currentTarget;
    const rect = bar.getBoundingClientRect();
    const pct  = Math.max(0, Math.min(100, Math.round((e.clientX - rect.left) / rect.width * 100)));
    const fill = document.getElementById('vol-fill');
    if (fill) fill.style.width = `${pct}%`;
    const gid = state.musicGuildId;
    if (!gid) return;
    fetch(`/api/music/${gid}/volume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: pct }),
    }).catch(() => {});
  });

  /* ── Custom date picker — Moderation ── */
  initDatePicker(
    'mod-date-range-btn', 'mod-date-picker',
    'mod-date-start', 'mod-date-end',
    'mod-date-label', 'mod-date-val',
    'mod-date-clear', 'mod-date-apply',
    (ds, de) => {
      state.modDateStart = ds;
      state.modDateEnd   = de;
      applyModFilters();
    }
  );

  /* ── Moderation filters ── */
  const dModFilter = debounce(applyModFilters, 250);
  document.getElementById('mod-search')?.addEventListener('input', dModFilter);
  ['mod-server-filter','mod-user-filter','mod-action-filter','mod-rpp'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', applyModFilters);
  });

  /* ── Moderation pagination ── */
  document.getElementById('mod-prev')?.addEventListener('click', () => { if (state.modPage > 1) { state.modPage--; renderModPage(); } });
  document.getElementById('mod-next')?.addEventListener('click', () => {
    const pages = Math.max(1, Math.ceil(state.modFiltered.length / state.modRpp));
    if (state.modPage < pages) { state.modPage++; renderModPage(); }
  });

  /* ── Custom clear modal — Moderation ── */
  document.getElementById('mod-delete-btn')?.addEventListener('click', () => showModal('modal-mod-clear'));
  document.getElementById('mod-clear-cancel')?.addEventListener('click', () => hideModal('modal-mod-clear'));
  document.getElementById('modal-mod-clear')?.addEventListener('click', e => {
    if (e.target === e.currentTarget) hideModal('modal-mod-clear');
  });
  document.getElementById('mod-clear-confirm')?.addEventListener('click', async () => {
    hideModal('modal-mod-clear');
    const note = document.getElementById('mod-clear-note')?.value || '';
    try {
      await fetch('/delete', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({note}) });
      state.modLogs = []; state.modFiltered = [];
      renderModPage(); _updateModMiniStats();
      document.getElementById('mod-clear-note').value = '';
    } catch (e) { alert('Failed to clear logs.'); }
  });

  /* ── Custom date picker — Invites ── */
  initDatePicker(
    'inv-date-range-btn', 'inv-date-picker',
    'inv-date-start', 'inv-date-end',
    'inv-date-label', 'inv-date-val',
    'inv-date-clear', 'inv-date-apply',
    (ds, de) => {
      state.invDateStart = ds;
      state.invDateEnd   = de;
      applyInvFilters();
    }
  );

  /* ── Invite filters ── */
  const dInvFilter = debounce(applyInvFilters, 250);
  document.getElementById('inv-search')?.addEventListener('input', dInvFilter);
  ['inv-event-filter','inv-member-filter','inv-inviter-filter','inv-server-filter','inv-rpp'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', applyInvFilters);
  });

  /* ── Invite pagination ── */
  document.getElementById('inv-prev')?.addEventListener('click', () => { if (state.invPage > 1) { state.invPage--; renderInvPage(); } });
  document.getElementById('inv-next')?.addEventListener('click', () => {
    const pages = Math.max(1, Math.ceil(state.invFiltered.length / state.invRpp));
    if (state.invPage < pages) { state.invPage++; renderInvPage(); }
  });

  /* ── Custom clear modal — Invites ── */
  document.getElementById('inv-delete-btn')?.addEventListener('click', () => showModal('modal-inv-clear'));
  document.getElementById('inv-clear-cancel')?.addEventListener('click', () => hideModal('modal-inv-clear'));
  document.getElementById('modal-inv-clear')?.addEventListener('click', e => {
    if (e.target === e.currentTarget) hideModal('modal-inv-clear');
  });
  document.getElementById('inv-clear-confirm')?.addEventListener('click', async () => {
    hideModal('modal-inv-clear');
    const note = document.getElementById('inv-clear-note')?.value || '';
    try {
      await fetch('/delete_invite_logs', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({note}) });
      state.invLogs = []; state.invFiltered = [];
      renderInvPage(); invUpdateStats();
      document.getElementById('inv-clear-note').value = '';
    } catch (e) { alert('Failed to clear logs.'); }
  });

  /* ── Table sorting ── */
  initTableSort('mod-table', 'mod', renderModPage);
  initTableSort('inv-table', 'inv', renderInvPage);

  /* ── Initial load ── */
  updateStatus();
  loadGuilds();
  loadDashboard();

  /* ── Polling ── */
  setInterval(updateStatus, 15_000);
  setInterval(loadDashboard, 60_000);
  setInterval(() => { if (state.activeTab === 'music') loadMusic(); }, 10_000);
});
