"""입주율 곡선(입주 시작 뒤 몇 달에 걸쳐 세대가 들어오는가)을 실제 버스 승차 증가로 추정한다.
사용: python3 scripts/fit_movein_ramp.py
입력: data/boarding_osan_monthly.csv(fit_bus_rate.py 산출), data/raw/gbis/stations.json, data/complexes.csv
출력: data/movein_ramp.json = {ramp: [입주 첫 달, 둘째 달, …](마지막 다음 달부터 100%), complexes: 단지별 곡선}

방법: 단지 반경 400m 정류소의 평일 하루 승차에서 입주 전 6개월 평균을 뺀 증가분을 달별로 구하고,
  입주 4~6개월째(k=3~5) 평균을 100%로 놓아 달별 비율을 만든다. 단지 평균을 곡선으로 쓴다.
제외: 입주 전에 정류소 승차가 거의 없던 단지(하루 30회 미만)는 입주 뒤 정류소·노선이 새로 생기며 승차가 계단처럼 뛰어
  입주 속도가 아니라 버스 개통 시점을 재게 되므로 뺀다. 입주 뒤 6개월 데이터가 없는 단지도 뺀다."""
import csv, json, math, pathlib
from collections import defaultdict

ROOT = pathlib.Path(__file__).parent.parent
mon, months = defaultdict(float), set()
for r in csv.DictReader(open(ROOT / "data/boarding_osan_monthly.csv", encoding="utf-8")):
    mon[(r["stop_id"], r["month"])] = float(r["weekday_mean_boardings"]); months.add(r["month"])
stations = {s["id"]: (s["lat"], s["lng"]) for s in json.loads((ROOT / "data/raw/gbis/stations.json").read_text(encoding="utf-8"))}


def dist(a, b):
    r = math.pi / 180
    h = math.sin((b[0] - a[0]) * r / 2) ** 2 + math.cos(a[0] * r) * math.cos(b[0] * r) * math.sin((b[1] - a[1]) * r / 2) ** 2
    return 2 * 6371000 * math.asin(math.sqrt(h))


def month_add(ym, k):
    y, m = map(int, ym.split("-")); m += k
    return f"{y + (m - 1) // 12:04d}-{(m - 1) % 12 + 1:02d}"


RAMP_MONTHS, MIN_PRE = 3, 30
curves = {}
for c in csv.DictReader(open(ROOT / "data/complexes.csv", encoding="utf-8-sig")):
    if not c["lat"] or not c["movein"][:4].isdigit():
        continue
    ym, p = c["movein"][:7], (float(c["lat"]), float(c["lng"]))
    near = [s for s, q in stations.items() if dist(p, q) <= 400]
    total = lambda m: sum(mon.get((s, m), 0) for s in near)
    pre_m = [month_add(ym, k) for k in range(-6, 0)]
    post_m = [month_add(ym, k) for k in range(0, 6)]
    if any(m not in months for m in pre_m + post_m):
        continue
    pre = sum(total(m) for m in pre_m) / 6
    if pre < MIN_PRE:
        continue
    inc = [total(m) - pre for m in post_m]
    plateau = sum(inc[3:6]) / 3
    if plateau <= 0:
        continue
    curves[c["name"]] = [round(min(1.0, max(0.0, v / plateau)), 2) for v in inc[:RAMP_MONTHS]]

ramp, prev = [], 0.0
for k in range(RAMP_MONTHS):
    v = max(prev, sum(cv[k] for cv in curves.values()) / len(curves))   # 줄어들지 않게
    ramp.append(round(v, 2)); prev = v
out = {"ramp": ramp, "complexes": curves, "method": "400m 정류소 승차 증가분 ÷ 입주 4~6개월째 평균. 입주 전 승차 30회 미만 단지 제외"}
(ROOT / "data/movein_ramp.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
print("단지별:", curves)
print("곡선(입주 첫 달부터):", ramp, "→ 이후 100%")
