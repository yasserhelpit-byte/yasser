// Dashboard notifications: bell menu + phone/desktop push opt-in. Needs window.CSRF and window.VAPID_KEY.
(function () {
  const all = (s) => document.querySelectorAll(s);
  const post = (url, data) => fetch(url, {
    method: 'POST',
    body: new URLSearchParams(data || {}),
    headers: { 'x-csrf-token': window.CSRF, accept: 'application/json' },
  }).then((r) => r.json());
  const ago = (iso) => {
    const s = Math.max(1, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 60) return 'الآن';
    if (s < 3600) return 'منذ ' + Math.round(s / 60) + ' د';
    if (s < 86400) return 'منذ ' + Math.round(s / 3600) + ' س';
    return 'منذ ' + Math.round(s / 86400) + ' يوم';
  };

  // ---- Bell ----
  function setCount(n) {
    all('.bell-count').forEach((b) => { b.textContent = n > 99 ? '99+' : n; b.hidden = !n; });
  }
  async function load(panel) {
    const list = panel.querySelector('.bell-list');
    try {
      const d = await fetch('/dashboard/notes', { headers: { accept: 'application/json' } }).then((r) => r.json());
      setCount(d.unread);
      list.innerHTML = '';
      if (!d.notes.length) { list.innerHTML = '<div class="bell-empty">🔕 لا توجد إشعارات بعد</div>'; return; }
      for (const n of d.notes) {
        const a = document.createElement('a');
        a.className = 'bell-item' + (n.read_at ? '' : ' unread');
        a.href = n.link || '#';
        a.innerHTML = '<span class="bi-main"><strong></strong><small></small></span><time></time>';
        a.querySelector('strong').textContent = n.title;
        a.querySelector('small').textContent = n.body;
        a.querySelector('time').textContent = ago(n.created_at);
        a.addEventListener('click', () => { if (!n.read_at) post('/dashboard/notes/read', { id: n.id }); });
        list.appendChild(a);
      }
    } catch (e) {
      list.innerHTML = '<div class="bell-empty">تعذّر التحميل</div>';
    }
  }
  all('.bell').forEach((bell) => {
    const panel = bell.querySelector('.bell-panel');
    bell.querySelector('.bell-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      const open = panel.hidden;
      all('.bell-panel').forEach((p) => { p.hidden = true; });
      panel.hidden = !open;
      if (open) load(panel);
    });
    panel.addEventListener('click', (e) => e.stopPropagation());
    panel.querySelector('.bell-readall').addEventListener('click', async () => {
      setCount((await post('/dashboard/notes/read')).unread);
      load(panel);
    });
  });
  document.addEventListener('click', () => all('.bell-panel').forEach((p) => { p.hidden = true; }));
  window.YasserBell = { setCount };

  // ---- Push opt-in ----
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const b64ToBytes = (b64) => {
    const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  };
  const subFields = (sub) => { const j = sub.toJSON(); return { endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth }; };

  async function currentSub() {
    if (!supported) return null;
    const reg = await navigator.serviceWorker.getRegistration('/');
    return reg ? reg.pushManager.getSubscription() : null;
  }
  async function enable() {
    if (!supported) throw new Error(isIOS && !standalone ? 'ios' : 'unsupported');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('denied');
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription())
      || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(window.VAPID_KEY) }));
    await post('/dashboard/push/subscribe', subFields(sub));
    await post('/dashboard/push/test');
    return true;
  }
  const MSG = {
    ios: '📱 على آيفون: افتح الموقع في Safari، اضغط زر المشاركة ⬆️ ثم «إضافة إلى الشاشة الرئيسية»، وافتح YASSER من هناك ثم فعّل الإشعارات.',
    denied: '🔕 الإشعارات محظورة لهذا الموقع. فعّلها من إعدادات المتصفح (رمز القفل بجانب الرابط) ثم أعد المحاولة.',
    unsupported: 'هذا المتصفح لا يدعم الإشعارات. جرّب Chrome على أندرويد أو الحاسوب.',
  };
  all('[data-push-enable]').forEach((btn) => btn.addEventListener('click', async () => {
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'جارٍ التفعيل…';
    try { await enable(); await refreshState(); } catch (e) { (window.yAlert || alert)(MSG[e.message] || 'تعذّر تفعيل الإشعارات: ' + e.message, { title: 'الإشعارات', icon: '🔔' }); }
    btn.textContent = label;
    btn.disabled = false;
  }));
  all('[data-push-test]').forEach((btn) => btn.addEventListener('click', async () => {
    const r = await post('/dashboard/push/test');
    btn.textContent = r.sent ? '✓ أُرسل إشعار تجريبي' : 'لا توجد أجهزة مفعّلة';
  }));
  all('[data-push-dismiss]').forEach((btn) => btn.addEventListener('click', () => {
    try { localStorage.setItem('yasser:push-dismissed', '1'); } catch (e) {}
    btn.closest('.push-banner').hidden = true;
  }));

  async function refreshState() {
    const sub = await currentSub().catch(() => null);
    const on = !!sub && Notification.permission === 'granted';
    all('[data-push-state]').forEach((el) => { el.dataset.on = on ? '1' : '0'; });
    let dismissed = false;
    try { dismissed = localStorage.getItem('yasser:push-dismissed') === '1'; } catch (e) {}
    all('.push-banner').forEach((b) => { b.hidden = on || dismissed; });
    if (on) post('/dashboard/push/subscribe', subFields(sub)); // keep this device linked to the signed-in account
  }
  refreshState();
})();
