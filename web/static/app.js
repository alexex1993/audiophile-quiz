// Quiz single-page app. Routes: #/ (home), #/quiz/:id, #/result/:id

const OPTIONS = [
  { n: 1, text: "Первый файл — lossless", hint: "второй — пережатый" },
  { n: 2, text: "Второй файл — lossless", hint: "первый — пережатый" },
  { n: 3, text: "Оба файла — lossless", hint: "пережатого нет" },
  { n: 4, text: "Оба файла — пережатые", hint: "AAC 128 kbps в обоих" },
];

const app = document.getElementById("app");
const nav = document.getElementById("nav");
let me = null;
let group = null;
let keyHandler = null;

window.addEventListener("hashchange", route);
route();

async function route() {
  group?.destroy();
  group = null;
  if (keyHandler) document.removeEventListener("keydown", keyHandler);
  keyHandler = null;

  try {
    me = await api("/api/me");
  } catch (e) {
    if (e.status === 401) return renderLanding(await api("/api/config").catch(() => null));
    return renderError(e);
  }
  renderNav();

  const [, view, id] = location.hash.replace(/^#\/?/, "/").split("/");
  try {
    if (view === "quiz" && id) return await renderQuiz(Number(id));
    if (view === "result" && id) return await renderResult(Number(id));
    await renderHome();
  } catch (e) {
    renderError(e);
  }
  window.scrollTo(0, 0);
}

function renderNav() {
  nav.innerHTML = `
    ${me.is_admin ? `<a class="btn btn-ghost btn-sm" href="/admin">Админка</a>` : ""}
    <span class="user-chip">
      ${me.user.picture ? `<img class="avatar" src="${esc(me.user.picture)}" alt="" referrerpolicy="no-referrer">` : ""}
      <span class="hide-sm">${esc(me.user.name || me.user.email)}</span>
    </span>
    <button class="btn btn-ghost btn-sm" id="logout">Выйти</button>`;
  nav.querySelector("#logout").onclick = logout;
}

function renderError(e) {
  app.innerHTML = `<div class="notice error">${esc(e.message)}</div>
    <p><a href="#/">← На главную</a></p>`;
}

// ---------- landing ----------

function renderLanding(cfg) {
  cfg = cfg || { attempts_per_week: 3, questions_per_quiz: 12, clip_seconds: 30, aac_bitrate: "128k" };
  const kbps = cfg.aac_bitrate.replace(/k$/i, "");
  nav.innerHTML = `<a class="btn btn-sm" href="/auth/google/login">Войти</a>`;
  const bars = Array.from({ length: 28 }, (_, i) =>
    `<span style="height:${30 + Math.round(60 * Math.abs(Math.sin(i * 0.7)))}px;animation-delay:${(i * 0.07).toFixed(2)}s"></span>`).join("");
  app.innerHTML = `
    <section class="hero">
      <div class="eyebrow">Слепой тест · ${cfg.questions_per_quiz} ${plural(cfg.questions_per_quiz, "трек", "трека", "треков")} · ${cfg.attempts_per_week} ${plural(cfg.attempts_per_week, "попытка", "попытки", "попыток")} в неделю</div>
      <h1>Вы правда слышите<br>разницу с lossless?</h1>
      <p class="lead">Аудиофилы уверены, что отличат оригинал от сжатого файла на слух. Проверьте себя:
        два ${cfg.clip_seconds}-секундных отрывка одного трека — угадайте, где lossless, а где AAC ${kbps} kbps.</p>
      <a class="btn btn-google btn-lg" href="/auth/google/login">
        <svg viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>
        Войти через Google и начать
      </a>
      <div class="hero-wave">${bars}</div>
      <div class="spec-strip">
        <span class="pill ok">WAV · исходные bit depth и sample rate</span>
        <span class="pill bad">AAC ${kbps} kbps → WAV</span>
        <span class="pill accent">одинаковый размер и формат файлов</span>
      </div>
    </section>
    <section class="grid grid-3 steps">
      <div class="card step"><div class="step-num">1</div><h3>Слушайте</h3>
        <p>Два отрывка одного трека. Переключайтесь между ними — воспроизведение продолжится с того же места.</p></div>
      <div class="card step"><div class="step-num">2</div><h3>Выбирайте</h3>
        <p>Lossless может быть первый, второй, оба — или ни одного. Четыре варианта, угадать случайно — 25%.</p></div>
      <div class="card step"><div class="step-num">3</div><h3>Узнайте правду</h3>
        <p>После ${cfg.questions_per_quiz} ${plural(cfg.questions_per_quiz, "трека", "треков", "треков")} — счёт, разбор ответов и шанс, что такой результат получился бы случайно.</p></div>
    </section>`;
}

// ---------- home ----------

async function renderHome() {
  const history = await api("/api/quiz/history");
  const q = me.quota;
  const unfinished = q.unfinished_attempt_id;
  const canStart = unfinished || ((q.unlimited || q.left > 0) && me.tracks_available > 0);
  const firstName = (me.user.name || "").split(" ")[0];

  let startNote = "";
  if (unfinished) startNote = "У вас есть незавершённая попытка — продолжите с того же места.";
  else if (me.tracks_available === 0) startNote = "Библиотека треков пока пуста — загляните позже.";
  else if (!q.unlimited && q.left === 0) startNote = `Лимит на неделю исчерпан. Следующая попытка — ${fmtDate(q.next_slot)}.`;
  else startNote = `${me.questions_per_quiz} ${plural(me.questions_per_quiz, "трек", "трека", "треков")} в случайном порядке. Наушники и тишина приветствуются.`;

  app.innerHTML = `
    <section class="welcome">
      <div class="eyebrow">Личный кабинет</div>
      <h1>Привет${firstName ? ", " + esc(firstName) : ""}!</h1>
      <p class="muted">Готовы проверить свой аудиофильский слух?</p>
    </section>
    <div class="grid grid-2" style="margin-top:24px">
      <div class="card">
        <div class="eyebrow">Попытки на этой неделе</div>
        ${q.unlimited ? `
        <div class="row" style="margin-top:10px;align-items:flex-end">
          <div class="big-number">∞</div><div class="muted" style="padding-bottom:6px">без ограничений</div>
        </div>
        <p class="faint" style="font-size:13px;margin:14px 0 0">Для администраторов лимит попыток не действует. За 7 дней пройдено: ${q.used}.</p>` : `
        <div class="row" style="margin-top:10px;align-items:flex-end">
          <div class="big-number">${q.left}</div><div class="muted" style="padding-bottom:6px">из ${q.limit} доступно</div>
        </div>
        <div class="quota-dots">${Array.from({ length: q.limit }, (_, i) => `<span class="${i < q.left ? "on" : ""}"></span>`).join("")}</div>
        <p class="faint" style="font-size:13px;margin:0">Окно — 7 дней с момента каждой попытки${q.next_slot && q.used > 0 ? `. Ближайшая освободится ${fmtDate(q.next_slot)}` : ""}.</p>`}
      </div>
      <div class="card" style="display:flex;flex-direction:column;justify-content:space-between;gap:18px">
        <div>
          <div class="eyebrow">${unfinished ? "Продолжить" : "Новый тест"}</div>
          <p class="muted" style="margin:10px 0 0">${esc(startNote)}</p>
        </div>
        <div><button class="btn btn-lg" id="start" ${canStart ? "" : "disabled"}>${unfinished ? "Продолжить тест" : "Начать тест"}</button></div>
      </div>
    </div>
    <div class="card" style="margin-top:20px">
      <h3>История</h3>
      ${history.length ? `<ul class="history">${history.map((a) => `
        <li data-id="${a.id}">
          <span class="score-badge">${a.score}/${a.total}</span>
          <span>${fmtDate(a.finished_at)}</span>
          <span class="spacer"></span>
          <span class="faint">${Math.round((a.score / a.total) * 100)}% →</span>
        </li>`).join("")}</ul>` : `<p class="faint">Пока ни одного завершённого теста.</p>`}
    </div>`;

  app.querySelector("#start").onclick = async (e) => {
    e.target.disabled = true;
    try {
      const a = await api("/api/quiz/start", { method: "POST" });
      location.hash = `#/quiz/${a.id}`;
    } catch (err) {
      toast(err.message, true);
      e.target.disabled = false;
    }
  };
  app.querySelectorAll(".history li").forEach((li) => (li.onclick = () => (location.hash = `#/result/${li.dataset.id}`)));
}

// ---------- quiz ----------

async function renderQuiz(id) {
  const attempt = await api(`/api/quiz/${id}`);
  if (attempt.finished_at) {
    location.hash = `#/result/${id}`;
    return;
  }
  const qs = attempt.questions;
  let idx = qs.findIndex((q) => !q.user_answer);
  if (idx < 0) idx = qs.length - 1;

  const show = () => {
    group?.destroy();
    group = new PlayerGroup();
    const q = qs[idx];
    const answered = qs.filter((x) => x.user_answer).length;
    let selected = q.user_answer || 0;
    const willFinish = qs.every((x, i) => i === idx || x.user_answer);

    app.innerHTML = `
      <div class="progress"><div style="width:${(answered / qs.length) * 100}%"></div></div>
      <div class="q-head">
        <div class="eyebrow">Трек</div>
        <div class="counter">${idx + 1} / ${qs.length}</div>
      </div>
      <h2 class="track-name">${esc(q.title)}</h2>
      ${q.artist ? `<p class="track-artist">${esc(q.artist)}</p>` : ""}
      <div class="grid grid-2 players" id="players"></div>
      <div class="card">
        <div class="question-title">Выберите верное утверждение:</div>
        <div class="options">${OPTIONS.map((o) => `
          <button class="option ${selected === o.n ? "selected" : ""}" data-n="${o.n}">
            <span class="num">${o.n}</span><span>${o.text}<small>${o.hint}</small></span>
          </button>`).join("")}
        </div>
        <div class="quiz-actions">
          <div class="dots">${qs.map((x, i) => `<button class="${x.user_answer ? "answered" : ""} ${i === idx ? "current" : ""}" data-i="${i}">${i + 1}</button>`).join("")}</div>
          <div class="row">
            <button class="btn btn-ghost" id="prev" ${idx === 0 ? "disabled" : ""}>Назад</button>
            <button class="btn" id="next" ${selected ? "" : "disabled"}>${willFinish ? "Завершить тест" : "Ответить"}</button>
          </div>
        </div>
      </div>
      <p class="faint center" style="font-size:13px;margin-top:18px">
        Клавиши: <span class="kbd">A</span> / <span class="kbd">B</span> — первый / второй файл,
        <span class="kbd">Пробел</span> — пауза, <span class="kbd">1–4</span> — ответ, <span class="kbd">Enter</span> — дальше
      </p>`;

    const players = app.querySelector("#players");
    players.append(group.add(`/api/audio/${q.token_a}`, "Первый файл", "WAV · 30 сек", "A"));
    players.append(group.add(`/api/audio/${q.token_b}`, "Второй файл", "WAV · 30 сек", "B"));

    const nextBtn = app.querySelector("#next");
    const select = (n) => {
      selected = n;
      app.querySelectorAll(".option").forEach((b) => b.classList.toggle("selected", Number(b.dataset.n) === n));
      nextBtn.disabled = false;
    };
    app.querySelectorAll(".option").forEach((b) => (b.onclick = () => select(Number(b.dataset.n))));

    const submit = async () => {
      if (!selected || nextBtn.disabled) return;
      nextBtn.disabled = true;
      try {
        if (q.user_answer !== selected) {
          await api(`/api/quiz/${id}/answer`, { method: "POST", json: { position: q.position, answer: selected } });
          q.user_answer = selected;
        }
        const firstOpen = qs.findIndex((x) => !x.user_answer);
        if (firstOpen < 0) {
          await api(`/api/quiz/${id}/finish`, { method: "POST" });
          location.hash = `#/result/${id}`;
          return;
        }
        idx = idx + 1 < qs.length && !qs[idx + 1].user_answer ? idx + 1 : firstOpen;
        show();
        window.scrollTo({ top: 0, behavior: "smooth" });
      } catch (err) {
        toast(err.message, true);
        nextBtn.disabled = false;
      }
    };
    nextBtn.onclick = submit;
    app.querySelector("#prev").onclick = () => { idx--; show(); };
    app.querySelectorAll(".dots button").forEach((b) => (b.onclick = () => { idx = Number(b.dataset.i); show(); }));

    if (keyHandler) document.removeEventListener("keydown", keyHandler);
    keyHandler = (e) => {
      if (e.target.closest("input, textarea") || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "a" || k === "ф") group.toggleIndex(0);
      else if (k === "b" || k === "и") group.toggleIndex(1);
      else if (k === " ") { e.preventDefault(); group.active ? group.stop() : group.toggleIndex(0); }
      else if (["1", "2", "3", "4"].includes(k)) select(Number(k));
      else if (k === "enter") submit();
    };
    document.addEventListener("keydown", keyHandler);
  };
  show();
}

// ---------- results ----------

// Probability of scoring at least k out of n by pure guessing (p = 1/4).
function chanceOfGuessing(k, n) {
  const binom = (n, k) => { let r = 1; for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i; return r; };
  let p = 0;
  for (let i = k; i <= n; i++) p += binom(n, i) * 0.25 ** i * 0.75 ** (n - i);
  return p;
}

function verdict(score, total) {
  const r = score / total;
  if (r >= 0.9) return ["Золотые уши", "Такой результат почти невозможно получить случайно. Вы действительно слышите кодек."];
  if (r >= 0.67) return ["Чуткий слух", "Вы заметно лучше случайного угадывания — разница для вас реальна."];
  if (r >= 0.42) return ["Что-то слышите", "Чуть лучше монетки. Может, дело в наушниках — или в удаче."];
  return ["Уровень случайности", "Результат в пределах случайного угадывания. AAC 128 kbps звучит для вас как оригинал — и это нормально."];
}

const KIND_LABEL = { lossless: "lossless", aac: "AAC" };

async function renderResult(id) {
  const a = await api(`/api/quiz/${id}`);
  if (!a.finished_at) {
    location.hash = `#/quiz/${id}`;
    return;
  }
  const pct = a.score / a.total;
  const [title, text] = verdict(a.score, a.total);
  const chance = chanceOfGuessing(a.score, a.total);
  const chanceText = chance < 0.001 ? "< 0,1%" : `${(chance * 100).toLocaleString("ru-RU", { maximumFractionDigits: 1 })}%`;
  const C = 2 * Math.PI * 88;

  app.innerHTML = `
    <section class="result-hero">
      <div class="score-ring">
        <svg viewBox="0 0 200 200">
          <defs><linearGradient id="rg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3b82f6"/><stop offset="1" stop-color="#38bdf8"/></linearGradient></defs>
          <circle cx="100" cy="100" r="88" fill="none" stroke="rgba(125,175,255,.15)" stroke-width="14"/>
          <circle id="ring" cx="100" cy="100" r="88" fill="none" stroke="url(#rg)" stroke-width="14" stroke-linecap="round"
            stroke-dasharray="${C}" stroke-dashoffset="${C}" style="transition:stroke-dashoffset 1.2s ease"/>
        </svg>
        <div class="val"><div><b>${a.score}<span style="font-size:24px;color:var(--text-dim)">/${a.total}</span></b><span>${Math.round(pct * 100)}% верно</span></div></div>
      </div>
      <div class="eyebrow">Результат · ${fmtDate(a.finished_at)}</div>
      <h1 class="verdict">${title}</h1>
      <p class="muted" style="max-width:560px;margin:10px auto 0">${text}</p>
      <div class="spec-strip">
        <span class="pill accent">случайно угадать ≥ ${a.score} из ${a.total}: ${chanceText}</span>
        <span class="pill">ожидание при угадывании: ${a.total / 4}</span>
      </div>
    </section>
    <div class="card" style="margin-top:28px">
      <h3>Разбор по трекам</h3>
      <p class="faint" style="margin-top:-6px;font-size:14px">Теперь можно переслушать — подписи раскрыты.</p>
      <ul class="result-list">${a.questions.map((q) => {
        const ok = q.user_answer === q.correct_answer;
        return `<li>
          <span class="mark ${ok ? "ok" : "bad"}">${ok ? "✓" : "✕"}</span>
          <div>
            <div><b>${esc(q.title)}</b>${q.artist ? ` <span class="faint">— ${esc(q.artist)}</span>` : ""}</div>
            <div class="answers">Ваш ответ: ${q.user_answer}. ${esc(OPTIONS[q.user_answer - 1].text)}
              ${ok ? "" : ` · <span style="color:var(--ok)">верно: ${q.correct_answer}. ${esc(OPTIONS[q.correct_answer - 1].text)}</span>`}</div>
          </div>
          <div class="mini-play" data-pos="${q.position}">
            <button data-token="${q.token_a}">1 · ${KIND_LABEL[q.kind_a]}</button>
            <button data-token="${q.token_b}">2 · ${KIND_LABEL[q.kind_b]}</button>
          </div>
        </li>`;
      }).join("")}</ul>
    </div>
    <div class="row" style="justify-content:center;margin-top:26px"><a class="btn" href="#/">На главную</a></div>`;

  requestAnimationFrame(() => setTimeout(() => (app.querySelector("#ring").style.strokeDashoffset = C * (1 - pct)), 50));

  // Lightweight re-listening: one shared audio element, synced position within a track.
  const audio = new Audio();
  let current = null, currentPos = null;
  group = { destroy: () => { audio.pause(); audio.removeAttribute("src"); } };
  app.querySelectorAll(".mini-play button").forEach((b) => {
    b.onclick = () => {
      const pos = b.closest(".mini-play").dataset.pos;
      app.querySelectorAll(".mini-play button").forEach((x) => x.classList.remove("on"));
      if (current === b.dataset.token && !audio.paused) { audio.pause(); return; }
      const t = pos === currentPos ? audio.currentTime : 0;
      audio.src = `/api/audio/${b.dataset.token}`;
      audio.addEventListener("loadedmetadata", () => (audio.currentTime = t), { once: true });
      audio.play().catch((e) => toast(e.message, true));
      current = b.dataset.token;
      currentPos = pos;
      b.classList.add("on");
    };
  });
  audio.onended = () => app.querySelectorAll(".mini-play button").forEach((x) => x.classList.remove("on"));
}
