"""OSM 좌표 + 학교알리미 학생수/학급수 -> data/facilities.json (앱이 읽는 실제 시설 데이터).
학교: 현원(enrolled)=학교알리미 2026 일반학급 학생수(실데이터), 정원(cap)=일반학급수 x 학급당 정원(가정, est).
정류장: 수송력 미상 -> 기본 400 (est=true). 공원: 면적 미상 -> 기본 10000㎡ (est=true).
est=true 값은 공공데이터(경기버스정보, 공원현황 등)로 교체해야 함."""
import csv, json, pathlib
ROOT = pathlib.Path(__file__).parent.parent
S, W, N, E = 37.115, 127.000, 37.195, 127.085   # 연구 범위(세교2 일대 후보). 확정 후 조정
CAP_PER_CLASS = {"elem": 25, "mid": 29, "high": 29}   # 학급당 정원(가정) - 경기도 학급편성 기준 확인 후 조정
BUS_PAX_PER_TRIP = 45   # 첨두 1회 운행당 수용 승객(가정): 좌석+입석 여유분. 노선 유형별로 세분화 가능
ALIAS = {"오산광성초등학교": "광성초등학교"}            # OSM 표기 -> 학교알리미 표기

SI = {r["name"]: r for r in csv.DictReader((ROOT / "data/raw/schoolinfo_osan_2026.csv").open(encoding="utf-8"))}
NEIS = {x["name"]: x for x in json.loads((ROOT / "data/neis_schools.json").read_text(encoding="utf-8"))}  # 개교연도용


def school(id_, lv, name, lat, lng, src):
    r = SI[name]
    cls, stu = int(r["classes"]), int(r["students"])
    founded = NEIS.get(name, {}).get("founded")
    return dict(id=id_, type="school", level=lv, name=name, lat=lat, lng=lng, classes=cls, enrolled=stu,
                cap=cls * CAP_PER_CLASS[lv], open=int(founded[:4]) if founded else 2020, est=True, src=src)


OSMP_PATH = ROOT / "data/osm_parks.json"   # OSM 경계 도형 기반 면적(fetch_osm_parks.py)
OSM_AREA = {r["key"]: r["area"] for r in json.loads(OSMP_PATH.read_text(encoding="utf-8"))} if OSMP_PATH.exists() else {}
PARKS_PATH = ROOT / "data/parks_osan.json"
PARKS = json.loads(PARKS_PATH.read_text(encoding="utf-8")) if PARKS_PATH.exists() else []
GBIS_PATH = ROOT / "data/gbis_stops.json"
GBIS = json.loads(GBIS_PATH.read_text(encoding="utf-8")) if GBIS_PATH.exists() else []
raw = json.loads((ROOT / "data/osm_raw.json").read_text(encoding="utf-8"))["elements"]
def pos(e): return (e.get("lat") or e["center"]["lat"], e.get("lon") or e["center"]["lon"])
out, seen, n = [], set(), {"school": 0, "bus": 0, "park": 0}
for e in raw:
    t = e["tags"]; lat, lng = pos(e)
    if not (S <= lat <= N and W <= lng <= E): continue
    name = t.get("name", "")
    if t.get("amenity") == "school":
        name = ALIAS.get(name.split("&")[0], name.split("&")[0])
        lv = "elem" if "초등" in name else "mid" if "중학" in name else "high" if "고등" in name else None
        if not lv or name in seen or name not in SI: continue   # 오산시 공시 학교만 사용(타 지역 동명교 제외)
        seen.add(name); n["school"] += 1
        out.append(school(f"S{n['school']}", lv, name, lat, lng, "OSM좌표+학교알리미2026"))
    elif t.get("highway") == "bus_stop" and not GBIS:   # GBIS 실데이터가 있으면 OSM 정류장은 쓰지 않음
        n["bus"] += 1
        out.append(dict(id=f"B{n['bus']}", type="bus", name=name or f"정류장{n['bus']}", lat=lat, lng=lng, cap=400, open=2020, est=True, src="OSM"))
    elif t.get("leisure") == "park" and not PARKS:   # 공원 실데이터(면적)가 있으면 OSM 공원은 쓰지 않음
        n["park"] += 1
        key = f"{e['type']}/{e['id']}"
        measured = key in OSM_AREA
        out.append(dict(id=f"P{n['park']}", type="park", name=name or f"공원{n['park']}", lat=lat, lng=lng,
                        area=OSM_AREA.get(key, 10000), open=2020, est=not measured, src="OSM 경계 면적" if measured else "OSM(면적 기본값)"))

# GBIS 정류장: 수송력 = 첨두 시간당 운행횟수 x 회당 수용 승객(가정). 배차정보가 없는 정류장은 제외
for g in GBIS:
    if g["trips_per_hr"] <= 0: continue
    n["bus"] += 1
    out.append(dict(id=f"B{n['bus']}", type="bus", name=g["name"], lat=g["lat"], lng=g["lng"], cap=round(g["trips_per_hr"] * BUS_PAX_PER_TRIP),
                    trips_per_hr=g["trips_per_hr"], routes=[dict(id=r["id"], name=r["name"], peek=r["peek"]) for r in g["routes"] if r.get("peek", 0) > 0], open=2020, est=False, src="GBIS API"))

# 공원 실데이터: 전국도시공원정보표준데이터(면적 ㎡, 좌표). 연구 범위 안만 사용
for pk in PARKS:
    if not (S <= pk["lat"] <= N and W <= pk["lng"] <= E) or pk["area"] <= 0: continue
    n["park"] += 1
    out.append(dict(id=f"P{n['park']}", type="park", name=pk["name"], lat=pk["lat"], lng=pk["lng"], area=pk["area"], open=2020, est=False, src="도시공원표준데이터"))

# OSM에 좌표가 없는 학교의 수동 좌표(Nominatim; 소프트웨어고는 도로 단위 근사) - 카카오 지오코딩으로 교체 권장
MANUAL = {"가수중학교": (37.14632, 127.05486, "장소 일치"), "경기오산소프트웨어고등학교": (37.16724, 127.04709, "도로 단위 근사"),
          "다온초등학교": (37.15184, 127.09080, "장소 일치"), "오산원당초등학교": (37.14188, 127.09086, "장소 일치"),
          "오산고현초등학교": (37.13339, 127.08544, "장소 일치"), "양산초등학교": (37.19695, 127.03213, "장소 일치")}
for nm, (la, lo, note) in MANUAL.items():
    if nm in SI and nm not in seen:
        lv = "elem" if "초등" in nm else "mid" if "중학" in nm else "high"
        n["school"] += 1; seen.add(nm)
        out.append(school(f"S{n['school']}", lv, nm, la, lo, f"수동좌표({note})+학교알리미2026"))

todo = [f"{k}({v['students']}명/{v['classes']}학급)" for k, v in SI.items() if k not in seen]
(ROOT / "data/schools_need_coords.json").write_text(json.dumps(todo, ensure_ascii=False, indent=1), encoding="utf-8")
print("좌표 필요 학교:", ", ".join(todo))
(ROOT / "data/facilities.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
print(n, "->", len(out))
