"""학구도(통학구역) 자료로 '단지 -> 실제 배정 학교'를 계산 -> data/zones.json.
입력: data/raw/schoolzone/{elem_zone,mid_zone}/*.shp (EPSG:5186), link/link.csv(학구ID<->학교ID), school_loc/school_loc.csv, data/complexes.csv
방법: 단지 좌표(WGS84)를 EPSG:5186으로 변환해 통학구역 폴리곤 point-in-polygon -> 학구ID -> 연계정보로 학교 목록.
공동통학구역이면 학교가 여러 개일 수 있음(모델에서 그 안에서 최근접/분배).
기준일: 2026-09-20. 신규 입주 단지는 구역이 미확정이라 없을 수 있음 -> 그 경우 비워 두고 모델이 최근접 배정으로 대체."""
import csv, json, pathlib, warnings
import pandas as pd, shapefile
from pyproj import Transformer
warnings.filterwarnings("ignore")
ROOT = pathlib.Path(__file__).parent.parent
RAW = ROOT / "data/raw/schoolzone"
tf = Transformer.from_crs("EPSG:4326", "EPSG:5186", always_xy=True)

link = pd.read_csv(RAW / "link/link.csv", encoding="utf-8-sig", dtype=str)
loc = pd.read_csv(RAW / "school_loc/school_loc.csv", encoding="utf-8-sig", dtype=str)
link_osan = link[link["교육지원청명"].str.contains("화성오산", na=False)]
zone_schools = link_osan.groupby("학구ID")["학교명"].apply(lambda s: sorted(set(s))).to_dict()

def pip(x, y, rings):
    """ray casting; 외곽/구멍 구분 없이 홀짝 규칙(구멍은 짝수로 처리됨)"""
    inside = False
    for ring in rings:
        n = len(ring)
        for i in range(n - 1):
            x1, y1 = ring[i]; x2, y2 = ring[i + 1]
            if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
                inside = not inside
    return inside

def load(name):
    r = shapefile.Reader(str(RAW / f"{name}/{name}"), encoding="euc_kr")
    out = []
    for sr in r.iterShapeRecords():
        rec = sr.record.as_dict()
        if "화성오산" not in rec["EDU_NM"] or sr.shape.shapeType == 0: continue
        pts = sr.shape.points; parts = list(sr.shape.parts) + [len(pts)]
        rings = [pts[parts[i]:parts[i + 1]] for i in range(len(parts) - 1)]
        out.append((rec["HAKGUDO_ID"], rec["HAKGUDO_NM"], sr.shape.bbox, rings))
    return out

elem, mid = load("elem_zone"), load("mid_zone")
print(f"화성오산 초등 통학구역 {len(elem)}개, 중학교 학교군 {len(mid)}개, 연계 학구 {len(zone_schools)}개")

def find(zones, x, y):
    hit = []
    for zid, nm, bb, rings in zones:
        if bb[0] <= x <= bb[2] and bb[1] <= y <= bb[3] and pip(x, y, rings):
            hit.append((zid, nm))
    return hit

res = {}
for r in csv.DictReader((ROOT / "data/complexes.csv").open(encoding="utf-8")):
    if not (r["lat"] and r["lng"]): continue
    x, y = tf.transform(float(r["lng"]), float(r["lat"]))
    e, m = find(elem, x, y), find(mid, x, y)
    res[r["id"]] = dict(
        name=r["name"],
        elem=[dict(zone=z, zone_name=n, schools=zone_schools.get(z, [])) for z, n in e],
        mid=[dict(zone=z, zone_name=n, schools=zone_schools.get(z, [])) for z, n in m])
(ROOT / "data/zones.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
for k, v in res.items():
    es = [s for z in v["elem"] for s in z["schools"]]; ms = [s for z in v["mid"] for s in z["schools"]]
    print(f"{k:>3} {v['name'][:16]:<16} 초등:{', '.join(es) or '구역 없음'} | 중학교군:{', '.join(ms)[:60] or '구역 없음'}")
