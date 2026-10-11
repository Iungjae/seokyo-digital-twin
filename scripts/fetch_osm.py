"""OSM(Overpass)에서 세교 일대 학교/버스정류장/공원/아파트를 좌표째 수집해 data/osm_raw.json 저장.
사용: python3 scripts/fetch_osm.py
bbox는 세교1·2지구를 덮는 범위(남,서,북,동). 필요 시 조정."""
import json, urllib.request, urllib.parse, pathlib
BBOX = "37.115,127.000,37.195,127.085"
Q = f"""[out:json][timeout:60];
(
 nwr["amenity"="school"]({BBOX});
 nwr["amenity"="kindergarten"]({BBOX});
 node["highway"="bus_stop"]({BBOX});
 nwr["leisure"="park"]({BBOX});
 nwr["building"="apartments"]["name"]({BBOX});
 nwr["landuse"="residential"]["name"]({BBOX});
);
out center tags;"""
MIRRORS = ["https://overpass.kumi.systems/api/interpreter", "https://overpass-api.de/api/interpreter",
           "https://overpass.private.coffee/api/interpreter"]
data = None
for url in MIRRORS:
    try:
        req = urllib.request.Request(url, data=urllib.parse.urlencode({"data": Q}).encode(), headers={"User-Agent": "seokyo-twin/0.1"})
        data = json.load(urllib.request.urlopen(req, timeout=100)); print("ok", url); break
    except Exception as e:
        print("fail", url, e)
if data is None: raise SystemExit("모든 미러 실패")
pathlib.Path(__file__).parent.parent.joinpath("data/osm_raw.json").write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
from collections import Counter
c = Counter()
for e in data["elements"]:
    t = e["tags"]
    k = t.get("amenity") or t.get("highway") or t.get("leisure") or t.get("building") or t.get("landuse")
    c[k] += 1
print(len(data["elements"]), dict(c))
