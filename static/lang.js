const i18n = {};
const errorCodeMap = {
  not_authenticated: 'not_authenticated',
  no_active_upload: 'no_active_upload',
  item_not_found: 'item_not_found',
};

let cookieLifetimeMin = 43200;

function getCookie(name) {
  const m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=([^;]*)'));
  let v = m ? decodeURIComponent(m[1]) : null;
  if (v == null) {
    const old = sessionStorage.getItem(name);
    if (old != null) {
      v = old;
      setCookie(name, old);
      sessionStorage.removeItem(name);
    }
  }
  return v;
}

function setCookie(name, value, minutes) {
  if (minutes == null) minutes = cookieLifetimeMin;
  const d = new Date();
  d.setTime(d.getTime() + minutes * 60e3);
  const sec = location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = name + '=' + encodeURIComponent(value) + '; path=/; expires=' + d.toUTCString() + '; SameSite=Lax' + sec;
}

function removeCookie(name) {
  document.cookie = name + '=; path=/; Max-Age=0; SameSite=Lax';
}

let _availableLangs = [];
let _currentLang = null;
let _loadPromise = null;

async function _loadI18n() {
  if (_loadPromise) return _loadPromise;
  _loadPromise = (async () => {
    let codes;
    try {
      const res = await fetch('/api/i18n');
      codes = await res.json();
    } catch (_) {
      codes = ['en'];
    }
    const results = await Promise.allSettled(
      codes.map(code =>
        fetch(`i18n/${code}.json`).then(r => r.json())
      )
    );
    for (let i = 0; i < codes.length; i++) {
      if (results[i].status === 'fulfilled') {
        i18n[codes[i]] = results[i].value;
        _availableLangs.push(codes[i]);
      }
    }
    if (!_availableLangs.includes('en') && codes.includes('en')) {
      i18n.en = { language: 'EN' };
      _availableLangs.push('en');
    }
  })();
  return _loadPromise;
}

function detectLang() {
  const saved = getCookie('lang');
  if (saved && _availableLangs.includes(saved)) return saved;
  for (const code of _availableLangs) {
    if (navigator.language && navigator.language.startsWith(code)) return code;
  }
  return _availableLangs.includes('en') ? 'en' : (_availableLangs[0] || 'en');
}

function getLang() {
  if (!_currentLang || !_availableLangs.includes(_currentLang)) {
    _currentLang = detectLang();
  }
  return _currentLang;
}

function setLang(lang) {
  _currentLang = lang;
  setCookie('lang', lang);
}

function getAvailableLangs() {
  return _availableLangs;
}

function getLangDisplayName(code) {
  return (i18n[code] && i18n[code].language) || code.toUpperCase();
}

function __(key) {
  const lang = getLang();
  let str = (i18n[lang] && i18n[lang][key]) || (i18n.en && i18n.en[key]) || key;
  for (let i = 1; i < arguments.length; i++) {
    str = str.replace('{' + (i - 1) + '}', String(arguments[i]));
  }
  return str;
}
