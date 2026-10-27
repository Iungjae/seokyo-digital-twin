"""세대당 버스 이용객 계수를 실제 승하차 데이터로 추정(입주 전후 비교 + 대조군 보정).

입력: data/raw/boarding/*.zip  (경기데이터드림 '경기도 정류소 별 승하차 인원 집계' 파일. 연간·월별 zip 모두 가능)
      실제 구조: zip → 월별 tar → 일자별 csv.gz(CP949). 열: 승하차일자(YYYYMMDD), 관할관청, 정류소ID, 승차합계 …
      정제 전 파일(_D-4)은 경기도 안내대로 쓰지 않는다(D-45만 사용)
      data/raw/gbis/stations.json (정류소 ID → 좌표), data/complexes.csv (단지 세대수·입주 월)
출력: data/boarding_osan_monthly.csv  오산시 정류소별 월 평일 평균 승차(저장소에 넣는 작은 요약)
      data/bus_rate.json             추정 결과(앱의 가정값 패널이 읽음)

방법
  1. 단지 반경 RADIUS(400m) 안 정류소들의 평일 하루 승차 합계를 월별로 구한다.
  2. 입주 전 6개월(입주 월 제외) 평균 vs 입주 6~11개월 뒤 평균. 실측 추이상 승차가 입주 뒤 12개월 가까이 계속 늘어
     (입주가 서서히 참) 그 전 구간은 과소 추정이 된다. 6~11개월 데이터가 3개월 미만인 단지는 2~7개월로 계산하고
     '입주 초기'로 표시해 묶은 추정에서 뺀다. 단지와 함께 새로 생긴 정류소는 생기기 전 승차를 0으로 본다.
  3. 같은 달들의 대조군(입주 단지 반경 800m 밖 오산시 정류소) 변화율로 '입주가 없었다면'의 값을 만든다.
  4. 증가분 ÷ 세대수 = 세대당 하루 승차. 여러 단지는 원점 회귀(증가분 = β × 세대수)로 묶는다.
  5. 모델 계수(첨두 1시간 이용객)는 β × PEAK_SHARE. 이 데이터에는 시간대가 없어 PEAK_SHARE는 가정이다.
실행: python3 scripts/fit_bus_rate.py [PEAK_SHARE=0.15]"""
import csv, gzip, io, json, math, pathlib, sys, tarfile, zipfile
from collections import defaultdict
from datetime import date

ROOT = pathlib.Path(__file__).parent.parent
RAW = pathlib.Path(__import__("os").environ.get("BOARDING_DIR", ROOT / "data/raw/boarding"))
RADIUS, CONTROL_GAP = 400, 800
PRE, POST, POST_EARLY = range(-6, 0), range(6, 12), range(2, 8)
PEAK_SHARE = float(sys.argv[1]) if len(sys.argv) > 1 else 0.15
CITY = "오산시"


def dist(a, b):
    R, rad = 6371000, math.pi / 180
    dlat, dlng = (b[0] - a[0]) * rad, (b[1] - a[1]) * rad
    h = math.sin(dlat / 2) ** 2 + math.cos(a[0] * rad) * math.cos(b[0] * rad) * math.sin(dlng / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def month_add(ym, k):
    y, m = map(int, ym.split("-")); m += k
    return f"{y + (m - 1) // 12:04d}-{(m - 1) % 12 + 1:02d}"


def decode(raw):
    for enc in ("utf-8-sig", "cp949"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("cp949", errors="replace")


def csv_rows(name, raw):
    """csv / csv.gz / tar(안에 csv.gz) 어느 것이든 행 단위로 풀어 준다"""
    if name.endswith(".tar"):
        with tarfile.open(fileobj=io.BytesIO(raw)) as t:
            for m in t.getmembers():
                if m.isfile():
                    yield from csv_rows(m.name, t.extractfile(m).read())
    elif name.endswith(".gz"):
        yield from csv_rows(name[:-3], gzip.decompress(raw))
    elif name.lower().endswith(".csv"):
        yield from csv.DictReader(io.StringIO(decode(raw)))


def read_rows():
    """오산시 행만 (날짜, 정류소ID, 승차 합계)로 돌려준다. 열 이름은 실제 파일(승하차일자·관할관청·정류소ID·승차합계)과
    사이트 미리보기(일자·시군명·정류소아이디·승차인원합계), 일부 달의 영문 열(RIDE_DATE·ORG_NM·STATION_ID·RIDE_TOT_CNT)을 모두 받는다"""
    for z in sorted(RAW.glob("*.zip")):
        if "_D-4." in z.name:          # 정제 전 최신 파일은 쓰지 않음
            continue
        with zipfile.ZipFile(z) as zf:
            for name in zf.namelist():
                for r in csv_rows(name, zf.read(name)):
                    if (r.get("관할관청") or r.get("시군명") or r.get("ORG_NM") or "").strip() != CITY:
                        continue
                    d = (r.get("승하차일자") or r.get("일자") or r.get("RIDE_DATE") or "").strip().replace("-", "")[:8]
                    stop = (r.get("정류소ID") or r.get("정류소아이디") or r.get("STATION_ID")).strip()
                    yield date(int(d[:4]), int(d[4:6]), int(d[6:8])), stop, int(float(r.get("승차합계") or r.get("승차인원합계") or r.get("RIDE_TOT_CNT") or 0))


# 1) 오산시 정류소별 월 평일 평균 승차
acc = defaultdict(lambda: [0, 0])     # (stop, ym) -> [승차 합, 평일 일수]
for d, stop, board in read_rows():
    if d.weekday() >= 5:
        continue
    k = (stop, f"{d.year:04d}-{d.month:02d}")
    acc[k][0] += board; acc[k][1] += 1
if not acc:
    sys.exit(f"{RAW}에 오산시 데이터가 있는 zip이 없습니다. 경기데이터드림 파일을 먼저 넣어 주세요.")
monthly = {k: v[0] / v[1] for k, v in acc.items() if v[1]}
with open(ROOT / "data/boarding_osan_monthly.csv", "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f); w.writerow(["stop_id", "month", "weekday_mean_boardings"])
    for (s, ym), v in sorted(monthly.items()):
        w.writerow([s, ym, round(v, 1)])
months = sorted({ym for _, ym in monthly})

# 2) 단지별 입주 전후 비교
stations = {s["id"]: (s["lat"], s["lng"]) for s in json.loads((ROOT / "data/raw/gbis/stations.json").read_text(encoding="utf-8"))}
cxs = [r for r in csv.DictReader(open(ROOT / "data/complexes.csv", encoding="utf-8-sig")) if r["lat"] and r["movein"][:4].isdigit()]
pos = {c["id"]: (float(c["lat"]), float(c["lng"])) for c in cxs}
stops_with_data = {s for s, _ in monthly}


def total(stops, ym):
    """그 달 정류소 승차 합. 아직 없던 정류소(그 달 데이터 없음)는 0. 그 달 오산시 데이터 자체가 없으면 None"""
    if ym not in months:
        return None
    return sum(monthly.get((s, ym), 0) for s in stops)


def estimate(radius):
    out = []
    for c in cxs:
        ym0 = c["movein"][:7]
        pre_m = [month_add(ym0, k) for k in PRE]
        if pre_m[0] < months[0]:
            continue
        post_m = [m for m in (month_add(ym0, k) for k in POST) if m <= months[-1]]
        early = len(post_m) < 3
        if early:
            post_m = [m for m in (month_add(ym0, k) for k in POST_EARLY) if m <= months[-1]]
            if len(post_m) < 3:
                continue
        near = [s for s, p in stations.items() if s in stops_with_data and dist(pos[c["id"]], p) <= radius]
        if not near:
            continue
        # 대조군: 이 단지와 같은 시기(±12개월)에 입주한 단지들 반경 800m 밖 정류소
        busy = [pos[o["id"]] for o in cxs if abs((int(o["movein"][:4]) * 12 + int(o["movein"][5:7])) - (int(ym0[:4]) * 12 + int(ym0[5:7]))) <= 12]
        ctrl = [s for s, p in stations.items() if s in stops_with_data and all(dist(p, b) > CONTROL_GAP for b in busy)]
        pre_v = [total(near, m) for m in pre_m]; post_v = [total(near, m) for m in post_m]
        cpre = [total(ctrl, m) for m in pre_m]; cpost = [total(ctrl, m) for m in post_m]
        if None in pre_v + post_v + cpre + cpost:
            continue
        pre, post = sum(pre_v) / len(pre_v), sum(post_v) / len(post_v)
        ratio = (sum(cpost) / len(cpost)) / (sum(cpre) / len(cpre))
        expected = pre * ratio
        units = int(c["units"])
        out.append(dict(id=c["id"], name=c["name"], units=units, movein=ym0, stops=len(near), control_stops=len(ctrl),
                        window=f"{'+2~+7' if early else '+6~+11'}개월", early=early,
                        pre=round(pre, 1), post=round(post, 1), control_ratio=round(ratio, 3), expected=round(expected, 1),
                        delta=round(post - expected, 1), per_hh_daily=round((post - expected) / units, 3)))
    return out


def pooled(rs):
    rs = [r for r in rs if not r["early"]]
    return (sum(r["delta"] * r["units"] for r in rs) / sum(r["units"] ** 2 for r in rs)) if rs else None


results = estimate(RADIUS)
sens = {f"{r}m": (round(b, 3) if (b := pooled(estimate(r))) is not None else None) for r in (400, 600, 800)}
if not results:
    sys.exit("입주 전후 기간이 데이터 안에 들어오는 단지가 없습니다(기간을 늘려 주세요).")
beta = pooled(results)
if beta is None:
    sys.exit("입주 6~11개월 뒤까지 데이터가 있는 단지가 없습니다.")
out = dict(method="입주 전후 비교 + 대조군 보정(이중차분), 원점 회귀", radius_m=RADIUS, months=[months[0], months[-1]],
           peak_share_assumed=PEAK_SHARE, daily_per_hh=round(beta, 3), peak_per_hh=round(beta * PEAK_SHARE, 3),
           model_default=0.3, radius_sensitivity_daily_per_hh=sens, complexes=results)
(ROOT / "data/bus_rate.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
print(json.dumps({k: v for k, v in out.items() if k != "complexes"}, ensure_ascii=False))
for r in results:
    print(f'{r["name"][:14]:<14} {r["units"]:>5}세대 {r["movein"]} {r["window"]}{" (입주 초기)" if r["early"] else ""}  정류소 {r["stops"]}  전 {r["pre"]:>7} 후 {r["post"]:>7} 기대 {r["expected"]:>7}  증가 {r["delta"]:>7}  세대당 {r["per_hh_daily"]}')
