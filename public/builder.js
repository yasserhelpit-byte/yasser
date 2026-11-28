// Section builder for the store homepage and custom pages.
// Needs: window.SCHEMA, window.CSRF, setupDropzone() from upload.js.
// Usage: initBuilder({ root, input, data, uploadUrl, presets })
function initBuilder({ root, input, data, uploadUrl, presets, onChange, onFocus }) {
  const SCHEMA = window.SCHEMA;
  let sections = JSON.parse(JSON.stringify(data || []));
  const open = new Set(); // indexes of expanded sections
  let dirty = false;

  const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
    return el;
  };
  const touch = () => { dirty = true; input.value = JSON.stringify(sections); onChange?.(); };
  let dragFrom = null;
  const blank = (fields) => Object.fromEntries(fields.map((f) => [f.k, f.t === 'select' ? Object.keys(f.options)[0] : '']));

  // ----- image field with upload -----
  function imageField(obj, f, onChange) {
    const wrap = h('div', { class: 'b-img' });
    const draw = () => {
      wrap.innerHTML = '';
      const box = h('div', { class: 'b-img-box' + (obj[f.k] ? '' : ' empty') });
      if (obj[f.k]) box.append(h('img', { src: obj[f.k], alt: '' }));
      else box.append(h('span', {}, '🖼️'));
      const file = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/gif', hidden: true });
      const status = h('div', { class: 'dz-status' });
      const zone = h('div', { class: 'dropzone mini', 'data-upload': uploadUrl }, file,
        h('button', { type: 'button', class: 'btn small', onclick: () => file.click() }, obj[f.k] ? 'تغيير' : '📤 رفع صورة'));
      setupDropzone(zone, file, status, (urls) => { obj[f.k] = urls[0]; touch(); draw(); onChange?.(); }, () => 1);
      const actions = h('div', { class: 'b-img-actions' }, zone,
        obj[f.k] ? h('button', { type: 'button', class: 'link danger', onclick: () => { obj[f.k] = ''; touch(); draw(); onChange?.(); } }, 'إزالة') : null,
        status);
      wrap.append(box, actions);
    };
    draw();
    return wrap;
  }

  function field(obj, f, onChange) {
    const id = 'b' + Math.random().toString(36).slice(2);
    let control;
    if (f.t === 'image') return h('div', { class: 'b-field' }, h('span', { class: 'b-label' }, f.l), imageField(obj, f, onChange));
    if (f.t === 'product') {
      const list = window.PRODUCTS || [];
      if (!list.length) return h('div', { class: 'b-field' }, h('span', { class: 'b-label' }, f.l), h('p', { class: 'muted small' }, 'أضف منتجاً أولاً من صفحة المنتجات.'));
      control = h('select', { id, onchange: (e) => { obj[f.k] = e.target.value; touch(); onChange?.(); } },
        h('option', { value: '' }, '— أحدث منتج متوفر —'),
        list.map((p) => h('option', { value: String(p.id), selected: String(obj[f.k]) === String(p.id) }, p.name + (p.active ? '' : ' (مخفي)'))));
      return h('label', { class: 'b-field', for: id }, h('span', { class: 'b-label' }, f.l), control);
    }
    if (f.t === 'datetime') {
      control = h('input', { id, type: 'datetime-local', dir: 'ltr', onchange: (e) => { obj[f.k] = e.target.value; touch(); onChange?.(); } });
      control.value = obj[f.k] || '';
      return h('label', { class: 'b-field', for: id }, h('span', { class: 'b-label' }, f.l), control,
        h('small', { class: 'muted' }, 'يختفي العدّاد تلقائياً بعد هذا الموعد. اتركه فارغاً لإخفائه.'));
    }
    if (f.t === 'select') {
      control = h('select', { id, onchange: (e) => { obj[f.k] = e.target.value; touch(); onChange?.(); } },
        Object.entries(f.options).map(([v, l]) => h('option', { value: v, selected: String(obj[f.k]) === v }, l)));
    } else if (f.t === 'textarea') {
      control = h('textarea', { id, rows: 4, maxlength: f.max, placeholder: f.ph || '', oninput: (e) => { obj[f.k] = e.target.value; touch(); onChange?.(); } });
      control.value = obj[f.k] || '';
    } else {
      control = h('input', { id, type: 'text', maxlength: f.max || 500, placeholder: f.ph || '', dir: f.t === 'link' ? 'ltr' : null,
        oninput: (e) => { obj[f.k] = e.target.value; touch(); onChange?.(); } });
      control.value = obj[f.k] || '';
    }
    return h('label', { class: 'b-field', for: id }, h('span', { class: 'b-label' }, f.l), control);
  }

  function moveBtns(arr, i, rerender) {
    return [
      h('button', { type: 'button', class: 'b-ic', title: 'لأعلى', disabled: i === 0, onclick: () => { [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]]; touch(); rerender(i - 1, i); } }, '↑'),
      h('button', { type: 'button', class: 'b-ic', title: 'لأسفل', disabled: i === arr.length - 1, onclick: () => { [arr[i + 1], arr[i]] = [arr[i], arr[i + 1]]; touch(); rerender(i + 1, i); } }, '↓'),
    ];
  }

  // ----- repeatable items (slides, images, testimonials...) -----
  function itemsEditor(sec, def) {
    const box = h('div', { class: 'b-items' });
    const draw = () => {
      box.innerHTML = '';
      sec.items.forEach((it, i) => {
        const titleOf = () => it.title || it.name || it.q || it.caption || `${def.items.label} ${i + 1}`;
        const label = h('span', { class: 'b-item-title' }, titleOf());
        const thumb = () => (def.items.fields[0].t === 'image' && it[def.items.fields[0].k]) ? h('img', { src: it[def.items.fields[0].k], class: 'b-item-thumb', alt: '' }) : null;
        const headEl = h('div', { class: 'b-item-head' }, thumb(), label,
          h('span', { class: 'b-tools' }, ...moveBtns(sec.items, i, draw),
            h('button', { type: 'button', class: 'b-ic danger', title: 'حذف', onclick: () => { sec.items.splice(i, 1); touch(); draw(); } }, '✕')));
        const body = h('div', { class: 'b-item-body' }, def.items.fields.map((f) => field(it, f, () => { label.textContent = titleOf(); })));
        box.append(h('div', { class: 'b-item' }, headEl, body));
      });
      const full = sec.items.length >= def.items.max;
      const add = h('button', { type: 'button', class: 'btn small ghost', disabled: full, onclick: () => { sec.items.push(blank(def.items.fields)); touch(); draw(); } }, `+ ${def.items.label}`);
      const row = h('div', { class: 'b-items-add' }, add);
      // Bulk image upload creates one item per image (galleries, sliders...).
      const imgField = def.items.fields.find((f) => f.t === 'image');
      if (imgField && !full) {
        const file = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/gif', multiple: true, hidden: true });
        const status = h('div', { class: 'dz-status' });
        const zone = h('div', { class: 'dropzone b-bulk', 'data-upload': uploadUrl }, file,
          h('span', {}, '📤 اسحب عدة صور هنا أو '), h('button', { type: 'button', class: 'link', onclick: () => file.click() }, 'اخترها من جهازك'));
        setupDropzone(zone, file, status, (urls) => {
          urls.forEach((u) => { if (sec.items.length < def.items.max) sec.items.push({ ...blank(def.items.fields), [imgField.k]: u }); });
          touch(); draw();
        }, () => def.items.max - sec.items.length);
        row.append(zone, status);
      }
      box.append(row, h('small', { class: 'muted' }, `${sec.items.length} / ${def.items.max}`));
    };
    draw();
    return box;
  }

  // ----- section cards -----
  function render(focus) {
    root.innerHTML = '';
    if (!sections.length) root.append(h('div', { class: 'b-empty' }, 'لا توجد أقسام بعد. أضف قسماً من الأسفل 👇'));
    sections.forEach((sec, i) => {
      const def = SCHEMA[sec.type];
      const isOpen = open.has(i);
      const summary = sec.title || (sec.items && sec.items[0] && (sec.items[0].title || sec.items[0].name)) || def.desc;
      const head = h('div', { class: 'b-head', onclick: (e) => {
          if (e.target.closest('button')) return;
          if (isOpen) open.delete(i); else { open.clear(); open.add(i); onFocus?.(i); }
          render();
        } },
        h('span', { class: 'b-grip', title: 'اسحب لتغيير الترتيب' }, '⋮⋮'),
        h('span', { class: 'b-icon' }, def.icon),
        h('span', { class: 'b-title' }, h('strong', {}, def.label), h('small', {}, summary)),
        h('span', { class: 'b-tools' },
          ...moveBtns(sections, i, (to, from) => { const a = open.has(from), b = open.has(to); open.delete(from); open.delete(to); if (a) open.add(to); if (b) open.add(from); render(to); }),
          h('button', { type: 'button', class: 'b-ic', title: sec.hidden ? 'إظهار' : 'إخفاء', onclick: () => { sec.hidden = !sec.hidden; touch(); render(); } }, sec.hidden ? '🙈' : '👁️'),
          h('button', { type: 'button', class: 'b-ic', title: 'نسخ', onclick: () => { sections.splice(i + 1, 0, JSON.parse(JSON.stringify(sec))); touch(); render(i + 1); } }, '⧉'),
          h('button', { type: 'button', class: 'b-ic danger', title: 'حذف', onclick: async () => { if (await yConfirm('سيُحذف هذا القسم من الصفحة. يمكنك التراجع بعدم الحفظ.', { title: 'حذف القسم؟', ok: 'حذف القسم', danger: true })) { sections.splice(i, 1); open.clear(); touch(); render(); } } }, '✕'),
          h('span', { class: 'b-chev' }, isOpen ? '▴' : '▾')));
      const card = h('div', { class: 'b-sec' + (sec.hidden ? ' hidden-sec' : '') + (isOpen ? ' open' : ''), id: 'sec-' + i }, head);
      // Drag and drop to reorder (closed cards only, so text inputs stay selectable).
      if (!isOpen) {
        card.draggable = true;
        card.addEventListener('dragstart', (e) => { dragFrom = i; card.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
        card.addEventListener('dragend', () => { card.classList.remove('dragging'); root.querySelectorAll('.drop-over').forEach((x) => x.classList.remove('drop-over')); });
      }
      card.addEventListener('dragover', (e) => { if (dragFrom === null) return; e.preventDefault(); card.classList.add('drop-over'); });
      card.addEventListener('dragleave', () => card.classList.remove('drop-over'));
      card.addEventListener('drop', (e) => {
        e.preventDefault();
        if (dragFrom === null || dragFrom === i) return;
        const [moved] = sections.splice(dragFrom, 1);
        sections.splice(i, 0, moved);
        dragFrom = null; open.clear(); touch(); render(); onFocus?.(i);
      });
      if (isOpen) {
        const body = h('div', { class: 'b-body' }, h('p', { class: 'muted small' }, def.desc), def.fields.map((f) => field(sec, f, () => {})));
        if (def.items) body.append(h('h4', { class: 'b-items-title' }, 'العناصر'), itemsEditor(sec, def));
        card.append(body);
      }
      root.append(card);
    });
    // Add-section picker
    const picker = h('div', { class: 'b-picker' },
      Object.entries(SCHEMA).map(([type, def]) => h('button', { type: 'button', class: 'b-pick', onclick: () => {
        const sec = { type, hidden: false, ...blank(def.fields) };
        if (def.items) sec.items = [];
        sections.push(sec); open.clear(); open.add(sections.length - 1); touch(); render(sections.length - 1); onFocus?.(sections.length - 1);
      } }, h('span', {}, def.icon), h('strong', {}, def.label), h('small', {}, def.desc))));
    root.append(h('details', { class: 'b-add' }, h('summary', { class: 'btn' }, '+ إضافة قسم'), picker));
    if (focus != null) document.getElementById('sec-' + focus)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  if (presets) {
    const sel = document.getElementById('preset-select');
    document.getElementById('preset-apply')?.addEventListener('click', async () => {
      const p = presets[sel.value];
      if (p && await yConfirm('سيحلّ هذا القالب محل كل أقسام الصفحة الحالية. لن يتغير شيء حتى تحفظ.', { title: `استعمال قالب «${p.label}»؟`, ok: 'استعمل القالب', icon: '✨' })) { sections = JSON.parse(JSON.stringify(p.sections)); open.clear(); touch(); render(); }
    });
  }
  input.form.addEventListener('submit', () => { input.value = JSON.stringify(sections); dirty = false; });
  window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
  input.value = JSON.stringify(sections);
  render();
  return { isDirty: () => dirty, markDirty: () => { dirty = true; }, value: () => JSON.stringify(sections) };
}
