// Drag-and-drop / click image uploader. Calls onDone(urls) with the uploaded file URLs.
// remaining() returns how many more files are allowed.
function setupDropzone(zone, input, status, onDone, remaining) {
  const say = (msg, isError) => {
    status.textContent = msg;
    status.className = 'dz-status' + (isError ? ' err' : '');
  };

  async function send(fileList) {
    let files = [...fileList].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return say('اختر ملفات صور فقط.', true);
    const left = remaining ? remaining() : 8;
    if (left <= 0) return say('وصلت إلى الحد الأقصى لعدد الصور.', true);
    if (files.length > left) files = files.slice(0, left);
    const big = files.find((f) => f.size > 5 * 1024 * 1024);
    if (big) return say(`الصورة «${big.name}» أكبر من 5 ميغابايت.`, true);

    const fd = new FormData();
    files.forEach((f) => fd.append('files', f));
    zone.classList.add('busy');
    say(`جارٍ رفع ${files.length} صورة...`);
    try {
      const res = await fetch(zone.dataset.upload, { method: 'POST', body: fd, headers: { 'x-csrf-token': window.CSRF } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'تعذّر رفع الصور.');
      say(`✓ تم رفع ${data.urls.length} صورة`);
      onDone(data.urls);
    } catch (e) {
      say(e.message, true);
    } finally {
      zone.classList.remove('busy');
      input.value = '';
    }
  }

  input.addEventListener('change', () => send(input.files));
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('over'); send(e.dataTransfer.files); });
  zone.addEventListener('click', (e) => { if (e.target === zone) input.click(); });
}
