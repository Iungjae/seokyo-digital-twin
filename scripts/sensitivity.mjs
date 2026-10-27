// 민감도 분석: 남은 가정을 흔들어 2027년 결론(정원 넘는 학교 수, 버스 노선, 우선 점검 순위)이 얼마나 바뀌는지 본다.
// 사용: node scripts/sensitivity.mjs   → 표를 출력하고 data/sensitivity.json 저장(docs/sensitivity.md의 근거)
// 앱(js/app.js)과 같은 방식으로 데이터를 불러와 같은 모델(js/model.js)을 돌린다.
import fs from "fs";
import { evaluate, buildReport, PARAMS } from "../js/model.js";

const root = new URL("..", import.meta.url).pathname;
const J = (p) => JSON.parse(fs.readFileSync(root + p, "utf8"));
const FAC = J("data/facilities.json");
const bg = J("data/bus_background.json");
PARAMS.busBg = bg.routes; PARAMS.busBaseYM = bg.meta.base_month;
PARAMS.cohort = J("data/cohort.json").factors;
PARAMS.moveinRamp = J("data/movein_ramp.json").ramp;
const zones = J("data/zones.json");
const [head, ...lines] = fs.readFileSync(root + "data/complexes.csv", "utf8").trim().split(/\r?\n/);
const cols = head.split(",");
const CX = lines.map((l) => Object.fromEntries(l.split(",").map((v, i) => [cols[i], v])))
  .filter((x) => x.lat && x.lng && /^\d{4}-\d{2}$/.test(x.movein))
  .map((x) => {
    const c = { id: x.id, name: x.name.replace(/\(.*$/, ""), lat: +x.lat, lng: +x.lng, phases: [[+x.movein.slice(0, 4), +x.units, x.movein]] };
    const z = zones[x.id];
    if (z) c.zone = { elem: [...new Set(z.elem.flatMap((e) => e.schools))], mid: [...new Set(z.mid.flatMap((e) => e.schools))] };
    return c;
  });
const YEAR = 2027;
const run = (o = {}) => evaluate(CX, FAC, YEAR, { ...PARAMS, ...o, kids: { ...PARAMS.kids, ...(o.kids || {}) } });
const short = (n) => n.replace("등학교", "").replace("학교", "");
const out = {};

// 1) 학교: 초등 학령인구 × 학교 정원 배율 → 정원 넘는 배정 학교 수 / 마루초 이용률
out.school = [];
for (const elem of [0.21, 0.3, 0.39]) for (const cap of [0.9, 1, 1.1]) {
  const r = run({ kids: { elem }, schoolCapScale: cap });
  const maru = r.schoolsUsedList.find((s) => s.name === "마루초등학교");
  out.school.push({ elem, cap, over: r.schoolsOver.length, maru: Math.round(maru.util * 100), grade: r.grade.level });
}
// 입주율 곡선을 끄면(한 번에 입주)
const noRamp = run({ moveinRamp: [] });
out.rampOff = { over: noRamp.schoolsOver.length, hh: noRamp.hh, total: +noRamp.summary.total.toFixed(1) };

// 2) 버스: 최대 재차 비율 × 도보권 반경 → 100% 넘는 노선 수 / 가장 붐비는 노선
out.bus = [];
for (const k of [0.3, 0.4, 0.5, 0.6, 0.7]) for (const c of [300, 400, 600]) {
  const r = run({ busMaxLoad: k, busCatch: c });
  const t = r.routesUsedList[0];
  out.bus.push({ maxLoad: k, catch: c, over: r.routesOver.length, top: `${t.name}번 ${Math.round(t.util * 100)}%` });
}

// 3) 우선 점검 상위 3위 안정성: 위 가정 전부(3 × 3 × 5 × 3 = 135조합)에서 상위 3위에 든 비율
const cnt = {}; let n = 0;
for (const elem of [0.21, 0.3, 0.39]) for (const cap of [0.9, 1, 1.1]) for (const k of [0.3, 0.4, 0.5, 0.6, 0.7]) for (const c of [300, 400, 600]) {
  const r = run({ kids: { elem }, schoolCapScale: cap, busMaxLoad: k, busCatch: c });
  for (const p of buildReport(r).prio) cnt[p.name] = (cnt[p.name] || 0) + 1;
  n++;
}
out.top3 = Object.entries(cnt).map(([name, v]) => ({ name, share: Math.round((v / n) * 100) })).sort((a, b) => b.share - a.share);
out.runs = n;

fs.writeFileSync(root + "data/sensitivity.json", JSON.stringify(out, null, 1));
console.log(`학교(${YEAR}): 초등 학령인구 × 정원 배율`);
for (const s of out.school) console.log(`  초등 ${s.elem} · 배율 ${s.cap} → 정원 넘는 학교 ${s.over}곳, 마루초 ${s.maru}%, 단계 ${s.grade}`);
console.log(`  입주율 곡선 끔 → 정원 넘는 학교 ${out.rampOff.over}곳, 입주 ${out.rampOff.hh}세대, 종합 ${out.rampOff.total}`);
console.log(`버스(${YEAR}): 최대 재차 비율 × 도보권 반경`);
for (const b of out.bus) console.log(`  재차 ${b.maxLoad} · 반경 ${b.catch}m → 넘는 노선 ${b.over}개, 최고 ${b.top}`);
console.log(`우선 점검 상위 3위에 든 비율(${n}조합)`);
for (const t of out.top3) console.log(`  ${t.name} ${t.share}%`);
