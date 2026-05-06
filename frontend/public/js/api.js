const API = {
  token: () => localStorage.getItem('wm_token'),
  user:  () => JSON.parse(localStorage.getItem('wm_user') || 'null'),

  headers(extra = {}) {
    const h = { 'Content-Type': 'application/json', ...extra };
    const t = this.token();
    if (t) h['Authorization'] = `Bearer ${t}`;
    return h;
  },

  async request(method, url, body, extraHeaders = {}) {
    const opts = { method, headers: this.headers(extraHeaders) };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    if (res.status === 401) { logout(); return; }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Fehler');
    return data;
  },

  get:    (url, h)    => API.request('GET', url, undefined, h),
  post:   (url, b, h) => API.request('POST', url, b, h),
  put:    (url, b, h) => API.request('PUT', url, b, h),
  delete: (url, h)    => API.request('DELETE', url, undefined, h),

  async upload(url, file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const fd  = new FormData();
      fd.append('image', file);
      xhr.open('POST', url);
      const t = this.token();
      if (t) xhr.setRequestHeader('Authorization', `Bearer ${t}`);
      if (onProgress) xhr.upload.onprogress = e => onProgress(e.loaded / e.total);
      xhr.onload  = () => { const d = JSON.parse(xhr.responseText); xhr.status >= 400 ? reject(new Error(d.error)) : resolve(d); };
      xhr.onerror = () => reject(new Error('Upload fehlgeschlagen'));
      xhr.send(fd);
    });
  }
};

function logout() {
  localStorage.removeItem('wm_token');
  localStorage.removeItem('wm_user');
  window.location.href = '/index.html';
}
function openModal(id)  { document.getElementById(id)?.classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id)?.classList.add('hidden'); }

function showToast(msg, type = 'info') {
  const el = document.createElement('div');
  el.textContent = msg;
  const col = type === 'error' ? '#7f1d1d' : type === 'success' ? '#14532d' : '#1e293b';
  const tc  = type === 'error' ? '#fca5a5' : type === 'success' ? '#86efac' : '#e2e8f0';
  const bc  = type === 'error' ? '#ef4444' : type === 'success' ? '#22c55e' : '#475569';
  el.style.cssText = `position:fixed;bottom:1.4rem;right:1.4rem;z-index:9999;background:${col};color:${tc};border:1px solid ${bc};border-radius:8px;padding:.55rem 1rem;font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,.4);max-width:320px`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}
