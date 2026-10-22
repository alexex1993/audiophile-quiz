// Helpers shared by the quiz and the admin page.

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
    const err = new Error(data.error || `Ошибка ${res.status}`);
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
  return d.toLocaleString("ru-RU", opts);
}

function plural(n, one, few, many) {
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
class PlayerGroup {
  constructor() {
    this.players = [];
    this.position = 0;
  }

  add(src, label, sub = "", key = "") {
    const audio = new Audio();
    audio.preload = "auto";
    audio.src = src;
    const bars = waveBars(7); // identical decoration on every player
    const el = h(`
      <div class="player">
        <div class="player-top">
          <button class="play-btn" aria-label="Играть">${ICON_PLAY}</button>
          <div>
            <div class="player-label">${esc(label)} ${key ? `<span class="kbd">${esc(key)}</span>` : ""}</div>
            <div class="player-sub">${esc(sub)}</div>
          </div>
        </div>
        <div class="wave"><div class="bars">${bars}</div><div class="bars fill">${bars}</div><div class="loading-bar"></div></div>
        <div class="player-time"><span class="cur">0:00</span><span class="dur">0:30</span></div>
      </div>`);
    const p = { audio, el, btn: el.querySelector(".play-btn"), fill: el.querySelector(".bars.fill"), load: el.querySelector(".loading-bar") };
    this.players.push(p);

    p.btn.addEventListener("click", () => this.toggle(p));
    el.querySelector(".wave").addEventListener("click", (e) => {
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
    audio.addEventListener("progress", () => {
      if (audio.duration && audio.buffered.length) {
        p.load.style.width = `${(audio.buffered.end(audio.buffered.length - 1) / audio.duration) * 100}%`;
      }
    });
    audio.addEventListener("ended", () => {
      this.position = 0;
      this.stop();
    });
    return el;
  }

  toggle(p) {
    if (this.active === p) return this.stop();
    if (this.active) {
      this.position = this.active.audio.currentTime;
      this.active.audio.pause();
    }
    this.active = p;
    this.last = p;
    if (isFinite(p.audio.duration) && this.position >= p.audio.duration - 0.05) this.position = 0;
    p.audio.currentTime = this.position;
    p.audio.play().catch((e) => toast("Не удалось воспроизвести: " + e.message, true));
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
      p.btn.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
      p.fill.style.clipPath = `inset(0 ${100 - Math.min(100, (t / dur) * 100)}% 0 0)`;
      p.el.querySelector(".cur").textContent = fmtTime(t);
      p.el.querySelector(".dur").textContent = fmtTime(dur);
    }
  }

  destroy() {
    for (const p of this.players) {
      p.audio.pause();
      p.audio.removeAttribute("src");
      p.audio.load();
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
