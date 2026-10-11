"""OSM 버스 노선 관계(route=bus) 수집 -> data/osm_bus_routes.json (노선 태그 + 정류장 멤버 id).
정류장별 '경유 노선 수'를 빈도 대리지표로 사용. 배차 간격은 OSM에 거의 없으므로 별도 확보 필요."""
import json, pathlib, urllib.parse, urllib.request
BBOX = "37.115,127.000,37.195,127.085"
Q = f'[out:json][timeout:90];rel["route"="bus"]({BBOX});out body;'
data = None
for url in ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]:
    try:
        req = urllib.request.Request(url, data=urllib.parse.urlencode({"data": Q}).encode(), headers={"User-Agent": "seokyo-twin/0.1"})
        data = json.load(urllib.request.urlopen(req, timeout=120)); print("ok", url); break
    except Exception as e:
        print("fail", url, e)
if data is None: raise SystemExit("실패")
rels = data["elements"]
pathlib.Path(__file__).parent.parent.joinpath("data/osm_bus_routes.json").write_text(json.dumps(rels, ensure_ascii=False), encoding="utf-8")
print(len(rels), "routes")
for r in rels[:15]:
    t = r["tags"]; print(t.get("ref"), "|", t.get("name"), "|", t.get("interval") or t.get("headway"), "| members", len(r["members"]))
