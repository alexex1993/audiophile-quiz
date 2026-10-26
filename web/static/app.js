// Quiz single-page app. Routes: #/ (home), #/quiz/:id, #/result/:id

// The four answers; the compressed clips of an attempt are AAC at kbps.
const options = (kbps) => [
  { n: 1, text: t("Первый файл — lossless", "The first clip is lossless"), hint: t("второй — пережатый", "the second is compressed") },
  { n: 2, text: t("Второй файл — lossless", "The second clip is lossless"), hint: t("первый — пережатый", "the first is compressed") },
  { n: 3, text: t("Оба файла — lossless", "Both clips are lossless"), hint: t("пережатого нет", "neither is compressed") },
  { n: 4, text: t("Оба файла — пережатые", "Both clips are compressed"), hint: t(`AAC ${kbps} kbps в обоих`, `AAC ${kbps} kbps in both`) },
];

const LEVEL_KEY = "difficulty"; // localStorage: the last level the user picked
const LOGIN_URL = "/auth/google/login";
const GOOGLE_ICON = `<svg viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>`;

// Guests (no Google account) may only play the warm-up level.
const guestLocked = (name) => me?.user.guest && name !== me.guest_difficulty;

function levelPill(name) {
  return `<span class="pill level-pill level-${esc(name)}">${esc(levelTitle(name))} · ${levelKbps(me?.difficulties, name)} kbps</span>`;
}

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
  if (me.user.guest) {
    nav.innerHTML = `
      <span class="user-chip"><span class="pill">${t("Гость", "Guest")}</span></span>
      <a class="btn btn-sm" href="${LOGIN_URL}">${t("Войти через Google", "Sign in with Google")}</a>`;
    return;
  }
  nav.innerHTML = `
    ${me.is_admin ? `<a class="btn btn-ghost btn-sm" href="/admin">${t("Админка", "Admin")}</a>` : ""}
    <span class="user-chip">
      ${me.user.picture ? `<img class="avatar" src="${esc(me.user.picture)}" alt="" referrerpolicy="no-referrer">` : ""}
      <span class="hide-sm">${esc(me.user.name || me.user.email)}</span>
    </span>
    <button class="btn btn-ghost btn-sm" id="logout">${t("Выйти", "Sign out")}</button>`;
  nav.querySelector("#logout").onclick = logout;
}

function renderError(e) {
  app.innerHTML = `<div class="notice error">${esc(e.message)}</div>
    <p><a href="#/">← ${t("На главную", "Home")}</a></p>`;
}

// ---------- landing ----------

function renderLanding(cfg) {
  cfg = cfg || { clip_seconds: 30, difficulties: DEFAULT_LEVELS };
  const kbps = cfg.difficulties.map((l) => l.kbps).join(" / ");
  // Track count per attempt depends on the level: "5–12", or one number if all agree.
  const counts = cfg.difficulties.map((l) => l.questions);
  const minQ = Math.min(...counts), maxQ = Math.max(...counts);
  const nQ = minQ === maxQ ? `${maxQ}` : `${minQ}–${maxQ}`;
  nav.innerHTML = `<a class="btn btn-sm" href="${LOGIN_URL}">${t("Войти", "Sign in")}</a>`;
  const warmup = cfg.difficulties.find((l) => l.name === (cfg.guest_difficulty || "easy"));
  const bars = Array.from({ length: 28 }, (_, i) =>
    `<span style="height:${30 + Math.round(60 * Math.abs(Math.sin(i * 0.7)))}px;animation-delay:${(i * 0.07).toFixed(2)}s"></span>`).join("");
  app.innerHTML = `
    <section class="hero">
      <div class="eyebrow">${t("Слепой тест", "Blind test")} · ${nQ} ${plural(maxQ, "трек|трека|треков", "track|tracks")}</div>
      <h1>${t("Вы правда слышите<br>разницу с lossless?", "Can you really hear<br>the difference from lossless?")}</h1>
      <p class="lead">${t(`Аудиофилы уверены, что отличат оригинал от сжатого файла на слух. Проверьте себя:
        два ${cfg.clip_seconds}-секундных отрывка одного трека — угадайте, где lossless, а где AAC.
        Три уровня сложности: ${cfg.difficulties.map((l) => `${levelTitle(l.name).toLowerCase()} — ${l.kbps} kbps, ${l.questions} ${plural(l.questions, "трек|трека|треков", "track|tracks")}`).join("; ")}.`,
        `Audiophiles are sure they can tell an original from a compressed file by ear. Test yourself:
        two ${cfg.clip_seconds}-second clips of the same track — guess which one is lossless and which is AAC.
        Three difficulty levels: ${cfg.difficulties.map((l) => `${levelTitle(l.name).toLowerCase()} — ${l.kbps} kbps, ${l.questions} ${plural(l.questions, "трек|трека|треков", "track|tracks")}`).join("; ")}.`)}</p>
      <div class="hero-actions">
        <a class="btn btn-google btn-lg" href="${LOGIN_URL}">${GOOGLE_ICON} ${t("Войти через Google и начать", "Sign in with Google and start")}</a>
        ${warmup ? `<button class="btn btn-ghost btn-lg" id="guest">${t("Попробовать без входа", "Try without signing in")}</button>` : ""}
      </div>
      ${warmup ? `<p class="faint hero-note">${t(`Без входа — только разминка: ${levelTitle(warmup.name).toLowerCase()} уровень, ${warmup.questions} ${plural(warmup.questions, "трек|трека|треков", "track|tracks")}, AAC ${warmup.kbps} kbps.`,
        `Without signing in you get the warm-up only: the ${levelTitle(warmup.name).toLowerCase()} level, ${warmup.questions} ${plural(warmup.questions, "track|tracks", "track|tracks")}, AAC ${warmup.kbps} kbps.`)}</p>` : ""}
      <div class="hero-wave">${bars}</div>
      <div class="spec-strip">
        <span class="pill ok">FLAC · ${t("исходные bit depth и sample rate", "original bit depth and sample rate")}</span>
        <span class="pill bad">FLAC → AAC ${kbps} kbps → FLAC</span>
        <span class="pill accent">${t("одинаковый размер и формат файлов", "identical file size and format")}</span>
      </div>
    </section>
    <section class="grid grid-3 steps">
      <div class="card step"><div class="step-num">1</div><h3>${t("Слушайте", "Listen")}</h3>
        <p>${t("Два отрывка одного трека. Переключайтесь между ними — воспроизведение продолжится с того же места.",
          "Two clips of the same track. Switch between them — playback continues from the same spot.")}</p></div>
      <div class="card step"><div class="step-num">2</div><h3>${t("Выбирайте", "Choose")}</h3>
        <p>${t("Lossless может быть первый, второй, оба — или ни одного. Четыре варианта, угадать случайно — 25%.",
          "Lossless may be the first, the second, both — or neither. Four options, so a random guess is right 25% of the time.")}</p></div>
      <div class="card step"><div class="step-num">3</div><h3>${t("Узнайте правду", "Learn the truth")}</h3>
        <p>${t(`После ${nQ} ${plural(maxQ, "трека|треков|треков", "track|tracks")} — счёт, разбор ответов и шанс, что такой результат получился бы случайно.`,
          `After ${nQ} ${plural(maxQ, "track|tracks", "track|tracks")} — your score, a breakdown of the answers and the chance of getting such a result by luck.`)}</p></div>
    </section>`;
  app.querySelector("#guest")?.addEventListener("click", (e) => tryAsGuest(warmup.name, e.currentTarget));
}

// tryAsGuest opens an anonymous session and starts the warm-up right away.
async function tryAsGuest(level, btn) {
  btn.disabled = true;
  try {
    await api("/auth/guest", { method: "POST" });
  } catch (err) {
    toast(err.message, true);
    btn.disabled = false;
    return;
  }
  try {
    const a = await api("/api/quiz/start", { method: "POST", json: { difficulty: level } });
    location.hash = `#/quiz/${a.id}`;
  } catch (err) {
    // The session exists now: the guest's home page explains what blocks the start.
    toast(err.message, true);
    history.replaceState(null, "", "#/");
    route();
  }
}

// ---------- home ----------

async function renderHome() {
  const history = await api("/api/quiz/history");
  const q = me.quota;
  const unfinished = q.unfinished_attempt_id;
  const canStart = unfinished || (!q.exhausted && me.tracks_available > 0);
  const firstName = (me.user.name || "").split(" ")[0];
  const guest = me.user.guest;

  const levels = me.difficulties || DEFAULT_LEVELS;
  let level = "medium";
  try { level = localStorage.getItem(LEVEL_KEY) || level; } catch {}
  if (!levels.some((l) => l.name === level)) level = "medium";
  if (guestLocked(level)) level = me.guest_difficulty;

  // Unless something blocks the start, the note follows the selected level.
  const levelNote = (name) => {
    if (guestLocked(name)) return t("Средний и сложный уровни открываются после входа через Google. Результаты разминки сохранятся в истории.",
      "The medium and hard levels open once you sign in with Google. Your warm-up results stay in your history.");
    const n = levels.find((l) => l.name === name)?.questions ?? 0;
    return `${n} ${plural(n, "трек|трека|треков", "track|tracks")} ${t("в случайном порядке. Наушники и тишина приветствуются.", "in random order. Headphones and silence are recommended.")}`;
  };
  let startNote = "";
  if (unfinished) startNote = t(`У вас есть незавершённая попытка (уровень «${levelTitle(q.unfinished_difficulty)}») — продолжите с того же места.`,
    `You have an unfinished attempt (${levelTitle(q.unfinished_difficulty).toLowerCase()} level) — continue where you left off.`);
  else if (me.tracks_available === 0) startNote = t("Библиотека треков пока пуста — загляните позже.", "The track library is empty for now — check back later.");
  else if (q.exhausted) startNote = t(`На сегодня попытки закончились. Следующая — ${fmtDate(q.next_slot)}.`, `You're out of attempts for today. Next one: ${fmtDate(q.next_slot)}.`);
  else startNote = levelNote(level);
  const noteFollowsLevel = !unfinished && me.tracks_available > 0 && !q.exhausted;

  app.innerHTML = `
    <section class="welcome">
      <div class="eyebrow">${guest ? t("Гостевой режим", "Guest mode") : t("Личный кабинет", "Your dashboard")}</div>
      <h1>${t("Привет", "Hi")}${firstName ? ", " + esc(firstName) : ""}!</h1>
      <p class="muted">${guest
        ? t("Без входа доступна только разминка. Войдите через Google, чтобы пройти средний и сложный уровни.",
          "Without signing in you can only take the warm-up. Sign in with Google to take the medium and hard levels.")
        : t("Готовы проверить свой аудиофильский слух?", "Ready to put your audiophile ears to the test?")}</p>
    </section>
    <div class="grid ${q.unlimited ? "grid-2" : ""}" style="margin-top:24px">
      ${q.unlimited ? `
      <div class="card">
        <div class="eyebrow">${t("Попытки", "Attempts")}</div>
        <div class="row" style="margin-top:10px;align-items:flex-end">
          <div class="big-number">∞</div><div class="muted" style="padding-bottom:6px">${t("без ограничений", "unlimited")}</div>
        </div>
        <p class="faint" style="font-size:13px;margin:14px 0 0">${t("Для администраторов лимит попыток не действует. За сутки начато:", "Admins have no attempt limit. Started in the last 24 hours:")} ${q.used}.</p>
      </div>` : ""}
      <div class="card" style="display:flex;flex-direction:column;justify-content:space-between;gap:18px">
        <div>
          <div class="eyebrow">${unfinished ? t("Продолжить", "Continue") : t("Новый тест", "New test")}</div>
          <p class="muted start-note" style="margin:10px 0 0">${esc(startNote)}</p>
          ${unfinished ? "" : `
          <div class="levels" role="radiogroup" aria-label="${t("Уровень сложности", "Difficulty")}">${levels.map((l) => `
            <div class="level-wrap">
              <button class="option level ${l.name === level ? "selected" : ""} ${guestLocked(l.name) ? "locked" : ""}" data-level="${esc(l.name)}" role="radio" aria-checked="${l.name === level}" aria-describedby="level-tip-${esc(l.name)}">
                <span class="num">${l.kbps}</span><span>${esc(levelTitle(l.name))}<small>AAC ${l.kbps} kbps · ${guestLocked(l.name) ? `🔒 ${t("после входа через Google", "after signing in with Google")}` : esc(LEVEL_TEXT[l.name]?.hint || "")}</small></span>
              </button>
              <div class="level-tip" role="tooltip" id="level-tip-${esc(l.name)}">${levelAbout(l)}</div>
            </div>`).join("")}
          </div>
          <div class="level-about">${levelAbout(levels.find((l) => l.name === level))}</div>`}
        </div>
        <div><button class="btn btn-lg" id="start"></button></div>
      </div>
    </div>
    <div class="card" style="margin-top:20px">
      <h3>${t("История", "History")}</h3>
      ${history.length ? `<ul class="history">${history.map((a) => `
        <li data-id="${a.id}">
          <span class="score-badge">${a.score}/${a.total}</span>
          <span class="history-meta"><span class="history-date">${fmtDate(a.finished_at)}</span>${levelPill(a.difficulty)}</span>
          <span class="history-pct faint">${Math.round((a.score / a.total) * 100)}% →</span>
        </li>`).join("")}</ul>` : `<p class="faint">${t("Пока ни одного завершённого теста.", "No finished tests yet.")}</p>`}
    </div>`;

  app.querySelectorAll(".level").forEach((b) => (b.onclick = () => {
    level = b.dataset.level;
    try { localStorage.setItem(LEVEL_KEY, level); } catch {}
    app.querySelectorAll(".level").forEach((x) => {
      x.classList.toggle("selected", x === b);
      x.setAttribute("aria-checked", x === b);
    });
    app.querySelector(".level-about").innerHTML = levelAbout(levels.find((l) => l.name === level));
    app.querySelector(".start-note").textContent = noteFollowsLevel || guestLocked(level) ? levelNote(level) : startNote;
    updateStart();
  }));
  // A level locked for a guest turns the start button into the Google sign-in.
  const startBtn = app.querySelector("#start");
  const updateStart = () => {
    const locked = !unfinished && guestLocked(level);
    startBtn.classList.toggle("btn-google", locked);
    startBtn.disabled = !locked && !canStart;
    startBtn.innerHTML = locked ? `${GOOGLE_ICON} ${t("Войти через Google", "Sign in with Google")}`
      : unfinished ? t("Продолжить тест", "Continue the test") : t("Начать тест", "Start the test");
  };
  updateStart();
  startBtn.onclick = () => (!unfinished && guestLocked(level) ? (location.href = LOGIN_URL) : startAttempt(level, startBtn));
  app.querySelectorAll(".history li").forEach((li) => (li.onclick = () => (location.hash = `#/result/${li.dataset.id}`)));
}

async function startAttempt(level, btn) {
  btn.disabled = true;
  try { localStorage.setItem(LEVEL_KEY, level); } catch {}
  try {
    const a = await api("/api/quiz/start", { method: "POST", json: { difficulty: level } });
    location.hash = `#/quiz/${a.id}`;
  } catch (err) {
    toast(err.message, true);
    btn.disabled = false;
  }
}

// levelAbout is the long description of a level: in a tooltip over its
// button, and under the picker on touch screens, which have no hover.
function levelAbout(l) {
  const text = LEVEL_TEXT[l.name] || {};
  return `<b>${esc(levelTitle(l.name))} · AAC ${l.kbps} kbps · ${l.questions} ${plural(l.questions, "трек|трека|треков", "track|tracks")}</b>
    <p>${esc(text.about || "")}</p>
    ${text.listen ? `<p class="level-listen"><span>${t("Что слушать", "What to listen for")}:</span> ${esc(text.listen)}</p>` : ""}`;
}

// ---------- quiz ----------

async function renderQuiz(id) {
  const attempt = await api(`/api/quiz/${id}`);
  if (attempt.finished_at) {
    location.hash = `#/result/${id}`;
    return;
  }
  const qs = attempt.questions;
  const opts = options(levelKbps(me.difficulties, attempt.difficulty));
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
        <div class="eyebrow">${t("Трек", "Track")}</div>
        <div class="row">${levelPill(attempt.difficulty)}<div class="counter">${idx + 1} / ${qs.length}</div></div>
      </div>
      <h2 class="track-name">${esc(q.title)}</h2>
      ${q.artist ? `<p class="track-artist">${esc(q.artist)}</p>` : ""}
      <div class="grid grid-2 players" id="players"></div>
      <div class="card">
        <div class="question-title">${t("Выберите верное утверждение:", "Pick the correct statement:")}</div>
        <div class="options">${opts.map((o) => `
          <button class="option ${selected === o.n ? "selected" : ""}" data-n="${o.n}">
            <span class="num">${o.n}</span><span>${o.text}<small>${o.hint}</small></span>
          </button>`).join("")}
        </div>
        <div class="quiz-actions">
          <div class="dots">${qs.map((x, i) => `<button class="${x.user_answer ? "answered" : ""} ${i === idx ? "current" : ""}" data-i="${i}">${i + 1}</button>`).join("")}</div>
          <div class="row">
            <button class="btn btn-ghost" id="prev" ${idx === 0 ? "disabled" : ""}>${t("Назад", "Back")}</button>
            <button class="btn" id="next" ${selected ? "" : "disabled"}>${willFinish ? t("Завершить тест", "Finish the test") : t("Ответить", "Answer")}</button>
          </div>
        </div>
      </div>
      <p class="faint center" style="font-size:13px;margin-top:18px">
        ${t("Клавиши", "Keys")}: <span class="kbd">A</span> / <span class="kbd">B</span> — ${t("первый / второй файл", "first / second clip")},
        <span class="kbd">${t("Пробел", "Space")}</span> — ${t("пауза", "pause")}, <span class="kbd">1–4</span> — ${t("ответ", "answer")}, <span class="kbd">Enter</span> — ${t("дальше", "next")}
      </p>`;

    const players = app.querySelector("#players");
    players.append(group.add(`/api/audio/${q.token_a}`, t("Первый файл", "First clip"), t("30 сек", "30 s"), "A"));
    players.append(group.add(`/api/audio/${q.token_b}`, t("Второй файл", "Second clip"), t("30 сек", "30 s"), "B"));

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

function verdict(score, total, kbps) {
  const r = score / total;
  if (r >= 0.9) return [t("Золотые уши", "Golden ears"), t("Такой результат почти невозможно получить случайно. Вы действительно слышите кодек.",
    "A result like this is almost impossible to get by chance. You really can hear the codec.")];
  if (r >= 0.67) return [t("Чуткий слух", "Keen hearing"), t("Вы заметно лучше случайного угадывания — разница для вас реальна.",
    "You are clearly better than random guessing — the difference is real for you.")];
  if (r >= 0.42) return [t("Что-то слышите", "You hear something"), t("Чуть лучше монетки. Может, дело в наушниках — или в удаче.",
    "A little better than a coin toss. Maybe it's the headphones — or luck.")];
  return [t("Уровень случайности", "Chance level"), t(`Результат в пределах случайного угадывания. AAC ${kbps} kbps звучит для вас как оригинал — и это нормально.`,
    `Your result is within random guessing. AAC ${kbps} kbps sounds like the original to you — and that's perfectly normal.`)];
}

// The easy level only checks that the service works, so its result gets no praise.
function warmupVerdict() {
  return [t("Это была разминка", "That was just a warm-up"),
    t("Лёгкий уровень нужен только чтобы убедиться, что сервис работает и звук играет. О слухе он ничего не говорит — настоящая проверка начинается на среднем и сложном уровнях.",
      "The easy level only makes sure the service works and the sound plays. It says nothing about your hearing — the real test starts at the medium and hard levels.")];
}

// After the warm-up: offer the levels that actually test hearing.
function nextLevelsCard() {
  const q = me.quota;
  const levels = (me.difficulties || DEFAULT_LEVELS).filter((l) => l.name !== "easy");
  if (me.user.guest) return guestSignInCard(levels);
  let note = "";
  if (q.unfinished_attempt_id) note = t("У вас есть незавершённая попытка — кнопка продолжит её.", "You have an unfinished attempt — the button will resume it.");
  else if (me.tracks_available === 0) note = t("Библиотека треков пока пуста — загляните позже.", "The track library is empty for now — check back later.");
  else if (q.exhausted) note = t(`На сегодня попытки закончились. Следующая — ${fmtDate(q.next_slot)}.`, `You're out of attempts for today. Next one: ${fmtDate(q.next_slot)}.`);
  const canStart = q.unfinished_attempt_id || (!q.exhausted && me.tracks_available > 0);
  return `
    <div class="card next-levels" style="margin-top:28px">
      <h3>${t("Теперь — настоящий тест", "Now for the real test")}</h3>
      <p class="muted" style="margin-top:-6px">${t("Сервис работает. Проверьте, слышите ли вы разницу там, где она действительно тонкая.",
        "The service works. Find out whether you can hear the difference where it's actually subtle.")}</p>
      ${note ? `<p class="faint" style="font-size:14px">${esc(note)}</p>` : ""}
      <div class="grid grid-2">${levels.map((l) => `
        <button class="option level" data-level="${esc(l.name)}" ${canStart ? "" : "disabled"}>
          <span class="num">${l.kbps}</span><span>${t("Пройти", "Take")} ${esc(levelTitle(l.name).toLowerCase())} ${t("уровень", "level")}<small>AAC ${l.kbps} kbps · ${esc(LEVEL_TEXT[l.name]?.hint || "")}</small></span>
        </button>`).join("")}
      </div>
    </div>`;
}

// A guest's warm-up result: the levels that test hearing need a Google account.
function guestSignInCard(levels) {
  return `
    <div class="card next-levels" style="margin-top:28px">
      <h3>${t("Теперь — настоящий тест", "Now for the real test")}</h3>
      <p class="muted" style="margin-top:-6px">${t("Сервис работает. Средний и сложный уровни — там, где разница действительно тонкая, — открываются после входа через Google. Результат разминки сохранится в вашей истории.",
        "The service works. The medium and hard levels — where the difference is actually subtle — open once you sign in with Google. Your warm-up result stays in your history.")}</p>
      <div class="grid grid-2">${levels.map((l) => `
        <a class="option level locked" href="${LOGIN_URL}">
          <span class="num">${l.kbps}</span><span>${esc(levelTitle(l.name))}<small>AAC ${l.kbps} kbps · 🔒 ${t("после входа через Google", "after signing in with Google")}</small></span>
        </a>`).join("")}
      </div>
      <div class="center" style="margin-top:20px">
        <a class="btn btn-google btn-lg" href="${LOGIN_URL}">${GOOGLE_ICON} ${t("Войти через Google и продолжить", "Sign in with Google and continue")}</a>
      </div>
    </div>`;
}

// hearingGrade rates a medium or hard result for the share card; hard gets lower
// thresholds, since anything clearly above chance at 320 kbps is impressive.
function hearingGrade(score, total, level) {
  const r = score / total;
  const [top, high, mid] = level === "hard" ? [0.75, 0.5, 0.34] : [0.9, 0.67, 0.42];
  if (r >= top) return t("У вас великолепный слух!", "You have superb hearing!");
  if (r >= high) return t("У вас отличный слух!", "You have excellent hearing!");
  if (r >= mid) return t("У вас хороший слух!", "You have good hearing!");
  return t("У вас средний слух", "You have average hearing");
}

// drawShareCard renders the result as a 1200×630 PNG-ready canvas to save or share.
async function drawShareCard(a, kbps, chanceText) {
  const W = 1200, H = 630;
  await Promise.all(["800 64px Manrope", "600 28px Manrope", "700 24px 'JetBrains Mono'"]
    .map((f) => document.fonts.load(f).catch(() => {})));
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const x = c.getContext("2d");
  const font = (w, px, mono) => `${w} ${px}px ${mono ? "'JetBrains Mono', ui-monospace, monospace" : "Manrope, system-ui, sans-serif"}`;

  let g = x.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, "#0d2257");
  g.addColorStop(1, "#040b1f");
  x.fillStyle = g;
  x.fillRect(0, 0, W, H);
  g = x.createRadialGradient(930, 300, 0, 930, 300, 420);
  g.addColorStop(0, "rgba(59,130,246,.35)");
  g.addColorStop(1, "rgba(59,130,246,0)");
  x.fillStyle = g;
  x.fillRect(0, 0, W, H);

  // Waveform along the bottom edge.
  const bars = 60, bw = W / bars;
  for (let i = 0; i < bars; i++) {
    const bh = 20 + 70 * Math.abs(Math.sin(i * 0.7)) * Math.abs(Math.cos(i * 0.23));
    x.fillStyle = `rgba(56,189,248,${0.08 + 0.1 * Math.abs(Math.sin(i * 0.31))})`;
    x.beginPath();
    x.roundRect(i * bw + bw * 0.25, H - bh, bw * 0.5, bh + 8, 4);
    x.fill();
  }

  // Brand.
  g = x.createLinearGradient(64, 56, 120, 112);
  g.addColorStop(0, "#3b82f6");
  g.addColorStop(1, "#38bdf8");
  x.fillStyle = g;
  x.beginPath();
  x.roundRect(64, 56, 56, 56, 14);
  x.fill();
  x.strokeStyle = "#fff";
  x.lineWidth = 5;
  x.lineCap = "round";
  [[4, 10, 14], [8, 6, 18], [12, 3, 21], [16, 7, 17], [20, 10, 14]].forEach(([bx, y1, y2]) => {
    x.beginPath();
    x.moveTo(64 + bx * 2.33, 56 + y1 * 2.33);
    x.lineTo(64 + bx * 2.33, 56 + y2 * 2.33);
    x.stroke();
  });
  x.fillStyle = "#e8f0ff";
  x.font = font(800, 32);
  x.textBaseline = "middle";
  x.fillText(t("Тест на аудиофила", "Audiophile Test"), 140, 85);
  x.fillStyle = "#6a83b3";
  x.font = font(600, 22);
  x.textAlign = "right";
  x.fillText(fmtDate(a.finished_at, false), W - 64, 85);
  x.textAlign = "left";

  // Verdict.
  x.textBaseline = "alphabetic";
  x.fillStyle = "#38bdf8";
  x.font = font(700, 20);
  x.fillText(t("СЛЕПОЙ ТЕСТ · LOSSLESS ПРОТИВ AAC", "BLIND TEST · LOSSLESS VS AAC"), 64, 196);
  x.fillStyle = "#ffffff";
  // Wrap the headline to the left column, shrinking it until it fits in two lines.
  let size = 64, lines;
  for (;; size -= 4) {
    x.font = font(800, size);
    lines = [];
    for (const word of hearingGrade(a.score, a.total, a.difficulty).split(" ")) {
      const last = lines[lines.length - 1];
      if (last && x.measureText(`${last} ${word}`).width <= 660) lines[lines.length - 1] = `${last} ${word}`;
      else lines.push(word);
    }
    if (lines.length <= 2 || size <= 40) break;
  }
  lines.forEach((l, i) => x.fillText(l, 64, 272 + i * size * 1.15));
  let y = 272 + (lines.length - 1) * size * 1.15 + 80;

  const levelColor = a.difficulty === "hard" ? "#fbbf24" : "#38bdf8";
  const pill = `${levelTitle(a.difficulty)} · AAC ${kbps} kbps`;
  x.font = font(700, 22);
  const pw = x.measureText(pill).width + 40;
  x.strokeStyle = levelColor;
  x.lineWidth = 2;
  x.beginPath();
  x.roundRect(64, y, pw, 46, 23);
  x.stroke();
  x.fillStyle = levelColor;
  x.textBaseline = "middle";
  x.fillText(pill, 84, y + 24);
  y += 84;
  x.fillStyle = "#9db3dc";
  x.font = font(600, 22);
  x.fillText(t(`Шанс угадать столько же случайно: ${chanceText}`, `Chance of scoring this by guessing: ${chanceText}`), 64, y);

  // Score ring.
  const cx = 930, cy = 320, r = 150;
  x.lineWidth = 26;
  x.strokeStyle = "rgba(125,175,255,.15)";
  x.beginPath();
  x.arc(cx, cy, r, 0, 2 * Math.PI);
  x.stroke();
  if (a.score > 0) {
    g = x.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
    g.addColorStop(0, "#3b82f6");
    g.addColorStop(1, "#38bdf8");
    x.strokeStyle = g;
    x.beginPath();
    x.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * (a.score / a.total));
    x.stroke();
  }
  x.textAlign = "center";
  x.textBaseline = "alphabetic";
  x.font = font(800, 96);
  const sw = x.measureText(String(a.score)).width;
  x.font = font(800, 44);
  const tw = x.measureText(`/${a.total}`).width;
  x.font = font(800, 96);
  x.fillStyle = "#ffffff";
  x.fillText(String(a.score), cx - tw / 2, cy + 20);
  x.font = font(800, 44);
  x.fillStyle = "#9db3dc";
  x.fillText(`/${a.total}`, cx + sw / 2, cy + 20);
  x.font = font(700, 24, true);
  x.fillText(`${Math.round((a.score / a.total) * 100)}% ${t("верно", "correct")}`, cx, cy + 66);

  x.textAlign = "left";
  x.fillStyle = "#e8f0ff";
  x.font = font(700, 24, true);
  x.fillText(location.host, 64, H - 48);
  return c;
}

function shareCardSection() {
  return `
    <div class="card share-card" style="margin-top:28px">
      <h3>${t("Поделитесь результатом", "Share your result")}</h3>
      <div class="share-preview"><div class="spinner"></div></div>
      <div class="row" style="justify-content:center;margin-top:16px">
        <a class="btn" id="share-download" download>${t("Скачать картинку", "Download image")}</a>
        <button class="btn btn-ghost" id="share-native" hidden>${t("Поделиться", "Share")}</button>
      </div>
    </div>`;
}

async function fillShareCard(a, kbps, chanceText) {
  const box = app.querySelector(".share-preview");
  const canvas = await drawShareCard(a, kbps, chanceText);
  const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
  if (!box.isConnected || !blob) return;
  const url = URL.createObjectURL(blob);
  const name = `audiophile-test-${a.difficulty}-${a.score}-${a.total}.png`;
  box.innerHTML = `<img src="${url}" alt="${esc(hearingGrade(a.score, a.total, a.difficulty))} — ${a.score}/${a.total}">`;
  const dl = app.querySelector("#share-download");
  dl.href = url;
  dl.download = name;
  const file = new File([blob], name, { type: "image/png" });
  const share = app.querySelector("#share-native");
  if (navigator.canShare?.({ files: [file] })) {
    share.hidden = false;
    share.onclick = () => navigator.share({ files: [file], title: t("Тест на аудиофила", "Audiophile Test") }).catch(() => {});
  }
  const prev = group;
  group = { destroy: () => { prev?.destroy(); URL.revokeObjectURL(url); } };
}

const KIND_LABEL = { lossless: "lossless", aac: "AAC" };

async function renderResult(id) {
  const a = await api(`/api/quiz/${id}`);
  if (!a.finished_at) {
    location.hash = `#/quiz/${id}`;
    return;
  }
  const pct = a.score / a.total;
  const kbps = levelKbps(me.difficulties, a.difficulty);
  const opts = options(kbps);
  const warmup = a.difficulty === "easy";
  const [title, text] = warmup ? warmupVerdict() : verdict(a.score, a.total, kbps);
  const chance = chanceOfGuessing(a.score, a.total);
  const chanceText = chance < 0.001 ? t("< 0,1%", "< 0.1%") : `${(chance * 100).toLocaleString(LOCALE, { maximumFractionDigits: 1 })}%`;
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
        <div class="val"><div><b>${a.score}<span style="font-size:24px;color:var(--text-dim)">/${a.total}</span></b><span>${Math.round(pct * 100)}% ${t("верно", "correct")}</span></div></div>
      </div>
      <div class="eyebrow">${t("Результат", "Result")} · ${fmtDate(a.finished_at)}</div>
      <div style="margin-top:10px">${levelPill(a.difficulty)}</div>
      <h1 class="verdict">${title}</h1>
      <p class="muted" style="max-width:560px;margin:10px auto 0">${text}</p>
      ${warmup ? "" : `<div class="spec-strip">
        <span class="pill accent">${t(`случайно угадать ≥ ${a.score} из ${a.total}`, `chance of guessing ≥ ${a.score} of ${a.total}`)}: ${chanceText}</span>
        <span class="pill">${t("ожидание при угадывании", "expected by guessing")}: ${(a.total / 4).toLocaleString(LOCALE)}</span>
      </div>`}
    </section>
    ${warmup ? nextLevelsCard() : shareCardSection()}
    <div class="card" style="margin-top:28px">
      <h3>${t("Разбор по трекам", "Track by track")}</h3>
      <p class="faint" style="margin-top:-6px;font-size:14px">${t("Теперь можно переслушать — подписи раскрыты.", "You can listen again now — the clips are labelled.")}</p>
      <ul class="result-list">${a.questions.map((q) => {
        const ok = q.user_answer === q.correct_answer;
        return `<li>
          <span class="mark ${ok ? "ok" : "bad"}">${ok ? "✓" : "✕"}</span>
          <div>
            <div><b>${esc(q.title)}</b>${q.artist ? ` <span class="faint">— ${esc(q.artist)}</span>` : ""}</div>
            <div class="answers">${t("Ваш ответ", "Your answer")}: ${q.user_answer}. ${esc(opts[q.user_answer - 1].text)}
              ${ok ? "" : ` · <span style="color:var(--ok)">${t("верно", "correct")}: ${q.correct_answer}. ${esc(opts[q.correct_answer - 1].text)}</span>`}</div>
          </div>
          <div class="mini-play" data-pos="${q.position}">
            <button data-token="${q.token_a}">1 · ${KIND_LABEL[q.kind_a]}</button>
            <button data-token="${q.token_b}">2 · ${KIND_LABEL[q.kind_b]}</button>
          </div>
        </li>`;
      }).join("")}</ul>
    </div>
    <div class="row" style="justify-content:center;margin-top:26px"><a class="btn" href="#/">${t("На главную", "Home")}</a></div>`;

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

  if (warmup) app.querySelectorAll(".next-levels button.level").forEach((b) => (b.onclick = () => startAttempt(b.dataset.level, b)));
  else fillShareCard(a, kbps, chanceText).catch(() => app.querySelector(".share-card")?.remove());
}
