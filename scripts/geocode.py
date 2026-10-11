"""data/complexes.csv의 빈 lat/lng를 카카오 로컬 API로 채움.
사용: KAKAO_REST_KEY=발급받은키 python3 scripts/geocode.py
키는 환경변수로만 받고 파일에 저장하지 않음. 이미 좌표가 있는 행은 건드리지 않음."""
import csv, json, os, pathlib, sys, urllib.parse, urllib.request

KEY = os.environ.get("KAKAO_REST_KEY")
if not KEY:
    sys.exit("KAKAO_REST_KEY 환경변수가 없습니다.")
PATH = pathlib.Path(__file__).parent.parent / "data/complexes.csv"
CENTER = (127.04, 37.19)  # x, y: 검색 기준점(세교2 일대). 결과 정렬에 사용


def search(query):
    qs = urllib.parse.urlencode({"query": query, "x": CENTER[0], "y": CENTER[1], "radius": 20000, "size": 3})
    req = urllib.request.Request(f"https://dapi.kakao.com/v2/local/search/keyword.json?{qs}",
                                 headers={"Authorization": f"KakaoAK {KEY}"})
    try:
        return json.load(urllib.request.urlopen(req, timeout=20))["documents"]
    except urllib.error.HTTPError as e:
        sys.exit(f"카카오 API 오류 {e.code}: {e.read().decode('utf-8', 'replace')}")


rows = list(csv.DictReader(PATH.open(encoding="utf-8")))
for r in rows:
    if r["lat"] and r["lng"]:
        continue
    docs = []
    extra = [q for q in (r.get("query") or "").split("|") if q]
    for q in extra + [f"오산 {r['name']}", f"세교 {r['name']}", r["name"]]:
        # 오산 지역 결과만 채택 (타 지역 동명 단지 오매칭 방지)
        docs = [d for d in search(q) if "오산" in d["address_name"]]
        if docs:
            break
    if docs:
        d = docs[0]
        r["lat"], r["lng"] = d["y"], d["x"]
        print(f"OK   {r['name']} -> {d['place_name']} ({d['address_name']}) {d['y']},{d['x']}")
    else:
        print(f"MISS {r['name']} (수동 입력 필요)")

with PATH.open("w", encoding="utf-8", newline="") as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
    w.writeheader()
    w.writerows(rows)
