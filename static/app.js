const APP_VERSION = '0.51.0'; // do not auto increment!
const isTouchDevice = window.matchMedia('(pointer: coarse)').matches;
let ws = null;
let currentPath = '/';
let currentItems = [];
let clipboard = null;
let ctxItem = null;
let selectedNames = new Set();
let lastClickedIndex = null;
let lastMoveSource = null;
let selectMode = false;
let pingInterval = null;

const $ = id => document.getElementById(id);
function esc(s) { return String(s).replace(/[&<>"']/g, function(m) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]; }); }

/* ───── WebSocket ───── */
function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws`);

  ws.onopen = () => {
    const saved = sessionStorage.getItem('authHost');
    if (saved) {
      send('auth', {
        host: saved,
        port: parseInt(sessionStorage.getItem('authPort'), 10) || 21,
        user: sessionStorage.getItem('authUser') || '',
        pass: sessionStorage.getItem('authPass') || '',
        passive: sessionStorage.getItem('authPassive') !== 'false',
      });
    } else {
      $('auth-overlay').classList.remove('hidden');
    }
    pingInterval = setInterval(() => send('ping'), 30000);
  };

  ws.onclose = () => {
    $('main').classList.add('hidden');
    $('auth-overlay').classList.remove('hidden');
    $('auth-error').textContent = __('connection_lost');
    $('auth-error').classList.remove('hidden');
    if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
    setTimeout(connect, 2000);
  };

  ws.onmessage = e => handleMsg(JSON.parse(e.data));
  ws.onerror = () => {};
}

function send(action, params) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action, params: params || {} }));
  }
}

/* ───── message dispatcher ───── */
function handleMsg(msg) {
  switch (msg.type) {
    case 'auth_ok':
      currentPath = msg.cwd;
      currentItems = msg.items;
      $('auth-overlay').classList.add('hidden');
      $('auth-error').classList.add('hidden');
      $('main').classList.remove('hidden');
      renderBreadcrumb(msg.cwd);
      renderListing();
      // save session for F5 persistence
      saveAuthSession(
        $('host').value,
        parseInt($('port').value, 10) || 21,
        $('username').value,
        $('password').value,
        $('passive').checked,
      );
      break;

    case 'auth_error':
      clearAuthSession();
      $('auth-error').textContent = msg.msg;
      $('auth-error').classList.remove('hidden');
      $('auth-overlay').classList.remove('hidden');
      break;

    case 'list_ok':
      currentPath = msg.path;
      currentItems = msg.items;
      renderBreadcrumb(msg.path);
      renderListing();
      break;

    case 'upload_started':
      sendNextChunk();
      break;

    case 'file_exists':
      console.log('[handleMsg] file_exists received:', msg.name, 'context:', msg.context);
      if (!confirm(__('overwrite', msg.name))) {
        if (msg.context === 'upload') { uploading = false; uploadNext(); }
        break;
      }
      if (msg.context === 'upload') {
        send('upload_start', { path: uploadPath, size: uploadFile.size, confirm_overwrite: true });
      } else {
        send(msg.context, { source: msg.source, dest: msg.dest, confirm_overwrite: true });
      }
      break;

    case 'chunk_ok':
      sendNextChunk();
      break;

    case 'op_progress':
      if (!_pasteQueue && !uploading) break;
      showOpProgress(msg.name, msg.current, msg.total);
      break;
    case 'ok':
      clearTimeout(opTimer);
      opTimer = setTimeout(() => hideOpBar(), 500);
      refresh();
      if (uploading) {
        uploadNext();
      } else if (_pasteQueue) {
        if (lastMoveSource) {
          const parent = lastMoveSource.substring(0, lastMoveSource.lastIndexOf('/')) || '/';
          send('list', { path: parent });
          lastMoveSource = null;
        }
        pasteNext();
      }
      break;

    case 'props_ok':
      showProperties(msg.props);
      break;

    case 'download_ready': {
      if (msg.zip) {
        fetch(`/api/download?token=${msg.token}`)
          .then(r => {
            const ct = r.headers.get('Content-Type') || '';
            if (ct.includes('json')) return r.json().then(e => { throw new Error(e.error || 'Download failed'); });
            const disp = r.headers.get('Content-Disposition');
            const m = disp && disp.match(/filename="(.+?)"/);
            const name = m ? m[1] : 'download.zip';
            return r.blob().then(b => ({ blob: b, name }));
          })
          .then(({ blob, name }) => {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = name;
            document.body.appendChild(a); a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
          })
          .catch(err => alert(__('error_prefix') + err.message))
          .finally(() => hideOpBar());
      } else {
        const a = document.createElement('a');
        a.href = `/api/download?token=${msg.token}`;
        a.download = '';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }
      break;
    }

    case 'error':
      hideOpBar();
      const errMsg = msg.code && errorCodeMap[msg.code] ? __(msg.code) : msg.msg;
      alert(__('error_prefix') + errMsg);
      break;
  }
}

/* ───── helpers ───── */
function fmtSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const s = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), s.length - 1);
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + s[i];
}

function fmtDate(raw) {
  if (!raw || raw === '—') return '—';
  if (/^\d{14}$/.test(raw)) {
    const dt = new Date(Date.UTC(
      +raw.slice(0, 4), +raw.slice(4, 6) - 1, +raw.slice(6, 8),
      +raw.slice(8, 10), +raw.slice(10, 12), +raw.slice(12, 14)
    ));
    const d = String(dt.getDate()).padStart(2, '0');
    const M = String(dt.getMonth() + 1).padStart(2, '0');
    const y = dt.getFullYear();
    const h = String(dt.getHours()).padStart(2, '0');
    const m = String(dt.getMinutes()).padStart(2, '0');
    const s = String(dt.getSeconds()).padStart(2, '0');
    return `${d}.${M}.${y} ${h}:${m}:${s}`;
  }
  return raw;
}

function saveAuthSession(host, port, user, pass, passive) {
  sessionStorage.setItem('authHost', host);
  sessionStorage.setItem('authPort', String(port));
  sessionStorage.setItem('authUser', user);
  sessionStorage.setItem('authPass', pass);
  sessionStorage.setItem('authPassive', String(passive));
}

function clearAuthSession() {
  ['authHost', 'authPort', 'authUser', 'authPass', 'authPassive']
    .forEach(k => sessionStorage.removeItem(k));
}

function joinPath(base, name) {
  base = base.replace(/\/+$/, '');
  return base === '' ? '/' + name : base + '/' + name;
}

function iconFile(type) {
  return type === 'dir'
    ? '<i class="fas fa-folder icon"></i>'
    : '<i class="far fa-file icon"></i>';
}

function iconDirUp() {
  return '<i class="fas fa-folder-open icon"></i>';
}

/* ───── sort ───── */
function getSort() {
  let col = sessionStorage.getItem('sortCol');
  let dir = sessionStorage.getItem('sortDir');
  return {
    col: col || 'name',
    dir: dir === 'desc' ? 'desc' : 'asc',
  };
}

function saveSort(col, dir) {
  sessionStorage.setItem('sortCol', col);
  sessionStorage.setItem('sortDir', dir);
}

function sortItems() {
  const { col, dir } = getSort();
  const mul = dir === 'desc' ? -1 : 1;

  currentItems.sort((a, b) => {
    let cmp = 0;
    if (col === 'name') {
      // folders first, then by name
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      cmp = a.name.localeCompare(b.name);
    } else if (col === 'size') {
      cmp = (a.size || 0) - (b.size || 0);
    } else if (col === 'date') {
      cmp = (a.date || '').localeCompare(b.date || '');
    }
    return cmp * mul;
  });
}

function updateSortIndicator() {
  const { col, dir } = getSort();
  document.querySelectorAll('.sort-col').forEach(th => {
    const c = th.dataset.col;
    const span = th.querySelector('.sort-indicator');
    if (c === col) {
      span.innerHTML = dir === 'asc'
        ? '<i class="fas fa-sort-up"></i>'
        : '<i class="fas fa-sort-down"></i>';
    } else {
      span.innerHTML = '';
    }
  });
}

/* ───── render ───── */
function renderListing() {
  sortItems();
  updateSortIndicator();

  const tbody = $('file-list');
  tbody.innerHTML = '';

  if (currentPath !== '/') {
    const tr = document.createElement('tr');
    tr.className = 'row-up';
    tr.innerHTML = `<td class="cb-cell"></td><td>${iconDirUp()} ..</td><td>&lt;UP&gt;</td><td>—</td>`;
    if (isTouchDevice) {
      let upTimer, upHandled = false;
      tr.addEventListener('click', e => { if (upHandled) { upHandled = false; return; } navigateUp(); });
      tr.addEventListener('touchstart', e => {
        upHandled = false;
        const touch = e.touches[0];
        upTimer = setTimeout(() => { upHandled = true; showCtx({ clientX: touch.clientX, clientY: touch.clientY }, null); }, 500);
      }, { passive: true });
      tr.addEventListener('touchend', () => clearTimeout(upTimer));
      tr.addEventListener('touchmove', () => clearTimeout(upTimer));
    } else {
      tr.addEventListener('dblclick', navigateUp);
      tr.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); showCtx(e, null); });
    }
    tbody.appendChild(tr);
  }

  for (const item of currentItems) {
    const tr = document.createElement('tr');
    tr.dataset.name = item.name;
    tr.dataset.type = item.type;
    if (selectedNames.has(item.name)) tr.classList.add('selected');
    const sizeStr = item.type === 'dir' ? '&lt;DIR&gt;' : fmtSize(item.size);
    tr.innerHTML =
      `<td class="cb-cell"><input type="checkbox" class="cb-select"></td>` +
      `<td>${iconFile(item.type)}${esc(item.name)}</td>` +
      `<td>${sizeStr}</td>` +
      `<td>${esc(fmtDate(item.date))}</td>`;

    const cb = tr.querySelector('.cb-select');
    if (cb) {
      cb.checked = selectedNames.has(item.name);
      cb.addEventListener('change', () => {
        if (!selectMode) enterSelectMode();
        if (cb.checked) selectedNames.add(item.name);
        else selectedNames.delete(item.name);
        tr.classList.toggle('selected', cb.checked);
      });
      cb.addEventListener('click', e => e.stopPropagation());
    }

    if (isTouchDevice) {
      let touchHandled = false, touchTimer;
      tr.addEventListener('touchstart', e => {
        touchHandled = false;
        const touch = e.touches[0];
        touchTimer = setTimeout(() => {
          touchHandled = true;
          selectedNames.clear();
          selectedNames.add(item.name);
          updateCheckboxes();
          showCtx({ clientX: touch.clientX, clientY: touch.clientY }, item);
        }, 500);
      }, { passive: true });
      tr.addEventListener('touchend', () => clearTimeout(touchTimer));
      tr.addEventListener('touchmove', () => clearTimeout(touchTimer));
      tr.addEventListener('click', e => {
        if (touchHandled) { touchHandled = false; return; }
        if (item.type === 'dir') {
          navigate(joinPath(currentPath, item.name));
        } else if (!selectMode) {
          if (selectedNames.has(item.name)) {
            selectedNames.delete(item.name);
          } else {
            selectedNames.clear();
            selectedNames.add(item.name);
          }
          lastClickedIndex = currentItems.indexOf(item);
          document.querySelectorAll('#file-list tr[data-name]').forEach(r => {
            r.classList.toggle('selected', selectedNames.has(r.dataset.name));
          });
        }
      });
    } else {
      tr.addEventListener('click', (e) => {
        if (e.ctrlKey || e.metaKey) {
          if (!selectMode) enterSelectMode();
          if (selectedNames.has(item.name)) selectedNames.delete(item.name);
          else selectedNames.add(item.name);
          updateCheckboxes();
          return;
        }
        if (selectMode && item.type !== 'dir') return;
        const idx = currentItems.indexOf(item);
        if (e.shiftKey && lastClickedIndex !== null) {
          const start = Math.min(lastClickedIndex, idx);
          const end = Math.max(lastClickedIndex, idx);
          for (let i = start; i <= end; i++) selectedNames.add(currentItems[i].name);
        } else {
          selectedNames.clear();
          selectedNames.add(item.name);
          lastClickedIndex = idx;
        }
        document.querySelectorAll('#file-list tr[data-name]').forEach(r => {
          r.classList.toggle('selected', selectedNames.has(r.dataset.name));
        });
      });

      tr.addEventListener('dblclick', () => {
        if (item.type === 'dir') navigate(joinPath(currentPath, item.name));
      });

      tr.addEventListener('contextmenu', e => {
        if (!selectedNames.has(item.name)) {
          selectedNames.clear();
          selectedNames.add(item.name);
          updateCheckboxes();
        }
        e.preventDefault();
        e.stopPropagation();
        showCtx(e, item);
      });
    }

    tbody.appendChild(tr);
  }
  const table = tbody.closest('table');
  if (table) table.classList.toggle('select-mode', selectMode);
}

function renderBreadcrumb(path) {
  const el = $('breadcrumb');
  el.innerHTML = '';

  const parts = path.replace(/\/+/g, '/').split('/').filter(Boolean);

  const root = document.createElement('span');
  root.className = 'cursor-pointer';
  root.innerHTML = '<i class="fas fa-home"></i>';
  root.addEventListener('click', () => navigate('/'));
  el.appendChild(root);

  let acc = '';
  for (const p of parts) {
    const sep = document.createElement('span');
    sep.className = 'sep';
    sep.textContent = '/';
    el.appendChild(sep);

    const span = document.createElement('span');
    span.className = 'cursor-pointer';
    span.textContent = p;
    acc += '/' + p;
    const pathHere = acc;
    span.addEventListener('click', () => navigate(pathHere));
    el.appendChild(span);
  }
}

/* ───── navigation ───── */
function navigate(path) {
  send('list', { path });
}

function navigateUp() {
  if (currentPath === '/') return;
  const parent = currentPath.replace(/\/+$/, '').split('/').slice(0, -1).join('/') || '/';
  navigate(parent);
}

function refresh() {
  navigate(currentPath);
}

/* ───── operation status bar ───── */
let opTimer = null;
let _pasteQueue = null;
let currentOpVerb = '';

function showOpBar(html) {
  $('op-bar-content').innerHTML = html;
  $('op-bar').classList.remove('op-bar-hidden');
  clearTimeout(opTimer);
}

function hideOpBar() {
  $('op-bar').classList.add('op-bar-hidden');
  clearTimeout(opTimer);
}

function showOpProgress(name, current, total) {
  const pct = total > 0 ? Math.round(current / total * 100) : 0;
  showOpBar('<i class="fas fa-spinner op-spinner"></i> <span>' + currentOpVerb + ' - ' + esc(name) + '</span> <span class="op-progress-bar"><span class="op-progress-bar-fill" style="width:' + pct + '%"></span></span> <span>' + pct + '%</span>');
}

function cancelCurrentOp() {
  send('cancel');
  uploading = false;
  uploadQueue = [];
  uploadFile = null;
  _pasteQueue = null;
  currentOpVerb = '';
  hideOpBar();
  refresh();
}

function pasteNext() {
  if (!_pasteQueue || _pasteQueue.paths.length === 0) {
    _pasteQueue = null;
    return;
  }
  const src = _pasteQueue.paths.shift();
  const itemName = src.split('/').filter(Boolean).pop();
  const verb = _pasteQueue.act === 'move' ? __('moving') : __('copying');
  currentOpVerb = verb;
  showOpBar(`<i class="fas fa-${_pasteQueue.act === 'move' ? 'cut' : 'copy'}"></i> ${verb} - ${esc(itemName)}\u2026`);
  if (_pasteQueue.act === 'move') lastMoveSource = src;
  send(_pasteQueue.act, { source: src, dest: _pasteQueue.dest });
}


/* ───── theme ───── */
let themeMedia = null;

function applyTheme(mode) {
  const html = document.documentElement;

  if (mode === 'dark') {
    html.dataset.theme = 'dark';
  } else if (mode === 'light') {
    delete html.dataset.theme;
  } else {
    if (themeMedia && themeMedia.matches) {
      html.dataset.theme = 'dark';
    } else {
      delete html.dataset.theme;
    }
  }

  const authThemeSel = $('auth-btn-theme');
  if (authThemeSel) authThemeSel.value = mode;
  const themeSel = $('menu-theme');
  if (themeSel) themeSel.value = mode;
}

function onSystemChange() {
  const mode = sessionStorage.getItem('themeMode') || 'auto';
  if (mode === 'auto') applyTheme('auto');
}

function startThemeListener() {
  themeMedia = window.matchMedia('(prefers-color-scheme: dark)');
  themeMedia.addEventListener('change', onSystemChange);
}

function initTheme() {
  startThemeListener();
  const saved = sessionStorage.getItem('themeMode') || 'auto';
  applyTheme(saved);
}

/* ───── language ───── */
function applyLanguage() {
  const lang = getLang();
  document.documentElement.lang = lang;

  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.dataset.i18n;
    let found = false;
    el.childNodes.forEach(node => {
      if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
        if (!found) {
          node.textContent = __(key);
          found = true;
        } else {
          node.textContent = '';
        }
      }
    });
    if (!found && !el.querySelector('*')) {
      el.textContent = __(key);
    }
  });

  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    el.placeholder = __(el.dataset.i18nPlaceholder);
  });

  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    el.title = __(el.dataset.i18nTitle);
  });

  const codes = getAvailableLangs();
  document.querySelectorAll('.lang-select').forEach(sel => {
    const current = sel.value;
    sel.innerHTML = codes.map(c =>
      `<option value="${c}"${c === lang ? ' selected' : ''}>${getLangDisplayName(c)}</option>`
    ).join('');
  });
}

async function initLanguage() {
  await _loadI18n();
  const saved = detectLang();
  setLang(saved);
  applyLanguage();
}

/* ───── upload (chunked) ───── */
const CHUNK_SIZE = 10 * 1024 * 1024;
let uploadQueue = [];
let uploading = false;
let uploadFile = null;
let uploadPath = '';
let uploadOffset = 0;

function uploadFiles(files) {
  for (const f of files) uploadQueue.push(f);
  if (!uploading) uploadNext();
}

function uploadNext() {
  console.log('[uploadNext] called, queue:', uploadQueue.length, 'file:', uploadQueue[0]?.name, 'currentItems len:', currentItems.length, 'first items:', currentItems.slice(0,5).map(i=>i.name));
  if (uploadQueue.length === 0) {
    uploading = false;
    return;
  }
  uploading = true;
  uploadFile = uploadQueue.shift();
  uploadPath = joinPath(currentPath, uploadFile.name);
  uploadOffset = 0;
  currentOpVerb = __('uploading');
  showOpProgress(uploadFile.name, 0, uploadFile.size);
  const exists = currentItems.some(i => i.name === uploadFile.name && i.type === 'file');
  console.log('[uploadNext] exists:', exists, 'uploadFile.name:', uploadFile.name);
  if (exists) {
    if (!confirm(__('overwrite', uploadFile.name))) {
      uploading = false;
      uploadNext();
      return;
    }
    send('upload_start', { path: uploadPath, size: uploadFile.size, confirm_overwrite: true });
    return;
  }
  send('upload_start', { path: uploadPath, size: uploadFile.size });
  console.log('[uploadNext] sending upload_start without confirm_overwrite');
}

function sendNextChunk() {
  if (!uploadFile) {
    uploading = false;
    uploadNext();
    return;
  }
  const remaining = uploadFile.size - uploadOffset;
  if (remaining <= 0) {
    send('upload_end');
    return;
  }
  const size = Math.min(CHUNK_SIZE, remaining);
  const blob = uploadFile.slice(uploadOffset, uploadOffset + size);
  const reader = new FileReader();
  reader.onload = function (e) {
    const b64 = e.target.result.split(',')[1];
    uploadOffset += size;
    showOpProgress(uploadFile.name, uploadOffset, uploadFile.size);
    send('upload_chunk', { data: b64 });
  };
  reader.readAsDataURL(blob);
}

function showDropOverlay(show) {
  const el = $('drop-overlay');
  el.classList.toggle('hidden', !show);
}

/* ───── select mode ───── */
function enterSelectMode() {
  selectMode = true;
  const table = $('file-list').closest('table');
  if (table) table.classList.add('select-mode');
  $('btn-done').classList.remove('hidden');
  updateCheckboxes();
}

function exitSelectMode() {
  selectMode = false;
  const table = $('file-list').closest('table');
  if (table) table.classList.remove('select-mode');
  $('btn-done').classList.add('hidden');
  selectedNames.clear();
  updateCheckboxes();
}

function updateCheckboxes() {
  document.querySelectorAll('#file-list tr[data-name]').forEach(tr => {
    const cb = tr.querySelector('.cb-select');
    if (cb) cb.checked = selectedNames.has(tr.dataset.name);
    tr.classList.toggle('selected', selectedNames.has(tr.dataset.name));
  });
}

/* ───── context menu ───── */
const MENU_ITEMS = [
  { action: 'mkdir',  icon: 'fa-folder-plus', i18n: 'new_folder' },
];

const MENU_ITEMS_FILE = [
  null,
  { action: 'copy',   icon: 'fa-copy',        i18n: 'copy' },
  { action: 'cut',    icon: 'fa-cut',         i18n: 'cut' },
  null,
  { action: 'delete', icon: 'fa-trash-alt',   i18n: 'delete' },
  null,
  { action: 'download', icon: 'fa-download',  i18n: 'download' },
  null,
  { action: 'rename', icon: 'fa-pen', i18n: 'rename' },
  null,
  { action: 'properties', icon: 'fa-info-circle', i18n: 'properties' },
];

const MENU_CLIPBOARD = [
  null,
  { action: 'paste',  icon: 'fa-paste',       i18n: 'paste' },
];

const MENU_ITEMS_SELECT = [
  null,
  { action: 'select', icon: 'fa-check-square', i18n: 'select' },
];

function showCtx(e, item) {
  ctxItem = item;
  const menu = $('ctx-menu');

  const list = [...MENU_ITEMS];

  if (item) list.push(...MENU_ITEMS_FILE);

  if (item) list.push(...MENU_ITEMS_SELECT);
  list.push({ action: 'select_all', icon: 'fa-check-double', i18n: 'select_all' });

  if (clipboard) {
    const pasteItem = {
      action: 'paste',
      icon: 'fa-paste',
      i18n: clipboard.cut ? 'paste_move' : 'paste',
    };
    list.push(...MENU_CLIPBOARD.slice(0, 1), pasteItem);
  }

  menu.innerHTML = list.map(i => {
    if (i === null) return '<li class="sep"></li>';
    return `<li data-action="${i.action}"><i class="fas ${i.icon}"></i> ${__(i.i18n)}</li>`;
  }).join('');

  menu.querySelectorAll('li[data-action]').forEach(li => {
    li.addEventListener('click', () => {
      ctxAction(li.dataset.action);
      hideCtx();
    });
  });

  const rect = menu.getBoundingClientRect();
  const mw = rect.width || 200;
  const mh = rect.height || list.length * 30;
  let x = e.clientX;
  let y = e.clientY;
  if (x + mw > window.innerWidth) x = window.innerWidth - mw - 8;
  if (y + mh > window.innerHeight) y = window.innerHeight - mh - 8;
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  menu.classList.remove('hidden');
}

function hideCtx() {
  $('ctx-menu').classList.add('hidden');
  ctxItem = null;
}

function ctxAction(action) {
  switch (action) {
    case 'mkdir': {
      const name = prompt(__('new_folder_name'));
      if (!name) return;
      send('mkdir', { path: joinPath(currentPath, name) });
      break;
    }

    case 'select':
      if (!ctxItem) break;
      enterSelectMode();
      selectedNames.clear();
      selectedNames.add(ctxItem.name);
      updateCheckboxes();
      break;

    case 'select_all':
      enterSelectMode();
      selectedNames = new Set(currentItems.map(i => i.name));
      updateCheckboxes();
      break;

    case 'copy':
      if (!ctxItem) break;
      clipboard = { paths: [...selectedNames].map(n => joinPath(currentPath, n)), cut: false };
      exitSelectMode();
      break;

    case 'cut':
      if (!ctxItem) break;
      clipboard = { paths: [...selectedNames].map(n => joinPath(currentPath, n)), cut: true };
      exitSelectMode();
      break;

    case 'paste':
      if (!clipboard) break;
      _pasteQueue = {
        paths: [...clipboard.paths],
        act: clipboard.cut ? 'move' : 'copy',
        dest: ctxItem && ctxItem.type === 'dir'
          ? joinPath(currentPath, ctxItem.name)
          : currentPath,
      };
      clipboard = null;
      pasteNext();
      break;

    case 'delete': {
      if (!ctxItem && selectedNames.size === 0) break;
      const targets = selectedNames.size > 0 ? [...selectedNames] : [ctxItem.name];
      if (!confirm(__('delete_confirm', targets.length))) break;
      for (const name of targets) {
        const type = currentItems.find(i => i.name === name)?.type || 'file';
        send(type === 'dir' ? 'rmdir' : 'delete', {
          path: joinPath(currentPath, name),
        });
      }
      selectedNames.clear();
      exitSelectMode();
      break;
    }

    case 'download':
      if (!ctxItem) break;
      if (selectedNames.size > 1 || ctxItem.type === 'dir') {
        showOpBar(`<i class="fas fa-download"></i> ${__('preparing_archive')}`);
        send('download_zip_request', { paths: [...selectedNames].map(n => joinPath(currentPath, n)) });
      } else {
        send('download_request', { path: joinPath(currentPath, ctxItem.name) });
      }
      selectedNames.clear();
      exitSelectMode();
      break;

    case 'rename':
      if (!ctxItem) break;
      if (selectedNames.size !== 1) break;
      const item = currentItems.find(i => i.name === [...selectedNames][0]);
      if (!item) break;
      const newName = prompt(__('rename', item.name), item.name);
      if (!newName || newName === item.name) break;
      send('rename', { source: joinPath(currentPath, item.name), dest: joinPath(currentPath, newName) });
      break;

    case 'properties':
      if (!ctxItem) break;
      send('properties', { path: joinPath(currentPath, ctxItem.name) });
      break;
  }
}

/* ───── properties modal ───── */
function showProperties(props) {
  const icon = props.type === 'dir'
    ? '<i class="fas fa-folder"></i>'
    : '<i class="far fa-file"></i>';
  const typeLabel = props.type === 'dir' ? __('folder') : __('file');
  $('props-body').innerHTML =
    `<p>${icon} <strong>${__('name_label')}</strong> ${esc(props.name)}</p>` +
    `<p><i class="fas fa-tag"></i> <strong>${__('type_label')}</strong> ${esc(typeLabel)}</p>` +
    `<p><i class="fas fa-weight-hanging"></i> <strong>${__('size_label')}</strong> ${props.type === 'dir' ? '—' : fmtSize(props.size)}</p>` +
    `<p><i class="far fa-calendar-alt"></i> <strong>${__('date_label')}</strong> ${esc(fmtDate(props.date))}</p>`;
  $('props-overlay').classList.remove('hidden');
}

/* ───── config ───── */
async function loadConfig() {
  try {
    const resp = await fetch('/api/config');
    const cfg = await resp.json();
    if (cfg.host) {
      $('host').value = cfg.host;
      $('port').value = cfg.port || 21;
      if (cfg.passive !== null) {
        $('passive').checked = !!cfg.passive;
      }
      $('config-group').classList.add('config-hidden');
    }
    document.title = cfg.title || 'FFM - Fast File Manager';
    $('auth-title').textContent = cfg.title || 'FFM - Fast File Manager';
  } catch (_) {
    // no config — keep fields visible
  }
}

/* ───── keyboard shortcuts ───── */
function isEditable(el) {
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}

/* ───── init ───── */
document.addEventListener('DOMContentLoaded', async () => {
  initTheme();
  await initLanguage();
  loadConfig();
  connect();

  /* sort clicks */
  document.querySelectorAll('.sort-col').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      const { col: curCol, dir: curDir } = getSort();
      let newDir = 'asc';
      if (col === curCol) newDir = curDir === 'asc' ? 'desc' : 'asc';
      saveSort(col, newDir);
      renderListing();
    });
  });

  $('auth-form').addEventListener('submit', e => {
    e.preventDefault();
    $('auth-error').classList.add('hidden');
    send('auth', {
      host: $('host').value,
      port: parseInt($('port').value, 10) || 21,
      user: $('username').value,
      pass: $('password').value,
      passive: $('passive').checked,
    });
  });

  $('btn-refresh').addEventListener('click', refresh);
  $('btn-done').addEventListener('click', exitSelectMode);
  if ($('btn-mkdir')) $('btn-mkdir').addEventListener('click', () => {
    const name = prompt(__('new_folder_name'));
    if (!name) return;
    send('mkdir', { path: joinPath(currentPath, name) });
  });
  if ($('auth-btn-theme')) $('auth-btn-theme').addEventListener('change', function () {
    sessionStorage.setItem('themeMode', this.value);
    applyTheme(this.value);
  });
  document.querySelectorAll('.lang-select').forEach(sel => {
    sel.addEventListener('change', function () {
      setLang(this.value);
      applyLanguage();
    });
  });

  /* hamburger menu */
  $('btn-menu').addEventListener('click', e => {
    e.stopPropagation();
    $('menu-dropdown').classList.toggle('hidden');
  });

  $('menu-theme').addEventListener('change', function () {
    sessionStorage.setItem('themeMode', this.value);
    applyTheme(this.value);
  });

  $('menu-lang').addEventListener('change', function () {
    setLang(this.value);
    applyLanguage();
  });

  $('menu-logout').addEventListener('click', () => {
    clearAuthSession();
    clipboard = null;
    $('main').classList.add('hidden');
    $('auth-overlay').classList.remove('hidden');
    $('menu-dropdown').classList.add('hidden');
  });

  $('menu-version').textContent = 'v. ' + APP_VERSION;
  const authVer = $('auth-version');
  if (authVer) authVer.textContent = 'v. ' + APP_VERSION;

  document.addEventListener('click', e => {
    const dd = $('menu-dropdown');
    if (dd.classList.contains('hidden')) return;
    if (e.target.closest('#menu-dropdown, #btn-menu')) return;
    dd.classList.add('hidden');
  });

  /* keyboard shortcuts */
  document.addEventListener('keydown', e => {
    if (isEditable(e.target)) return;
    if ($('main').classList.contains('hidden')) return;

    if (e.key === 'F2') {
      e.preventDefault();
      if (selectedNames.size !== 1) return;
      const item = currentItems.find(i => i.name === [...selectedNames][0]);
      if (!item) return;
      const newName = prompt(__('rename', item.name), item.name);
      if (!newName || newName === item.name) return;
      send('rename', { source: joinPath(currentPath, item.name), dest: joinPath(currentPath, newName) });
      return;
    }

    if (e.key === 'Delete') {
      e.preventDefault();
      if (selectedNames.size === 0) return;
      const targets = [...selectedNames];
      if (!confirm(__('delete_confirm', targets.length))) return;
      for (const name of targets) {
        const item = currentItems.find(i => i.name === name);
        if (!item) continue;
        send(item.type === 'dir' ? 'rmdir' : 'delete', {
          path: joinPath(currentPath, name),
        });
      }
      selectedNames.clear();
      exitSelectMode();
      return;
    }

    if (e.key === 'Backspace') {
      e.preventDefault();
      navigateUp();
      return;
    }

    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();

    if (k === 'a') {
      e.preventDefault();
      if (currentItems.length === 0) return;
      enterSelectMode();
      selectedNames = new Set(currentItems.map(i => i.name));
      updateCheckboxes();
    } else if (k === 'c') {
      if (selectedNames.size === 0) return;
      e.preventDefault();
      clipboard = { paths: [...selectedNames].map(n => joinPath(currentPath, n)), cut: false };
      exitSelectMode();
    } else if (k === 'x') {
      if (selectedNames.size === 0) return;
      e.preventDefault();
      clipboard = { paths: [...selectedNames].map(n => joinPath(currentPath, n)), cut: true };
      exitSelectMode();
    } else if (k === 'v') {
      if (!clipboard) return;
      e.preventDefault();
      _pasteQueue = {
        paths: [...clipboard.paths],
        act: clipboard.cut ? 'move' : 'copy',
        dest: currentPath,
      };
      clipboard = null;
      pasteNext();
    }
  });

  /* upload */
  $('btn-upload-fab').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', () => {
    uploadFiles($('file-input').files);
    $('file-input').value = '';
  });

  const wrap = $('table-wrap');
  wrap.addEventListener('dragover', e => { e.preventDefault(); showDropOverlay(true); });
  wrap.addEventListener('dragleave', () => showDropOverlay(false));
  wrap.addEventListener('drop', e => {
    e.preventDefault();
    showDropOverlay(false);
    if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
  });

  $('op-cancel').addEventListener('click', cancelCurrentOp);

  $('props-close').addEventListener('click', () => {
    $('props-overlay').classList.add('hidden');
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('#ctx-menu')) hideCtx();
  });

  document.addEventListener('contextmenu', e => {
    e.preventDefault();
    if (isTouchDevice) return;
    const row = e.target.closest('tbody tr');
    if (row) return;
    if (e.target.closest('#ctx-menu')) return;
    showCtx(e, null);
  });

  /* empty-space long-press on mobile */
  if (isTouchDevice) {
    let wrapTimer;
    const wrap = $('table-wrap');
    wrap.addEventListener('touchstart', e => {
      if (e.target.closest('tr')) return;
      clearTimeout(wrapTimer);
      wrapTimer = setTimeout(() => {
        showCtx({ clientX: e.touches[0].clientX, clientY: e.touches[0].clientY }, null);
      }, 500);
    }, { passive: true });
    wrap.addEventListener('touchend', () => clearTimeout(wrapTimer));
    wrap.addEventListener('touchmove', () => clearTimeout(wrapTimer));
  }
});


