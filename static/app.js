const APP_VERSION = '0.68.0'; // do not auto increment!
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
let basePath = '/';
let folderTree = new Map();
let lastAuth = null;

const $ = id => document.getElementById(id);
function esc(s) { return String(s).replace(/[&<>"']/g, function(m) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]; }); }

/* ───── WebSocket ───── */
function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws`);

  ws.onopen = () => {
    $('splash').classList.add('hidden');
    const token = getCookie('ffm_auth');
    const saved = getCookie('authHost');
    if (token) {
      lastAuth = { token };
      send('auth', lastAuth);
    } else if (saved) {
      lastAuth = {
        host: saved,
        port: parseInt(getCookie('authPort'), 10) || 21,
        user: getCookie('authUser') || '',
        pass: getCookie('authPass') || '',
        passive: getCookie('authPassive') !== 'false',
      };
      send('auth', lastAuth);
    } else {
      $('auth-overlay').classList.remove('hidden');
    }
    pingInterval = setInterval(() => send('ping'), 30000);
  };

  ws.onclose = () => {
    $('splash').classList.add('hidden');
    $('main').classList.add('hidden');
    $('auth-overlay').classList.remove('hidden');
    $('auth-error').textContent = __('connection_lost');
    $('auth-error').classList.remove('hidden');
    for (const [p, e] of checksumCache) {
      if (e && e.pending) checksumCache.set(p, {});
    }
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
      basePath = msg.cwd;
      initFolderTree();
      $('auth-overlay').classList.add('hidden');
      $('auth-error').classList.add('hidden');
      $('main').classList.remove('hidden');
      applySidebarWidth();
      syncSidebarResizer();
      renderBreadcrumb(msg.cwd);
      renderListing();
      // save encrypted session token for F5 persistence
      if (lastAuth && msg.token) {
        saveAuthToken(msg.token);
      }
      break;

    case 'auth_error':
      $('splash').classList.add('hidden');
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
      revealInTree(msg.path);
      break;

    case 'list_items_ok':
      {
        const node = folderTree.get(msg.path);
        if (node) {
          node.loaded = true;
          node.loading = false;
          node.items = msg.items;
          sortSidebarItems(node.items);
          renderSidebar();
        }
      }
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
      refreshFolderTree();
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

    case 'checksum_ok':
      checksumCache.set(msg.path, { algo: msg.algo, hash: msg.hash });
      pendingChecksumPath = null;
      if (currentPropsPath === msg.path) {
        const row = $('props-checksum-row');
        if (row) row.outerHTML = renderChecksumRow(msg.path);
      }
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
      if (msg.code === 'checksum_failed' && msg.path) {
        const entry = checksumCache.get(msg.path);
        if (entry && entry.pending) {
          checksumCache.set(msg.path, {});
          if (currentPropsPath === msg.path) {
            const row = $('props-checksum-row');
            if (row) row.outerHTML = renderChecksumRow(msg.path);
          }
        }
      }
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

function saveAuthToken(token) {
  setCookie('ffm_auth', token);
  ['authHost', 'authPort', 'authUser', 'authPass', 'authPassive']
    .forEach(k => removeCookie(k));
}

function clearAuthSession() {
  ['ffm_auth', 'authHost', 'authPort', 'authUser', 'authPass', 'authPassive']
    .forEach(k => removeCookie(k));
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
  let col = getCookie('sortCol');
  let dir = getCookie('sortDir');
  return {
    col: col || 'name',
    dir: dir === 'desc' ? 'desc' : 'asc',
  };
}

function saveSort(col, dir) {
  setCookie('sortCol', col);
  setCookie('sortDir', dir);
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

  const empty = $('empty-root');
  const table = $('file-list').closest('table');
  if (currentPath === basePath) {
    table.classList.add('hidden');
    if (empty) empty.classList.remove('hidden');
    return;
  }
  table.classList.remove('hidden');
  if (empty) empty.classList.add('hidden');

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
  const listTable = tbody.closest('table');
  if (listTable) listTable.classList.toggle('select-mode', selectMode);
}

function renderBreadcrumb(path) {
  const el = $('breadcrumb');
  el.innerHTML = '';

  const parts = path.replace(/\/+/g, '/').split('/').filter(Boolean);

  const root = document.createElement('span');
  root.className = 'cursor-pointer';
  root.innerHTML = '<i class="fas fa-home"></i>';
  root.addEventListener('click', () => {
    navigate('/');
    collapseFolderTree();
  });
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
  if (currentPath === basePath || currentPath === '/') return;
  const parent = currentPath.replace(/\/+$/, '').split('/').slice(0, -1).join('/') || '/';
  navigate(parent);
}

function refresh() {
  navigate(currentPath);
}

/* ───── folder sidebar tree ───── */
function treeKey(path) {
  return path.replace(/\/+$/, '') || '/';
}

function initFolderTree() {
  folderTree.clear();
  const key = treeKey(basePath);
  folderTree.set(key, { loaded: false, loading: false, expanded: true, items: [] });
  requestDir(key);
}

function requestDir(path) {
  const node = folderTree.get(treeKey(path));
  if (!node || node.loading || node.loaded) return;
  node.loading = true;
  renderSidebar();
  send('list_items', { path });
}

function sortSidebarItems(items) {
  items.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function renderSidebar() {
  const el = $('folder-tree');
  el.innerHTML = '';
  const key = treeKey(basePath);
  const node = folderTree.get(key);
  if (node) renderTreeNode(el, key, node, 0);
}

function pathName(path) {
  const k = treeKey(path);
  return k.split('/').filter(Boolean).pop() || '';
}

function parentDir(path) {
  const k = treeKey(path);
  const idx = k.lastIndexOf('/');
  return idx <= 0 ? '/' : k.slice(0, idx);
}

function sidebarCtxHandlers(row, item, ctxBase) {
  if (isTouchDevice) {
    let timer;
    row.addEventListener('touchstart', e => {
      const touch = e.touches[0];
      timer = setTimeout(() => {
        row._ctxHandled = true;
        showCtx({ clientX: touch.clientX, clientY: touch.clientY }, item, ctxBase);
      }, 500);
    }, { passive: true });
    row.addEventListener('touchend', () => clearTimeout(timer));
    row.addEventListener('touchmove', () => clearTimeout(timer));
  } else {
    row.addEventListener('contextmenu', e => {
      e.preventDefault();
      e.stopPropagation();
      showCtx(e, item, ctxBase);
    });
  }
}

function renderTreeNode(parent, path, node, depth) {
  const row = document.createElement('div');
  row.className = 'tree-node' + (path === treeKey(currentPath) ? ' active' : '') + (node.expanded ? ' expanded' : '');
  row.style.paddingLeft = (8 + depth * 16) + 'px';
  row.dataset.path = path;

  const chevron = document.createElement('span');
  chevron.className = 'tree-chevron';
  if (node.loading) {
    chevron.className = 'tree-spinner';
    chevron.innerHTML = '<i class="fas fa-spinner"></i>';
  } else if (node.expanded && node.loaded && node.items.length === 0) {
    chevron.className = 'tree-chevron leaf';
  } else {
    chevron.innerHTML = '<i class="fas fa-chevron-right"></i>';
  }
  row.appendChild(chevron);

  const icon = document.createElement('span');
  icon.className = 'tree-icon';
  icon.innerHTML = '<i class="fas fa-folder"></i>';
  row.appendChild(icon);

  const label = document.createElement('span');
  label.className = 'tree-label';
  label.textContent = pathName(path) || '/';
  row.appendChild(label);

  row.addEventListener('click', e => {
    if (row._ctxHandled) { row._ctxHandled = false; return; }
    if (e.target.closest('.tree-chevron') || e.target.closest('.tree-spinner')) {
      if (!node.loading) {
        node.expanded = !node.expanded;
        if (node.expanded) requestDir(path);
        renderSidebar();
      }
      return;
    }
    navigate(path);
    const n = folderTree.get(treeKey(path));
    if (n) {
      n.expanded = true;
      requestDir(path);
    }
    closeSidebar();
  });

  parent.appendChild(row);

  const isRoot = path === treeKey(basePath);
  const ctxItemForRow = isRoot ? null : { name: pathName(path) || '/', type: 'dir', path };
  sidebarCtxHandlers(row, ctxItemForRow, isRoot ? path : parentDir(path));

  if (node.expanded) {
    if (!node.loaded) {
      const ph = document.createElement('div');
      ph.className = 'tree-empty';
      ph.textContent = '…';
      ph.style.paddingLeft = (24 + depth * 16) + 'px';
      parent.appendChild(ph);
    } else {
      for (const item of node.items) {
        const childPath = joinPath(path, item.name);
        if (item.type === 'dir') {
          let child = folderTree.get(treeKey(childPath));
          if (!child) {
            child = { loaded: false, loading: false, expanded: false, items: [] };
            folderTree.set(treeKey(childPath), child);
          }
          renderTreeNode(parent, childPath, child, depth + 1);
        } else {
          renderFileRow(parent, childPath, item, depth);
        }
      }
    }
  }
}

function renderFileRow(parent, path, item, depth) {
  const row = document.createElement('div');
  row.className = 'tree-node';
  row.style.paddingLeft = (8 + depth * 16) + 'px';
  row.dataset.path = path;

  const chevron = document.createElement('span');
  chevron.className = 'tree-chevron leaf';
  row.appendChild(chevron);

  const icon = document.createElement('span');
  icon.className = 'tree-icon';
  icon.style.color = '#6b7280';
  icon.innerHTML = '<i class="far fa-file"></i>';
  row.appendChild(icon);

  const label = document.createElement('span');
  label.className = 'tree-label';
  label.textContent = item.name;
  row.appendChild(label);

  row.addEventListener('click', e => {
    if (row._ctxHandled) { row._ctxHandled = false; return; }
  });
  sidebarCtxHandlers(row, item, parentDir(path));
  parent.appendChild(row);
}

function revealInTree(path) {
  const base = treeKey(basePath);
  const target = treeKey(path);
  const prefix = base === '/' ? '' : base + '/';
  const rel = target === base ? '' : target.startsWith(prefix) ? target.slice(prefix.length) : '';
  let cur = base;
  for (const seg of rel.split('/').filter(Boolean)) {
    cur = joinPath(cur, seg);
    const key = treeKey(cur);
    let node = folderTree.get(key);
    if (!node) {
      node = { loaded: false, loading: false, expanded: false, items: [] };
      folderTree.set(key, node);
    }
    node.expanded = true;
    requestDir(cur);
  }
  requestDir(base);
  renderSidebar();
}

function refreshFolderTree() {
  const keys = [...folderTree.keys()].filter(k => {
    const n = folderTree.get(k);
    return n && n.expanded && n.loaded && !n.loading;
  });
  if (keys.length === 0) return;
  keys.forEach(k => {
    const n = folderTree.get(k);
    n.loaded = false;
    n.loading = true;
    send('list_items', { path: k });
  });
  renderSidebar();
}

function collapseFolderTree() {
  folderTree.clear();
  const key = treeKey(basePath);
  folderTree.set(key, { loaded: false, loading: false, expanded: true, items: [] });
  requestDir(key);
}

function openSidebar() {
  $('folder-sidebar').classList.add('open');
  $('sidebar-backdrop').classList.remove('hidden');
}

function closeSidebar() {
  $('folder-sidebar').classList.remove('open');
  $('sidebar-backdrop').classList.add('hidden');
}

function toggleSidebar() {
  if ($('folder-sidebar').classList.contains('open')) closeSidebar();
  else openSidebar();
}

/* ───── sidebar resize ───── */
function syncSidebarResizer() {
  const sb = $('folder-sidebar');
  const rz = $('sidebar-resizer');
  if (!sb || !rz) return;
  rz.style.left = (sb.offsetWidth - 3) + 'px';
}

function applySidebarWidth() {
  const saved = getCookie('sidebarWidth');
  const sb = $('folder-sidebar');
  if (sb && saved) sb.style.width = saved + 'px';
  syncSidebarResizer();
}

function initSidebarResize() {
  const sb = $('folder-sidebar');
  const rz = $('sidebar-resizer');
  if (!sb || !rz) return;

  rz.addEventListener('mousedown', e => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sb.offsetWidth;
    const MIN = 160, MAX = 400;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    const onMove = ev => {
      const w = Math.min(MAX, Math.max(MIN, startW + (ev.clientX - startX)));
      sb.style.width = w + 'px';
      syncSidebarResizer();
    };
    const onUp = () => {
      setCookie('sidebarWidth', sb.offsetWidth);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

/* ───── operation status bar ───── */
let opTimer = null;
let _pasteQueue = null;
let currentOpVerb = '';
const checksumCache = new Map();
let currentPropsPath = null;

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
  const mode = getCookie('themeMode') || 'auto';
  if (mode === 'auto') applyTheme('auto');
}

function startThemeListener() {
  themeMedia = window.matchMedia('(prefers-color-scheme: dark)');
  themeMedia.addEventListener('change', onSystemChange);
}

function initTheme() {
  startThemeListener();
  const saved = getCookie('themeMode') || 'auto';
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

let ctxBasePath = null;

function showCtx(e, item, sidePath) {
  ctxItem = item;
  ctxBasePath = sidePath || currentPath;
  const menu = $('ctx-menu');

  const list = [...MENU_ITEMS];

  if (item) list.push(...MENU_ITEMS_FILE);

  if (item && !sidePath) list.push(...MENU_ITEMS_SELECT);
  if (!sidePath) list.push({ action: 'select_all', icon: 'fa-check-double', i18n: 'select_all' });

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
  ctxBasePath = null;
}

function ctxAction(action) {
  const base = ctxBasePath || currentPath;
  switch (action) {
    case 'mkdir': {
      const name = prompt(__('new_folder_name'));
      if (!name) return;
      send('mkdir', { path: joinPath(base, name) });
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
    case 'cut': {
      if (!ctxItem) break;
      let paths;
      if (selectedNames.size > 0) {
        paths = [...selectedNames].map(n => joinPath(base, n));
      } else {
        paths = [joinPath(base, ctxItem.name)];
      }
      clipboard = { paths, cut: action === 'cut' };
      exitSelectMode();
      break;
    }

    case 'paste':
      if (!clipboard) break;
      _pasteQueue = {
        paths: [...clipboard.paths],
        act: clipboard.cut ? 'move' : 'copy',
        dest: ctxItem && ctxItem.type === 'dir'
          ? joinPath(base, ctxItem.name)
          : base,
      };
      clipboard = null;
      pasteNext();
      break;

    case 'delete': {
      if (!ctxItem && selectedNames.size === 0) break;
      const targets = selectedNames.size > 0 ? [...selectedNames] : [ctxItem.name];
      if (!confirm(__('delete_confirm', targets.length))) break;
      for (const name of targets) {
        const type = selectedNames.size > 0
          ? (currentItems.find(i => i.name === name)?.type || 'file')
          : (ctxItem.type || 'file');
        send(type === 'dir' ? 'rmdir' : 'delete', {
          path: joinPath(base, name),
        });
      }
      selectedNames.clear();
      exitSelectMode();
      break;
    }

    case 'download':
      if (!ctxItem) break;
      if (selectedNames.size > 0) {
        if (selectedNames.size > 1 || ctxItem.type === 'dir') {
          showOpBar(`<i class="fas fa-download"></i> ${__('preparing_archive')}`);
          send('download_zip_request', { paths: [...selectedNames].map(n => joinPath(base, n)) });
        } else {
          send('download_request', { path: joinPath(base, [...selectedNames][0]) });
        }
      } else if (ctxItem.type === 'dir') {
        showOpBar(`<i class="fas fa-download"></i> ${__('preparing_archive')}`);
        send('download_zip_request', { paths: [joinPath(base, ctxItem.name)] });
      } else {
        send('download_request', { path: joinPath(base, ctxItem.name) });
      }
      selectedNames.clear();
      exitSelectMode();
      break;

    case 'rename':
      if (!ctxItem) break;
      if (selectedNames.size > 0 && selectedNames.size !== 1) break;
      if (selectedNames.size === 1) {
        const selItem = currentItems.find(i => i.name === [...selectedNames][0]);
        if (!selItem) break;
        const newName = prompt(__('rename', selItem.name), selItem.name);
        if (!newName || newName === selItem.name) break;
        send('rename', { source: joinPath(base, selItem.name), dest: joinPath(base, newName) });
      } else {
        const newName = prompt(__('rename', ctxItem.name), ctxItem.name);
        if (!newName || newName === ctxItem.name) break;
        send('rename', { source: joinPath(base, ctxItem.name), dest: joinPath(base, newName) });
      }
      break;

    case 'properties':
      if (!ctxItem) break;
      send('properties', { path: joinPath(base, ctxItem.name) });
      break;
  }
}

/* ───── properties modal ───── */
function copyToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text).then(() => true).catch(() => fallbackCopy(text));
  }
  return Promise.resolve(fallbackCopy(text));
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.top = '0';
  ta.style.left = '0';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (_) {}
  document.body.removeChild(ta);
  return ok;
}

function flashPathCopied() {
  const icon = $('props-path-icon');
  if (!icon) return;
  icon.className = 'fas fa-check text-blue-600 dark:text-blue-400';
  setTimeout(() => { icon.className = 'fas fa-copy text-gray-400 dark:text-slate-500 cursor-pointer hover:text-blue-600 dark:hover:text-blue-400'; }, 1500);
}

function flashChecksumCopied() {
  const icon = $('props-checksum-icon');
  if (!icon) return;
  icon.className = 'fas fa-check text-blue-600 dark:text-blue-400';
  setTimeout(() => { icon.className = 'fas fa-copy text-gray-400 dark:text-slate-500 cursor-pointer hover:text-blue-600 dark:hover:text-blue-400'; }, 1500);
}

function renderChecksumRow(path) {
  const entry = checksumCache.get(path);
  if (entry && entry.hash) {
    return `<p id="props-checksum-row"><i class="fas fa-hashtag"></i> <strong>${__('checksum_label', entry.algo)}</strong> ` +
      `<span id="props-checksum" class="cursor-pointer select-all props-path">${esc(entry.hash)}</span> ` +
      `<i id="props-checksum-icon" class="fas fa-copy text-gray-400 dark:text-slate-500 cursor-pointer hover:text-blue-600 dark:hover:text-blue-400" title="${__('copy_checksum')}"></i></p>`;
  }
  if (entry && entry.pending) {
    return `<p id="props-checksum-row"><i class="fas fa-hashtag"></i> <strong>${__('checksum_label', 'MD5')}</strong> ` +
      `<i class="fas fa-spinner op-spinner"></i></p>`;
  }
  return `<p id="props-checksum-row"><i class="fas fa-hashtag"></i> <strong>${__('checksum_label', 'MD5')}</strong> ` +
    `<i id="props-checksum-btn" class="fas fa-sync-alt text-gray-400 dark:text-slate-500 cursor-pointer hover:text-blue-600 dark:hover:text-blue-400" title="${__('checksum_refresh')}"></i></p>`;
}

function startChecksum(path) {
  if (checksumCache.get(path) && checksumCache.get(path).pending) return;
  checksumCache.set(path, { pending: true });
  const row = $('props-checksum-row');
  if (row) row.outerHTML = renderChecksumRow(path);
  send('checksum', { path });
}

function showProperties(props) {
  const icon = props.type === 'dir'
    ? '<i class="fas fa-folder"></i>'
    : '<i class="far fa-file"></i>';
  const typeLabel = props.type === 'dir' ? __('folder') : __('file');
  const fullPath = props.path || props.name;
  currentPropsPath = props.path || props.name;
  $('props-body').innerHTML =
    `<p>${icon} <strong>${__('path_label')}</strong> ` +
    `<span id="props-path" class="cursor-pointer select-all props-path">${esc(fullPath)}</span> ` +
    `<i id="props-path-icon" class="fas fa-copy text-gray-400 dark:text-slate-500 cursor-pointer hover:text-blue-600 dark:hover:text-blue-400" title="${__('copy_path')}"></i></p>` +
    `<p><i class="fas fa-tag"></i> <strong>${__('type_label')}</strong> ${esc(typeLabel)}</p>` +
    `<p><i class="fas fa-weight-hanging"></i> <strong>${__('size_label')}</strong> ${props.type === 'dir' ? '—' : fmtSize(props.size)}</p>` +
    `<p><i class="far fa-calendar-alt"></i> <strong>${__('date_label')}</strong> ${esc(fmtDate(props.date))}</p>` +
    (props.type === 'dir' ? '' : renderChecksumRow(fullPath));
  const pathEl = $('props-path');
  if (pathEl) {
    pathEl.addEventListener('click', e => {
      const name = fullPath.split('/').filter(Boolean).pop() || '';
      copyToClipboard((e.ctrlKey || e.metaKey) ? name : fullPath).then(flashPathCopied);
    });
  }
  const pathIcon = $('props-path-icon');
  if (pathIcon) {
    pathIcon.addEventListener('click', () => {
      copyToClipboard(fullPath).then(flashPathCopied);
    });
  }
  $('props-overlay').classList.remove('hidden');
}

/* ───── config ───── */
async function loadConfig() {
  try {
    const resp = await fetch('/api/config');
    const cfg = await resp.json();
    cookieLifetimeMin = cfg.sessionLifetime || 180;
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
    lastAuth = {
      host: $('host').value,
      port: parseInt($('port').value, 10) || 21,
      user: $('username').value,
      pass: $('password').value,
      passive: $('passive').checked,
    };
    send('auth', lastAuth);
  });

  $('btn-refresh').addEventListener('click', refresh);
  $('btn-done').addEventListener('click', exitSelectMode);
  if ($('btn-mkdir')) $('btn-mkdir').addEventListener('click', () => {
    const name = prompt(__('new_folder_name'));
    if (!name) return;
    send('mkdir', { path: joinPath(currentPath, name) });
  });
  if ($('auth-btn-theme')) $('auth-btn-theme').addEventListener('change', function () {
    setCookie('themeMode', this.value);
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

  /* folder sidebar drawer (mobile) */
  if ($('btn-folders')) $('btn-folders').addEventListener('click', toggleSidebar);
  $('sidebar-backdrop').addEventListener('click', closeSidebar);
  initSidebarResize();

  $('menu-theme').addEventListener('change', function () {
    setCookie('themeMode', this.value);
    applyTheme(this.value);
  });

  $('menu-lang').addEventListener('change', function () {
    setLang(this.value);
    applyLanguage();
  });

  $('menu-logout').addEventListener('click', () => {
    clearAuthSession();
    lastAuth = null;
    clipboard = null;
    folderTree.clear();
    closeSidebar();
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
    currentPropsPath = null;
  });

  $('props-body').addEventListener('click', e => {
    if (e.target.closest('#props-checksum-btn')) {
      startChecksum(currentPropsPath);
      return;
    }
    if (e.target.closest('#props-checksum') || e.target.closest('#props-checksum-icon')) {
      const entry = checksumCache.get(currentPropsPath);
      copyToClipboard(entry ? entry.hash : '').then(flashChecksumCopied);
    }
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


