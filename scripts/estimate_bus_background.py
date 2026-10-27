"""기존 버스 이용객(노선별 첨두 1시간 승차)을 실제 정류소 승하차 데이터로 추정한다.
사용: python3 scripts/estimate_bus_background.py [첨두비중=0.15]
입력: data/boarding_osan_monthly.csv(scripts/fit_bus_rate.py 산출, 오산시 정류소별 월 평일 평균 승차),
      data/gbis_stops.json(정류소별 경유 노선·첨두 배차간격)
출력: data/bus_background.json = {meta, routes: {routeId: {name, daily, peak}}}

방법
  1. 기준 기간(데이터 마지막 3개월) 정류소별 평일 하루 승차 평균을 구한다.
  2. 승하차 데이터에는 노선 정보가 없으므로, 정류소 승차를 그 정류소를 지나는 노선에 첨두 운행 횟수 비율로 나눈다.
  3. 노선별로 조사 범위(세교 일대 정류소) 안의 승차를 더하고 첨두 비중(기본 15%, fit_bus_rate.py와 같은 가정)을 곱한다.
  4. 모델은 이 값(양방향 첨두 1시간 승차)에 '최대 재차 비율'(가정, 가정값 패널)을 곱해 노선의 기존 부하로 쓴다.
     최대 재차 비율 = 가장 붐비는 구간에서 한 방향 버스에 동시에 타고 있는 사람 ÷ 양방향 승차. 노선별 정류소 순서(GBIS)가 있으면
     구간별 재차 인원을 직접 계산할 수 있으나 지금은 없어 가정으로 둔다.
한계: 조사 범위 밖(오산 외곽·타 시군)에서 탄 승객은 빠져 기존 부하는 낮게 잡힌다. 기준 기간에 이미 입주한 단지 주민은
      기존 이용객에 들어 있으므로, 모델은 기준 기간 뒤에 입주하는 단지만 새 수요로 더한다."""
import csv, json, pathlib, sys
from collections import defaultdict

ROOT = pathlib.Path(__file__).parent.parent
PEAK_SHARE = float(sys.argv[1]) if len(sys.argv) > 1 else 0.15

rows = list(csv.DictReader(open(ROOT / "data/boarding_osan_monthly.csv", encoding="utf-8")))
months = sorted({r["month"] for r in rows})[-3:]
acc = defaultdict(list)
for r in rows:
    if r["month"] in months:
        acc[r["stop_id"]].append(float(r["weekday_mean_boardings"]))
board = {s: sum(v) / len(v) for s, v in acc.items()}

stops = json.loads((ROOT / "data/gbis_stops.json").read_text(encoding="utf-8"))
daily, name = defaultdict(float), {}
covered = 0
for s in stops:
    rs = [r for r in s["routes"] if r["peek"] > 0]
    tph = sum(60 / r["peek"] for r in rs)
    if not rs or s["id"] not in board:
        continue
    covered += 1
    for r in rs:
        daily[r["id"]] += board[s["id"]] * (60 / r["peek"]) / tph
        name[r["id"]] = str(r["name"])

out = {
    "meta": {
        "months": months, "base_month": months[-1], "peak_share": PEAK_SHARE,
        "stops_used": covered, "stops_total": len(stops),
        "method": "정류소 평일 승차를 경유 노선에 첨두 운행 비율로 배분 → 노선별 합 × 첨두 비중. 모델에서 최대 재차 비율(가정)을 곱해 기존 부하로 씀",
    },
    "routes": {rid: {"name": name[rid], "daily": round(v, 1), "peak": round(v * PEAK_SHARE, 1)} for rid, v in sorted(daily.items(), key=lambda kv: -kv[1])},
}
(ROOT / "data/bus_background.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
print(f"기준 기간 {months[0]}~{months[-1]}, 정류소 {covered}/{len(stops)}곳, 노선 {len(daily)}개")
for rid, v in list(out["routes"].items())[:8]:
    print(f"  {v['name']:>6}  하루 {v['daily']:7.1f}  첨두 {v['peak']:6.1f}")
