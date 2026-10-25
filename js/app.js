import { CENTER as SAMPLE_CENTER, YEARS, COMPLEXES as SAMPLE_COMPLEXES, FACILITIES as SAMPLE_FAC } from "./data.js";
import { evaluate, buildReport, LEVEL_LABEL, PARAMS, dist } from "./model.js?v=capture4";

// 실제 시설(OSM 기반, scripts/build_data.py 산출). 없으면 샘플 사용.
let FACILITIES = SAMPLE_FAC, facSource = "샘플";
try {
  const r = await fetch("data/facilities.json", { cache: "no-store" });
  if (r.ok) { FACILITIES = await r.json(); facSource = "OSM·공공데이터"; }
} catch (e) { /* 샘플 유지 */ }

// 실제 단지(data/complexes.csv). 좌표·입주월(YYYY-MM)이 모두 있는 행만 사용.
let COMPLEXES = SAMPLE_COMPLEXES, CENTER = SAMPLE_CENTER, cxSource = "샘플", cxSkipped = [];
try {
  const r = await fetch("data/complexes.csv", { cache: "no-store" });
  if (r.ok) {
    const [head, ...lines] = (await r.text()).trim().split(/\r?\n/);
    const cols = head.split(",");
    const rows = lines.map((l) => Object.fromEntries(l.split(",").map((v, i) => [cols[i], v])));
    const ok = rows.filter((x) => x.lat && x.lng && /^\d{4}-\d{2}$/.test(x.movein));
    cxSkipped = rows.filter((x) => !ok.includes(x)).map((x) => x.name);
    if (ok.length) {
      COMPLEXES = ok.map((x) => ({ id: x.id, name: x.name, lat: +x.lat, lng: +x.lng, phases: [[+x.movein.slice(0, 4), +x.units]] }));
      CENTER = [COMPLEXES.reduce((a, c) => a + c.lat, 0) / COMPLEXES.length, COMPLEXES.reduce((a, c) => a + c.lng, 0) / COMPLEXES.length];
      cxSource = `실제 ${ok.length}개`;
    }
  }
} catch (e) { /* 샘플 유지 */ }

// 학구(통학구역) 매핑: scripts/build_zones.py 산출. 있으면 단지에 부착(없으면 최근접 배정)
let zoneSource = "최근접";
try {
  const r = await fetch("data/zones.json", { cache: "no-store" });
  if (r.ok) {
    const zones = await r.json();
    for (const c of COMPLEXES) {
      const z = zones[c.id];
      if (!z) continue;
      c.zone = { elem: [...new Set(z.elem.flatMap((e) => e.schools))], mid: [...new Set(z.mid.flatMap((e) => e.schools))] };
    }
    zoneSource = "학구 기준";
  }
} catch (e) { /* 최근접 배정 유지 */ }

const DEFAULTS = JSON.parse(JSON.stringify(PARAMS));   // 가정값 패널로 바꾸기 전의 기본 가정(기준선 계산과 "기본으로" 복원에 사용)

const $ = (s) => document.querySelector(s);
const state = { year: 2026, layer: "total", tool: null, added: [], plan: {}, newCx: [], labels: false, show: { school: true, park: true, bus: false } };

// 입주계획 편집: plan[id] = { units, year } 로 기존 단지를 덮어쓰고, newCx 는 사용자가 지도에 추가한 신규 단지.
// 시나리오 계산에는 이 "유효 단지 목록"을 쓰고, 기준선("현재 계획")은 원본 COMPLEXES 그대로 쓴다.
function effComplexesOf(plan, newCx) {
  const base = COMPLEXES.map((c) => {
    const o = plan[c.id];
    return o ? { ...c, phases: o.units > 0 ? [[o.year, o.units]] : [] } : c;
  });
  const added = newCx.map((n) => ({ id: n.id, name: n.name, lat: n.lat, lng: n.lng, phases: n.units > 0 ? [[n.year, n.units]] : [] }));
  return [...base, ...added];
}
const effComplexes = () => effComplexesOf(state.plan, state.newCx);

const TOOLS = {
  "school-elem": { type: "school", level: "elem", cap: 900, name: "신설 초등학교" },
  "school-mid": { type: "school", level: "mid", cap: 900, name: "신설 중학교" },
  bus: { type: "bus", cap: 500, name: "신설 정류장" },
  park: { type: "park", area: 20000, name: "신설 공원" },
  // 세교2-1 초·중통합학교: 36학급(초 24+중 12), 2030 개교 목표(중부일보). 정원=학급수x학급당정원(가정 25/29). 위치는 미확정이라 지도에서 지정.
  newcx: { cx: true, units: 800 },   // 신규 단지(800세대) 추가 도구: 지도 클릭 위치에 현재 연도 입주로 생성
  seokyo21: {
    open: 2030,
    pair: [
      { type: "school", level: "elem", classes: 24, cap: 600, enrolled: 0, name: "세교2-1 통합학교(초 24학급)" },
      { type: "school", level: "mid", classes: 12, cap: 348, enrolled: 0, name: "세교2-1 통합학교(중 12학급)" },
    ],
  },
};
const ICON = { school: "학", bus: "버", park: "공" };   // 목록 표시용 글자
const PIN_INK = "#3A4150", PIN_NEW = "#3B5BDB";   // 기존 시설은 중립색(점수 색과 겹치지 않게), 사용자가 추가한 시설은 강조색
const PIN = { school: ["학", PIN_INK], park: ["공", PIN_INK], bus: ["버", PIN_INK] };   // [지도 핀 글자, 색]
const LAYER_KEY = { total: "total", school: "schoolScore", bus: "busScore", park: "parkScore" };

// 주소 파라미터(공유·캡처용): ?year=2027&layer=bus&tab=scenario&add=bus:37.1622,127.0492&labels=1&view=map&focus=schools
const URLP = new URLSearchParams(location.search);
if (URLP.get("view") === "map") document.body.classList.add("map-only");   // 패널 숨기고 지도만 표시(캡처용)

const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const map = L.map("map", { zoomControl: true, zoomAnimation: !reduceMotion, fadeAnimation: !reduceMotion, markerZoomAnimation: !reduceMotion }).setView(CENTER, 15);
if (COMPLEXES !== SAMPLE_COMPLEXES) map.fitBounds(COMPLEXES.map((c) => [c.lat, c.lng]), { padding: [60, 60] });
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "&copy; OpenStreetMap contributors", maxZoom: 19,
}).addTo(map);
const complexLayer = L.layerGroup().addTo(map);
const facLayer = L.layerGroup().addTo(map);

function color(score) {
  // 0 양호(초록) → 50 노랑 → 100 부족(빨강). 범례 그라데이션(#2FB67C, #F5B84B, #E5484D)과 같은 색
  const t = Math.max(0, Math.min(100, score)) / 100;
  const [c0, c1, c2] = [[47, 182, 124], [245, 184, 75], [229, 72, 77]];
  const [p, q, u] = t < 0.5 ? [c0, c1, t / 0.5] : [c1, c2, (t - 0.5) / 0.5];
  return `rgb(${p.map((v, i) => Math.round(v + (q[i] - v) * u)).join(",")})`;
}

function run(year, withAdded = true) {
  const extra = withAdded ? state.added.map((f) => ({ ...f, added: true })) : [];
  return evaluate(withAdded ? effComplexes() : COMPLEXES, [...FACILITIES, ...extra], year, withAdded ? PARAMS : DEFAULTS);
}

function popup(x) {
  const lv = (k) => {
    const s = x.school[k];
    if (s.unassigned) return "통학구역 미확정";
    return s.f ? `${s.f.name} ${Math.round(s.d)}m, 정원 ${s.over ? "+" + (s.over * 100).toFixed(0) + "%" : "여유"}` : "없음";
  };
  return `<div class="pop"><b>${x.c.name} · ${x.hh.toLocaleString()}세대</b><table>
    <tr><td>종합</td><td>${x.total.toFixed(0)}점</td></tr>
    <tr><td>학교</td><td>${x.schoolScore.toFixed(0)}점</td></tr>
    <tr><td>초등</td><td>${lv("elem")}</td></tr>
    <tr><td>중등</td><td>${lv("mid")}</td></tr>
    <tr><td>고등</td><td>${lv("high")}</td></tr>
    <tr><td>버스</td><td>${x.busScore.toFixed(0)}점 (${x.bus.f ? Math.round(x.bus.d) + "m" : "없음"})</td></tr>
    <tr><td>공원</td><td>${x.parkScore.toFixed(0)}점</td></tr>
    ${x.parkTier.map((tr) => `<tr><td>&nbsp;&nbsp;${tr.label}</td><td>${isFinite(tr.d) ? Math.round(tr.d) + "m" : "없음"} / 기준 ${tr.reach}m</td></tr>`).join("")}
  </table></div>`;
}

function draw(res) {
  complexLayer.clearLayers();
  for (const x of res.items) {
    if (x.hh <= 0) {
      L.circle([x.c.lat, x.c.lng], { radius: 60, color: "#98A2B3", weight: 1.5, dashArray: "4", fillColor: "#98A2B3", fillOpacity: 0.12 })
        .bindTooltip(`${x.c.name} (미입주)`).addTo(complexLayer);
      continue;
    }
    const score = x[LAYER_KEY[state.layer]];
    L.circle([x.c.lat, x.c.lng], {
      radius: 70 + Math.sqrt(x.hh) * 3.2, color: "#fff", fillColor: color(score), fillOpacity: 0.78, weight: 2.5,
    }).bindPopup(popup(x)).bindTooltip(
      state.labels ? `${x.c.name.split("(")[0].replace("오산 세교", "").replace("세교 ", "").slice(0, 11)} ${score.toFixed(0)}` : `${x.c.name} ${score.toFixed(0)}점`,
      state.labels ? { permanent: true, direction: "top", offset: [0, -4], className: "cx-label" } : {}
    ).addTo(complexLayer);
  }
  facLayer.clearLayers();
  const all = [...FACILITIES, ...state.added].filter((f) => f.open <= state.year);
  for (const f of all) {
    const isNew = !FACILITIES.includes(f);
    if (!isNew && !state.show[f.type]) continue;           // 사용자가 추가한 시설은 항상 표시
    if (!isNew && f.type === "park" && f.area < 10000 && map.getZoom() < 16) continue;   // 축소 상태에서는 작은 공원(1만㎡ 미만)을 숨겨 핀 겹침을 줄임
    const tip = f.name + (f.level ? ` (${LEVEL_LABEL[f.level]})` : "");
    if (f.type === "bus" && !isNew) {
      // 기존 정류장은 작은 점으로(349개 이모지는 지도를 가림)
      L.circleMarker([f.lat, f.lng], { radius: 3.5, color: "#fff", weight: 1.2, fillColor: PIN_INK, fillOpacity: 0.85, interactive: !state.tool })
        .bindTooltip(tip).addTo(facLayer);
      continue;
    }
    L.marker([f.lat, f.lng], {
      icon: L.divIcon({ className: "", html: `<div class="pin${isNew ? " new" : ""}" style="--c:${isNew ? PIN_NEW : PIN[f.type][1]}">${PIN[f.type][0]}</div>`, iconSize: isNew ? [26, 26] : [22, 22] }),
      interactive: !state.tool,
    }).bindTooltip(tip).addTo(facLayer);
  }
}

function renderPanel(res, base) {
  $("#yearLabel").textContent = state.year;
  $("#kHH").textContent = res.hh.toLocaleString();
  $("#kTotal").textContent = res.summary.total.toFixed(0);
  $("#kSchoolOver").textContent = `${res.schoolOver}곳`;
  $("#kBusOver").textContent = `${res.busOver}곳`;
  const d = res.summary.total - base.summary.total;
  const el = $("#kDelta");
  el.textContent = Math.abs(d) > 0.05 ? `${d < 0 ? "▼" : "▲"}${Math.abs(d).toFixed(1)}` : "";
  el.className = d < 0 ? "down" : "up";
  $("#mapYear").textContent = state.year;
  $("#legendTitle").textContent = { total: "종합 부족도", school: "학교 부족도", bus: "버스 부족도", park: "공원 부족도" }[state.layer];

  const bar = (label, v) => `<div class="bar"><b>${label}</b><span><i style="width:${v}%;background:${color(v)}"></i></span><b>${v.toFixed(0)}</b></div>`;
  $("#bars").innerHTML = bar("학교", res.summary.school) + bar("버스", res.summary.bus) + bar("공원", res.summary.park);

  $("#report").innerHTML = buildReport(res, base).map((l) => `<p>${l}</p>`).join("");
  $("#added").innerHTML = state.added
    .map((f) => `<li>[${ICON[f.type]}] ${f.name}${f.level ? `(${LEVEL_LABEL[f.level]})` : ""} - ${f.open}년 개통</li>`).join("");
  renderSchools(res, base);
  renderTrend();
}

// 학교별 이용률(부하/정원) 상위 + 시나리오 전후 비교. 기존 재학생은 학교알리미 실측, 정원은 학급수x학급당정원(가정)
function renderSchools(res, base) {
  const baseMap = new Map(base.schools.map((s) => [s.id, s]));
  const rows = res.schools.filter((s) => s.cap > 0).sort((a, b) => b.util - a.util).slice(0, 6);
  $("#schoolsBox").innerHTML = rows.map((s) => {
    const b = baseMap.get(s.id);
    const d = b ? s.util - b.util : 0;
    const dTxt = Math.abs(d) > 0.005 ? ` <em class="${d < 0 ? "down" : "up"}">${d < 0 ? "▼" : "▲"}${Math.abs(d * 100).toFixed(0)}p</em>` : "";
    const w = Math.min(100, s.util * 100);
    return `<div class="bar bar-wide"><b title="${s.name}">${s.name.replace("초등학교", "초").replace("중학교", "중").replace("고등학교", "고").slice(0, 14)}</b><span><i style="width:${w}%;background:${color(Math.max(0, (s.util - 0.7) / 0.5 * 100))}"></i></span><b>${(s.util * 100).toFixed(0)}%${dTxt}</b></div>`;
  }).join("");
}

function renderTrend() {
  const base = YEARS.map((y) => evaluate(COMPLEXES, FACILITIES, y, DEFAULTS).summary.total);
  const scen = YEARS.map((y) => run(y).summary.total);
  const W = 300, H = 100, pad = 20, max = Math.max(60, ...base, ...scen);
  const px = (i) => pad + (i * (W - pad * 2)) / (YEARS.length - 1);
  const py = (v) => H - 20 - (v / max) * (H - 36);
  const path = (arr) => arr.map((v, i) => `${i ? "L" : "M"}${px(i)},${py(v)}`).join(" ");
  $("#trend").innerHTML =
    `<path d="${path(base)}" fill="none" stroke="#B4BBC8" stroke-width="2" stroke-dasharray="4 4" stroke-linecap="round"/>` +
    `<path d="${path(scen)}" fill="none" stroke="#3B5BDB" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>` +
    YEARS.map((y, i) => `<text x="${px(i)}" y="${H - 4}" text-anchor="middle">${y}</text>` +
      `<circle cx="${px(i)}" cy="${py(scen[i])}" r="${y === state.year ? 5.5 : 3.2}" fill="${y === state.year ? "#3B5BDB" : "#fff"}" stroke="#3B5BDB" stroke-width="${y === state.year ? 2.5 : 1.8}"/>`).join("") +
    `<text class="legend" x="${W - 4}" y="10" text-anchor="end">점선 현재 계획 · 실선 시나리오</text>`;
}

function refresh() {
  renderCompare();
  const res = run(state.year);
  const base = run(state.year, false);
  draw(res);
  renderPanel(res, base);
}

// --- 이벤트 ---
$("#year").addEventListener("input", (e) => { state.year = +e.target.value; refresh(); });
$("#layers").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  state.layer = b.dataset.layer;
  document.querySelectorAll("#layers button").forEach((x) => x.classList.toggle("on", x === b));
  refresh();
});
$("#show").addEventListener("change", (e) => {
  const k = e.target.dataset.show; if (!k) return;
  state.show[k] = e.target.checked;
  refresh();
});
$("#tools").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  state.tool = state.tool === b.dataset.tool ? null : b.dataset.tool;
  if (state.tool === "seokyo21") { state.year = TOOLS.seokyo21.open; $("#year").value = state.year; }  // 개교 연도로 이동해 효과를 바로 확인
  document.querySelectorAll("#tools button").forEach((x) => x.classList.toggle("on", x.dataset.tool === state.tool));
  map.getContainer().classList.toggle("adding", !!state.tool);
  $("#toolHint").textContent = state.tool ? "지도를 클릭해 위치를 지정하세요. (다시 누르면 해제)" : "버튼 선택 후 지도를 클릭하면 선택 연도부터 시설이 생깁니다.";
  refresh();
});
map.on("click", (e) => {
  if (!state.tool) return;
  const t = TOOLS[state.tool];
  if (t.cx) {
    const n = state.newCx.length + 1;
    state.newCx.push({ id: `N${Date.now()}`, name: `신규 단지 ${n}`, lat: e.latlng.lat, lng: e.latlng.lng, units: t.units, year: state.year });
    renderPlan(); refresh();
    return;
  }
  const grp = (state.added.at(-1)?.grp || 0) + 1;
  for (const spec of t.pair || [t]) {
    state.added.push({ ...spec, id: `U${grp}-${state.added.length + 1}`, grp, lat: e.latlng.lat, lng: e.latlng.lng, open: t.open ?? state.year });
  }
  refresh();
});
$("#undo").addEventListener("click", () => {
  const g = state.added.at(-1)?.grp;                       // 한 번에 추가된 묶음(통합학교 등)은 함께 되돌림
  state.added = state.added.filter((f) => f.grp !== g);
  refresh();
});
$("#reset").addEventListener("click", () => { state.added = []; state.plan = {}; state.newCx = []; renderPlan(); refresh(); });

map.on("zoomend", () => refresh());

// --- 탭 전환 ---
$("#tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]"); if (!b) return;
  document.querySelectorAll("#tabs button").forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-selected", x === b); });
  document.querySelectorAll(".pane").forEach((p) => { p.hidden = p.dataset.pane !== b.dataset.tab; });
  $("#panel").scrollTo({ top: Math.min($("#panel").scrollTop, $("#tabs").offsetTop - 0), behavior: "instant" });
});

// --- 입주계획 편집 ---
// 기존 단지의 세대수·입주 연도를 바꾸거나(0세대=제외) 신규 단지를 추가해 입주계획 변경의 영향을 본다.
// 주의: 2026년 이전 입주분은 학교 현원(학교알리미 2026)에 이미 포함된 것으로 보므로 학교 부하는 2027년 이후 입주분만 변화시킨다.
const PLAN_YEARS = [2023, 2024, 2025, 2026, 2027, 2028, 2029, 2030];
function baseUnits(c) { return c.phases.reduce((s2, [, n]) => s2 + n, 0); }
function baseYear(c) { return c.phases.length ? c.phases[0][0] : 2030; }

function renderPlan() {
  const row = (id, name, units, year, edited, removable) => `<div class="plan-row${edited ? " edited" : ""}" data-id="${id}">
    <span class="plan-name" title="${name}">${name.replace(/\(.*$/, "").slice(0, 14)}</span>
    <input type="number" min="0" max="5000" step="50" value="${units}" data-k="units" aria-label="${name} 세대수">
    <select data-k="year" aria-label="${name} 입주 연도">${PLAN_YEARS.map((y) => `<option value="${y}"${y === year ? " selected" : ""}>${y}</option>`).join("")}</select>
    ${removable ? '<button data-k="del" aria-label="삭제">✕</button>' : "<i></i>"}</div>`;
  const rows = COMPLEXES.map((c) => {
    const o = state.plan[c.id];
    return row(c.id, c.name, o ? o.units : baseUnits(c), o ? o.year : baseYear(c), !!o, false);
  });
  const added = state.newCx.map((n) => row(n.id, n.name, n.units, n.year, true, true));
  $("#planList").innerHTML = rows.join("") + added.join("");
}

$("#planList").addEventListener("change", (e) => {
  const el = e.target, rowEl = el.closest(".plan-row"); if (!rowEl) return;
  const id = rowEl.dataset.id, k = el.dataset.k;
  const n = state.newCx.find((x) => x.id === id);
  if (n) { n[k] = +el.value; }
  else {
    const c = COMPLEXES.find((x) => x.id === id);
    const o = state.plan[id] ?? { units: baseUnits(c), year: baseYear(c) };
    o[k] = +el.value;
    if (o.units === baseUnits(c) && o.year === baseYear(c)) delete state.plan[id]; else state.plan[id] = o;
    rowEl.classList.toggle("edited", !!state.plan[id]);
  }
  refresh();
});
$("#planList").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-k=del]"); if (!b) return;
  state.newCx = state.newCx.filter((x) => x.id !== b.closest(".plan-row").dataset.id);
  renderPlan(); refresh();
});
$("#planReset").addEventListener("click", () => { state.plan = {}; state.newCx = []; renderPlan(); refresh(); });

// --- 가정값 패널 ---
const getP = (o, path) => path.split(".").reduce((v, k) => v[k], o);
const setP = (o, path, val) => { const ks = path.split("."); const last = ks.pop(); ks.reduce((v, k) => v[k], o)[last] = val; };
const CONTROLS = [
  { grp: "수요", p: "persons", label: "세대당 가구원(명)", min: 2, max: 3.5, step: 0.1, d: 1 },
  { p: "kids.elem", label: "초등 학령인구 / 세대", min: 0.05, max: 0.3, step: 0.01, d: 2 },
  { p: "kids.mid", label: "중등 학령인구 / 세대", min: 0.02, max: 0.15, step: 0.01, d: 2 },
  { p: "kids.high", label: "고등 학령인구 / 세대", min: 0.02, max: 0.15, step: 0.01, d: 2 },
  { grp: "학교", p: "schoolCapScale", label: "학교 정원 배율", min: 0.8, max: 1.3, step: 0.05, d: 2 },
  { grp: "버스", p: "busPeakPaxPerHH", label: "세대당 첨두 버스 이용객", min: 0.1, max: 0.8, step: 0.05, d: 2 },
  { p: "busPaxPerTrip", label: "회당 수용 승객(명)", min: 25, max: 70, step: 5, d: 0 },
  { p: "busBackground", label: "기존 이용객 선점 비율", min: 0, max: 0.6, step: 0.05, d: 2 },
  { p: "busCatch", label: "버스 도보권 반경(m)", min: 300, max: 1000, step: 100, d: 0 },
  { grp: "종합 가중치(합은 자동 정규화)", p: "weights.school", label: "학교", min: 0, max: 1, step: 0.05, d: 2 },
  { p: "weights.bus", label: "버스", min: 0, max: 1, step: 0.05, d: 2 },
  { p: "weights.park", label: "공원", min: 0, max: 1, step: 0.05, d: 2 },
];

function renderParams() {
  let html = "", changed = 0;
  for (const c of CONTROLS) {
    const v = getP(PARAMS, c.p), dflt = getP(DEFAULTS, c.p), ch = Math.abs(v - dflt) > 1e-9;
    if (ch) changed++;
    if (c.grp) html += `<div class="param-grp">${c.grp}</div>`;
    html += `<div class="param-row${ch ? " changed" : ""}" data-p="${c.p}"><label>${c.label}${ch ? ` (기본 ${dflt})` : ""}</label>
      <input type="range" min="${c.min}" max="${c.max}" step="${c.step}" value="${v}" aria-label="${c.label}"><output>${(+v).toFixed(c.d)}</output></div>`;
  }
  $("#paramList").innerHTML = html;
  $("#paramBadge").textContent = changed ? `${changed}개 변경` : "";
}

$("#paramList").addEventListener("input", (e) => {
  const row = e.target.closest(".param-row"); if (!row) return;
  const c = CONTROLS.find((x) => x.p === row.dataset.p), v = +e.target.value;
  setP(PARAMS, c.p, v);
  row.querySelector("output").textContent = v.toFixed(c.d);
  const ch = Math.abs(v - getP(DEFAULTS, c.p)) > 1e-9;
  row.classList.toggle("changed", ch);
  row.querySelector("label").textContent = c.label + (ch ? ` (기본 ${getP(DEFAULTS, c.p)})` : "");
  $("#paramBadge").textContent = CONTROLS.filter((x) => Math.abs(getP(PARAMS, x.p) - getP(DEFAULTS, x.p)) > 1e-9).length + "개 변경";
  if ($("#paramBadge").textContent === "0개 변경") $("#paramBadge").textContent = "";
  refresh();
});
function resetParams() { for (const c of CONTROLS) setP(PARAMS, c.p, getP(DEFAULTS, c.p)); renderParams(); }
$("#paramReset").addEventListener("click", () => { resetParams(); refresh(); });

// --- 시나리오 저장·비교 ---
// 시나리오 = 시설 추가 + 입주계획 편집 + 가정값(기본과 다른 항목만). 브라우저 localStorage에 저장(막혀 있으면 이 세션 메모리에만).
const SC_KEY = "seokyo.scenarios.v1";
let scenarios = [];
try { scenarios = JSON.parse(localStorage.getItem(SC_KEY) || "[]"); } catch (e) { scenarios = []; }
const persistScenarios = () => { try { localStorage.setItem(SC_KEY, JSON.stringify(scenarios)); return true; } catch (e) { return false; } };
const clone = (o) => JSON.parse(JSON.stringify(o));
const diffParams = () => Object.fromEntries(CONTROLS.filter((c) => Math.abs(getP(PARAMS, c.p) - getP(DEFAULTS, c.p)) > 1e-9).map((c) => [c.p, getP(PARAMS, c.p)]));

function evalScenario(sc, year) {
  const P = clone(DEFAULTS);
  for (const [p, v] of Object.entries(sc.params || {})) setP(P, p, v);
  return evaluate(effComplexesOf(sc.plan, sc.newCx), [...FACILITIES, ...sc.added.map((f) => ({ ...f, added: true }))], year, P);
}

function renderCompare() {
  const el = $("#scTable"); if (!el) return;
  const year = state.year;
  const base = evaluate(COMPLEXES, FACILITIES, year, DEFAULTS).summary.total;
  const dirty = state.added.length || Object.keys(state.plan).length || state.newCx.length || Object.keys(diffParams()).length;
  const rows = [{ name: "기준선", cls: "base", r: evaluate(COMPLEXES, FACILITIES, year, DEFAULTS) }];
  if (dirty) rows.push({ name: "현재 작업", cls: "cur", r: run(year) });
  scenarios.forEach((sc, i) => rows.push({ name: sc.name, i, r: evalScenario(sc, year), tip: Object.keys(sc.params || {}).length ? `가정 변경: ${Object.entries(sc.params).map(([k, v]) => `${k}=${v}`).join(", ")}` : "" }));
  const f = (v) => v.toFixed(1);
  el.innerHTML = `<table><tr><th>${year}년</th><th>종합</th><th>Δ</th><th>학교</th><th>버스</th><th>공원</th><th>세대</th><th></th></tr>` +
    rows.map((x) => { const d = x.r.summary.total - base; const dc = Math.abs(d) < 0.05 ? "" : d > 0 ? "up" : "down";
      return `<tr class="${x.cls || ""}" title="${x.tip || ""}"><td>${x.name}</td><td>${f(x.r.summary.total)}</td><td class="${dc}">${dc ? (d > 0 ? "+" : "") + f(d) : "–"}</td><td>${f(x.r.summary.school)}</td><td>${f(x.r.summary.bus)}</td><td>${f(x.r.summary.park)}</td><td>${x.r.hh.toLocaleString()}</td>
      <td>${x.i === undefined ? "" : `<button data-sc="load" data-i="${x.i}">불러오기</button><button data-sc="del" data-i="${x.i}" aria-label="삭제">✕</button>`}</td></tr>`; }).join("") + "</table>";
}

$("#scSave").addEventListener("click", () => {
  const name = ($("#scName").value || "").trim() || `시나리오 ${scenarios.length + 1}`;
  scenarios.push({ id: Date.now(), name, added: clone(state.added), plan: clone(state.plan), newCx: clone(state.newCx), params: diffParams() });
  const ok = persistScenarios();
  $("#scName").value = "";
  $("#scHint").textContent = ok ? `‘${name}’ 저장됨 (이 브라우저에 보관)` : `‘${name}’ 저장됨 (브라우저 저장소를 쓸 수 없어 이번 세션에서만 유지)`;
  renderCompare();
});
$("#scTable").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-sc]"); if (!b) return;
  const i = +b.dataset.i, sc = scenarios[i]; if (!sc) return;
  if (b.dataset.sc === "del") { scenarios.splice(i, 1); persistScenarios(); renderCompare(); return; }
  state.added = clone(sc.added); state.plan = clone(sc.plan); state.newCx = clone(sc.newCx);
  resetParams(); for (const [p, v] of Object.entries(sc.params || {})) setP(PARAMS, p, v);
  renderParams(); renderPlan(); refresh();
  $("#scHint").textContent = `‘${sc.name}’을 불러왔습니다.`;
});

// --- 최적 입지 추천 ---
// 연구 범위에 후보 격자를 깔고, 후보마다 시설을 가상으로 추가해 모델을 다시 돌려 종합 부족도 감소량(gain)을 구함.
// 상위 후보를 400m 이상 간격(비최대 억제)으로 N개 추려 제시. 후보는 격자점이라 토지이용·건축 가능 여부는 검토하지 않음.
const REC = { step: 200, minSep: 400, topN: 5, pad: 0.006 };
const REC_LABEL = { "school-elem": "초등학교", "school-mid": "중학교", bus: "정류장", park: "공원" };
const recLayer = L.layerGroup().addTo(map);
let recState = { cands: [], top: [], key: null, year: null };

function candidateGrid() {
  const cxs = effComplexes().filter((c) => c.phases.length);
  const lats = cxs.map((c) => c.lat), lngs = cxs.map((c) => c.lng);
  const [s0, n0] = [Math.min(...lats) - REC.pad, Math.max(...lats) + REC.pad];
  const [w0, e0] = [Math.min(...lngs) - REC.pad, Math.max(...lngs) + REC.pad];
  const dLat = REC.step / 110540, dLng = REC.step / (111320 * Math.cos(((s0 + n0) / 2) * Math.PI / 180));
  const pts = [];
  for (let la = s0; la <= n0; la += dLat) for (let ln = w0; ln <= e0; ln += dLng) pts.push({ lat: la, lng: ln });
  return pts;
}

function evalWith(spec, p, year) {
  const extra = state.added.map((f) => ({ ...f, added: true }));
  const cand = { ...spec, id: "REC", lat: p.lat, lng: p.lng, open: year, added: true };
  return evaluate(effComplexes(), [...FACILITIES, ...extra, cand], year);
}

function nearestComplex(p, year) {
  let best = null, bd = Infinity;
  for (const c of effComplexes()) { if (!c.phases.length) continue; const d = dist(p, c); if (d < bd) { bd = d; best = c; } }
  return { name: best.name, d: Math.round(bd) };
}

// 보조 지표: 시설 종류별 수요(학령인구/세대) 가중 평균 접근거리(m). 부족도가 포화돼 동률일 때 위치를 가리는 데 사용
function meanAccess(res, key) {
  const lv = key === "school-elem" ? "elem" : key === "school-mid" ? "mid" : null;
  let sum = 0, w = 0;
  for (const x of res.items) {
    if (x.hh <= 0) continue;
    let d, wt;
    if (lv) { const sc = x.school[lv]; if (!sc || !sc.f || sc.unassigned) continue; d = sc.d; wt = sc.kids; }
    else if (key === "bus") { if (!x.bus.f) continue; d = x.bus.d; wt = x.hh; }
    else { const t = x.parkTier[0]; if (!isFinite(t.d)) continue; d = t.d; wt = x.hh; }
    sum += d * wt; w += wt;
  }
  return w ? sum / w : 0;
}

const yieldToUi = () => new Promise((ok) => { const ch = new MessageChannel(); ch.port1.onmessage = () => ok(); ch.port2.postMessage(0); });

async function recommend() {
  const key = $("#recType").value, spec = TOOLS[key], year = state.year;
  const base = run(year), baseDist = meanAccess(base, key);
  const pts = candidateGrid(), res = [];
  const t0 = performance.now();
  let lastYield = t0;
  $("#recRun").disabled = true;
  for (let i = 0; i < pts.length; i++) {
    const r = evalWith(spec, pts[i], year);
    const dDist = baseDist - meanAccess(r, key);
    res.push({ ...pts[i], gain: base.summary.total - r.summary.total, dDist,
      dSchool: base.summary.school - r.summary.school, dBus: base.summary.bus - r.summary.bus, dPark: base.summary.park - r.summary.park });
    if (performance.now() - lastYield > 40) {            // 40ms마다만 화면에 양보(타이머는 백그라운드 탭에서 1초로 지연되므로 MessageChannel 사용)
      $("#recStatus").textContent = `탐색 중… ${i + 1}/${pts.length}`;
      await yieldToUi(); lastYield = performance.now();
    }
  }
  // 주 기준: 종합 부족도 감소량. 동률(포화)이면 평균 접근거리 단축량으로 가림(100m 단축 = 0.05점 상당)
  const score = (c) => c.gain + 0.0005 * c.dDist;
  res.sort((x, y) => score(y) - score(x));
  const top = [];
  for (const c of res) {
    if (top.length >= REC.topN) break;
    if (top.every((t) => dist(t, c) >= REC.minSep)) top.push(c);
  }
  recState = { cands: res, top, key, year };
  $("#recRun").disabled = false;
  const sec = ((performance.now() - t0) / 1000).toFixed(1);
  const max = top[0]?.gain ?? 0;
  $("#recStatus").textContent = max < 0.05
    ? `후보 ${pts.length}곳을 ${sec}초 탐색: ${year}년에는 ${REC_LABEL[key]}를 추가해도 부족도가 거의 줄지 않습니다.`
    : `후보 ${pts.length}곳을 ${sec}초 탐색 (${year}년 기준, 격자 ${REC.step}m, 추천 간격 ${REC.minSep}m 이상)`;
  renderRec();
}

function renderRec() {
  recLayer.clearLayers();
  const { cands, top, key, year } = recState;
  $("#recList").innerHTML = top.map((c, i) => {
    const nc = nearestComplex(c, year);
    return `<li><b>${i + 1}위</b> <span class="gain">종합 −${c.gain.toFixed(2)}점</span><br>
      ${nc.name.slice(0, 16)} 인근 ${nc.d}m · 학교 −${c.dSchool.toFixed(2)} 버스 −${c.dBus.toFixed(2)} 공원 −${c.dPark.toFixed(2)}<br>수요 가중 평균 접근거리 ${c.dDist >= 0 ? "−" : "+"}${Math.abs(Math.round(c.dDist))}m
      <div class="acts"><button data-rec="view" data-i="${i}">지도에서 보기</button><button data-rec="add" data-i="${i}">시나리오에 추가</button></div></li>`;
  }).join("");
  if (!cands.length) return;
  const max = top[0]?.gain || 1;
  if ($("#recGrid").checked && max > 0.05) {
    for (const c of cands) {
      if (c.gain <= 0.02) continue;
      L.circleMarker([c.lat, c.lng], { radius: 6, stroke: false, fillColor: "#3B5BDB", fillOpacity: Math.max(0.06, Math.min(0.55, (c.gain / max) * 0.55)), interactive: false }).addTo(recLayer);
    }
  }
  top.forEach((c, i) => L.marker([c.lat, c.lng], {
    icon: L.divIcon({ className: "", html: `<div class="rec-pin">${i + 1}</div>`, iconSize: [28, 28] }),
    interactive: false,
  }).addTo(recLayer));
}

$("#recRun").addEventListener("click", recommend);
$("#recGrid").addEventListener("change", renderRec);
$("#recList").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  const c = recState.top[+b.dataset.i]; if (!c) return;
  if (b.dataset.rec === "view") { map.flyTo([c.lat, c.lng], Math.max(map.getZoom(), 16)); return; }
  const grp = (state.added.at(-1)?.grp || 0) + 1;
  state.added.push({ ...TOOLS[recState.key], id: `U${grp}-rec`, grp, lat: c.lat, lng: c.lng, open: recState.year });
  recState = { cands: [], top: [], key: null, year: null };
  $("#recStatus").textContent = "시나리오에 추가했습니다. 추천을 다시 계산하면 이 시설을 반영한 새 후보를 찾습니다.";
  refresh(); renderRec();
});

// --- 주소 파라미터 적용 ---
(function applyUrlParams() {
  const y = +URLP.get("year");
  if (YEARS.includes(y)) { state.year = y; $("#year").value = y; }
  const layer = URLP.get("layer");
  if (LAYER_KEY[layer]) {
    state.layer = layer;
    document.querySelectorAll("#layers button").forEach((x) => x.classList.toggle("on", x.dataset.layer === layer));
  }
  if (URLP.get("labels") === "1") state.labels = true;
  if (URLP.get("pins") === "0") { state.show.school = false; state.show.park = false; document.querySelectorAll('#show input[data-show="school"], #show input[data-show="park"]').forEach((c) => { c.checked = false; }); }   // 학교·공원 핀 숨김(캡처용)
  if (URLP.get("buses") === "1") { state.show.bus = true; const c = document.querySelector('#show input[data-show="bus"]'); if (c) c.checked = true; }
  // add=bus:37.1622,127.0492;seokyo21:37.1395,127.0425  (시설 종류:위도,경도; 여러 개는 세미콜론)
  for (const item of (URLP.get("add") || "").split(";").filter(Boolean)) {
    const [key, pos] = item.split(":"); const [lat, lng] = (pos || "").split(",").map(Number);
    const t = TOOLS[key]; if (!t || !isFinite(lat) || !isFinite(lng)) continue;
    const grp = (state.added.at(-1)?.grp || 0) + 1;
    for (const spec of t.pair || [t]) state.added.push({ ...spec, id: `U${grp}-${state.added.length + 1}`, grp, lat, lng, open: t.open ?? state.year });
  }
  // zoom=15&center=37.152,127.048 (지도 확대·중심 지정)
  const z = +URLP.get("zoom"), [clat, clng] = (URLP.get("center") || "").split(",").map(Number);
  if (isFinite(z) && z > 0) {
    // 창 크기가 확정된 뒤(헤드리스·리사이즈 포함)에도 같은 확대·중심이 유지되도록 여러 시점에 적용
    const applyView = () => { map.invalidateSize({ animate: false }); map.setView(isFinite(clat) && isFinite(clng) ? [clat, clng] : map.getCenter(), z, { animate: false }); };
    applyView();
    window.addEventListener("load", applyView);
    [200, 700, 1500].forEach((ms) => setTimeout(applyView, ms));
  }
  const tab = URLP.get("tab");
  if (tab) { const b = document.querySelector(`#tabs button[data-tab="${tab}"]`); if (b) b.click(); }
})();

renderPlan();
renderParams();
refresh();
if (URLP.get("focus") === "schools") requestAnimationFrame(() => $("#schoolsBox").scrollIntoView({ block: "center" }));   // 캡처용: 학교 이용률 패널로 스크롤
// 디버그/검증용
window.__twin = { state, run, PARAMS, map };
$("#dataBadge").textContent = `단지: ${cxSource} · 시설: ${facSource} · 학교 배정: ${zoneSource}`;
if (cxSkipped.length) console.warn("좌표/입주월 누락으로 제외된 단지:", cxSkipped.join(", "));
