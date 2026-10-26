// Admin page: upload tracks, manage the library, view user results.

const app = document.getElementById("app");
let cfg = { clip_seconds: 30, difficulties: DEFAULT_LEVELS };
let previewAudio = new Audio();

init();

async function init() {
  const signIn = () => (app.innerHTML = `<div class="card center" style="max-width:420px;margin:60px auto">
    <h2>${t("Вход в админку", "Admin sign-in")}</h2><p class="muted">${t("Войдите Google-аккаунтом из списка ADMIN_EMAILS.", "Sign in with a Google account listed in ADMIN_EMAILS.")}</p>
    <a class="btn" href="/auth/google/login">${t("Войти через Google", "Sign in with Google")}</a></div>`);
  let me;
  try {
    me = await api("/api/me");
    if (me.user.guest) return signIn();
    if (!me.is_admin) {
      app.innerHTML = `<div class="notice error">${t("Доступ только для администраторов", "Admins only")} (${esc(me.user.email)}).</div>`;
      return;
    }
    cfg = await api("/api/config");
  } catch (e) {
    if (e.status === 401) return signIn();
    app.innerHTML = `<div class="notice error">${esc(e.message)}</div>`;
    return;
  }

  app.innerHTML = `
    <div id="maint-banner"></div>
    <div class="row" style="margin-bottom:24px">
      <div><div class="eyebrow">${t("Управление", "Management")}</div><h1 style="margin:4px 0 0;letter-spacing:-0.02em">${t("Библиотека и результаты", "Library and results")}</h1></div>
      <span class="spacer"></span>
      <button class="btn btn-ghost btn-sm" id="maint-btn"></button>
      <div class="tabs"><button class="active" data-tab="tracks">${t("Треки", "Tracks")}</button><button data-tab="users">${t("Пользователи", "Users")}</button><button data-tab="stats">${t("Статистика", "Statistics")}</button></div>
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
  renderMaintenance(me.maintenance);
  renderUploader();
  loadTracks();
}

// ---------- maintenance ----------

// renderMaintenance shows the maintenance switch; while it is on the site is
// closed to everyone but admins.
function renderMaintenance(on) {
  const btn = document.getElementById("maint-btn");
  btn.className = on ? "btn btn-sm" : "btn btn-ghost btn-sm";
  btn.textContent = on ? t("Открыть сайт", "Reopen the site") : `🛠 ${t("Техническое обслуживание", "Maintenance")}`;
  document.getElementById("maint-banner").innerHTML = on
    ? `<div class="notice warn" style="margin-bottom:20px">${t("Сайт закрыт на техническое обслуживание: посетители видят заглушку, работают только админка и сам тест для администраторов.",
      "The site is closed for maintenance: visitors see a stub page; only the admin page and the test for admins keep working.")}</div>`
    : "";
  btn.onclick = async () => {
    if (!on && !confirm(t("Закрыть сайт на техническое обслуживание? Посетители увидят заглушку, незавершённые попытки сохранятся.",
      "Close the site for maintenance? Visitors will see a stub page; unfinished attempts are kept."))) return;
    btn.disabled = true;
    try {
      const res = await api("/api/admin/maintenance", { method: "PUT", json: { enabled: !on } });
      renderMaintenance(res.enabled);
      toast(res.enabled ? t("Сайт закрыт на обслуживание", "The site is closed for maintenance") : t("Сайт снова открыт", "The site is open again"));
    } catch (e) {
      toast(e.message, true);
    } finally {
      btn.disabled = false;
    }
  };
}

// ---------- upload ----------

function renderUploader() {
  const sec = document.getElementById("tab-tracks");
  sec.innerHTML = `
    <div class="card" id="uploader">
      <h3>${t("Добавить трек", "Add a track")}</h3>
      <p class="muted" style="margin-top:-6px;font-size:14px">
        ${t("Исходник", "Source")} (FLAC, WAV, ALAC, AIFF, WavPack; ${t("до 24 бит", "up to 24 bit")}) → ${t(`отрывок ${cfg.clip_seconds} с`, `${cfg.clip_seconds} s clip`)} →
        <span class="pill ok">lossless.flac</span> ${t("и", "and")} <span class="pill bad">AAC ${cfg.difficulties.map((l) => l.kbps).join(" / ")} kbps</span> → <span class="pill bad">encoded_*.flac</span>
        (${t("по файлу на уровень сложности", "one file per difficulty level")}).
        ${t("Исходник удаляется с сервера после обработки.", "The source is deleted from the server after processing.")}
      </p>
      <input type="file" id="file" accept=".flac,.wav,.aif,.aiff,.m4a,.alac,.wv,.ape,audio/*" hidden>
      <div class="dropzone" id="drop">${t("<b>Перетащите файл сюда</b> или нажмите, чтобы выбрать", "<b>Drop a file here</b> or click to choose one")}</div>
      <div id="form" class="hidden" style="margin-top:20px">
        <div class="row" style="margin-bottom:12px"><span class="pill accent" id="fname"></span><span class="faint" id="fsize"></span>
          <span class="spacer"></span><button class="btn btn-ghost btn-sm" id="reset">${t("Другой файл", "Another file")}</button></div>
        <audio id="local" controls></audio>
        <div class="clip-range" title="${t("Выбранный отрывок", "Selected clip")}"><div id="range"></div></div>
        <div class="grid grid-3" style="margin-top:18px">
          <div class="field"><label>${t("Исполнитель", "Artist")}</label><input class="input" id="artist" placeholder="Pink Floyd"></div>
          <div class="field"><label>${t("Название", "Title")}</label><input class="input" id="title" placeholder="Time"></div>
          <div class="field"><label>${t("Начало отрывка (м:сс или секунды)", "Clip start (m:ss or seconds)")}</label>
            <div class="row" style="flex-wrap:nowrap"><input class="input mono" id="start" value="0:00">
              <button class="btn btn-ghost btn-sm" id="usepos" title="${t("Взять текущую позицию плеера", "Use the player's current position")}">◉ ${t("сейчас", "now")}</button></div></div>
        </div>
        <div class="row" style="margin-top:20px">
          <button class="btn" id="upload">${t("Загрузить и обработать", "Upload and process")}</button>
          <button class="btn btn-ghost" id="preview">▶ ${t("Прослушать отрывок", "Preview the clip")}</button>
          <span class="spacer"></span>
          <span class="faint" id="status"></span>
        </div>
        <div class="upload-progress hidden" id="prog" style="margin-top:14px"><div></div></div>
      </div>
    </div>
    <div class="card" style="margin-top:20px">
      <div class="row"><h3 style="margin:0">${t("Треки", "Tracks")}</h3><span class="spacer"></span><span class="faint" id="count"></span></div>
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
    sec.querySelector("#fsize").textContent = `${(f.size / 1048576).toFixed(1)} ${t("МБ", "MB")}`;
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
    if (isNaN(s)) return toast(t("Неверное время начала", "Invalid start time"), true);
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
    if (!sec.querySelector("#title").value.trim()) return toast(t("Укажите название", "Enter a title"), true);
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
      setStatus(`${t("Загрузка", "Uploading")} ${Math.round(p)}%`);
      if (e.loaded === e.total) {
        prog.classList.add("indeterminate");
        prog.firstElementChild.style.width = "";
        setStatus(t("Нарезка и кодирование…", "Cutting and encoding…"));
      }
    };
    xhr.onload = () => {
      btn.disabled = false;
      prog.classList.add("hidden");
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status === 201) {
        toast(`${t("Добавлено", "Added")}: ${data.title}`);
        sec.querySelector("#reset").click();
        loadTracks();
      } else {
        setStatus("");
        toast(data.error || `${t("Ошибка", "Error")} ${xhr.status}`, true);
      }
    };
    xhr.onerror = () => {
      btn.disabled = false;
      prog.classList.add("hidden");
      setStatus("");
      toast(t("Сетевая ошибка при загрузке", "Network error during upload"), true);
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
  const active = tracks.filter((track) => track.active).length;
  document.getElementById("count").textContent = t(`${active} активных из ${tracks.length}`, `${active} of ${tracks.length} active`);
  if (!tracks.length) {
    box.innerHTML = `<p class="faint">${t("Пока пусто. Загрузите первый трек.", "Nothing here yet. Upload the first track.")}</p>`;
    return;
  }
  box.innerHTML = `<div class="table-wrap"><table class="table">
    <thead><tr><th>${t("Трек", "Track")}</th><th>${t("Формат", "Format")}</th><th>${t("Отрывок", "Clip")}</th><th title="${t("Только средний и сложный уровни", "Medium and hard levels only")}">${t("Угадали", "Guessed")}<div class="faint" style="font-size:11px;font-weight:500">${t("без лёгкого", "excl. easy")}</div></th><th>${t("Прослушать", "Listen")}</th><th>${t("Активен", "Active")}</th><th></th></tr></thead>
    <tbody>${tracks.map((track) => `
      <tr class="${track.active ? "" : "inactive"}" data-id="${track.id}">
        <td><b>${esc(track.title)}</b><div class="faint" style="font-size:13px">${esc(track.artist) || "—"}</div></td>
        <td class="mono" style="font-size:12.5px;white-space:nowrap">${track.bit_depth} bit / ${(track.sample_rate / 1000).toLocaleString(LOCALE)} kHz<div class="faint">${track.channels} ch · ${esc(track.source_codec)} · ${(track.file_size / 1048576).toFixed(1)} ${t("МБ", "MB")}</div></td>
        <td class="mono" style="font-size:13px;white-space:nowrap">${fmtTime(track.start_seconds)}–${fmtTime(track.start_seconds + track.clip_seconds)}</td>
        <td class="mono" style="font-size:13px">${track.times_played ? `${Math.round((track.times_correct / track.times_played) * 100)}% <span class="faint">(${track.times_correct}/${track.times_played})</span>` : `<span class="faint">—</span>`}</td>
        <td><div class="mini-play">
          <button data-play="lossless">lossless</button>${cfg.difficulties.map((l) =>
            `<button data-play="${esc(l.name)}" title="${esc(levelTitle(l.name))}">${l.kbps}</button>`).join("")}
        </div></td>
        <td><label class="switch"><input type="checkbox" data-act="toggle" ${track.active ? "checked" : ""}><span></span></label></td>
        <td style="white-space:nowrap"><button class="btn btn-ghost btn-sm" data-act="edit">✎</button>
          <button class="btn btn-danger btn-sm" data-act="delete">${t("Удалить", "Delete")}</button></td>
      </tr>`).join("")}</tbody></table></div>`;

  const byId = Object.fromEntries(tracks.map((track) => [track.id, track]));
  let playing = null;
  box.querySelectorAll("tr[data-id]").forEach((tr) => {
    const track = byId[tr.dataset.id];
    tr.querySelectorAll("[data-play]").forEach((b) => (b.onclick = () => {
      box.querySelectorAll("[data-play]").forEach((x) => x.classList.remove("on"));
      const key = `${track.id}/${b.dataset.play}`;
      if (playing === key && !previewAudio.paused) { previewAudio.pause(); playing = null; return; }
      // Switching sides of the same track keeps the position.
      const pos = playing && playing.startsWith(`${track.id}/`) ? previewAudio.currentTime : 0;
      previewAudio.src = `/api/admin/tracks/${track.id}/audio/${b.dataset.play}`;
      previewAudio.addEventListener("loadedmetadata", () => (previewAudio.currentTime = pos), { once: true });
      previewAudio.play();
      playing = key;
      b.classList.add("on");
    }));
    tr.querySelector('[data-act="toggle"]').onchange = async (e) => {
      try {
        await api(`/api/admin/tracks/${track.id}`, { method: "PATCH", json: { artist: track.artist, title: track.title, active: e.target.checked } });
        loadTracks();
      } catch (err) { toast(err.message, true); e.target.checked = !e.target.checked; }
    };
    tr.querySelector('[data-act="edit"]').onclick = async () => {
      const artist = prompt(t("Исполнитель", "Artist"), track.artist);
      if (artist === null) return;
      const title = prompt(t("Название", "Title"), track.title);
      if (title === null || !title.trim()) return;
      try {
        await api(`/api/admin/tracks/${track.id}`, { method: "PATCH", json: { artist, title, active: track.active } });
        loadTracks();
      } catch (err) { toast(err.message, true); }
    };
    tr.querySelector('[data-act="delete"]').onclick = async () => {
      if (!confirm(t(`Удалить «${track.title}» вместе с файлами? Результаты прошлых тестов сохранятся.`,
        `Delete “${track.title}” and its files? Past test results will be kept.`))) return;
      try {
        await api(`/api/admin/tracks/${track.id}`, { method: "DELETE" });
        toast(t("Трек удалён", "Track deleted"));
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
      <div class="card"><div class="eyebrow">${t("Пользователей", "Users")}</div><div class="big-number" style="margin-top:8px">${users.length}</div></div>
      <div class="card"><div class="eyebrow">${t("Прошли тест", "Took the test")}</div><div class="big-number" style="margin-top:8px">${played.length}</div></div>
      <div class="card"><div class="eyebrow">${t("Средний результат", "Average score")}</div><div class="big-number" style="margin-top:8px">${Math.round(avg)}%</div>
        <div class="faint" style="font-size:13px;margin-top:6px">${t("случайное угадывание — 25%", "random guessing is 25%")}</div></div>
    </div>
    <div class="card" style="margin-top:20px"><div class="table-wrap"><table class="table">
      <thead><tr><th>${t("Пользователь", "User")}</th><th>${t("Попыток", "Attempts")}</th><th>${t("Лучший", "Best")}</th><th>${t("Средний", "Average")}</th><th>${t("Последний тест", "Last test")}</th><th>${t("Регистрация", "Signed up")}</th></tr></thead>
      <tbody>${users.map((u) => `<tr class="${u.attempts ? "user-row" : ""}" data-id="${u.id}">
        <td><div class="row" style="flex-wrap:nowrap">${u.picture ? `<img class="avatar" src="${esc(u.picture)}" alt="" referrerpolicy="no-referrer">` : ""}
          <div>${u.guest ? `<b>${t("Гость", "Guest")} #${u.id}</b><div class="faint" style="font-size:13px">${t("без Google-аккаунта", "no Google account")}</div>`
            : `<b>${esc(u.name) || "—"}</b><div class="faint" style="font-size:13px">${esc(u.email)}</div>`}</div></div></td>
        <td class="mono">${u.attempts}</td>
        <td class="mono">${u.best_score ?? "—"}</td>
        <td class="mono">${u.avg_percent != null ? Math.round(u.avg_percent) + "%" : "—"}</td>
        <td>${u.last_played ? fmtDate(u.last_played) : '<span class="faint">—</span>'}</td>
        <td class="faint">${fmtDate(u.created_at, false)}</td>
      </tr>`).join("")}</tbody></table></div></div>`;

  // Clicking a user who has played opens their attempts under the row.
  sec.querySelectorAll("tr.user-row").forEach((tr) => (tr.onclick = () => {
    const open = tr.nextElementSibling?.classList.contains("user-detail");
    if (open) { tr.nextElementSibling.remove(); tr.classList.remove("open"); return; }
    tr.classList.add("open");
    const detail = document.createElement("tr");
    detail.className = "user-detail";
    detail.innerHTML = `<td colspan="6"><div class="spinner" style="margin:16px auto"></div></td>`;
    tr.after(detail);
    loadUserAttempts(tr.dataset.id, detail.firstElementChild);
  }));
}

// Short labels for the four answers (see answerKinds in store/quiz.go).
const ANSWER_SHORT = {
  1: t("1-й lossless", "1st lossless"),
  2: t("2-й lossless", "2nd lossless"),
  3: t("оба lossless", "both lossless"),
  4: t("оба AAC", "both AAC"),
};

async function loadUserAttempts(userID, cell) {
  let attempts;
  try {
    attempts = await api(`/api/admin/users/${userID}/attempts`);
  } catch (e) {
    cell.innerHTML = `<div class="notice error">${esc(e.message)}</div>`;
    return;
  }
  if (!attempts.length) {
    cell.innerHTML = `<p class="faint">${t("Завершённых попыток нет.", "No finished attempts.")}</p>`;
    return;
  }
  cell.innerHTML = attempts.map((a, i) => `
    <details class="attempt"${i === 0 ? " open" : ""}>
      <summary>
        <span>${fmtDate(a.finished_at)}</span>
        <span class="pill level-pill level-${esc(a.difficulty)}">${esc(levelTitle(a.difficulty))} · ${levelKbps(cfg.difficulties, a.difficulty)} kbps</span>
        <b class="mono">${a.score}/${a.total}</b>
        <span class="faint mono">${Math.round((a.score / a.total) * 100)}%</span>
      </summary>
      <ul class="result-list">${(a.questions || []).map((q) => {
        const ok = q.user_answer === q.correct_answer;
        return `<li>
          <span class="mark ${ok ? "ok" : "bad"}">${ok ? "✓" : "✕"}</span>
          <div>
            <div><b>${esc(q.title)}</b>${q.artist ? ` <span class="faint">— ${esc(q.artist)}</span>` : ""}</div>
            <div class="answers">${t("Ответ", "Answer")}: ${esc(ANSWER_SHORT[q.user_answer] || "—")}
              ${ok ? "" : ` · <span style="color:var(--ok)">${t("верно", "correct")}: ${esc(ANSWER_SHORT[q.correct_answer])}</span>`}</div>
          </div>
        </li>`;
      }).join("")}</ul>
    </details>`).join("");
}
