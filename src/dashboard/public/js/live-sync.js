(function setupLiveSync() {
  if (window.__dashboardLiveSyncInitialized) {
    console.warn('[DEBUG_AUDIO_UI] live-sync already initialized, skipping duplicate init');
    return;
  }
  window.__dashboardLiveSyncInitialized = true;

  try {
    const params = new URLSearchParams(window.location.search);
    const debugFlag = params.get('debugAudioUi');
    if (debugFlag === '1' || debugFlag === '0') {
      window.localStorage.setItem('debugAudioUi', debugFlag);
    }
  } catch {}

  const DEBUG_AUDIO = (() => {
    try {
      return window.localStorage.getItem('debugAudioUi') === '1';
    } catch {
      return false;
    }
  })();
  function debugAudioLog(...args) {
    if (!DEBUG_AUDIO) return;
    console.log('[DEBUG_AUDIO_UI]', ...args);
  }
  debugAudioLog('init', { guildId: (document.body?.dataset?.guildId || '').trim() || null });

  let playerState = null;
  let currentTrack = null;
  let controlsBound = false;
  let controlRequestSeq = 0;
  let controlInFlight = false;
  let skipClickCount = 0;
  let panelOpen = false;
  let activePanelTab = 'queue';
  let toastTimer = null;
  let socketConnected = false;
  const selectedGuildId = (document.body?.dataset?.guildId || '').trim();

  function getActiveGuildName() {
    const activeGuild = document.querySelector('.guild-item.active');
    const name = activeGuild?.getAttribute('data-guild-name');
    if (name && name.trim()) return name.trim();
    return 'selected server';
  }

  function formatValue(value) {
    return typeof value === 'number' ? value.toLocaleString() : (value ?? '');
  }

  function formatTime(seconds) {
    const safe = Math.max(0, Math.floor(seconds));
    const mins = Math.floor(safe / 60);
    const secs = safe % 60;
    return `${mins}:${String(secs).padStart(2, '0')}`;
  }

  function updateStats(stats) {
    if (!stats) return;
    document.querySelectorAll('[data-stat]').forEach((element) => {
      const key = element.getAttribute('data-stat');
      if (!key || !(key in stats)) return;
      element.textContent = formatValue(stats[key]);
    });
  }

  function updateConfig(config) {
    if (!config) return;

    document.querySelectorAll('[data-config]').forEach((element) => {
      const key = element.getAttribute('data-config');
      if (!key || !(key in config)) return;

      const value = config[key];
      element.textContent = value ?? '';

      if (key === 'spotifySupport' || key === 'inviteTracking') {
        element.classList.toggle('active', String(value).toLowerCase() === 'active');
      }
    });
  }

  function updateHealth(health) {
    if (!health) return;
    document.querySelectorAll('[data-health]').forEach((element) => {
      const key = element.getAttribute('data-health');
      if (!key || !(key in health)) return;
      element.textContent = formatValue(health[key]);
    });
  }

  function setControlsDisabled(disabled) {
    ['npPrevBtn', 'npPauseBtn', 'npStopBtn', 'npSkipBtn', 'npVolumeRange', 'npPanelToggle'].forEach((id) => {
      const element = document.getElementById(id);
      if (element) element.disabled = disabled;
    });
  }

  function updateControlAvailability(state) {
    const prevBtn = document.getElementById('npPrevBtn');
    const skipBtn = document.getElementById('npSkipBtn');
    const stopBtn = document.getElementById('npStopBtn');
    const pauseBtn = document.getElementById('npPauseBtn');
    const volumeRange = document.getElementById('npVolumeRange');
    const panelToggle = document.getElementById('npPanelToggle');

    if (prevBtn) prevBtn.disabled = !state || !state.canBack;
    if (skipBtn) skipBtn.disabled = !state || !state.canSkip;
    if (stopBtn) stopBtn.disabled = !state || !state.canStop;
    if (pauseBtn) pauseBtn.disabled = !state;
    if (volumeRange) volumeRange.disabled = !state;
    if (panelToggle) panelToggle.disabled = !currentTrack;
  }

  function showToast(message) {
    if (!message) return;

    let toast = document.getElementById('appToast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'appToast';
      toast.className = 'app-toast';
      document.body.appendChild(toast);
    }

    toast.textContent = message;
    toast.classList.add('show');

    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2400);
  }

  function updatePauseIcon(isPaused) {
    const pauseBtn = document.getElementById('npPauseBtn');
    if (!pauseBtn) return;

    pauseBtn.innerHTML = isPaused
      ? '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>'
      : '<svg viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';
  }

  function updateVolumeUI(volume) {
    const safeVolume = Number.isFinite(Number(volume)) ? Math.max(0, Math.min(100, Math.round(Number(volume)))) : 50;
    const volumeRange = document.getElementById('npVolumeRange');
    const volumeValue = document.getElementById('npVolumeValue');

    if (volumeRange) volumeRange.value = String(safeVolume);
    if (volumeValue) volumeValue.textContent = `${safeVolume}%`;
  }

  function setPanelOpen(isOpen) {
    panelOpen = Boolean(isOpen);
    const panel = document.getElementById('npDetailsPanel');
    const toggle = document.getElementById('npPanelToggle');

    if (panel) panel.classList.toggle('hidden', !panelOpen);
    if (toggle) toggle.classList.toggle('open', panelOpen);
  }

  function setPanelTab(tab) {
    activePanelTab = tab === 'history' ? 'history' : 'queue';
    const queueTab = document.getElementById('npTabQueue');
    const historyTab = document.getElementById('npTabHistory');
    const queueList = document.getElementById('npPanelQueueList');
    const historyList = document.getElementById('npPanelHistoryList');

    if (queueTab) queueTab.classList.toggle('active', activePanelTab === 'queue');
    if (historyTab) historyTab.classList.toggle('active', activePanelTab === 'history');
    if (queueList) queueList.classList.toggle('hidden', activePanelTab !== 'queue');
    if (historyList) historyList.classList.toggle('hidden', activePanelTab !== 'history');
  }

  function updateProgress(track, state) {
    const barFill = document.getElementById('npBarProgressFill');
    const barElapsedEl = document.getElementById('npBarElapsed');
    const barTotalEl = document.getElementById('npBarTotal');

    const hasBarProgress = barFill && barElapsedEl && barTotalEl;
    if (!hasBarProgress) return;

    const progress = state?.progress || null;
    if (!progress) {
      barFill.style.width = '0%';
      barElapsedEl.textContent = '0:00';
      barTotalEl.textContent = track?.duration || '--:--';
      return;
    }

    const percent = Number.isFinite(progress.percent) ? Math.max(0, Math.min(100, progress.percent)) : 0;
    barFill.style.width = `${percent}%`;

    if (progress.currentLabel) {
      barElapsedEl.textContent = progress.currentLabel;
    } else {
      barElapsedEl.textContent = formatTime(Number(progress.currentValue || 0) / 1000);
    }

    barTotalEl.textContent = progress.totalLabel || track?.duration || '--:--';
  }

  function updateNowPlaying(track, state) {
    const bar = document.getElementById('nowPlayingBar');
    if (!bar) return;

    if (!track) {
      currentTrack = null;
      bar.classList.remove('hidden');
      updateNowPlayingSummary(null, state);
      setControlsDisabled(true);
      updateVolumeUI(state?.volume ?? 50);
      setPanelOpen(false);

      const title = document.getElementById('npTitle');
      const artist = document.getElementById('npArtist');
      const time = document.getElementById('npTime');
      const thumb = document.getElementById('npThumbnail');
      const thumbFallback = document.getElementById('npThumbnailFallback');
      const panelTitle = document.getElementById('npPanelTitle');
      const panelArtist = document.getElementById('npPanelArtist');
      const panelRequested = document.getElementById('npPanelRequested');
      const panelThumb = document.getElementById('npPanelThumb');
      const panelThumbFallback = document.getElementById('npPanelThumbFallback');

      const serverName = getActiveGuildName();
      if (title) title.textContent = 'Nothing playing';
      if (artist) artist.textContent = `No active track for ${serverName}`;
      if (time) time.textContent = '--:--';
      if (panelTitle) panelTitle.textContent = 'Nothing playing';
      if (panelArtist) panelArtist.textContent = `No active track for ${serverName}`;
      if (panelRequested) panelRequested.textContent = 'Requested by Unknown';

      if (thumb && thumbFallback) {
        thumb.classList.add('hidden-thumb');
        thumbFallback.classList.remove('hidden-thumb');
      }
      if (panelThumb && panelThumbFallback) {
        panelThumb.classList.add('hidden-thumb');
        panelThumbFallback.classList.remove('hidden-thumb');
      }

      updateProgress(null, state);
      return;
    }

    currentTrack = track;
    bar.classList.remove('hidden');
    setControlsDisabled(false);
    updateControlAvailability(state);
    updatePauseIcon(Boolean(state?.isPaused));
    updateVolumeUI(state?.volume ?? 50);

    const title = document.getElementById('npTitle');
    const artist = document.getElementById('npArtist');
    const time = document.getElementById('npTime');
    const thumb = document.getElementById('npThumbnail');
    const thumbFallback = document.getElementById('npThumbnailFallback');

    const panelTitle = document.getElementById('npPanelTitle');
    const panelArtist = document.getElementById('npPanelArtist');
    const panelRequested = document.getElementById('npPanelRequested');
    const panelThumb = document.getElementById('npPanelThumb');
    const panelThumbFallback = document.getElementById('npPanelThumbFallback');

    if (title) title.textContent = track.title || 'Unknown title';
    if (artist) artist.textContent = track.author || 'Unknown artist';
    if (time) time.textContent = track.duration || '--:--';

    if (panelTitle) panelTitle.textContent = track.title || 'Unknown title';
    if (panelArtist) panelArtist.textContent = track.author || 'Unknown artist';
    if (panelRequested) panelRequested.textContent = `Requested by ${track.requestedBy || 'Unknown'}`;

    if (thumb && thumbFallback) {
      if (track.thumbnail) {
        thumb.src = track.thumbnail;
        thumb.alt = track.title ? `${track.title} cover` : 'thumbnail';
        thumb.classList.remove('hidden-thumb');
        thumbFallback.classList.add('hidden-thumb');
      } else {
        thumb.classList.add('hidden-thumb');
        thumbFallback.classList.remove('hidden-thumb');
      }
    }

    if (panelThumb && panelThumbFallback) {
      if (track.thumbnail) {
        panelThumb.src = track.thumbnail;
        panelThumb.alt = track.title ? `${track.title} cover` : 'thumbnail';
        panelThumb.classList.remove('hidden-thumb');
        panelThumbFallback.classList.add('hidden-thumb');
      } else {
        panelThumb.classList.add('hidden-thumb');
        panelThumbFallback.classList.remove('hidden-thumb');
      }
    }

    updateProgress(track, state);
    updateNowPlayingSummary(track, state);
  }

  function updateNowPlayingSummary(track, state) {
    const titleEl = document.getElementById('dashNowTitle');
    const metaEl = document.getElementById('dashNowMeta');
    if (!titleEl || !metaEl) return;

    if (!track) {
      const serverName = getActiveGuildName();
      titleEl.textContent = 'Nothing playing';
      metaEl.textContent = `No active track for ${serverName}`;
      return;
    }

    titleEl.textContent = track.title || 'Unknown title';
    const author = track.author || 'Unknown artist';
    const current = state?.progress?.currentLabel || '0:00';
    const total = state?.progress?.totalLabel || track.duration || '--:--';
    metaEl.textContent = `${author} - ${current} / ${total}`;
  }
  // Track list fingerprints for smart diffing — skip re-render when data hasn't changed
  const listFingerprints = {};

  function trackListFingerprint(tracks) {
    if (!Array.isArray(tracks) || tracks.length === 0) return '';
    return tracks.map((t) => `${t.title || ''}|${t.author || ''}|${t.duration || ''}|${t.thumbnail || ''}`).join(';;');
  }

  function buildTrackItemHtml(track, index, isDraggable) {
    const title = escapeHtml(track.title || 'Unknown title');
    const author = escapeHtml(track.author || 'Unknown artist');
    const duration = escapeHtml(track.duration || '--:--');
    const thumbnail = track.thumbnail ? escapeHtml(track.thumbnail) : '';
    const thumbHtml = thumbnail
      ? `<img class="music-item-thumb" src="${thumbnail}" alt="${title} cover" loading="lazy">`
      : '<div class="music-item-thumb music-item-thumb-fallback"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg></div>';
    const dragAttr = isDraggable ? `draggable="true" data-queue-index="${index}"` : '';
    const dragHandle = isDraggable
      ? '<div class="music-item-drag"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M11 18c0 1.1-.9 2-2 2s-2-.9-2-2 .9-2 2-2 2 .9 2 2zm-2-8c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0-6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm6 4c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/></svg></div>'
      : '';
    return [
      `<div class="music-item" ${dragAttr}>`,
      `  ${dragHandle}`,
      `  ${thumbHtml}`,
      '  <div class="music-item-main">',
      `    <div class="music-item-title">${title}</div>`,
      `    <div class="music-item-meta">${author}</div>`,
      '  </div>',
      `  <div class="music-item-duration">${duration}</div>`,
      '</div>'
    ].join('\n');
  }

  function renderPanelTrackList(containerId, tracks, emptyText, isDraggable) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const fp = trackListFingerprint(tracks);
    // Only skip re-render if panel is NOT open or this tab is NOT active
    const isVisible = panelOpen && (
      (containerId === 'npPanelQueueList' && activePanelTab === 'queue') ||
      (containerId === 'npPanelHistoryList' && activePanelTab === 'history')
    );
    // Always re-render if visible to ensure fresh data; diff only when hidden
    if (!isVisible && listFingerprints[containerId] === fp) return;
    listFingerprints[containerId] = fp;

    if (!Array.isArray(tracks) || tracks.length === 0) {
      container.innerHTML = `<div class="music-empty">${emptyText}</div>`;
      return;
    }

    container.innerHTML = tracks.map((track, i) => buildTrackItemHtml(track, i, isDraggable)).join('\n');

    if (isDraggable) bindQueueDragDrop(container);
  }

  // Drag and drop for queue reordering
  let dragSourceIndex = null;

  function bindQueueDragDrop(container) {
    const items = container.querySelectorAll('.music-item[draggable]');
    items.forEach((item) => {
      item.addEventListener('dragstart', (e) => {
        dragSourceIndex = parseInt(item.dataset.queueIndex, 10);
        item.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(dragSourceIndex));
      });
      item.addEventListener('dragend', () => {
        item.classList.remove('dragging');
        container.querySelectorAll('.music-item').forEach((el) => el.classList.remove('drag-over'));
        dragSourceIndex = null;
      });
      item.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        container.querySelectorAll('.music-item').forEach((el) => el.classList.remove('drag-over'));
        item.classList.add('drag-over');
      });
      item.addEventListener('dragleave', () => {
        item.classList.remove('drag-over');
      });
      item.addEventListener('drop', (e) => {
        e.preventDefault();
        item.classList.remove('drag-over');
        const targetIndex = parseInt(item.dataset.queueIndex, 10);
        if (dragSourceIndex !== null && dragSourceIndex !== targetIndex) {
          postControl('reorder', { from: dragSourceIndex, to: targetIndex }).then((result) => {
            if (result?.payload) applySyncPayload(result.payload);
          }).catch((err) => showToast(err.message || 'Reorder failed.'));
        }
      });
    });
  }

  function renderMusicLists(queueList, historyList) {
    const queueCount = document.getElementById('npQueueCount');
    const historyCount = document.getElementById('npHistoryCount');

    if (queueCount) queueCount.textContent = String((queueList || []).length);
    if (historyCount) historyCount.textContent = String((historyList || []).length);

    renderPanelTrackList('npPanelQueueList', queueList, 'No tracks in queue.', true);
    renderPanelTrackList('npPanelHistoryList', historyList, 'No history yet.', false);
  }

  async function postControl(action, extra = {}) {
    const requestId = ++controlRequestSeq;
    const startedAt = Date.now();
    const payload = { action, guildId: selectedGuildId || null, ...extra };
    debugAudioLog('postControl:request', { requestId, payload, inFlight: controlInFlight });
    const response = await fetch('/api/player/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({ message: 'Action failed.' }));
      debugAudioLog('postControl:error', {
        requestId,
        action,
        status: response.status,
        data,
        elapsedMs: Date.now() - startedAt
      });
      throw new Error(data.message || 'Action failed.');
    }

    const data = await response.json();
    debugAudioLog('postControl:success', {
      requestId,
      action,
      elapsedMs: Date.now() - startedAt,
      hasPayload: Boolean(data?.payload)
    });
    return data;
  }

  function applySyncPayload(payload) {
    if (!payload) return;
    playerState = payload.playerState || null;
    updateStats(payload.stats || payload);
    updateHealth(payload.health || null);
    updateConfig(payload.config || null);
    updateNowPlaying(payload.currentTrack || null, playerState);
    renderMusicLists(payload.queueList || [], payload.historyList || []);
    renderDashboardRecentLogs(payload.recentCommands || []);
    renderDashboardCommandUsage(payload.commandUsage || []);
  }

  function bindPlayerControls() {
    if (controlsBound) return;

    const prevBtn = document.getElementById('npPrevBtn');
    const pauseBtn = document.getElementById('npPauseBtn');
    const stopBtn = document.getElementById('npStopBtn');
    const skipBtn = document.getElementById('npSkipBtn');
    const volumeRange = document.getElementById('npVolumeRange');
    const panelToggle = document.getElementById('npPanelToggle');
    const tabQueue = document.getElementById('npTabQueue');
    const tabHistory = document.getElementById('npTabHistory');

    if (!prevBtn || !pauseBtn || !stopBtn || !skipBtn || !volumeRange || !panelToggle || !tabQueue || !tabHistory) return;
    controlsBound = true;

    const withLock = async (action, payload) => {
      debugAudioLog('withLock:start', { action, payload, playerState, lockBefore: controlInFlight });
      if (controlInFlight) {
        debugAudioLog('withLock:ignored-due-lock', { action });
        return;
      }
      controlInFlight = true;
      setControlsDisabled(true);
      try {
        const result = await postControl(action, payload);
        if (result?.payload) applySyncPayload(result.payload);
      } catch (error) {
        console.error('Player control error:', error.message);
        showToast(error.message || 'Action failed.');
      } finally {
        controlInFlight = false;
        if (playerState) {
          setControlsDisabled(false);
          updateControlAvailability(playerState);
        } else {
          setControlsDisabled(true);
        }
        debugAudioLog('withLock:end', { action, lockAfter: controlInFlight });
      }
    };

    prevBtn.addEventListener('click', () => withLock('back'));
    pauseBtn.addEventListener('click', () => withLock('toggle-pause'));
    stopBtn.addEventListener('click', () => withLock('stop'));
    skipBtn.addEventListener('click', () => {
      skipClickCount += 1;
      debugAudioLog('skip:click', { count: skipClickCount, disabled: skipBtn.disabled, lock: controlInFlight });
      withLock('skip');
    });

    volumeRange.addEventListener('input', (event) => updateVolumeUI(event.target.value));
    volumeRange.addEventListener('change', (event) => withLock('set-volume', { value: event.target.value }));

    panelToggle.addEventListener('click', () => {
      if (!currentTrack) return;
      setPanelOpen(!panelOpen);
    });

    tabQueue.addEventListener('click', () => setPanelTab('queue'));
    tabHistory.addEventListener('click', () => setPanelTab('history'));
    setPanelTab('queue');
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function renderCommandLogs(logs) {
    const tbody = document.getElementById('commandLogsBody');
    if (!tbody) return;

    const emptyState = document.getElementById('commandLogsEmpty');
    const rows = Array.isArray(logs) ? logs.slice(0, 50) : [];

    if (rows.length === 0) {
      tbody.innerHTML = '';
      if (emptyState) emptyState.style.display = '';
      return;
    }

    if (emptyState) emptyState.style.display = 'none';
    tbody.innerHTML = rows.map((log) => {
      const command = escapeHtml(log.command || 'unknown');
      const userTag = escapeHtml(log.user_tag || 'unknown');
      const guildName = escapeHtml(log.guild_name || 'DM');
      const date = escapeHtml(new Date(log.timestamp).toLocaleString());
      return [
        '<tr>',
        `  <td class="cmd">/${command}</td>`,
        `  <td class="user">${userTag}</td>`,
        `  <td>${guildName}</td>`,
        `  <td>${date}</td>`,
        '</tr>'
      ].join('\n');
    }).join('\n');
  }

  function renderDashboardRecentLogs(logs) {
    const tbody = document.getElementById('dashRecentCommandLogsBody');
    if (!tbody) return;

    const emptyState = document.getElementById('dashRecentCommandLogsEmpty');
    const rows = Array.isArray(logs) ? logs.slice(0, 4) : [];

    if (rows.length === 0) {
      tbody.innerHTML = '';
      if (emptyState) emptyState.style.display = '';
      return;
    }

    if (emptyState) emptyState.style.display = 'none';
    tbody.innerHTML = rows.map((log) => {
      const command = escapeHtml(log.command || 'unknown');
      const userTag = escapeHtml(log.user_tag || 'unknown');
      const date = escapeHtml(new Date(log.timestamp).toLocaleString());
      return [
        '<tr>',
        `  <td class="cmd">/${command}</td>`,
        `  <td class="user">${userTag}</td>`,
        `  <td>${date}</td>`,
        '</tr>'
      ].join('\n');
    }).join('\n');
  }

  function renderDashboardCommandUsage(rows) {
    const tbody = document.getElementById('dashCommandUsageBody');
    if (!tbody) return;

    const emptyState = document.getElementById('dashCommandUsageEmpty');
    const usageRows = Array.isArray(rows) ? rows.slice(0, 4) : [];

    if (usageRows.length === 0) {
      tbody.innerHTML = '';
      if (emptyState) emptyState.style.display = '';
      return;
    }

    if (emptyState) emptyState.style.display = 'none';
    tbody.innerHTML = usageRows.map((row) => {
      const command = escapeHtml(row.command || 'unknown');
      const uses = escapeHtml(row.uses ?? 0);
      return [
        '<tr>',
        `  <td class="cmd">/${command}</td>`,
        `  <td>${uses}</td>`,
        '</tr>'
      ].join('\n');
    }).join('\n');
  }

  function renderClearLogs(logs) {
    const tbody = document.getElementById('clearLogsBody');
    const table = document.getElementById('clearLogsTable');
    const emptyState = document.getElementById('clearLogsEmpty');
    if (!tbody) return;

    const rows = Array.isArray(logs) ? logs : [];
    const guildId = selectedGuildId || '';
    const guildParam = guildId ? `?guildId=${encodeURIComponent(guildId)}` : '';

    if (rows.length === 0) {
      tbody.innerHTML = '';
      if (table) table.style.display = 'none';
      if (emptyState) emptyState.style.display = '';
      return;
    }

    if (table) table.style.display = '';
    if (emptyState) emptyState.style.display = 'none';

    tbody.innerHTML = rows.map((log) => {
      const moderator = escapeHtml(log.moderator_tag || 'Unknown');
      const channel = escapeHtml(log.channel_name || 'unknown');
      const count = escapeHtml(log.message_count ?? 0);
      const guild = escapeHtml(log.guild_name || 'Unknown');
      const date = escapeHtml(new Date(log.timestamp).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }));
      const href = `/transcript/${log.id}${guildParam}`;
      return [
        `<tr id="clear-log-row-${log.id}">`,
        `  <td class="user-tag">${moderator}</td>`,
        `  <td class="channel">#${channel}</td>`,
        `  <td>${count} items</td>`,
        `  <td class="server">${guild}</td>`,
        `  <td class="date">${date}</td>`,
        `  <td><div style="display:flex;align-items:center;justify-content:space-between;gap:8px;"><a href="${href}" style="display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:8px;background:rgba(203,213,230,0.08);border:1px solid rgba(203,213,230,0.15);color:#cbd5e6;font-size:12px;font-weight:600;text-decoration:none;"><svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm4 18H6V4h7v5h5v11z"/></svg>Transcript</a><button class="delete-log-btn" data-log-id="${log.id}" title="Delete log" style="background:rgba(231,76,60,0.08);border:1px solid rgba(231,76,60,0.2);border-radius:8px;cursor:pointer;color:#e74c3c;padding:6px 8px;display:flex;align-items:center;"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg></button></div></td>`,
        '</tr>'
      ].join('\n');
    }).join('\n');
  }

  async function fetchStats() {
    try {
      const params = new URLSearchParams();
      if (selectedGuildId) params.set('guildId', selectedGuildId);
      const response = await fetch(`/api/stats${params.toString() ? `?${params.toString()}` : ''}`);
      if (!response.ok) return;
      const data = await response.json();
      applySyncPayload(data);
    } catch {
      // Ignore polling failures; websocket or next polling cycle may recover.
    }
  }

  async function fetchCommandLogs() {
    if (!document.getElementById('commandLogsBody')) return;
    try {
      const params = new URLSearchParams();
      if (selectedGuildId) params.set('guildId', selectedGuildId);
      const response = await fetch(`/api/command-logs${params.toString() ? `?${params.toString()}` : ''}`);
      if (!response.ok) return;
      const logs = await response.json();
      renderCommandLogs(logs);
    } catch {
      // Ignore polling failures; websocket or next polling cycle may recover.
    }
  }

  function navigateToGuild(guildId) {
    const url = new URL(window.location.href);
    if (guildId) {
      url.searchParams.set('guildId', guildId);
    } else {
      url.searchParams.delete('guildId');
    }
    window.location.assign(url.toString());
  }

  function bindGuildFilter() {
    document.querySelectorAll('[data-guild-select]').forEach((element) => {
      element.addEventListener('click', () => {
        navigateToGuild(element.getAttribute('data-guild-select') || '');
      });
    });
  }

  function bindGuildHoverTooltip() {
    const guildItems = document.querySelectorAll('.guild-item[data-guild-name]');
    if (!guildItems.length) return;

    let tooltip = document.querySelector('.guild-hover-tooltip');
    if (!tooltip) {
      tooltip = document.createElement('div');
      tooltip.className = 'guild-hover-tooltip';
      document.body.appendChild(tooltip);
    }

    let activeItem = null;

    const positionTooltip = (item) => {
      if (!item) return;
      const rect = item.getBoundingClientRect();
      const offsetX = 14;
      const top = rect.top + (rect.height / 2);

      tooltip.style.left = `${Math.round(rect.right + offsetX)}px`;
      tooltip.style.top = `${Math.round(top)}px`;
      tooltip.style.transform = 'translateX(0) translateY(-50%) scale(1)';
    };

    guildItems.forEach((item) => {
      item.addEventListener('mouseenter', () => {
        const label = item.getAttribute('data-guild-name') || '';
        if (!label) return;
        activeItem = item;
        tooltip.textContent = label;
        positionTooltip(item);
        tooltip.classList.add('show');
      });

      item.addEventListener('mouseleave', () => {
        activeItem = null;
        tooltip.classList.remove('show');
      });
    });

    window.addEventListener('scroll', () => {
      if (activeItem && tooltip.classList.contains('show')) positionTooltip(activeItem);
    }, { passive: true });
    window.addEventListener('resize', () => {
      if (activeItem && tooltip.classList.contains('show')) positionTooltip(activeItem);
    });
  }

  function bindServerPanelToggle() {
    const toggleBtn = document.getElementById('serversToggleBtn');
    const panel = document.getElementById('sidebarExtended');
    if (!toggleBtn || !panel) return;

    const storageKey = 'discord_dashboard_servers_panel_open';
    const applyOpenState = (open) => {
      panel.classList.toggle('is-open', open);
      toggleBtn.classList.toggle('active', open);
      document.body.classList.toggle('servers-open', open);
    };

    const persisted = window.localStorage.getItem(storageKey);
    const isOpen = persisted === '1';
    applyOpenState(isOpen);

    toggleBtn.addEventListener('click', () => {
      const nextOpen = !panel.classList.contains('is-open');
      applyOpenState(nextOpen);
      window.localStorage.setItem(storageKey, nextOpen ? '1' : '0');
    });
  }

  if (typeof window.io === 'function') {
    const socket = window.io({
      query: selectedGuildId ? { guildId: selectedGuildId } : {}
    });

    socket.on('connect', () => {
      socketConnected = true;
    });

    socket.on('disconnect', () => {
      socketConnected = false;
    });

    socket.on('dashboard:sync', (payload) => {
      applySyncPayload(payload);
    });
    socket.on('dashboard:commandLogs', (logs) => {
      renderCommandLogs(logs);
      renderDashboardRecentLogs(logs);
    });
    socket.on('dashboard:clearLogs', (logs) => {
      renderClearLogs(logs);
    });
  }

  bindServerPanelToggle();
  bindGuildFilter();
  bindGuildHoverTooltip();
  bindPlayerControls();
  fetchStats();
  fetchCommandLogs();
  // Keep progress/timer moving even when websocket is connected.
  // Socket events handle state changes; polling keeps timestamp in sync.
  setInterval(() => {
    fetchStats();
  }, 1500);
  setInterval(() => {
    if (!socketConnected) fetchCommandLogs();
  }, 45000);
})();








