"""OSM 공원(leisure=park) 경계 도형에서 면적(㎡)을 계산 -> data/osm_parks.json (키 불필요).
way는 닫힌 외곽선, relation(멀티폴리곤)은 닫힌 outer 링만 합산하고 inner 링은 차감. 닫히지 않은 도형은 면적 미상으로 제외(기본값 사용).
주의: OSM 공원은 지자체 도시공원 대장과 다를 수 있음(누락·경계 부정확). 공원 API(fetch_parks.py) 반영 시 그쪽이 우선."""
import json, math, pathlib, urllib.parse, urllib.request
BBOX = "37.115,127.000,37.195,127.085"
Q = f'[out:json][timeout:120];(way["leisure"="park"]({BBOX});relation["leisure"="park"]({BBOX}););out geom;'
data = None
for url in ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]:
    try:
        req = urllib.request.Request(url, data=urllib.parse.urlencode({"data": Q}).encode(), headers={"User-Agent": "seokyo-twin/0.1"})
        data = json.load(urllib.request.urlopen(req, timeout=150)); print("ok", url); break
    except Exception as e:
        print("fail", url, e)
if data is None: raise SystemExit("실패")

def ring_area(pts):
    """위경도 점열의 면적(㎡). 중심 위도에서 등장방형 근사 후 신발끈 공식."""
    if len(pts) < 4 or pts[0] != pts[-1]: return None
    la0 = sum(p[0] for p in pts) / len(pts)
    kx, ky = 111320 * math.cos(math.radians(la0)), 110540
    xy = [(p[1] * kx, p[0] * ky) for p in pts]
    return abs(sum(xy[i][0] * xy[i + 1][1] - xy[i + 1][0] * xy[i][1] for i in range(len(xy) - 1))) / 2

out, skipped = [], 0
for e in data["elements"]:
    t = e.get("tags", {})
    area, c = None, None
    if e["type"] == "way":
        pts = [(g["lat"], g["lon"]) for g in e.get("geometry", [])]
        area = ring_area(pts)
        if pts: c = (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))
    else:
        outer = inner = 0.0; ok = True; allpts = []
        for m in e.get("members", []):
            pts = [(g["lat"], g["lon"]) for g in m.get("geometry", [])]
            if m.get("type") != "way" or not pts: continue
            a = ring_area(pts)
            if a is None: ok = False; continue          # 열린 선분은 링을 못 이으므로 면적 신뢰 불가
            allpts += pts
            if m.get("role") == "inner": inner += a
            else: outer += a
        area = (outer - inner) if ok and outer > 0 else None
        if allpts: c = (sum(p[0] for p in allpts) / len(allpts), sum(p[1] for p in allpts) / len(allpts))
    if area is None or c is None or area < 300:
        skipped += 1; continue
    out.append(dict(key=f"{e['type']}/{e['id']}", name=t.get("name", ""), lat=round(c[0], 6), lng=round(c[1], 6), area=round(area)))
pathlib.Path(__file__).parent.parent.joinpath("data/osm_parks.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
print(f"공원 {len(data['elements'])}개 중 면적 계산 {len(out)}개, 제외 {skipped}개(열린 도형/300㎡ 미만)")
for p in sorted(out, key=lambda p: -p["area"])[:10]: print(f"  {p['name'] or '(이름없음)'} {p['area']:,}㎡")
