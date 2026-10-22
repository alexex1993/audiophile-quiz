// Admin page: upload tracks, manage the library, view user results.

const app = document.getElementById("app");
let cfg = { clip_seconds: 30, aac_bitrate: "128k" };
let previewAudio = new Audio();

init();

async function init() {
  try {
    const me = await api("/api/me");
    if (!me.is_admin) {
      app.innerHTML = `<div class="notice error">Доступ только для администраторов (${esc(me.user.email)}).</div>`;
      return;
    }
    cfg = await api("/api/config");
  } catch (e) {
    if (e.status === 401) {
      app.innerHTML = `<div class="card center" style="max-width:420px;margin:60px auto">
        <h2>Вход в админку</h2><p class="muted">Войдите Google-аккаунтом из списка ADMIN_EMAILS.</p>
        <a class="btn" href="/auth/google/login">Войти через Google</a></div>`;
      return;
    }
    app.innerHTML = `<div class="notice error">${esc(e.message)}</div>`;
    return;
  }

  app.innerHTML = `
    <div class="row" style="margin-bottom:24px">
      <div><div class="eyebrow">Управление</div><h1 style="margin:4px 0 0;letter-spacing:-0.02em">Библиотека и результаты</h1></div>
      <span class="spacer"></span>
      <div class="tabs"><button class="active" data-tab="tracks">Треки</button><button data-tab="users">Пользователи</button><button data-tab="stats">Статистика</button></div>
    </div>
    <section id="tab-tracks"></section>
    <section id="tab-users" class="hidden"></section>
    <section id="tab-stats" class="hidden"></section>`;
  app.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => {
    app.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("active", x === b));
    for (const tab of ["tracks", "users", "stats"]) {
      document.getElementById(`tab-${tab}`).classList.toggle("hidden", b.dataset.tab !== tab);
    }
    if (b.dataset.tab === "users") loadUsers();
    if (b.dataset.tab === "stats") loadStats();
  }));
  renderUploader();
  loadTracks();
}

// ---------- upload ----------

function renderUploader() {
  const sec = document.getElementById("tab-tracks");
  sec.innerHTML = `
    <div class="card" id="uploader">
      <h3>Добавить трек</h3>
      <p class="muted" style="margin-top:-6px;font-size:14px">
        Исходник (FLAC, WAV, ALAC, AIFF, WavPack) → отрывок ${cfg.clip_seconds} с →
        <span class="pill ok">lossless.wav</span> и <span class="pill bad">AAC ${esc(cfg.aac_bitrate)} → encoded.wav</span>.
        Исходник удаляется с сервера после обработки.
      </p>
      <input type="file" id="file" accept=".flac,.wav,.aif,.aiff,.m4a,.alac,.wv,.ape,audio/*" hidden>
      <div class="dropzone" id="drop"><b>Перетащите файл сюда</b> или нажмите, чтобы выбрать</div>
      <div id="form" class="hidden" style="margin-top:20px">
        <div class="row" style="margin-bottom:12px"><span class="pill accent" id="fname"></span><span class="faint" id="fsize"></span>
          <span class="spacer"></span><button class="btn btn-ghost btn-sm" id="reset">Другой файл</button></div>
        <audio id="local" controls></audio>
        <div class="clip-range" title="Выбранный отрывок"><div id="range"></div></div>
        <div class="grid grid-3" style="margin-top:18px">
          <div class="field"><label>Исполнитель</label><input class="input" id="artist" placeholder="Pink Floyd"></div>
          <div class="field"><label>Название</label><input class="input" id="title" placeholder="Time"></div>
          <div class="field"><label>Начало отрывка (м:сс или секунды)</label>
            <div class="row" style="flex-wrap:nowrap"><input class="input mono" id="start" value="0:00">
              <button class="btn btn-ghost btn-sm" id="usepos" title="Взять текущую позицию плеера">◉ сейчас</button></div></div>
        </div>
        <div class="row" style="margin-top:20px">
          <button class="btn" id="upload">Загрузить и обработать</button>
          <button class="btn btn-ghost" id="preview">▶ Прослушать отрывок</button>
          <span class="spacer"></span>
          <span class="faint" id="status"></span>
        </div>
        <div class="upload-progress hidden" id="prog" style="margin-top:14px"><div></div></div>
      </div>
    </div>
    <div class="card" style="margin-top:20px">
      <div class="row"><h3 style="margin:0">Треки</h3><span class="spacer"></span><span class="faint" id="count"></span></div>
      <div id="tracks" style="margin-top:12px"><div class="spinner" style="margin:30px auto"></div></div>
    </div>`;

  const fileInput = sec.querySelector("#file");
  const drop = sec.querySelector("#drop");
  const local = sec.querySelector("#local");
  const startInput = sec.querySelector("#start");
  let file = null, objectURL = null;

  drop.onclick = () => fileInput.click();
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("drag"); };
  drop.ondragleave = () => drop.classList.remove("drag");
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove("drag"); if (e.dataTransfer.files[0]) pick(e.dataTransfer.files[0]); };
  fileInput.onchange = () => fileInput.files[0] && pick(fileInput.files[0]);

  function pick(f) {
    file = f;
    if (objectURL) URL.revokeObjectURL(objectURL);
    objectURL = URL.createObjectURL(f);
    local.src = objectURL;
    sec.querySelector("#fname").textContent = f.name;
    sec.querySelector("#fsize").textContent = `${(f.size / 1048576).toFixed(1)} МБ`;
    // "Artist - Title.flac" → prefill both fields.
    const base = f.name.replace(/\.[^.]+$/, "").replace(/^\d+[\s.\-_]+/, "");
    const m = base.split(/\s+[-–—]\s+/);
    sec.querySelector("#artist").value = m.length > 1 ? m[0] : "";
    sec.querySelector("#title").value = m.length > 1 ? m.slice(1).join(" - ") : base;
    startInput.value = "0:00";
    drop.classList.add("hidden");
    sec.querySelector("#form").classList.remove("hidden");
    setStatus("");
  }

  const parseStart = () => {
    const parts = startInput.value.trim().replace(",", ".").split(":").map(Number);
    if (parts.some((n) => isNaN(n) || n < 0)) return NaN;
    return parts.reduce((acc, n) => acc * 60 + n, 0);
  };
  const updateRange = () => {
    const d = local.duration, s = parseStart();
    const r = sec.querySelector("#range");
    if (!d || isNaN(s)) { r.style.width = "0"; return; }
    r.style.left = `${Math.min(100, (s / d) * 100)}%`;
    r.style.width = `${Math.min(100 - (s / d) * 100, (cfg.clip_seconds / d) * 100)}%`;
    r.style.background = s + cfg.clip_seconds > d + 0.01 ? "var(--bad)" : "";
  };
  local.onloadedmetadata = updateRange;
  startInput.oninput = updateRange;
  sec.querySelector("#usepos").onclick = () => {
    const t = Math.max(0, Math.min(local.currentTime, (local.duration || 0) - cfg.clip_seconds));
    startInput.value = `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;
    updateRange();
  };
  sec.querySelector("#preview").onclick = () => {
    const s = parseStart();
    if (isNaN(s)) return toast("Неверное время начала", true);
    local.currentTime = s;
    local.play();
    const stopAt = () => { if (local.currentTime >= s + cfg.clip_seconds) { local.pause(); local.removeEventListener("timeupdate", stopAt); } };
    local.addEventListener("timeupdate", stopAt);
  };
  sec.querySelector("#reset").onclick = () => {
    local.pause();
    file = null;
    fileInput.value = "";
    drop.classList.remove("hidden");
    sec.querySelector("#form").classList.add("hidden");
  };

  function setStatus(t) { sec.querySelector("#status").textContent = t; }

  sec.querySelector("#upload").onclick = () => {
    if (!file) return;
    if (!sec.querySelector("#title").value.trim()) return toast("Укажите название", true);
    local.pause();
    const fd = new FormData();
    fd.append("artist", sec.querySelector("#artist").value.trim());
    fd.append("title", sec.querySelector("#title").value.trim());
    fd.append("start", startInput.value.trim());
    fd.append("file", file);

    const btn = sec.querySelector("#upload");
    const prog = sec.querySelector("#prog");
    btn.disabled = true;
    prog.classList.remove("hidden", "indeterminate");
    prog.firstElementChild.style.width = "0";

    // XHR instead of fetch: it reports upload progress.
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/admin/tracks");
    xhr.setRequestHeader("X-Requested-With", "fetch");
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const p = (e.loaded / e.total) * 100;
      prog.firstElementChild.style.width = `${p}%`;
      setStatus(`Загрузка ${Math.round(p)}%`);
      if (e.loaded === e.total) {
        prog.classList.add("indeterminate");
        prog.firstElementChild.style.width = "";
        setStatus("Нарезка и кодирование…");
      }
    };
    xhr.onload = () => {
      btn.disabled = false;
      prog.classList.add("hidden");
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status === 201) {
        toast(`Добавлено: ${data.title}`);
        sec.querySelector("#reset").click();
        loadTracks();
      } else {
        setStatus("");
        toast(data.error || `Ошибка ${xhr.status}`, true);
      }
    };
    xhr.onerror = () => {
      btn.disabled = false;
      prog.classList.add("hidden");
      setStatus("");
      toast("Сетевая ошибка при загрузке", true);
    };
    xhr.send(fd);
  };
}

// ---------- tracks ----------

async function loadTracks() {
  const box = document.getElementById("tracks");
  let tracks;
  try {
    tracks = await api("/api/admin/tracks");
  } catch (e) {
    box.innerHTML = `<div class="notice error">${esc(e.message)}</div>`;
    return;
  }
  const active = tracks.filter((t) => t.active).length;
  document.getElementById("count").textContent = `${active} активных из ${tracks.length}`;
  if (!tracks.length) {
    box.innerHTML = `<p class="faint">Пока пусто. Загрузите первый трек.</p>`;
    return;
  }
  box.innerHTML = `<div class="table-wrap"><table class="table">
    <thead><tr><th>Трек</th><th>Формат</th><th>Отрывок</th><th>Угадали</th><th>Прослушать</th><th>Активен</th><th></th></tr></thead>
    <tbody>${tracks.map((t) => `
      <tr class="${t.active ? "" : "inactive"}" data-id="${t.id}">
        <td><b>${esc(t.title)}</b><div class="faint" style="font-size:13px">${esc(t.artist) || "—"}</div></td>
        <td class="mono" style="font-size:12.5px;white-space:nowrap">${t.bit_depth} bit / ${(t.sample_rate / 1000).toLocaleString("ru-RU")} kHz<div class="faint">${t.channels} ch · ${esc(t.source_codec)} · ${(t.file_size / 1048576).toFixed(1)} МБ</div></td>
        <td class="mono" style="font-size:13px;white-space:nowrap">${fmtTime(t.start_seconds)}–${fmtTime(t.start_seconds + t.clip_seconds)}</td>
        <td class="mono" style="font-size:13px">${t.times_played ? `${Math.round((t.times_correct / t.times_played) * 100)}% <span class="faint">(${t.times_correct}/${t.times_played})</span>` : `<span class="faint">—</span>`}</td>
        <td><div class="mini-play">
          <button data-play="lossless">lossless</button><button data-play="aac">AAC</button>
        </div></td>
        <td><label class="switch"><input type="checkbox" data-act="toggle" ${t.active ? "checked" : ""}><span></span></label></td>
        <td style="white-space:nowrap"><button class="btn btn-ghost btn-sm" data-act="edit">✎</button>
          <button class="btn btn-danger btn-sm" data-act="delete">Удалить</button></td>
      </tr>`).join("")}</tbody></table></div>`;

  const byId = Object.fromEntries(tracks.map((t) => [t.id, t]));
  let playing = null;
  box.querySelectorAll("tr[data-id]").forEach((tr) => {
    const t = byId[tr.dataset.id];
    tr.querySelectorAll("[data-play]").forEach((b) => (b.onclick = () => {
      box.querySelectorAll("[data-play]").forEach((x) => x.classList.remove("on"));
      const key = `${t.id}/${b.dataset.play}`;
      if (playing === key && !previewAudio.paused) { previewAudio.pause(); playing = null; return; }
      // Switching sides of the same track keeps the position.
      const pos = playing && playing.startsWith(`${t.id}/`) ? previewAudio.currentTime : 0;
      previewAudio.src = `/api/admin/tracks/${t.id}/audio/${b.dataset.play}`;
      previewAudio.addEventListener("loadedmetadata", () => (previewAudio.currentTime = pos), { once: true });
      previewAudio.play();
      playing = key;
      b.classList.add("on");
    }));
    tr.querySelector('[data-act="toggle"]').onchange = async (e) => {
      try {
        await api(`/api/admin/tracks/${t.id}`, { method: "PATCH", json: { artist: t.artist, title: t.title, active: e.target.checked } });
        loadTracks();
      } catch (err) { toast(err.message, true); e.target.checked = !e.target.checked; }
    };
    tr.querySelector('[data-act="edit"]').onclick = async () => {
      const artist = prompt("Исполнитель", t.artist);
      if (artist === null) return;
      const title = prompt("Название", t.title);
      if (title === null || !title.trim()) return;
      try {
        await api(`/api/admin/tracks/${t.id}`, { method: "PATCH", json: { artist, title, active: t.active } });
        loadTracks();
      } catch (err) { toast(err.message, true); }
    };
    tr.querySelector('[data-act="delete"]').onclick = async () => {
      if (!confirm(`Удалить «${t.title}» вместе с файлами? Результаты прошлых тестов сохранятся.`)) return;
      try {
        await api(`/api/admin/tracks/${t.id}`, { method: "DELETE" });
        toast("Трек удалён");
        loadTracks();
      } catch (err) { toast(err.message, true); }
    };
  });
  previewAudio.onended = () => box.querySelectorAll("[data-play]").forEach((x) => x.classList.remove("on"));
}

// ---------- users ----------

async function loadUsers() {
  const sec = document.getElementById("tab-users");
  sec.innerHTML = `<div class="card"><div class="spinner" style="margin:30px auto"></div></div>`;
  let users;
  try {
    users = await api("/api/admin/users");
  } catch (e) {
    sec.innerHTML = `<div class="notice error">${esc(e.message)}</div>`;
    return;
  }
  const played = users.filter((u) => u.attempts > 0);
  const avg = played.length ? played.reduce((s, u) => s + u.avg_percent, 0) / played.length : 0;
  sec.innerHTML = `
    <div class="grid grid-3">
      <div class="card"><div class="eyebrow">Пользователей</div><div class="big-number" style="margin-top:8px">${users.length}</div></div>
      <div class="card"><div class="eyebrow">Прошли тест</div><div class="big-number" style="margin-top:8px">${played.length}</div></div>
      <div class="card"><div class="eyebrow">Средний результат</div><div class="big-number" style="margin-top:8px">${Math.round(avg)}%</div>
        <div class="faint" style="font-size:13px;margin-top:6px">случайное угадывание — 25%</div></div>
    </div>
    <div class="card" style="margin-top:20px"><div class="table-wrap"><table class="table">
      <thead><tr><th>Пользователь</th><th>Попыток</th><th>Лучший</th><th>Средний</th><th>Последний тест</th><th>Регистрация</th></tr></thead>
      <tbody>${users.map((u) => `<tr>
        <td><div class="row" style="flex-wrap:nowrap">${u.picture ? `<img class="avatar" src="${esc(u.picture)}" alt="" referrerpolicy="no-referrer">` : ""}
          <div><b>${esc(u.name) || "—"}</b><div class="faint" style="font-size:13px">${esc(u.email)}</div></div></div></td>
        <td class="mono">${u.attempts}</td>
        <td class="mono">${u.best_score ?? "—"}</td>
        <td class="mono">${u.avg_percent != null ? Math.round(u.avg_percent) + "%" : "—"}</td>
        <td>${u.last_played ? fmtDate(u.last_played) : '<span class="faint">—</span>'}</td>
        <td class="faint">${fmtDate(u.created_at, false)}</td>
      </tr>`).join("")}</tbody></table></div></div>`;
}
