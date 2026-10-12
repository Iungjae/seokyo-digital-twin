// 부족도 모델. 모든 점수는 0(충분)~100(심각 부족). 계수는 PARAMS에서 조정.
// 설명 가능성을 위해 규칙 기반으로 두고, 계수 출처는 발표 시 명시.

export const PARAMS = {
  schoolCapScale: 1, // 학교 정원 배율(가정 패널에서 조정). 정원 = 학급수 x 학급당 정원 x 배율
  baseYear: 2026, // 학급 데이터(NEIS AY2026) 기준연도. 이 이전 입주분은 이미 학교 현원에 반영됨
  persons: 2.8, // 세대당 가구원
  kids: { elem: 0.17, mid: 0.07, high: 0.07 }, // 세대당 학령인구
  walkLimit: { elem: 1000, mid: 1500, high: 2000, bus: 400, park: 800 }, // m
  busPeakPaxPerHH: 0.3, // 세대당 첨두시 버스 이용객(가정, 민감도 0.15~0.6의 중간값; 절대 점수는 이 값에 크게 좌우, 상위 취약 단지 순위는 안정적)
  busPaxPerTrip: 45, // 회당 수용 승객(가정, 민감도 30~60의 중간값; build_data.py의 BUS_PAX_PER_TRIP과 동일 유지)
  busBackground: 0, // 기존 이용객(단지 밖 주민)이 이미 쓰는 노선 수송력 비율(가정). 기본 0 = 미반영, 민감도 분석에서 0~0.4로 변화
  busCatch: 600, // 수요를 배분하는 정류장 도보권 반경(m)
  // 공원 접근성: 단계별 최소 규모·유치거리(m). 도시공원법 시행규칙의 유치거리 기준을 따른 값(재확인 필요).
  // 1인당 면적은 기존 주민 인구를 몰라 분모가 왜곡되므로 쓰지 않음(신규 입주 인구로만 나누면 큰 공원이 있을 때 과소 평가)
  parkTiers: [
    { label: "어린이공원급", minArea: 1500, reach: 250 },
    { label: "근린생활권 근린공원", minArea: 10000, reach: 500 },
    { label: "도보권 근린공원", minArea: 30000, reach: 1000 },
  ],
  weights: { school: 0.4, bus: 0.35, park: 0.25 },
};

export const LEVEL_LABEL = { elem: "초등", mid: "중등", high: "고등" };

const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));

export function dist(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function households(c, year) {
  return c.phases.reduce((s, [y, n]) => (y <= year ? s + n : s), 0);
}

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
    const list = open.filter((f) => f.type === "school" && f.level === lv);
    const addedList = list.filter((f) => f.added);
    for (const x of active) {
      const kids = x.hh * P.kids[lv];
      const kidsNew = Math.max(0, x.hh - households(x.c, P.baseYear)) * P.kids[lv];
      const zoned = ((x.c.zone && x.c.zone[lv]) || []).map((n) => byName.get(n)).filter((f) => f && f.level === lv);
      let cands;
      if (zoned.length) {
        const nz = nearest(x.c, zoned), na = nearest(x.c, addedList);
        cands = na.f && na.d < nz.d ? [na.f] : zoned;
      } else if (x.c.zone && lv === "elem") {
        cands = [];                       // 학구 자료가 있는데 해당 통학구역이 없음 = 미확정(신규 단지). 최근접으로 우기지 않음
      } else {
        const n = nearest(x.c, list);
        cands = n.f ? [n.f] : [];
      }
      const capSum = cands.reduce((s2, f) => s2 + f.cap, 0) || 1;
      const ws = cands.map((f) => ({ f, w: f.cap / capSum }));
      const prim = nearest(x.c, cands);
      x.school[lv] = { kids, f: prim.f, d: ws.reduce((s2, c) => s2 + c.w * dist(x.c, c.f), 0), cands: ws, zoned: zoned.length > 0, unassigned: !cands.length && !!x.c.zone && lv === "elem" };
      for (const { f, w } of ws) schoolLoad[f.id] += kidsNew * w;
    }
  }
  for (const x of active) {
    let sum = 0, w = 0;
    for (const lv of ["elem", "mid", "high"]) {
      const s = x.school[lv];
      let sc;
      if (s.unassigned) sc = 0;           // 통학구역 미확정: 점수에서 제외(0점)
      else if (!s.f) sc = 100;
      else {
        const over = s.cands.reduce((s2, c) => s2 + c.w * clamp(schoolLoad[c.f.id] / (c.f.cap * P.schoolCapScale) - 1), 0);
        const far = clamp((s.d - P.walkLimit[lv]) / P.walkLimit[lv]);
        sc = 100 * (0.6 * over + 0.4 * far);
        s.over = over; s.load = s.cands.reduce((s2, c) => s2 + c.w * schoolLoad[c.f.id], 0);
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
  for (const id of Object.keys(routeCap)) routeLoad[id] = routeCap[id] * (P.busBgFn ? P.busBgFn(id) : P.busBackground);   // 기존 이용객 선점분
  for (const x of active) {
    x.bus = nearest(x.c, stops);
    let near = stops.filter((f) => dist(x.c, f) <= P.busCatch);
    if (!near.length && x.bus.f) near = [x.bus.f];
    const ids = new Set();
    for (const f of near) for (const r of routesOf(f)) if (r.peek > 0) ids.add(r.id);
    x.busRoutes = [...ids];
    const capSum = x.busRoutes.reduce((s2, id) => s2 + routeCap[id], 0) || 1;
    x.busDemand = x.hh * P.busPeakPaxPerHH;
    for (const id of x.busRoutes) routeLoad[id] = (routeLoad[id] || 0) + (x.busDemand * routeCap[id]) / capSum;
  }
  for (const x of active) {
    if (!x.bus.f) { x.busScore = 100; continue; }
    const far = clamp((x.bus.d - P.walkLimit.bus) / 500);
    const capSum = x.busRoutes.reduce((s2, id) => s2 + routeCap[id], 0) || 1;
    const util = x.busRoutes.reduce((s2, id) => s2 + ((routeLoad[id] || 0) / routeCap[id]) * (routeCap[id] / capSum), 0);
    x.bus.over = clamp(util - 1); x.bus.util = util; x.bus.cap = capSum; x.bus.nRoutes = x.busRoutes.length;
    // 이용률 0.5 초과부터 점수 가산(혼잡 체감은 100% 이전에 시작) + 거리
    x.busScore = 100 * (0.3 * far + 0.7 * clamp((util - 0.5) / 0.5));
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
    risky: active.filter((x) => ["elem", "mid", "high"].some((lv) => (x.school[lv] && x.school[lv].over) > 0.0005) || x.bus.util > 1).length,
    schools: open.filter((f) => f.type === "school")
      .map((f) => ({ id: f.id, name: f.name, level: f.level, load: schoolLoad[f.id] || 0, cap: f.cap, util: (schoolLoad[f.id] || 0) / f.cap })),
  };
}

// --- 정책 리포트 (규칙 기반 텍스트. LLM 연동 시 이 구조화 결과를 입력으로 사용) ---
export function buildReport(res, base) {
  const act = res.items.filter((x) => x.hh > 0).sort((a, b) => b.total - a.total);
  const lines = [];
  lines.push(`${res.year}년 기준 입주 ${res.hh.toLocaleString()}세대(약 ${Math.round(res.pop).toLocaleString()}명), 종합 부족도 ${res.summary.total.toFixed(0)}점입니다.`);
  const dim = [["학교", res.summary.school], ["버스", res.summary.bus], ["공원", res.summary.park]].sort((a, b) => b[1] - a[1]);
  lines.push(`가장 취약한 분야는 ${dim[0][0]}(${dim[0][1].toFixed(0)}점)이며, 다음은 ${dim[1][0]}(${dim[1][1].toFixed(0)}점)입니다.`);
  act.slice(0, 3).forEach((x, i) => {
    const cause = [];
    for (const lv of ["elem", "mid", "high"]) {
      const s = x.school[lv];
      if (s && s.kids > 5 && s.over > 0.1) cause.push(`${LEVEL_LABEL[lv]}학교 정원 ${(s.over * 100).toFixed(0)}% 초과`);
      else if (s && s.kids > 5 && s.f && s.d > PARAMS.walkLimit[lv]) cause.push(`${LEVEL_LABEL[lv]}학교까지 ${Math.round(s.d)}m`);
    }
    if (x.bus.f && x.bus.d > PARAMS.walkLimit.bus) cause.push(`정류장까지 ${Math.round(x.bus.d)}m`);
    if (x.bus.util > 0.8) cause.push(`도보권 ${x.bus.nRoutes}개 노선 첨두 이용률 ${(x.bus.util * 100).toFixed(0)}%(가정 기반)`);
    for (const tr of x.parkTier) if (tr.short > 0.05) cause.push(`${tr.label} 유치거리 ${tr.reach}m 밖(최근접 ${isFinite(tr.d) ? Math.round(tr.d) + "m" : "없음"})`);
    lines.push(`우선순위 ${i + 1}: ${x.c.name} (${x.total.toFixed(0)}점) - ${cause.join(", ") || "복합 요인"}`);
  });
  if (base) {
    const d = res.summary.total - base.summary.total;
    if (Math.abs(d) > 0.05) lines.push(`시나리오 효과: 종합 부족도가 현재 계획 대비 ${d < 0 ? "" : "+"}${d.toFixed(1)}점 변화했습니다.`);
  }
  return lines;
}
