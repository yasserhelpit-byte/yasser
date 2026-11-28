// YASSER dialogs: replace the browser's confirm()/alert() with styled, RTL, keyboard-friendly ones.
//   await yConfirm('message', { title, ok, cancel, danger, icon })  -> true / false
//   await yAlert('message', { title, icon })
//   await yChoice('message', { title, buttons: [{ value, label, kind: 'primary'|'ghost'|'danger' }] }) -> value or ''
// Forms: <form data-confirm="message" data-confirm-title="…" data-confirm-ok="…" data-danger> ask before submitting.
(function () {
  let open = null;

  function yDialog({ title = '', message = '', ok = 'تأكيد', cancel = 'إلغاء', danger = false, icon = '', alertOnly = false, buttons = null }) {
    if (open) open.close('cancel');
    return new Promise((resolve) => {
      const d = document.createElement('dialog');
      d.className = 'ydlg' + (danger ? ' danger' : '');
      d.setAttribute('dir', 'rtl');
      d.innerHTML = '<form method="dialog" class="ydlg-card">'
        + '<span class="ydlg-ic" aria-hidden="true"></span>'
        + '<h3 class="ydlg-title"></h3><p class="ydlg-msg"></p>'
        + '<div class="ydlg-actions"><button value="ok" class="btn ydlg-ok"></button><button value="cancel" class="btn ghost ydlg-cancel"></button></div>'
        + '</form>';
      d.querySelector('.ydlg-ic').textContent = icon || (danger ? '⚠️' : alertOnly ? 'ℹ️' : '❓');
      d.querySelector('.ydlg-title').textContent = title;
      d.querySelector('.ydlg-title').hidden = !title;
      d.querySelector('.ydlg-msg').textContent = message;
      d.querySelector('.ydlg-ok').textContent = alertOnly ? 'حسناً' : ok;
      const c = d.querySelector('.ydlg-cancel');
      c.textContent = cancel;
      c.hidden = alertOnly;
      if (buttons) { // free set of buttons; the dialog resolves with the chosen value
        const box = d.querySelector('.ydlg-actions');
        box.innerHTML = '';
        box.classList.add('stack');
        for (const bt of buttons) {
          const el = document.createElement('button');
          el.value = bt.value;
          el.className = 'btn' + (bt.kind === 'ghost' ? ' ghost' : bt.kind === 'danger' ? ' ydlg-danger' : '');
          el.textContent = bt.label;
          box.appendChild(el);
        }
      }
      // A click on the dimmed backdrop cancels.
      d.addEventListener('click', (e) => { if (e.target === d) d.close('cancel'); });
      d.addEventListener('close', () => {
        open = null;
        d.classList.add('out');
        setTimeout(() => d.remove(), 160);
        resolve(buttons ? (d.returnValue === 'cancel' ? '' : d.returnValue) : d.returnValue === 'ok');
      });
      document.body.appendChild(d);
      open = d;
      d.showModal();
      if (buttons) d.querySelector('.ydlg-actions button')?.focus();
      else (alertOnly || !danger ? d.querySelector('.ydlg-ok') : c).focus(); // destructive actions start on "cancel"
    });
  }

  window.yDialog = yDialog;
  window.yConfirm = (message, opts = {}) => yDialog({ ...opts, message });
  window.yAlert = (message, opts = {}) => yDialog({ ...opts, message, alertOnly: true });
  window.yChoice = (message, opts = {}) => yDialog({ ...opts, message });

  // Forms that need a confirmation.
  document.addEventListener('submit', async (e) => {
    const f = e.target;
    if (!(f instanceof HTMLFormElement) || !f.dataset.confirm || f.dataset.confirmed) return;
    e.preventDefault();
    const okd = await yDialog({
      title: f.dataset.confirmTitle || '',
      message: f.dataset.confirm,
      ok: f.dataset.confirmOk || 'تأكيد',
      danger: f.hasAttribute('data-danger'),
      icon: f.dataset.confirmIcon || '',
    });
    if (!okd) return;
    f.dataset.confirmed = '1';
    if (e.submitter && e.submitter.name) { // keep the clicked button's value
      const h = document.createElement('input');
      h.type = 'hidden'; h.name = e.submitter.name; h.value = e.submitter.value;
      f.appendChild(h);
    }
    HTMLFormElement.prototype.submit.call(f);
  }, true);
})();
