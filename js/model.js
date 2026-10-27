// 부족도 모델. 모든 점수는 0(충분)~100(심각 부족). 계수는 PARAMS에서 조정.
// 설명 가능성을 위해 규칙 기반으로 두고, 계수 출처는 발표 시 명시.

export const PARAMS = {
  schoolCapScale: 1, // 학교 정원 배율(가정 패널에서 조정). 정원 = 학급수 x 학급당 정원 x 배율
  // 학교 현원(학교알리미 2026 공시, 4월 1일 기준)에 이미 들어 있는 입주의 마지막 달. 이 달까지 입주한 세대는 새 학생 수요로 더하지 않는다.
  // 예전에는 연도만 봐서 2026년 4~10월 입주 단지(파라곤·라프리미어·금강펜테리움 2,828세대)의 학생이 현원에도 신규 수요에도 빠졌음
  schoolBaseYM: "2026-03",
  persons: 2.8, // 세대당 가구원
  // 세대당 학령인구. 초등은 실측: 이 단지들과 함께 개교한 세담초(2024)·마루초(2025)의 2026 현원 1,317명 ÷ 학구 안 입주 세대 3,400 = 0.39
  // (예전 가정 0.17은 백테스트에서도 낮게 나왔음, docs/backtest.md). 학구에 다른 주택이 섞여 있으면 과대일 수 있음. 중·고는 기존 시가지와 섞여 실측 불가 → 가정
  kids: { elem: 0.39, mid: 0.07, high: 0.07 },
  walkLimit: { elem: 1000, mid: 1500, high: 2000, bus: 400, park: 800 }, // m
  // 세대당 첨두시 버스 이용객. 경기도 정류소별 승하차(2023-01~2026-08)로 추정한 값(scripts/fit_bus_rate.py → data/bus_rate.json):
  // 세대당 하루 승차 0.216회 × 첨두 1시간 비중 15%(가정) = 0.032. 예전 근거 없는 가정 0.3은 약 10배 과대였음(docs/ai.md)
  busPeakPaxPerHH: 0.032,
  busPaxPerTrip: 45, // 회당 수용 승객(가정, 민감도 30~60의 중간값; build_data.py의 BUS_PAX_PER_TRIP과 동일 유지)
  // 기존 이용객: 노선별 양방향 첨두 1시간 승차(실제 정류소 승차를 노선에 배차 비율로 나눈 값, scripts/estimate_bus_background.py → data/bus_background.json).
  // 앱이 불러와 채운다. 노선 부하 = 이 값 × 최대 재차 비율(가정: 가장 붐비는 구간에서 한 방향 버스에 동시에 탄 사람 ÷ 양방향 승차)
  busBg: {},
  busMaxLoad: 0.5,
  busBaseYM: "2026-08", // 기존 이용객 데이터의 마지막 달. 이 달까지 입주한 단지 주민은 기존 이용객에 들어 있어 새 수요로 더하지 않음
  busCatch: 600, // 수요를 배분하는 정류장 도보권 반경(m)
  // 공원 접근성: 단계별 최소 규모·유치거리(m). 도시공원법 시행규칙의 유치거리 기준을 따른 값(재확인 필요).
  // 1인당 면적은 기존 주민 인구를 몰라 분모가 왜곡되므로 쓰지 않음(신규 입주 인구로만 나누면 큰 공원이 있을 때 과소 평가)
  parkTiers: [
    { label: "어린이공원급", minArea: 1500, reach: 250 },
    { label: "근린생활권 근린공원", minArea: 10000, reach: 500 },
    { label: "도보권 근린공원", minArea: 30000, reach: 1000 },
  ],
  weights: { school: 0.4, bus: 0.35, park: 0.25 },
  // 이용률(부하 ÷ 정원·수송력) 압박 점수: from이면 0, to이면 1로 선형.
  // 학교: 예전 방식(100% 초과분만 반영)은 115% 학교도 9점으로 눌려 "정원 초과 학교가 있는데 학교 점수 4점" 모순을 만들었음 → 90%부터 120%까지로.
  // 버스: 혼잡 체감이 100% 이전에 시작된다고 보고 50%부터 100%까지(기존 값 유지)
  pressure: { school: { from: 0.9, to: 1.2 }, bus: { from: 0.5, to: 1.0 } },
  parkTolerance: 0.1, // 공원 "기준 밖" 집계 허용 오차(유치거리의 10%). 단지 좌표가 대표점 하나라 생기는 거리 오차를 감안
};

export const LEVEL_LABEL = { elem: "초등", mid: "중등", high: "고등" };

const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
// 단계: 정원·수송력 대비 이용률 100% 초과 = 부족, 90% 이상 = 주의
export const levelOf = (u) => (u > 1 ? "부족" : u >= 0.9 ? "주의" : "여유");
const pressure = (u, r) => clamp((u - r.from) / (r.to - r.from));

export function dist(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// 입주 단계 = [연도, 세대수, 입주 연월("YYYY-MM")]. 연월이 없으면(편집·추가한 단지) 그해 12월로 본다
const phaseYM = (p) => p[2] || `${p[0]}-12`;
function households(c, year) {
  return c.phases.reduce((s, [y, n]) => (y <= year ? s + n : s), 0);
}
// 기준 연월까지 입주한 세대(데이터에 이미 반영된 세대)
const householdsBy = (c, ym) => c.phases.reduce((s, p) => (phaseYM(p) <= ym ? s + p[1] : s), 0);

function nearest(c, list) {
  let best = null, bd = Infinity;
  for (const f of list) {
    const d = dist(c, f);
    if (d < bd) { bd = d; best = f; }
  }
  return { f: best, d: bd };
}

export function evaluate(complexes, facilities, year, P = PARAMS) {
  const open = facilities.filter((f) => f.open <= year);
  const cs = complexes.map((c) => {
    const hh = households(c, year);
    return { c, hh, pop: hh * P.persons, school: {}, schoolScore: 0, busScore: 0, parkScore: 0 };
  });
  const active = cs.filter((x) => x.hh > 0);

  // --- 학교: 실제 학구(통학구역, 학구도안내서비스 2026-09-20) 기준 배정. 구역 정보가 없으면 최근접 학교로 대체 ---
  // 초등: 통학구역의 학교(공동통학구역이면 정원 비율 분배), 중학교: 학교군 내 학교들에 정원 비율로 분배, 고등: 최근접
  // What-if로 추가한 학교(added)는 학구 재조정으로 간주: 구역 학교보다 가까우면 그 학교에 배정
  // 부하 = 기존 재학생(enrolled, 학교알리미 2026 실측) + 기준연도 이후 신규 입주 세대의 학령인구
  const schoolLoad = {};
  for (const f of open) if (f.type === "school") schoolLoad[f.id] = f.enrolled || 0;
  const byName = new Map(open.filter((f) => f.type === "school").map((f) => [f.name, f]));
  for (const lv of ["elem", "mid", "high"]) {
    const list = open.filter((f) => f.type === "school" && f.level === lv && !f.vocational);   // 특성화고는 통학권 배정 대상이 아님
    const addedList = list.filter((f) => f.added);
    for (const x of active) {
      const kids = x.hh * P.kids[lv];
      const kidsNew = Math.max(0, x.hh - householdsBy(x.c, P.schoolBaseYM)) * P.kids[lv];
      const zoned = ((x.c.zone && x.c.zone[lv]) || []).map((n) => byName.get(n)).filter((f) => f && f.level === lv);
      let cands, temp = false;
      if (zoned.length) {
        const nz = nearest(x.c, zoned), na = nearest(x.c, addedList);
        cands = na.f && na.d < nz.d ? [na.f] : zoned;
      } else if (x.c.zone && lv === "elem") {
        // 학구 자료가 있는데 통학구역이 없음 = 미확정(신규 단지). 학생을 빼면 부하가 줄고 점수가 0점이 되어 낙관 쪽으로 기우므로
        // 가장 가까운 학교에 임시 배정하고 화면에 '임시'로 표시한다
        const n = nearest(x.c, list);
        cands = n.f ? [n.f] : [];
        temp = true;
      } else {
        const n = nearest(x.c, list);
        cands = n.f ? [n.f] : [];
      }
      const capSum = cands.reduce((s2, f) => s2 + f.cap, 0) || 1;
      const ws = cands.map((f) => ({ f, w: f.cap / capSum }));
      const prim = nearest(x.c, cands);
      // 통학거리 = 배정 후보 중 가장 가까운 학교까지(학교군 여러 곳의 평균 거리는 먼 학교가 섞여 실제보다 길게 나옴). 학생 부하는 후보에 정원 비율로 나눔
      x.school[lv] = { kids, f: prim.f, d: prim.f ? prim.d : 0, cands: ws, zoned: zoned.length > 0, temp };
      for (const { f, w } of ws) schoolLoad[f.id] += kidsNew * w;
    }
  }
  for (const x of active) {
    let sum = 0, w = 0;
    for (const lv of ["elem", "mid", "high"]) {
      const s = x.school[lv];
      let sc;
      if (!s.f) sc = 100;
      else {
        const over = s.cands.reduce((s2, c) => s2 + c.w * clamp(schoolLoad[c.f.id] / (c.f.cap * P.schoolCapScale) - 1), 0);
        const util = s.cands.reduce((s2, c) => s2 + c.w * schoolLoad[c.f.id] / (c.f.cap * P.schoolCapScale), 0);
        const far = clamp((s.d - P.walkLimit[lv]) / P.walkLimit[lv]);
        sc = 100 * (0.6 * pressure(util, P.pressure.school) + 0.4 * far);
        s.over = over; s.util = util; s.load = s.cands.reduce((s2, c) => s2 + c.w * schoolLoad[c.f.id], 0);
      }
      s.score = sc;
      sum += sc * s.kids; w += s.kids;
    }
    x.schoolScore = w ? sum / w : 0;
  }

  // --- 버스: 도보권 내 '서로 다른 노선'의 첨두 수송력(시간당 운행 x 회당 승객)을 합산하고, 노선 수송력을 이용 단지들이 수요 비율로 나눠 씀 ---
  const stops = open.filter((f) => f.type === "bus");
  const routesOf = (f) => f.routes || [{ id: f.id, name: f.name, peek: 60 / Math.max(f.cap / P.busPaxPerTrip, 0.1) }];
  const routeCap = {};
  for (const f of stops) for (const r of routesOf(f)) if (r.peek > 0) routeCap[r.id] = (60 / r.peek) * P.busPaxPerTrip;
  const routeLoad = {};
  for (const id of Object.keys(routeCap)) routeLoad[id] = ((P.busBg[id] && P.busBg[id].peak) || 0) * P.busMaxLoad;   // 기존 이용객(실측 승차 기반)
  for (const x of active) {
    x.bus = nearest(x.c, stops);
    let near = stops.filter((f) => dist(x.c, f) <= P.busCatch);
    if (!near.length && x.bus.f) near = [x.bus.f];
    const ids = new Set();
    for (const f of near) for (const r of routesOf(f)) if (r.peek > 0) ids.add(r.id);
    x.busRoutes = [...ids];
    const capSum = x.busRoutes.reduce((s2, id) => s2 + routeCap[id], 0) || 1;
    x.busDemand = Math.max(0, x.hh - householdsBy(x.c, P.busBaseYM)) * P.busPeakPaxPerHH;   // 기존 이용객 데이터 뒤에 입주하는 세대만
    for (const id of x.busRoutes) routeLoad[id] = (routeLoad[id] || 0) + (x.busDemand * routeCap[id]) / capSum;
  }
  for (const x of active) {
    if (!x.bus.f) { x.busScore = 100; continue; }
    const far = clamp((x.bus.d - P.walkLimit.bus) / 500);
    const capSum = x.busRoutes.reduce((s2, id) => s2 + routeCap[id], 0) || 1;
    const util = x.busRoutes.reduce((s2, id) => s2 + ((routeLoad[id] || 0) / routeCap[id]) * (routeCap[id] / capSum), 0);
    x.bus.over = clamp(util - 1); x.bus.util = util; x.bus.cap = capSum; x.bus.nRoutes = x.busRoutes.length;
    x.busScore = 100 * (0.3 * far + 0.7 * pressure(util, P.pressure.bus));
  }

  // --- 공원: 단계별(규모·유치거리) 최근접 공원까지 거리. 유치거리 안이면 0, 2배 이상이면 100으로 선형, 세 단계 평균 ---
  const parks = open.filter((f) => f.type === "park");
  for (const x of active) {
    x.parkTier = P.parkTiers.map((tr) => {
      const n = nearest(x.c, parks.filter((p) => p.area >= tr.minArea));
      const d = n.f ? n.d : Infinity;
      return { label: tr.label, reach: tr.reach, d, name: n.f ? n.f.name : null, short: clamp((d - tr.reach) / tr.reach) };
    });
    x.parkScore = (100 * x.parkTier.reduce((s2, tr) => s2 + tr.short, 0)) / x.parkTier.length;
  }

  // --- 종합 ---
  for (const x of active) {
    const ws = P.weights, wsum = ws.school + ws.bus + ws.park || 1;   // 가중치 합이 1이 아니어도 정규화
    x.total = (ws.school * x.schoolScore + ws.bus * x.busScore + ws.park * x.parkScore) / wsum;
  }
  // 물리 단위 요약(화면 첫 요약용): 입주 단지가 실제로 쓰는 학교·노선만 센다
  const usedSchools = new Map(), firmSchools = new Set();   // firm = 실제 학구로 배정된 적이 있는 학교(아니면 임시 배정만 받은 학교)
  for (const x of active) for (const lv of ["elem", "mid", "high"]) for (const { f } of x.school[lv].cands || []) { usedSchools.set(f.id, f); if (!x.school[lv].temp) firmSchools.add(f.id); }
  // 툴팁에서 쓰도록 부하·정원도 함께 둔다(가장 붐비는 순)
  const schoolsUsedList = [...usedSchools.values()].map((f) => ({ name: f.name, temp: !firmSchools.has(f.id), load: schoolLoad[f.id], cap: f.cap * P.schoolCapScale, util: schoolLoad[f.id] / (f.cap * P.schoolCapScale) }))
    .sort((a, b) => b.util - a.util);
  const schoolsOver = schoolsUsedList.filter((s) => s.util > 1);
  const routeName = {};
  for (const f of stops) for (const r of routesOf(f)) routeName[r.id] = r.name;
  const usedRoutes = new Set(active.flatMap((x) => x.busRoutes || []));
  const routesUsedList = [...usedRoutes].map((id) => ({ name: String(routeName[id] ?? id), load: routeLoad[id] || 0, cap: routeCap[id], util: (routeLoad[id] || 0) / routeCap[id] }))
    .sort((a, b) => b.util - a.util);
  const routesOver = routesUsedList.filter((r) => r.util > 1);
  const parkOut = active.filter((x) => x.parkTier.some((tr) => tr.short > P.parkTolerance)).length;
  // 단계(종합 점수를 읽는 기준): 입주 단지가 쓰는 학교·버스 노선 중 가장 붐비는 곳의 이용률로 정한다.
  // 부족 = 정원·수송력을 넘는 곳이 있음(100% 초과), 주의 = 90% 이상, 여유 = 그 외. 공원은 정원 개념이 없어 제외
  const busiest = [
    ...[...usedSchools.values()].map((f) => ({ name: f.name, util: schoolLoad[f.id] / (f.cap * P.schoolCapScale) })),
    ...[...usedRoutes].map((id) => ({ name: `${routeName[id] ?? id}번 버스`, util: (routeLoad[id] || 0) / routeCap[id] })),
  ].sort((a, b) => b.util - a.util)[0] || { name: "", util: 0 };
  const grade = { level: levelOf(busiest.util), util: busiest.util, name: busiest.name };
  // 단지별 단계(지도 색): 그 단지가 쓰는 학교·노선 중 가장 붐비는 곳의 이용률. 상단 단계와 같은 규칙
  const worst = (arr) => arr.sort((a, b) => b.util - a.util)[0] || { name: "", util: 0 };
  for (const x of active) {
    const sc = worst(["elem", "mid", "high"].flatMap((lv) => (x.school[lv].cands || []).map(({ f }) => ({ name: f.name, util: schoolLoad[f.id] / (f.cap * P.schoolCapScale) }))));
    const bu = worst((x.busRoutes || []).map((id) => ({ name: `${routeName[id] ?? id}번 버스`, util: (routeLoad[id] || 0) / routeCap[id] })));
    const g = (w) => ({ level: levelOf(w.util), util: w.util, name: w.name });
    x.grade = { school: g(sc), bus: g(bu), total: g(sc.util >= bu.util ? sc : bu) };
  }

  const pop = active.reduce((s, x) => s + x.pop, 0);
  const avg = (k) => (pop ? active.reduce((s, x) => s + x[k] * x.pop, 0) / pop : 0);
  return {
    year, items: cs, pop,
    hh: active.reduce((s, x) => s + x.hh, 0),
    summary: { total: avg("total"), school: avg("schoolScore"), bus: avg("busScore"), park: avg("parkScore") },
    // 기준 초과 단지: 배정 학교 정원 또는 도보권 버스 노선 첨두 수송력 대비 이용률이 100%를 넘는 단지.
    // 임의의 점수 임계값(예: 50점 이상) 대신 물리적 수용 한계를 기준으로 삼는다.
    // 학교 초과는 학급당 정원 가정(초 25·중고 29명)에 민감하므로 학교/버스를 나눠 돌려준다. risky = 둘 중 하나라도.
    schoolOver: active.filter((x) => ["elem", "mid", "high"].some((lv) => (x.school[lv] && x.school[lv].over) > 0.0005)).length,
    busOver: active.filter((x) => x.bus.util > 1).length,
    schoolsOver, schoolsUsed: usedSchools.size, schoolsUsedList, routesOver, routesUsed: usedRoutes.size, routesUsedList, parkOut, active: active.length, grade,
    risky: active.filter((x) => ["elem", "mid", "high"].some((lv) => (x.school[lv] && x.school[lv].over) > 0.0005) || x.bus.util > 1).length,
    schools: open.filter((f) => f.type === "school")
      .map((f) => ({ id: f.id, name: f.name, level: f.level, load: schoolLoad[f.id] || 0, cap: f.cap, util: (schoolLoad[f.id] || 0) / (f.cap * P.schoolCapScale) })),   // 요약과 같은 정원(배율 반영)
  };
}

// --- 정책 리포트 (규칙 기반 텍스트. LLM 연동 시 이 구조화 결과를 입력으로 사용) ---
export function buildReport(res) {
  // 우선순위 단지 3곳과 원인. 입주 세대·종합 점수·시나리오 효과·분야별 점수는 화면 위쪽 요약과 막대에 이미 있어 넣지 않음
  const act = res.items.filter((x) => x.hh > 0).sort((a, b) => b.total - a.total);
  const SHORT = { "어린이공원급": "어린이공원", "근린생활권 근린공원": "1만㎡ 공원", "도보권 근린공원": "3만㎡ 공원" };
  const prio = act.slice(0, 3).map((x) => {
    const causes = [];
    for (const lv of ["elem", "mid", "high"]) {
      const s = x.school[lv];
      if (s && s.kids > 5 && s.over > 0.1) causes.push(`${LEVEL_LABEL[lv]}학교 정원 ${(s.over * 100).toFixed(0)}% 초과`);
      else if (s && s.kids > 5 && s.f && s.d > PARAMS.walkLimit[lv]) causes.push(`${LEVEL_LABEL[lv]}학교까지 ${Math.round(s.d).toLocaleString()}m`);
    }
    if (x.bus.f && x.bus.d > PARAMS.walkLimit.bus) causes.push(`정류장까지 ${Math.round(x.bus.d)}m`);
    if (x.bus.util > 0.8) causes.push(`버스 노선 ${x.bus.nRoutes}개 이용률 ${(x.bus.util * 100).toFixed(0)}%`);
    for (const tr of x.parkTier) if (tr.short > 0.05) causes.push(`${SHORT[tr.label] || tr.label} ${tr.reach}m 밖 (최근접 ${isFinite(tr.d) ? Math.round(tr.d) + "m" : "없음"})`);
    return { name: x.c.name.replace(/\(.*$/, ""), score: x.total, causes: causes.length ? causes : ["여러 요인이 조금씩 겹침"] };
  });
  return { prio };
}

