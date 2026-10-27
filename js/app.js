import { CENTER as SAMPLE_CENTER, YEARS, COMPLEXES as SAMPLE_COMPLEXES, FACILITIES as SAMPLE_FAC } from "./data.js";
import { evaluate, buildReport, LEVEL_LABEL, PARAMS, dist } from "./model.js?v=bus1";

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
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const lines = (...a) => a.filter(Boolean).map((t) => `<span>${t}</span>`).join("");   // 안내문은 한 문장 = 한 줄
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
  // 분야(학교·버스·공원)마다 머리줄(이름 + 점수)을 두고, 세부 항목은 모두 같은 들여쓰기·같은 열에서 시작
  const school = (k) => {
    const s = x.school[k];
    if (s.unassigned) return "통학구역 미확정";
    return s.f ? `${s.f.name}<small>${Math.round(s.d)}m · 정원 ${s.over ? "+" + (s.over * 100).toFixed(0) + "% 초과" : "여유"}</small>` : "없음";
  };
  const head = (label, v, cls = "") => `<tr class="grp${cls}"><th colspan="2">${label}</th><td class="sc"><i style="background:${color(v)}"></i>${v.toFixed(0)}점</td></tr>`;
  const item = (label, val) => `<tr class="item"><td>${label}</td><td colspan="2">${val}</td></tr>`;
  const routes = x.bus.nRoutes ? `${x.bus.nRoutes}개<small>첨두 이용률 ${(x.bus.util * 100).toFixed(0)}% (가정 기반)</small>` : "없음";
  return `<div class="pop"><div class="pop-head"><b>${x.c.name}</b><span>${x.hh.toLocaleString()}세대 입주</span></div><table>
    ${head("종합 부족도", x.total, " total")}
    ${head("학교", x.schoolScore)}
    ${item("초등", school("elem"))}${item("중등", school("mid"))}${item("고등", school("high"))}
    ${head("버스", x.busScore)}
    ${item("최근접 정류장", x.bus.f ? Math.round(x.bus.d) + "m" : "없음")}${item("도보권 노선", routes)}
    ${head("공원", x.parkScore)}
    ${x.parkTier.map((tr) => item(tr.label, `${isFinite(tr.d) ? Math.round(tr.d) + "m" : "없음"} <small class="in">/ 기준 ${tr.reach}m</small>`)).join("")}
  </table></div>`;
}

const narrow = () => matchMedia("(max-width: 900px)").matches;   // style.css의 좁은 화면 기준과 같음
map.on("popupopen popupclose", (e) => $("#stage").classList.toggle("pop-open", e.type === "popupopen"));

function draw(res) {
  complexLayer.clearLayers();
  for (const x of res.items) {
    if (x.hh <= 0) {
      L.circle([x.c.lat, x.c.lng], { radius: 60, color: "#98A2B3", weight: 1.5, dashArray: "4", fillColor: "#98A2B3", fillOpacity: 0.12 })
        .bindTooltip(`${x.c.name} (미입주)`).addTo(complexLayer);
      continue;
    }
    const score = x[LAYER_KEY[state.layer]];
    // 팝업: 넓은 화면은 위쪽 연도 상자(HUD) 아래로 자동 이동, 좁은 화면은 지도 높이에 맞춰 안에서 스크롤(HUD는 팝업이 열린 동안 숨김)
    L.circle([x.c.lat, x.c.lng], {
      radius: 70 + Math.sqrt(x.hh) * 3.2, color: "#fff", fillColor: color(score), fillOpacity: 0.78, weight: 2.5,
    }).bindPopup(popup(x), narrow() ? { minWidth: 260, maxWidth: 300, maxHeight: Math.max(200, map.getSize().y - 70), autoPanPaddingTopLeft: [48, 10], autoPanPaddingBottomRight: [8, 8] } : { minWidth: 300, maxWidth: 340, autoPanPaddingTopLeft: [20, 110] }).bindTooltip(
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
  renderOverview(res, base);
  $("#mapYear").textContent = state.year;
  $("#legendTitle").textContent = { total: "종합 부족도", school: "학교 부족도", bus: "버스 부족도", park: "공원 부족도" }[state.layer];

  const bar = (label, v) => `<div class="bar"><b>${label}</b><span><i style="width:${v}%;background:${color(v)}"></i></span><b>${v.toFixed(0)}</b></div>`;
  $("#bars").innerHTML = bar("학교", res.summary.school) + bar("버스", res.summary.bus) + bar("공원", res.summary.park);

  // 정책 리포트: 순위 번호 | 단지명 ··· 점수, 아래에 원인 한 줄씩(모든 줄이 같은 열에서 시작)
  const rep = buildReport(res);
  $("#report").innerHTML = `<ol class="prio">${rep.prio.map((p, i) => `<li><span class="rank">${i + 1}</span><div><p class="prio-head"><b>${p.name}</b><span>${p.score.toFixed(0)}점</span></p>${p.causes.map((c) => `<p class="cause">${c}</p>`).join("")}</div></li>`).join("")}</ol>`;
  $("#added").innerHTML = state.added
    .map((f) => `<li><span>${f.name}${f.level ? ` (${LEVEL_LABEL[f.level]})` : ""}</span><span>${f.open}년 개통</span></li>`).join("");
  renderSchools(res, base);
}

// 상단 요약: 연도 막대(누적 입주 세대 높이 + 종합 부족도 색) = 연도 선택기, 아래에 선택 연도를 문장으로
function renderOverview(res, base) {
  const byYear = YEARS.map((y) => (y === state.year ? res : run(y)));
  const maxHH = Math.max(1, ...byYear.map((r) => r.hh));
  $("#timeline").innerHTML = byYear.map((r, i) => {
    const y = YEARS[i], on = y === state.year, t = r.summary.total;
    return `<button type="button" role="radio" aria-checked="${on}" tabindex="${on ? 0 : -1}" data-year="${y}" class="tl-col${on ? " on" : ""}"
      aria-label="${y}년, ${r.hh.toLocaleString()}세대, 종합 부족도 ${t.toFixed(0)}점">
      <span class="tl-score">${t.toFixed(0)}점</span>
      <span class="tl-bar"><i style="height:${Math.max(4, (r.hh / maxHH) * 100)}%;background:${color(t)}"></i></span>
      <span class="tl-year">${y}</span></button>`;
  }).join("");

  // 첫 요약은 물리 단위(정원을 넘는 학교, 이용률 100%를 넘는 노선, 기준 밖 단지)가 주인공. 종합 점수는 보조
  const pct = (u) => `${Math.round(u * 100)}%`;
  const top3 = (arr, f) => arr.slice(0, 3).map(f).join(" · ") + (arr.length > 3 ? ` 외 ${arr.length - 3}` : "");
  const row = (label, val, detail) => `<div><dt>${label}</dt><dd>${val}</dd>${detail ? `<p class="over-detail">${detail}</p>` : ""}</div>`;
  const so = res.schoolsOver, ro = res.routesOver;
  const short = (n) => n.replace("등학교", "").replace("학교", "");
  const d = res.summary.total - base.summary.total;
  const delta = Math.abs(d) > 0.05 ? ` <span class="delta ${d < 0 ? "down" : "up"}">현재 계획보다 ${Math.abs(d).toFixed(1)}점 ${d < 0 ? "낮음" : "높음"}</span>` : "";
  $("#readout").innerHTML =
    `<span class="lead-line"><b>${state.year}년</b>까지 <b>${res.hh.toLocaleString()}세대</b>가 입주합니다.</span>` +
    `<dl class="over">` +
    row("정원을 넘는 배정 학교", so.length ? `${so.length}곳` : "없음", so.length ? top3(so, (x) => `${short(x.name)} ${pct(x.util)}`) : "") +
    row("이용률 100%를 넘는 버스 노선", ro.length ? `${ro.length}개` : "없음", ro.length ? top3(ro, (x) => `${x.name}번 ${pct(x.util)}`) : "") +
    row("공원 유치거리 밖 단지", `${res.parkOut}곳 / ${res.active}곳`, "") + `</dl>` +
    `<span class="total-line">종합 부족도 <i class="dot" style="background:${color(res.summary.total)}"></i><b>${res.summary.total.toFixed(0)}점</b>${delta}</span>` +
    (so.length ? `<span class="note">학교 정원은 학급 수 × 학급당 25·29명으로 가정했습니다.</span>` : "");
}
const pickYear = (y) => { state.year = y; $("#year").value = y; refresh(); };
$("#timeline").addEventListener("click", (e) => { const b = e.target.closest("[data-year]"); if (b) pickYear(+b.dataset.year); });
$("#timeline").addEventListener("keydown", (e) => {   // 라디오 그룹 관례: 좌우 화살표로 연도 이동
  const step = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[e.key]; if (!step) return;
  e.preventDefault();
  const i = Math.min(YEARS.length - 1, Math.max(0, YEARS.indexOf(state.year) + step));
  pickYear(YEARS[i]); $(`#timeline [data-year="${YEARS[i]}"]`).focus();
});

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
  $("#toolHint").innerHTML = state.tool ? lines("지도를 클릭해 위치를 정하세요.", "같은 버튼을 다시 누르면 취소됩니다.") : lines("버튼을 고르고 지도를 클릭하면 시설이 생깁니다.", "시설은 선택한 연도부터 열립니다.");
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
// 되돌릴 수 없는 작업은 앱 안의 확인창으로 묻는다(제목 = 질문, 본문 = 무엇이 지워지는지 + 되돌릴 수 없음)
function confirmDlg(title, body, okLabel) {
  const d = $("#confirmDlg");
  $("#dlgTitle").textContent = title; $("#dlgBody").innerHTML = lines(body, "되돌릴 수 없습니다."); $("#dlgOk").textContent = okLabel;
  d.showModal();
  return new Promise((ok) => {
    const done = (v) => { d.close(); $("#dlgOk").onclick = $("#dlgCancel").onclick = d.oncancel = null; ok(v); };
    $("#dlgOk").onclick = () => done(true);
    $("#dlgCancel").onclick = () => done(false);
    d.oncancel = (e) => { e.preventDefault(); done(false); };   // Esc
  });
}
$("#reset").addEventListener("click", async () => {
  if (!state.added.length && !Object.keys(state.plan).length && !state.newCx.length) return;
  if (!(await confirmDlg("시나리오를 초기화하시겠습니까?", "추가한 시설과 입주계획 편집이 모두 지워집니다.", "초기화"))) return;
  state.added = []; state.plan = {}; state.newCx = []; renderPlan(); refresh();
});

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

// 입주계획 목록용 짧은 이름: 괄호 설명과 모든 단지에 붙는 지역 접두어(오산·오산역·세교)를 뺌. 전체 이름은 title로
const shortName = (n) => n.replace(/\(.*$/, "").replace(/^((오산역|오산|세교)\s*)+/, "").trim() || n;
function renderPlan() {
  const row = (id, name, units, year, edited, removable) => `<div class="plan-row${edited ? " edited" : ""}" data-id="${id}">
    <span class="plan-name" title="${name}">${shortName(name)}${removable ? ` <button data-k="del" aria-label="${name} 삭제">삭제</button>` : ""}</span>
    <input type="number" min="0" max="5000" step="50" value="${units}" data-k="units" aria-label="${name} 세대수">
    <select data-k="year" aria-label="${name} 입주 연도">${PLAN_YEARS.map((y) => `<option value="${y}"${y === year ? " selected" : ""}>${y}</option>`).join("")}</select>
    </div>`;
  const rows = COMPLEXES.map((c) => {
    const o = state.plan[c.id];
    return row(c.id, c.name, o ? o.units : baseUnits(c), o ? o.year : baseYear(c), !!o, false);
  });
  const added = state.newCx.map((n) => row(n.id, n.name, n.units, n.year, true, true));
  $("#planList").innerHTML = `<div class="plan-row plan-head"><span>단지</span><span>세대수</span><span>입주 연도</span></div>` + rows.join("") + added.join("");
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
$("#planReset").addEventListener("click", async () => {
  if (!Object.keys(state.plan).length && !state.newCx.length) return;
  if (!(await confirmDlg("입주계획을 초기화하시겠습니까?", "바꾼 세대수·입주 연도와 추가한 단지가 지워집니다.", "초기화"))) return;
  state.plan = {}; state.newCx = []; renderPlan(); refresh();
});

// --- 가정값 패널 ---
const getP = (o, path) => path.split(".").reduce((v, k) => v[k], o);
const setP = (o, path, val) => { const ks = path.split("."); const last = ks.pop(); ks.reduce((v, k) => v[k], o)[last] = val; };
const CONTROLS = [
  { grp: "수요", p: "persons", label: "세대당 가구원(명)", min: 2, max: 3.5, step: 0.1, d: 1 },
  { p: "kids.elem", label: "초등 학령인구 / 세대", min: 0.05, max: 0.3, step: 0.01, d: 2 },
  { p: "kids.mid", label: "중등 학령인구 / 세대", min: 0.02, max: 0.15, step: 0.01, d: 2 },
  { p: "kids.high", label: "고등 학령인구 / 세대", min: 0.02, max: 0.15, step: 0.01, d: 2 },
  { grp: "학교", p: "schoolCapScale", label: "학교 정원 배율", min: 0.8, max: 1.3, step: 0.05, d: 2 },
  { grp: "버스", p: "busPeakPaxPerHH", label: "세대당 첨두 버스 이용객", min: 0.01, max: 0.5, step: 0.001, d: 3 },
  { p: "busPaxPerTrip", label: "회당 수용 승객(명)", min: 25, max: 70, step: 5, d: 0 },
  { p: "busBackground", label: "기존 이용객 선점 비율", min: 0, max: 0.6, step: 0.05, d: 2 },
  { p: "busCatch", label: "버스 도보권 반경(m)", min: 300, max: 1000, step: 100, d: 0 },
  { grp: "종합 가중치(정책 우선순위에 따라 정하는 값)", p: "weights.school", label: "학교", min: 0, max: 1, step: 0.05, d: 2 },
  { p: "weights.bus", label: "버스", min: 0, max: 1, step: 0.05, d: 2 },
  { p: "weights.park", label: "공원", min: 0, max: 1, step: 0.05, d: 2 },
];

let BUS_FIT = null;   // data/bus_rate.json(있을 때만)
fetch("data/bus_rate.json").then((r) => (r.ok ? r.json() : null)).then((j) => { if (j && j.peak_per_hh != null) { BUS_FIT = j; renderParams(); } }).catch(() => {});
$("#paramList").addEventListener("click", (e) => {
  if (!BUS_FIT || !["useBusFit", "useOldBus"].includes(e.target.id)) return;
  const c = CONTROLS.find((x) => x.p === "busPeakPaxPerHH");
  setP(PARAMS, c.p, e.target.id === "useOldBus" ? 0.3 : Math.min(c.max, Math.max(c.min, BUS_FIT.peak_per_hh)));
  renderParams(); refresh();
});
function renderParams() {
  let html = "", changed = 0;
  for (const c of CONTROLS) {
    const v = getP(PARAMS, c.p), dflt = getP(DEFAULTS, c.p), ch = Math.abs(v - dflt) > 1e-9;
    if (ch) changed++;
    if (c.grp) html += `<div class="param-grp">${c.grp}</div>`;
    html += `<div class="param-row${ch ? " changed" : ""}" data-p="${c.p}"><label>${c.label}${ch ? ` (기본 ${dflt})` : ""}</label>
      <input type="range" min="${c.min}" max="${c.max}" step="${c.step}" value="${v}" aria-label="${c.label}"><output>${(+v).toFixed(c.d)}</output></div>`;
    // 승하차 데이터로 추정한 값이 있으면 가정값 바로 아래에 함께 보여 준다(scripts/fit_bus_rate.py → data/bus_rate.json)
    // 기본값이 이미 데이터 추정치면 "쓰는 중"으로, 예전 가정(0.3)과 비교할 수 있는 버튼을 둔다
    const usingFit = BUS_FIT && Math.abs(v - BUS_FIT.peak_per_hh) < 1e-9;
    if (c.p === "busPeakPaxPerHH" && BUS_FIT) html += `<div class="param-fit"><span>데이터 추정 <b>${BUS_FIT.peak_per_hh}</b>명${usingFit ? " · 지금 쓰는 값" : ""}</span>${usingFit ? `<button type="button" id="useOldBus">예전 가정 0.3과 비교</button>` : `<button type="button" id="useBusFit">이 값 쓰기</button>`}
      <p><span>세대당 하루 승차 ${BUS_FIT.daily_per_hh}회 × 첨두 비중 ${Math.round(BUS_FIT.peak_share_assumed * 100)}%(가정)</span><span>단지 ${BUS_FIT.complexes.length}곳의 입주 전후 승하차를 비교했습니다.</span></p></div>`;
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
$("#paramReset").addEventListener("click", async () => {
  if (!Object.keys(diffParams()).length) return;
  if (!(await confirmDlg("가정값을 기본으로 되돌리시겠습니까?", "바꾼 가정값이 모두 기본값으로 돌아갑니다.", "기본으로"))) return;
  resetParams(); refresh();
});

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
  el.innerHTML = `<table><tr><th>${year}년</th><th>종합</th><th>변화</th><th>학교</th><th>버스</th><th>공원</th><th>세대</th></tr>` +
    rows.map((x) => { const d = x.r.summary.total - base; const dc = Math.abs(d) < 0.05 ? "" : d > 0 ? "up" : "down";
      // 저장된 시나리오는 이름·버튼을 머리줄로 올리고 숫자 행 첫 칸은 비워 둠(좁은 화면에서도 이름이 갈라지지 않게)
      const head = x.i === undefined ? "" : `<tr class="sc-head" title="${x.tip || ""}"><td colspan="7"><b>${esc(x.name)}</b><button data-sc="load" data-i="${x.i}">불러오기</button><button data-sc="del" data-i="${x.i}">삭제</button></td></tr>`;
      return head + `<tr class="${x.cls || ""}" title="${x.tip || ""}"><td>${x.i === undefined ? esc(x.name) : ""}</td><td>${f(x.r.summary.total)}</td><td class="${dc}">${dc ? (d > 0 ? "+" : "") + f(d) : "–"}</td><td>${f(x.r.summary.school)}</td><td>${f(x.r.summary.bus)}</td><td>${f(x.r.summary.park)}</td><td>${x.r.hh.toLocaleString()}</td></tr>`; }).join("") + "</table>";
}

$("#scSave").addEventListener("click", () => {
  const name = ($("#scName").value || "").trim() || `시나리오 ${scenarios.length + 1}`;
  scenarios.push({ id: Date.now(), name, added: clone(state.added), plan: clone(state.plan), newCx: clone(state.newCx), params: diffParams() });
  const ok = persistScenarios();
  $("#scName").value = "";
  $("#scHint").innerHTML = lines(`‘${esc(name)}’을 저장했습니다.`, ok ? "이 브라우저에만 보관됩니다." : "저장소를 쓸 수 없어 이번 접속에서만 유지됩니다.");
  renderCompare();
});
$("#scTable").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-sc]"); if (!b) return;
  const i = +b.dataset.i, sc = scenarios[i]; if (!sc) return;
  if (b.dataset.sc === "del") {
    if (!(await confirmDlg(`‘${sc.name}’ 시나리오를 삭제하시겠습니까?`, "저장한 시나리오가 지워집니다.", "삭제"))) return;
    scenarios.splice(scenarios.indexOf(sc), 1); persistScenarios(); renderCompare(); return;
  }
  state.added = clone(sc.added); state.plan = clone(sc.plan); state.newCx = clone(sc.newCx);
  resetParams(); for (const [p, v] of Object.entries(sc.params || {})) setP(PARAMS, p, v);
  renderParams(); renderPlan(); refresh();
  $("#scHint").innerHTML = lines(`‘${esc(sc.name)}’을 불러왔습니다.`);
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
      $("#recStatus").innerHTML = lines(`후보 ${pts.length}곳 중 ${i + 1}곳을 계산했습니다.`);
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
  $("#recStatus").innerHTML = max < 0.05
    ? lines(`후보 ${pts.length}곳을 모두 계산했습니다.`, `${year}년에는 ${REC_LABEL[key]}${eulReul(REC_LABEL[key])} 더해도 효과가 거의 없습니다.`)
    : lines(`${year}년 기준 후보 ${pts.length}곳을 ${sec}초 만에 계산했습니다.`, `추천 위치끼리는 ${REC.minSep}m 이상 떨어뜨렸습니다.`);
  renderRec();
}

function renderRec() {
  recLayer.clearLayers();
  const { cands, top, key, year } = recState;
  $("#recList").innerHTML = top.map((c, i) => {
    const nc = nearestComplex(c, year);
    const parts = [["학교", c.dSchool], ["버스", c.dBus], ["공원", c.dPark]].filter(([, v]) => Math.abs(v) >= 0.01).map(([k, v]) => `${k} −${v.toFixed(1)}점`);
    const dd = Math.round(c.dDist);
    return `<li><span class="rank">${i + 1}</span><div>
      <p class="rec-head"><b>${nc.name.replace(/\(.*$/, "")} 인근</b><span class="gain">${c.gain >= 0.05 ? `종합 −${c.gain.toFixed(1)}점` : "변화 거의 없음"}</span></p>
      <p class="rec-sub">가장 가까운 단지까지 ${nc.d}m</p>
      ${parts.length ? `<p class="rec-sub">${parts.join(" · ")}</p>` : ""}
      ${Math.abs(dd) >= 1 ? `<p class="rec-sub">평균 접근거리 ${Math.abs(dd)}m ${dd > 0 ? "단축" : "증가"}</p>` : ""}
      <div class="acts"><button data-rec="view" data-i="${i}">지도에서 보기</button><button data-rec="add" data-i="${i}">시나리오에 추가</button></div></div></li>`;
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
  $("#recStatus").innerHTML = lines("고른 위치를 시나리오에 추가했습니다.", "다시 계산하면 그다음 후보를 찾습니다.");
  refresh(); renderRec();
});

// --- AI(Claude Haiku 5.5): 정책 리포트 문장 쓰기, 말로 시나리오 만들기 ---
// 키는 정적 사이트에 둘 수 없어 ai-worker(Cloudflare Worker)를 거친다. 주소는 index.html의 meta[name=seokyo-ai].
// 로컬 확인용으로만 ?ai=주소 덮어쓰기를 허용(외부 링크가 요청을 다른 서버로 보내지 못하게)
const AI_BASE = ((["localhost", "127.0.0.1"].includes(location.hostname) && URLP.get("ai")) || document.querySelector('meta[name="seokyo-ai"]')?.content || "").replace(/\/$/, "");
async function aiCall(path, body) {
  if (!AI_BASE) throw new Error("AI 서버가 아직 연결되지 않았습니다.");
  let r;
  try { r = await fetch(AI_BASE + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); }
  catch (e) { throw new Error("AI 서버에 연결하지 못했습니다."); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `AI 요청이 실패했습니다(${r.status}).`);
  return j;
}

// 리포트 근거: 화면이 계산한 수치를 번호 붙은 사실로 만든다. AI는 이 사실의 숫자만 쓸 수 있다(서버가 검사)
function aiFacts() {
  const res = run(state.year), base = run(state.year, false), F = [];
  const add = (text) => F.push({ id: `F${F.length + 1}`, text });
  add(`${state.year}년까지 입주 세대 ${res.hh.toLocaleString()}세대, 입주 단지 ${res.active}곳`);
  add(`종합 부족도 ${Math.round(res.summary.total)}점(가정 기반 상대 비교), 학교 ${Math.round(res.summary.school)}점, 버스 ${Math.round(res.summary.bus)}점, 공원 ${Math.round(res.summary.park)}점`);
  if (res.schoolsOver.length) for (const s of res.schoolsOver.slice(0, 4)) add(`배정 학교 ${s.name}의 정원 대비 부하 ${Math.round(s.util * 100)}%`);
  else add("정원을 넘는 배정 학교 없음");
  const ro = res.routesOver;
  add(ro.length ? `이용률 100%를 넘는 버스 노선 ${ro.length}개, 가장 높은 노선은 ${ro[0].name}번 ${Math.round(ro[0].util * 100)}%` : "이용률 100%를 넘는 버스 노선 없음");
  add(`공원 유치거리 밖 단지 ${res.parkOut}곳(전체 ${res.active}곳 중)`);
  buildReport(res).prio.forEach((p, i) => add(`우선 점검 ${i + 1}순위 ${p.name}(${Math.round(p.score)}점): ${p.causes.join(", ")}`));
  const d = res.summary.total - base.summary.total;
  if (Math.abs(d) > 0.05) add(`시나리오를 적용하면 종합 부족도가 현재 계획보다 ${Math.abs(d).toFixed(1)}점 ${d < 0 ? "낮음" : "높음"}`);
  return F;
}
$("#aiReportBtn").addEventListener("click", async () => {
  const box = $("#aiReport"), btn = $("#aiReportBtn"), facts = aiFacts();
  btn.disabled = true; box.innerHTML = `<p class="ai-status">AI가 리포트를 쓰는 중입니다.</p>`;
  try {
    const r = await aiCall("/api/report", { year: state.year, facts });
    const byId = new Map(facts.map((f) => [f.id, f.text]));
    box.innerHTML = `<ol class="ai-lines">${r.sentences.map((s) => `<li><span>${esc(s.text)}</span><span class="ai-refs">${s.facts.map((id) => `<abbr title="${esc(byId.get(id) || "")}">${esc(id)}</abbr>`).join("")}</span></li>`).join("")}</ol>` +
      `<p class="ai-note"><span>Claude Haiku 5.5가 아래 근거의 숫자만 써서 만든 문장입니다.</span>${r.dropped.length ? `<span>근거에 없는 숫자를 쓴 문장 ${r.dropped.length}개는 걸러 냈습니다.</span>` : ""}</p>` +
      `<details class="ai-facts"><summary>근거 보기</summary><ol>${facts.map((f) => `<li><b>${f.id}</b> ${esc(f.text)}</li>`).join("")}</ol></details>`;
  } catch (e) { box.innerHTML = `<p class="ai-status err">${esc(e.message)}</p>`; }
  btn.disabled = false;
});

// 말로 시나리오 만들기: 질문 → (AI) 조작 목록 → 사용자가 확인하면 적용
const FAC_LABEL = { "school-elem": "초등학교", "school-mid": "중학교", bus: "정류장", park: "공원" };
// 받침이 있으면 "을", 없으면 "를"(한글이 아니면 "을")
const eulReul = (w) => { const c = w.trim().slice(-1).charCodeAt(0) - 0xac00; return c >= 0 && c < 11172 && c % 28 === 0 ? "를" : "을"; };
const cxById = (id) => COMPLEXES.find((c) => c.id === id) || state.newCx.find((c) => c.id === id);
const describeOp = (o) => ({
  set_year: () => `기준 연도를 ${o.year}년으로 바꿉니다.`,
  set_units: () => `${shortName(cxById(o.complex_id).name)} 세대수를 ${o.units.toLocaleString()}세대로 바꿉니다.`,
  set_movein: () => `${shortName(cxById(o.complex_id).name)} 입주를 ${o.year}년으로 바꿉니다.`,
  add_facility: () => `${shortName(cxById(o.complex_id).name)} 근처에 ${FAC_LABEL[o.facility]}${eulReul(FAC_LABEL[o.facility])} 추가합니다${o.year ? `(${o.year}년 개통)` : ""}.`,
  set_param: () => { const l = CONTROLS.find((c) => c.p === o.param)?.label ?? o.param; return `${l}${eulReul(l.replace(/\(.*\)$/, ""))} ${o.value}로 바꿉니다.`; },
}[o.op]());
const aiCatalog = () => ({
  currentYear: state.year, years: YEARS, moveinYears: PLAN_YEARS,
  complexes: COMPLEXES.map((c) => ({ id: c.id, name: c.name, units: state.plan[c.id]?.units ?? baseUnits(c), movein: state.plan[c.id]?.year ?? baseYear(c) })),
  params: CONTROLS.map((c) => ({ key: c.p, label: c.label, min: c.min, max: c.max, value: getP(PARAMS, c.p) })),
});
function applyOps(ops) {
  for (const o of ops) {
    const c = o.complex_id ? COMPLEXES.find((x) => x.id === o.complex_id) : null;
    if ((o.op === "set_units" || o.op === "set_movein") && c) {
      const cur = state.plan[c.id] ?? { units: baseUnits(c), year: baseYear(c) };
      state.plan[c.id] = o.op === "set_units" ? { ...cur, units: o.units } : { ...cur, year: o.year };
    } else if (o.op === "add_facility" && c) {
      const grp = (state.added.at(-1)?.grp || 0) + 1;   // 단지 바로 북쪽(약 130m)에 둔다
      state.added.push({ ...TOOLS[o.facility], id: `U${grp}-ai`, grp, lat: c.lat + 0.0012, lng: c.lng, open: o.year ?? state.year });
    } else if (o.op === "set_param") setP(PARAMS, o.param, o.value);
  }
  const y = ops.find((o) => o.op === "set_year")?.year;
  if (y) { state.year = y; $("#year").value = y; }
  renderParams(); renderPlan(); refresh();
}
let nlPending = null;
async function nlAsk(question) {
  const box = $("#nlResult");
  box.innerHTML = `<p class="ai-status">AI가 질문을 해석하는 중입니다.</p>`;
  try {
    const r = await aiCall("/api/whatif", { question, catalog: aiCatalog() });
    nlPending = r.ops;
    // 바뀌는 내용은 앱이 조작 목록에서 직접 문장으로 만든다(AI 요약은 같은 말이라 보여 주지 않음)
    box.innerHTML = (r.ops.length ? `<p class="nl-summary">이렇게 바꿉니다.</p><ul class="nl-ops">${r.ops.map((o) => `<li>${esc(describeOp(o))}</li>`).join("")}</ul>` : "") +
      (r.unsupported ? `<p class="ai-status err">${esc(r.unsupported)}</p>` : "") +
      (r.rejected.length ? `<p class="ai-status err">적용할 수 없는 조작 ${r.rejected.length}개를 뺐습니다: ${r.rejected.map((x) => esc(x.reason)).join(" ")}</p>` : "") +
      (r.ops.length ? `<div class="row nl-acts"><button type="button" id="nlCancel">취소</button><button type="button" id="nlApply" class="primary">적용</button></div>` : "");
  } catch (e) { box.innerHTML = `<p class="ai-status err">${esc(e.message)}</p>`; }
}
$("#nlForm").addEventListener("submit", (e) => { e.preventDefault(); const q = $("#nlInput").value.trim(); if (q.length >= 2) nlAsk(q); });
$("#nlExamples").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; $("#nlInput").value = b.textContent; nlAsk(b.textContent); });
$("#nlResult").addEventListener("click", (e) => {
  if (e.target.id === "nlApply" && nlPending) { applyOps(nlPending); $("#nlResult").innerHTML = `<p class="ai-status">적용했습니다. 위쪽 요약과 지도에서 바뀐 결과를 확인하세요.</p>`; nlPending = null; }
  if (e.target.id === "nlCancel") { nlPending = null; $("#nlResult").innerHTML = ""; }
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
