// Helpers shared by the quiz and the admin page.

// UI language: the footer switch's "lang" cookie if set, otherwise Russian
// when it is the browser's first preference and English for everyone else.
// The server picks the language of its error messages the same way.
const LANG = (() => {
  const c = document.cookie.match(/(?:^|;\s*)lang=(ru|en)(?:;|$)/);
  if (c) return c[1];
  return /^ru(-|$)/i.test(navigator.languages?.[0] || navigator.language || "") ? "ru" : "en";
})();
const LOCALE = LANG === "ru" ? "ru-RU" : "en-US";

// t returns the string for the current language.
function t(ru, en) {
  return LANG === "ru" ? ru : en;
}

// Static markup is written in Russian; elements carry their English text in data-en.
document.documentElement.lang = LANG;
if (LANG === "en") {
  document.querySelectorAll("[data-en]").forEach((el) => {
    if (el.tagName === "META") el.content = el.dataset.en;
    else el.textContent = el.dataset.en;
  });
}
document.querySelectorAll(".lang-switch").forEach((a) => {
  a.textContent = LANG === "ru" ? "English" : "Русский";
  a.onclick = (e) => {
    e.preventDefault();
    document.cookie = `lang=${LANG === "ru" ? "en" : "ru"}; path=/; max-age=31536000; samesite=lax`;
    location.reload();
  };
});

// Difficulty levels by name: title, a short hint, and the longer "about" and
// "listen" texts of the picker tooltip. Their bitrates and track counts come
// from the server (`difficulties` in /api/config and /api/me).
const LEVEL_TEXT = {
  easy: {
    title: t("Лёгкий", "Easy"),
    hint: t("только проверка работы сервиса", "only a service check"),
    about: t("Этот режим создан, чтобы проверить работу сервиса — что звук играет и плеер работает, — и не более. Разницу слышно даже через динамики ноутбука или телефона. Настоящий тест — средний и сложный уровни.",
      "This mode exists to check that the service works — that sound plays and the player behaves — and nothing more. The difference is audible even through laptop or phone speakers. The real test is the medium and hard levels."),
    listen: t("Слушайте тарелки, хай-хэт и шипящие: в сжатой версии они «булькают» и звенят металлом, а самый верх срезан.",
      "Listen to cymbals, hi-hats and sibilants: in the compressed clip they sound watery and metallic, and the very top is cut off."),
  },
  medium: {
    title: t("Средний", "Medium"),
    hint: t("для чуткого слуха", "for keen ears"),
    about: t("Услышать разницу сложно, но людям с хорошим слухом это под силу. Как правило, нужны хорошие наушники и хороший ЦАП.",
      "The difference is hard to hear, but people with good hearing can pass. It usually takes good headphones and a good DAC."),
    listen: t("Найдите короткий фрагмент на 2–3 секунды, переключайтесь A/B и следите за атакой тарелок, «воздухом» и шириной сцены.",
      "Pick a short 2–3 second passage, switch A/B and focus on cymbal attacks, “air” and stereo width."),
  },
  hard: {
    title: t("Сложный", "Hard"),
    hint: t("почти неотличимо", "nearly indistinguishable"),
    about: t("Услышать разницу почти невозможно: сжатое аудио очень близко к оригиналу.",
      "Hearing the difference is nearly impossible: the compressed audio is very close to the original."),
    listen: t("AAC 320 kbps в слепых тестах обычно считают прозрачным. Результат заметно выше 25% — уже повод для гордости.",
      "AAC at 320 kbps is generally considered transparent in blind tests. Scoring clearly above 25% is already something to be proud of."),
  },
};
const DEFAULT_LEVELS = [{ name: "easy", kbps: 32, questions: 5 }, { name: "medium", kbps: 128, questions: 12 }, { name: "hard", kbps: 320, questions: 12 }];

function levelTitle(name) {
  return LEVEL_TEXT[name]?.title || name;
}

function levelKbps(levels, name) {
  return (levels || DEFAULT_LEVELS).find((l) => l.name === name)?.kbps ?? 128;
}

async function api(path, opts = {}) {
  const init = { method: opts.method || "GET", headers: { "X-Requested-With": "fetch" }, credentials: "same-origin" };
  if (opts.json !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(opts.json);
  }
  const res = await fetch(path, init);
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `${t("Ошибка", "Error")} ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function h(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

let toastTimer;
function toast(msg, isError = false) {
  document.querySelector(".toast")?.remove();
  const el = h(`<div class="toast ${isError ? "error" : ""}">${esc(msg)}</div>`);
  document.body.append(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 4000);
}

function fmtTime(sec) {
  if (!isFinite(sec)) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function fmtDate(iso, withTime = true) {
  const d = new Date(iso);
  const opts = { day: "numeric", month: "long" };
  if (withTime) Object.assign(opts, { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleString(LOCALE, opts);
}

// plural picks the word form for n: ru is "one|few|many", en is "one|other".
function plural(n, ru, en) {
  if (LANG === "en") {
    const [one, other] = en.split("|");
    return n === 1 ? one : other;
  }
  const [one, few, many] = ru.split("|");
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

async function logout() {
  await api("/auth/logout", { method: "POST" }).catch(() => {});
  location.href = "/";
}

const ICON_PLAY = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.6-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>`;
const ICON_PAUSE = `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1.2"/><rect x="14" y="5" width="4" height="14" rx="1.2"/></svg>`;

// PlayerGroup keeps several clips of the same excerpt in sync: starting one
// pauses the others and continues from the same moment, which makes quick
// A/B switching seamless.
//
// All clips are downloaded in full, behind one shared progress bar, before any
// of them can play: the clips are FLACs of equal size but different bitrate,
// so per-clip buffering would hint at which one went through AAC.
class PlayerGroup {
  constructor() {
    this.players = [];
    this.position = 0;
    this.ready = false;
    this.abort = new AbortController();
  }

  add(src, label, sub = "", key = "") {
    const audio = new Audio();
    audio.preload = "auto";
    const bars = waveBars(7); // identical decoration on every player
    const el = h(`
      <div class="player loading">
        <div class="player-top">
          <button class="play-btn" aria-label="${t("Играть", "Play")}">${ICON_PLAY}</button>
          <div>
            <div class="player-label">${esc(label)} ${key ? `<span class="kbd">${esc(key)}</span>` : ""}</div>
            <div class="player-sub">${esc(sub)}</div>
          </div>
        </div>
        <div class="wave"><div class="bars">${bars}</div><div class="bars fill">${bars}</div><div class="loading-bar"></div></div>
        <div class="player-time"><span class="cur">0:00</span><span class="dur">0:30</span></div>
      </div>`);
    const p = { audio, el, btn: el.querySelector(".play-btn"), fill: el.querySelector(".bars.fill"), load: el.querySelector(".loading-bar"), loaded: 0, total: 0, url: null, playing: false };
    this.players.push(p);
    this.download(p, src);

    p.btn.addEventListener("click", () => this.toggle(p));
    el.querySelector(".wave").addEventListener("click", (e) => {
      if (!this.ready) return;
      const r = e.currentTarget.getBoundingClientRect();
      const t = ((e.clientX - r.left) / r.width) * (audio.duration || 30);
      this.position = t;
      if (this.active) this.active.audio.currentTime = t;
      else this.toggle(p);
      this.render();
    });
    audio.addEventListener("timeupdate", () => {
      if (this.active === p) this.position = audio.currentTime;
      this.render();
    });
    audio.addEventListener("loadedmetadata", () => this.render());
    audio.addEventListener("ended", () => {
      this.position = 0;
      this.stop();
    });
    return el;
  }

  async download(p, src) {
    try {
      const res = await fetch(src, { signal: this.abort.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      p.total = Number(res.headers.get("Content-Length")) || 0;
      const reader = res.body.getReader();
      const chunks = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        p.loaded += value.length;
        this.renderLoading();
      }
      p.url = URL.createObjectURL(new Blob(chunks, { type: res.headers.get("Content-Type") || "" }));
    } catch (e) {
      if (e.name !== "AbortError") toast(t("Не удалось загрузить аудио: ", "Failed to load audio: ") + e.message, true);
      return;
    }
    if (!this.players.every((x) => x.url)) return;
    this.ready = true;
    for (const x of this.players) {
      x.audio.src = x.url;
      x.el.classList.remove("loading");
    }
    this.renderLoading();
  }

  // One progress value for the whole group, shown on every player.
  renderLoading() {
    let loaded = 0, total = 0;
    for (const p of this.players) {
      loaded += p.loaded;
      total += p.total;
    }
    const known = this.players.every((p) => p.total);
    const pct = this.ready ? 100 : known ? (loaded / total) * 100 : 0;
    for (const p of this.players) p.load.style.width = `${pct}%`;
  }

  toggle(p) {
    if (!this.ready) return;
    if (this.active === p) return this.stop();
    if (this.active) {
      this.position = this.active.audio.currentTime;
      this.active.audio.pause();
    }
    this.active = p;
    this.last = p;
    if (isFinite(p.audio.duration) && this.position >= p.audio.duration - 0.05) this.position = 0;
    p.audio.currentTime = this.position;
    p.audio.play().catch((e) => toast(t("Не удалось воспроизвести: ", "Playback failed: ") + e.message, true));
    this.render();
  }

  toggleIndex(i) {
    if (this.players[i]) this.toggle(this.players[i]);
  }

  stop() {
    if (this.active) {
      this.position = this.active.audio.currentTime;
      this.active.audio.pause();
    }
    this.active = null;
    this.render();
  }

  render() {
    for (const p of this.players) {
      const playing = this.active === p;
      const dur = p.audio.duration || 30;
      // Only the playing (or last paused) clip shows progress; the shared
      // position is applied to the other one when it starts.
      const t = playing ? p.audio.currentTime : this.last === p ? this.position : 0;
      p.el.classList.toggle("playing", playing);
      // Swap the icon only on a state change: render() runs on every timeupdate, and
      // replacing the SVG between mousedown and mouseup swallows the click.
      if (p.playing !== playing) {
        p.playing = playing;
        p.btn.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
      }
      p.fill.style.clipPath = `inset(0 ${100 - Math.min(100, (t / dur) * 100)}% 0 0)`;
      p.el.querySelector(".cur").textContent = fmtTime(t);
      p.el.querySelector(".dur").textContent = fmtTime(dur);
    }
  }

  destroy() {
    this.abort.abort();
    for (const p of this.players) {
      p.audio.pause();
      p.audio.removeAttribute("src");
      p.audio.load();
      if (p.url) URL.revokeObjectURL(p.url);
    }
    this.players = [];
    this.active = null;
    this.last = null;
  }
}

// Decorative pseudo-waveform; deterministic so both players look the same.
function waveBars(seed) {
  let x = seed;
  const rnd = () => ((x = (x * 9301 + 49297) % 233280) / 233280);
  let out = "";
  for (let i = 0; i < 72; i++) {
    const env = 0.35 + 0.65 * Math.abs(Math.sin(i / 9));
    out += `<i style="height:${Math.round((0.18 + rnd() * 0.82) * env * 100)}%"></i>`;
  }
  return out;
}
