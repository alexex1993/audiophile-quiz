// Admin statistics tab: aggregated results with charts. Blue marks are what
// players actually did, orange is what pure guessing (p = 1/4) would give.

const ANSWERS = ["Первый lossless", "Второй lossless", "Оба lossless", "Оба пережатые"];
const ANSWERS_SHORT = ["1-й lossless", "2-й lossless", "Оба lossless", "Оба пережатые"];
const CHANCE = 0.25;

const statsState = { days: 0, admins: true, data: null };
let statsResizeTimer;

window.addEventListener("resize", () => {
  clearTimeout(statsResizeTimer);
  statsResizeTimer = setTimeout(() => {
    const sec = document.getElementById("tab-stats");
    if (statsState.data && sec && !sec.classList.contains("hidden")) renderStats(statsState.data);
  }, 150);
});

async function loadStats() {
  const sec = document.getElementById("tab-stats");
  if (!sec.querySelector("#stats-body")) {
    sec.innerHTML = `
      <div class="stats-filters">
        <div class="seg" id="stats-days">
          ${[[7, "7 дней"], [30, "30 дней"], [90, "90 дней"], [0, "Всё время"]].map(([d, l]) =>
            `<button data-days="${d}" class="${d === statsState.days ? "active" : ""}">${l}</button>`).join("")}
        </div>
        <label class="check"><span class="switch"><input type="checkbox" id="stats-admins" ${statsState.admins ? "checked" : ""}><span></span></span>
          Учитывать попытки админов</label>
      </div>
      <div id="stats-body"><div class="card"><div class="spinner" style="margin:30px auto"></div></div></div>`;
    sec.querySelectorAll("#stats-days button").forEach((b) => (b.onclick = () => {
      statsState.days = Number(b.dataset.days);
      sec.querySelectorAll("#stats-days button").forEach((x) => x.classList.toggle("active", x === b));
      loadStats();
    }));
    sec.querySelector("#stats-admins").onchange = (e) => {
      statsState.admins = e.target.checked;
      loadStats();
    };
  }
  const body = sec.querySelector("#stats-body");
  body.classList.add("loading"); // keep the previous render while refetching
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const q = new URLSearchParams({ days: statsState.days, admins: statsState.admins ? "1" : "0", tz });
    statsState.data = await api(`/api/admin/stats?${q}`);
    renderStats(statsState.data);
  } catch (e) {
    body.innerHTML = `<div class="notice error">${esc(e.message)}</div>`;
  } finally {
    body.classList.remove("loading");
  }
}

function renderStats(d) {
  const body = document.getElementById("stats-body");
  const s = d.summary;
  const scores = d.scores || [];
  const accuracy = s.questions ? s.correct / s.questions : 0;
  const pAll = s.questions ? binomTail(s.correct, s.questions) : 1;
  const significant = scores.reduce((n, b) => n + (binomTail(b.score, b.total) < 0.05 ? b.count : 0), 0);

  body.innerHTML = `
    <div class="grid grid-4">
      ${statTile("Завершённых попыток", fmtInt(s.attempts),
        s.unfinished ? `ещё ${s.unfinished} ${plural(s.unfinished, "брошена", "брошены", "брошено")} на середине` : "без брошенных")}
      ${statTile("Игроков", fmtInt(s.players), s.players ? `в среднем ${fmtNum(s.attempts / s.players, 1)} ${plural(Math.round(s.attempts / s.players), "попытка", "попытки", "попыток")}` : "—")}
      ${statTile("Верных ответов", s.questions ? fmtPct(accuracy) : "—",
        s.questions ? `${fmtInt(s.correct)} из ${fmtInt(s.questions)} · угадывание 25% · ${pText(pAll)}` : "—")}
      ${statTile("Лучше угадывания", s.attempts ? fmtPct(significant / s.attempts) : "—",
        s.attempts ? `${significant} ${plural(significant, "попытка", "попытки", "попыток")} с p < 0,05` : "—")}
    </div>
    <div class="stats-stack" id="stats-charts"></div>`;

  const charts = body.querySelector("#stats-charts");
  if (!s.attempts) {
    charts.innerHTML = `<div class="card chart-empty">За выбранный период нет завершённых попыток.</div>`;
    return;
  }

  charts.append(scoreChart(scores));

  const row1 = h(`<div class="grid grid-2"></div>`);
  row1.append(typeChart(d.confusion || []), confusionChart(d.confusion || []));
  charts.append(row1);

  charts.append(trackChart(d.by_track || []));

  const row2 = h(`<div class="grid grid-2"></div>`);
  row2.append(positionChart(d.by_position || []), attemptNoChart(d.by_attempt_no || []));
  charts.append(row2);

  const row3 = h(`<div class="grid grid-2"></div>`);
  row3.append(formatChart(d.by_track || []), activityChart(d.daily || []));
  charts.append(row3);

  // Charts measure their card, so draw them once the cards are in the DOM.
  charts.querySelectorAll(".chart-card").forEach((c) => c._draw?.());
}

function statTile(label, value, sub) {
  return `<div class="card"><div class="stat-label">${esc(label)}</div><div class="stat-value">${esc(value)}</div><div class="stat-sub">${esc(sub)}</div></div>`;
}

// ---------- individual charts ----------

function scoreChart(scores) {
  // One quiz length → one column per score; mixed lengths → 10% bins.
  const totals = [...new Set(scores.map((b) => b.total))];
  const single = totals.length === 1;
  const n = single ? totals[0] : 10;
  const bins = Array.from({ length: n + (single ? 1 : 0) }, () => ({ actual: 0, expected: 0 }));
  const binOf = (k, total) => (single ? k : Math.min(9, Math.floor((k / total) * 10)));
  let attempts = 0, points = 0, maxPoints = 0;
  for (const b of scores) {
    bins[binOf(b.score, b.total)].actual += b.count;
    for (let k = 0; k <= b.total; k++) bins[binOf(k, b.total)].expected += b.count * binomPmf(k, b.total);
    attempts += b.count;
    points += b.score * b.count;
    maxPoints += b.total * b.count;
  }
  const labels = bins.map((_, i) => (single ? String(i) : `${i * 10}–${i === 9 ? 100 : i * 10 + 9}%`));
  const mean = single ? `${fmtNum(points / attempts, 1)} из ${n}` : fmtPct(points / maxPoints);
  const meanChance = single ? `${fmtNum(n * CHANCE, 1)}` : "25%";

  return chartCard({
    title: "Распределение результатов",
    sub: `Средний результат ${mean}; при случайных ответах было бы ${meanChance}. Если синие столбцы совпадают с оранжевой линией — люди угадывают.`,
    legend: [["bar", "Попытки"], ["line", "Если бы все отвечали наугад"]],
    draw: (el) => columnChart(el, {
      labels,
      values: bins.map((b) => b.actual),
      expected: bins.map((b) => b.expected),
      xTitle: single ? "верных ответов" : "доля верных",
      tip: (i) => [single ? `${labels[i]} из ${n} верных` : `${labels[i]} верных`,
        [[fmtInt(bins[i].actual), plural(bins[i].actual, "попытка", "попытки", "попыток"), "series"],
         [fmtNum(bins[i].expected, 1), "ожидалось при угадывании", "chance"]]],
    }),
    table: [[single ? "Верных" : "Доля верных", "Попыток", "Ожидалось наугад"],
      bins.map((b, i) => [labels[i], fmtInt(b.actual), fmtNum(b.expected, 1)])],
  });
}

function typeChart(confusion) {
  const rows = [1, 2, 3, 4].map((c) => {
    const row = confusion.filter((x) => x.correct === c);
    const answered = row.reduce((s, x) => s + x.count, 0);
    const correct = row.find((x) => x.answer === c)?.count || 0;
    return { answered, correct };
  });
  return chartCard({
    title: "Точность по типу вопроса",
    sub: "Какой вариант был верным — и как часто его угадывали.",
    legend: [["bar", "Доля верных"], ["line", "Случайное угадывание, 25%"]],
    draw: (el) => columnChart(el, {
      labels: ANSWERS_SHORT,
      values: rows.map((r) => (r.answered ? (r.correct / r.answered) * 100 : 0)),
      percent: true, ref: 25, caps: true,
      tip: (i) => accuracyTip(ANSWERS[i], rows[i]),
    }),
    table: accuracyTable("Верный ответ", ANSWERS, rows),
  });
}

function confusionChart(confusion) {
  const m = [1, 2, 3, 4].map((c) => [1, 2, 3, 4].map((a) => confusion.find((x) => x.correct === c && x.answer === a)?.count || 0));
  const rowSum = m.map((r) => r.reduce((a, b) => a + b, 0));
  const colSum = [0, 1, 2, 3].map((j) => m.reduce((s, r) => s + r[j], 0));
  const all = rowSum.reduce((a, b) => a + b, 0);
  const fav = colSum.indexOf(Math.max(...colSum));

  const card = chartCard({
    title: "Матрица ответов",
    sub: all ? `Строка — верный ответ, столбец — что выбрали; рамкой отмечены попадания. Чаще всего отвечают «${ANSWERS[fav]}» — ${fmtPct(colSum[fav] / all)} ответов.` : "",
    draw: (el) => {
      const cell = (i, j) => {
        const share = rowSum[i] ? m[i][j] / rowSum[i] : 0;
        const alpha = 0.06 + share * 0.86;
        // Light fills get dark ink so the label keeps its contrast.
        const ink = alpha > 0.55 ? "#04102b" : "var(--text)";
        return `<td tabindex="0" class="${i === j ? "diag" : ""}" data-i="${i}" data-j="${j}"
          style="background:rgba(74,143,248,${alpha.toFixed(3)});color:${ink}">${fmtPct(share)}<small>${fmtInt(m[i][j])}</small></td>`;
      };
      el.innerHTML = `<div class="table-wrap"><table class="heat">
        <thead><tr><th class="rowh">верный ↓ / ответ →</th>${ANSWERS_SHORT.map((a) => `<th>${esc(a)}</th>`).join("")}<th>всего</th></tr></thead>
        <tbody>${m.map((r, i) => `<tr><th class="rowh">${esc(ANSWERS_SHORT[i])}</th>${r.map((_, j) => cell(i, j)).join("")}
          <td class="margin">${fmtInt(rowSum[i])}</td></tr>`).join("")}
          <tr><th class="rowh">выбирали</th>${colSum.map((c) => `<td class="margin">${all ? fmtPct(c / all) : "—"}</td>`).join("")}<td class="margin">${fmtInt(all)}</td></tr>
        </tbody></table></div>`;
      el.querySelectorAll("td[data-i]").forEach((td) => {
        const i = +td.dataset.i, j = +td.dataset.j;
        bindTip(td, () => [`Верно: ${ANSWERS[i]}`, [[fmtInt(m[i][j]), `ответили «${ANSWERS[j]}»`, "series"],
          [rowSum[i] ? fmtPct(m[i][j] / rowSum[i]) : "—", "от вопросов этого типа"]]]);
      });
    },
    table: [["Верный ответ", ...ANSWERS_SHORT, "Всего"], m.map((r, i) => [ANSWERS[i], ...r.map(fmtInt), fmtInt(rowSum[i])])],
  });
  return card;
}

function trackChart(byTrack) {
  const rows = byTrack.map((t) => ({
    label: t.title + (t.track_id ? "" : " (удалён)"),
    sub: t.artist,
    answered: t.answered,
    correct: t.correct,
  })).sort((a, b) => b.correct / b.answered - a.correct / a.answered || b.answered - a.answered);
  return chartCard({
    title: "Точность по трекам",
    sub: "На каких треках разницу слышат лучше всего. При малом числе ответов доля сильно шумит — смотрите на n и доверительный интервал в подсказке.",
    legend: [["bar", "Доля верных"], ["line", "Случайное угадывание, 25%"]],
    draw: (el) => hbarChart(el, rows),
    table: accuracyTable("Трек", rows.map((r) => (r.sub ? `${r.sub} — ${r.label}` : r.label)), rows),
  });
}

function formatChart(byTrack) {
  const groups = new Map();
  for (const t of byTrack) {
    const key = t.bit_depth ? `${t.bit_depth} bit / ${fmtNum(t.sample_rate / 1000, 1)} kHz` : "удалённые треки";
    const g = groups.get(key) || { label: key, sub: "", answered: 0, correct: 0, tracks: 0, rate: t.sample_rate || 0, bits: t.bit_depth || 0 };
    g.answered += t.answered;
    g.correct += t.correct;
    g.tracks++;
    groups.set(key, g);
  }
  const rows = [...groups.values()].sort((a, b) => b.bits - a.bits || b.rate - a.rate);
  rows.forEach((g) => (g.sub = `${g.tracks} ${plural(g.tracks, "трек", "трека", "треков")}`));
  return chartCard({
    title: "Точность по формату исходника",
    sub: "Помогает ли hi-res услышать разницу.",
    legend: [["bar", "Доля верных"], ["line", "Случайное угадывание, 25%"]],
    draw: (el) => hbarChart(el, rows),
    table: accuracyTable("Формат", rows.map((r) => r.label), rows),
  });
}

function positionChart(byPosition) {
  return chartCard({
    title: "Точность по номеру вопроса",
    sub: "Устают ли уши к концу теста.",
    legend: [["bar", "Доля верных"], ["line", "Случайное угадывание, 25%"]],
    draw: (el) => columnChart(el, {
      labels: byPosition.map((r) => String(r.key)),
      values: byPosition.map((r) => (r.answered ? (r.correct / r.answered) * 100 : 0)),
      percent: true, ref: 25, xTitle: "номер вопроса",
      tip: (i) => accuracyTip(`Вопрос ${byPosition[i].key}`, byPosition[i]),
    }),
    table: accuracyTable("Вопрос", byPosition.map((r) => r.key), byPosition),
  });
}

function attemptNoChart(byAttempt) {
  const label = (k) => (k >= 10 ? "10+" : String(k));
  return chartCard({
    title: "Прогресс игроков",
    sub: "Точность в первой, второй, третьей… попытке игрока. Растёт — значит, слух тренируется.",
    legend: [["bar", "Доля верных"], ["line", "Случайное угадывание, 25%"]],
    draw: (el) => columnChart(el, {
      labels: byAttempt.map((r) => label(r.key)),
      values: byAttempt.map((r) => (r.answered ? (r.correct / r.answered) * 100 : 0)),
      percent: true, ref: 25, xTitle: "номер попытки", caps: byAttempt.length <= 6,
      tip: (i) => accuracyTip(`Попытка №${label(byAttempt[i].key)}`, byAttempt[i]),
    }),
    table: accuracyTable("Попытка", byAttempt.map((r) => label(r.key)), byAttempt),
  });
}

function activityChart(daily) {
  const byDay = new Map(daily.map((r) => [r.day, r]));
  const today = localISODate(new Date());
  const first = statsState.days ? addDays(today, -(statsState.days - 1)) : daily[0]?.day || today;
  const days = [];
  for (let d = first; d <= today; d = addDays(d, 1)) days.push(d);
  // Long ranges are grouped by week so columns stay readable.
  const step = days.length > 120 ? 7 : 1;
  const buckets = [];
  for (let i = 0; i < days.length; i += step) {
    const span = days.slice(i, i + step);
    const b = { day: span[0], attempts: 0, answered: 0, correct: 0 };
    for (const d of span) {
      const r = byDay.get(d);
      if (r) { b.attempts += r.attempts; b.answered += r.answered; b.correct += r.correct; }
    }
    buckets.push(b);
  }
  const label = (b) => (step > 1 ? "с " : "") + fmtShortDate(b.day);
  return chartCard({
    title: "Активность",
    sub: `Завершённые попытки по ${step > 1 ? "неделям" : "дням"}.`,
    draw: (el) => columnChart(el, {
      labels: buckets.map(label),
      values: buckets.map((b) => b.attempts),
      tip: (i) => [step > 1 ? `Неделя ${label(buckets[i])}` : fmtShortDate(buckets[i].day, true),
        [[fmtInt(buckets[i].attempts), plural(buckets[i].attempts, "попытка", "попытки", "попыток"), "series"],
         [buckets[i].answered ? fmtPct(buckets[i].correct / buckets[i].answered) : "—", "верных ответов"]]],
    }),
    table: [["Дата", "Попыток", "Верных ответов"],
      buckets.filter((b) => b.attempts).map((b) => [label(b), fmtInt(b.attempts), fmtPct(b.correct / b.answered)])],
  });
}

function accuracyTip(title, r) {
  const [lo, hi] = wilson(r.correct, r.answered);
  return [title, [[r.answered ? fmtPct(r.correct / r.answered) : "—", "верных ответов", "series"],
    [`${fmtInt(r.correct)} из ${fmtInt(r.answered)}`, "ответов"],
    [`${fmtPct(lo)}–${fmtPct(hi)}`, "95% интервал"],
    [fmtP(binomTail(r.correct, r.answered)), "p (отличие от угадывания)"]]];
}

function accuracyTable(head, labels, rows) {
  return [[head, "Ответов", "Верных", "Доля", "95% интервал", "p"], rows.map((r, i) => {
    const [lo, hi] = wilson(r.correct, r.answered);
    return [labels[i], fmtInt(r.answered), fmtInt(r.correct), r.answered ? fmtPct(r.correct / r.answered) : "—",
      `${fmtPct(lo)}–${fmtPct(hi)}`, fmtP(binomTail(r.correct, r.answered))];
  })];
}

// ---------- chart primitives ----------

// chartCard wraps a chart with a title, legend and a table view of the same numbers.
function chartCard({ title, sub, legend, draw, table }) {
  const card = h(`<div class="card chart-card">
    <div class="chart-head"><div style="flex:1;min-width:0"><h3>${esc(title)}</h3>${sub ? `<div class="chart-sub">${esc(sub)}</div>` : ""}</div>
      <button class="chart-toggle">Таблица</button></div>
    ${legend ? `<div class="legend">${legend.map(([k, l]) => `<span><i class="${k === "line" ? "line" : ""}"></i>${esc(l)}</span>`).join("")}</div>` : ""}
    <div class="chart-body"></div>
    <div class="chart-table hidden"><table class="table"><thead><tr>${table[0].map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead>
      <tbody>${table[1].map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
  </div>`);
  const bodyEl = card.querySelector(".chart-body");
  const tableEl = card.querySelector(".chart-table");
  const legendEl = card.querySelector(".legend");
  card._draw = () => draw(bodyEl);
  card.querySelector(".chart-toggle").onclick = (e) => {
    const showTable = tableEl.classList.contains("hidden");
    tableEl.classList.toggle("hidden", !showTable);
    bodyEl.classList.toggle("hidden", showTable);
    legendEl?.classList.toggle("hidden", showTable);
    e.target.textContent = showTable ? "График" : "Таблица";
    if (!showTable) card._draw();
  };
  return card;
}

const SVG_NS = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

// columnChart draws vertical bars from a common baseline. Options:
// labels, values, percent (0–100 axis), ref (horizontal chance line),
// expected (chance value per column), caps (value labels), tip(i), xTitle.
function columnChart(el, o) {
  el.innerHTML = "";
  const W = Math.max(260, el.clientWidth);
  const m = { top: 18, right: 8, left: 40 };
  const pw = W - m.left - m.right, ph = 180;
  const n = o.values.length;
  const rawMax = Math.max(...o.values, ...(o.expected || []), 1);
  const ticks = o.percent ? [0, 25, 50, 75, 100] : niceTicks(rawMax);
  const yMax = ticks[ticks.length - 1];
  const y = (v) => m.top + ph - (v / yMax) * ph;
  const band = pw / n;
  const barW = band >= 12 ? Math.min(24, band * 0.6) : Math.max(1, band - 2);
  const cx = (i) => m.left + band * i + band / 2;

  // Labels that don't fit their column wrap onto two lines; if they still
  // collide, only every k-th is drawn, counting back from the last one.
  const textW = (t) => t.length * 6.4 + 8;
  const wrap = o.labels.some((l) => textW(l) > band && l.includes(" "));
  const lines = o.labels.map((l) => (wrap ? l.split(/ (.*)/s).filter(Boolean) : [l]));
  const every = Math.max(1, Math.ceil(Math.max(...lines.flat().map(textW)) / band));
  const labelH = 13 * Math.max(...lines.map((l) => l.length));
  // The SVG includes the axis band, so labels never get clipped.
  const H = m.top + ph + 14 + labelH + (o.xTitle ? 16 : 0);

  const svg = svgEl("svg", { width: W, height: H, role: "img" });
  for (const t of ticks) {
    svg.append(svgEl("line", { x1: m.left, x2: W - m.right, y1: y(t), y2: y(t), stroke: "var(--grid)", "stroke-width": 1 }));
    const tx = svgEl("text", { x: m.left - 8, y: y(t) + 4, "text-anchor": "end" });
    tx.textContent = o.percent ? `${t}%` : fmtInt(t);
    svg.append(tx);
  }

  o.values.forEach((v, i) => {
    const top = y(v), base = y(0);
    if (v > 0) {
      const x = cx(i) - barW / 2, r = Math.min(4, barW / 2, base - top);
      svg.append(svgEl("path", {
        d: `M${x},${base}V${top + r}Q${x},${top} ${x + r},${top}H${x + barW - r}Q${x + barW},${top} ${x + barW},${top + r}V${base}Z`,
        fill: "var(--series)",
      }));
    }
    if (o.caps && n <= 8) {
      const cap = svgEl("text", { x: cx(i), y: top - 6, "text-anchor": "middle", class: "cap" });
      cap.textContent = o.percent ? `${Math.round(v)}%` : fmtInt(v);
      svg.append(cap);
    }
    if ((n - 1 - i) % every === 0) {
      lines[i].forEach((line, k) => {
        const lx = svgEl("text", { x: cx(i), y: m.top + ph + 18 + k * 13, "text-anchor": "middle" });
        lx.textContent = line;
        svg.append(lx);
      });
    }
  });
  if (o.xTitle) {
    const xt = svgEl("text", { x: m.left + pw / 2, y: H - 6, "text-anchor": "middle" });
    xt.textContent = o.xTitle;
    svg.append(xt);
  }

  if (o.ref != null) {
    svg.append(svgEl("line", { x1: m.left, x2: W - m.right, y1: y(o.ref), y2: y(o.ref), stroke: "var(--chance)", "stroke-width": 2, "stroke-linecap": "round" }));
  }
  if (o.expected) {
    svg.append(svgEl("polyline", {
      points: o.expected.map((v, i) => `${cx(i)},${y(v)}`).join(" "),
      fill: "none", stroke: "var(--chance)", "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round",
    }));
    o.expected.forEach((v, i) => svg.append(svgEl("circle", { cx: cx(i), cy: y(v), r: 4, fill: "var(--chance)", stroke: "var(--surface)", "stroke-width": 2 })));
  }

  // Full-height hit areas, on top of everything.
  o.values.forEach((_, i) => {
    const hit = svgEl("rect", { x: m.left + band * i, y: m.top, width: band, height: ph, class: "hit", tabindex: 0 });
    if (o.tip) bindTip(hit, () => o.tip(i));
    svg.append(hit);
  });
  el.append(svg);
}

// hbarChart lists accuracy rows as horizontal bars on a fixed 0–100% scale.
function hbarChart(el, rows) {
  if (!rows.length) {
    el.innerHTML = `<div class="chart-empty">Нет данных</div>`;
    return;
  }
  el.innerHTML = `<div class="hbars">${rows.map((r, i) => {
    const share = r.answered ? r.correct / r.answered : 0;
    return `<div class="hbar" tabindex="0" data-i="${i}">
      <div class="hbar-label"><b>${esc(r.label)}</b>${r.sub ? `<span>${esc(r.sub)}</span>` : ""}</div>
      <div class="hbar-track"><div class="hbar-fill" style="width:${(share * 100).toFixed(2)}%"></div><div class="hbar-ref" style="left:${CHANCE * 100}%"></div></div>
      <div class="hbar-val">${fmtPct(share)}<span>n = ${fmtInt(r.answered)}</span></div>
    </div>`;
  }).join("")}</div>`;
  el.querySelectorAll(".hbar").forEach((row) => {
    const r = rows[row.dataset.i];
    bindTip(row, () => accuracyTip(r.sub ? `${r.sub} — ${r.label}` : r.label, r));
  });
}

let tipEl;
// bindTip shows a tooltip on hover and keyboard focus. content() returns
// [title, [[value, label, colorKey?], ...]]; text goes in via textContent.
function bindTip(target, content) {
  const show = (x, y) => {
    if (!tipEl) {
      tipEl = document.createElement("div");
      tipEl.className = "chart-tip";
      document.body.append(tipEl);
    }
    const [title, rows] = content();
    tipEl.replaceChildren();
    const t = document.createElement("div");
    t.className = "tt";
    t.textContent = title;
    tipEl.append(t);
    for (const [value, label, color] of rows) {
      const row = document.createElement("div");
      row.className = "tr";
      const key = document.createElement("i");
      key.style.background = color ? `var(--${color})` : "transparent";
      const b = document.createElement("b");
      b.textContent = value;
      const s = document.createElement("span");
      s.textContent = label;
      row.append(key, b, s);
      tipEl.append(row);
    }
    tipEl.style.display = "block";
    const r = tipEl.getBoundingClientRect();
    let left = x + 14, top = y + 14;
    if (left + r.width > innerWidth - 8) left = x - r.width - 14;
    if (top + r.height > innerHeight - 8) top = y - r.height - 14;
    tipEl.style.left = `${Math.max(8, left)}px`;
    tipEl.style.top = `${Math.max(8, top)}px`;
  };
  const hide = () => tipEl && (tipEl.style.display = "none");
  target.addEventListener("pointermove", (e) => show(e.clientX, e.clientY));
  target.addEventListener("pointerleave", hide);
  target.addEventListener("focus", () => {
    const r = target.getBoundingClientRect();
    show(r.left + r.width / 2, r.top + r.height / 2);
  });
  target.addEventListener("blur", hide);
}

function niceTicks(max, count = 4) {
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((k) => k * mag).find((s) => s >= raw && (s >= 1 || mag < 1)) || mag * 10;
  const st = Math.max(1, step); // counts are integers
  const ticks = [];
  for (let v = 0; v < max + st; v += st) ticks.push(v);
  return ticks;
}

// ---------- statistics ----------

function binomPmf(k, n, p = CHANCE) {
  return Math.exp(logChoose(n, k) + k * Math.log(p) + (n - k) * Math.log(1 - p));
}

function logChoose(n, k) {
  let s = 0;
  for (let i = 1; i <= k; i++) s += Math.log(n - k + i) - Math.log(i);
  return s;
}

// binomTail is P(X >= k) for X ~ Binomial(n, 1/4): the chance of doing at
// least this well by guessing.
function binomTail(k, n, p = CHANCE) {
  if (n <= 0 || k <= 0) return 1;
  let term = binomPmf(k, n, p), sum = 0;
  for (let i = k; i <= n && term > 1e-300; i++) {
    sum += term;
    term *= ((n - i) / (i + 1)) * (p / (1 - p));
  }
  return Math.min(1, sum);
}

// Wilson score interval for a proportion, 95%.
function wilson(k, n) {
  if (!n) return [0, 1];
  const z = 1.96, p = k / n, z2 = z * z;
  const c = (p + z2 / (2 * n)) / (1 + z2 / n);
  const d = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return [Math.max(0, c - d), Math.min(1, c + d)];
}

// ---------- formatting ----------

function fmtInt(n) { return Math.round(n).toLocaleString("ru-RU"); }
function fmtNum(n, digits) { return n.toLocaleString("ru-RU", { maximumFractionDigits: digits }); }
function fmtPct(x) { return `${Math.round(x * 100)}%`; }
function fmtP(p) { return p < 0.001 ? "< 0,001" : p.toLocaleString("ru-RU", { maximumFractionDigits: 3 }); }
function pText(p) { return p < 0.001 ? "p\u00a0<\u00a00,001" : `p\u00a0=\u00a0${fmtP(p)}`; }

function localISODate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function fmtShortDate(iso, long = false) {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("ru-RU", { day: "numeric", month: long ? "long" : "short", timeZone: "UTC" });
}
