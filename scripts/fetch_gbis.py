"""경기도 버스정보(GBIS) OpenAPI(공공데이터포털)로 세교 일대 정류소 + 경유노선 + 첨두 배차간격 수집.
사용: GBIS_KEY=발급키 python3 scripts/fetch_gbis.py      (키는 Encoding/Decoding 어느 쪽이든 가능)
필요 활용신청(무료): '경기도_정류소 조회'(15080666), '경기도_버스노선 조회'(15080662)
호출 순서: 주변정류소(격자) -> 정류소경유노선 -> 노선정보(배차간격). 호출 수 약 200~400회(개발계정 일 한도 내 목표).
출력: data/gbis_stops.json = [{id,name,lat,lng,routes:[{id,name,type,peek}],trips_per_hr}], 원본은 data/raw/gbis/ 에 저장.
명세 출처: data.go.kr 15080666/15080662 Swagger (Base URL apis.data.go.kr/6410000/...)"""
import json, os, pathlib, sys, time, urllib.parse, urllib.request

ROOT = pathlib.Path(__file__).parent.parent
RAW = ROOT / "data/raw/gbis"
BASE = "https://apis.data.go.kr/6410000"
# 조사 범위(남,서,북,동): 세교 단지 + 여유. 격자 간격은 주변정류소 반경 500m에 맞춰 600m.
S, W, N, E = 37.125, 127.025, 37.180, 127.075
STEP_LAT, STEP_LNG = 0.0054, 0.0068   # 약 600m


def make_key():
    k = os.environ.get("GBIS_KEY")
    if not k:
        sys.exit("GBIS_KEY 환경변수가 없습니다.")
    return urllib.parse.quote(urllib.parse.unquote(k), safe="")  # Encoding/Decoding 키 모두 처리


def items(resp, listkey):
    """응답 JSON에서 msgBody[listkey]를 항상 리스트로 반환. 오류/결과없음이면 []."""
    body = resp.get("response", resp)
    hdr = body.get("msgHeader", {})
    if str(hdr.get("resultCode")) not in ("0", "None"):
        return []
    lst = (body.get("msgBody") or {}).get(listkey)
    if lst is None:
        return []
    return lst if isinstance(lst, list) else [lst]


def call(key, svc, op, **params):
    q = "&".join([f"serviceKey={key}", "format=json"] + [f"{k}={urllib.parse.quote(str(v))}" for k, v in params.items()])
    url = f"{BASE}/{svc}/v2/{op}?{q}"
    for _ in range(3):
        try:
            return json.loads(urllib.request.urlopen(url, timeout=30).read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            msg = e.read().decode("utf-8", "replace")[:300]
            if e.code in (400, 401, 403):
                sys.exit(f"HTTP {e.code} {op}: {msg}\n(키 활용신청 승인 여부/키 값을 확인하세요)")
            time.sleep(1.5)
        except Exception:
            time.sleep(1.5)
    return {}


def main():
    key = make_key()
    RAW.mkdir(parents=True, exist_ok=True)
    stations, calls = {}, 0
    lat = S
    while lat <= N:
        lng = W
        while lng <= E:
            r = call(key, "busstationservice", "getBusStationAroundListv2", x=round(lng, 6), y=round(lat, 6))
            calls += 1
            for s in items(r, "busStationAroundList"):
                stations[str(s["stationId"])] = dict(id=str(s["stationId"]), name=s.get("stationName"), lat=float(s["y"]), lng=float(s["x"]))
            time.sleep(0.1)
            lng += STEP_LNG
        lat += STEP_LAT
    print("정류소", len(stations), "개 (호출", calls, "회)")
    (RAW / "stations.json").write_text(json.dumps(list(stations.values()), ensure_ascii=False, indent=1), encoding="utf-8")

    routes = {}
    for sid, s in stations.items():
        r = call(key, "busstationservice", "getBusStationViaRouteListv2", stationId=sid)
        s["routes"] = [dict(id=str(x["routeId"]), name=x.get("routeName"), type=x.get("routeTypeName")) for x in items(r, "busRouteList")]
        for x in s["routes"]:
            routes.setdefault(x["id"], None)
        time.sleep(0.1)
    print("노선", len(routes), "개")

    for rid in list(routes):
        r = call(key, "busrouteservice", "getBusRouteInfoItemv2", routeId=rid)
        it = items(r, "busRouteInfoItem")
        routes[rid] = it[0] if it else {}
        time.sleep(0.1)
    (RAW / "routes.json").write_text(json.dumps(routes, ensure_ascii=False, indent=1), encoding="utf-8")

    out = []
    for s in stations.values():
        tph = 0.0
        for x in s["routes"]:
            info = routes.get(x["id"]) or {}
            peek = float(info.get("peekAlloc") or 0)    # 첨두 배차간격(분)
            x["peek"] = peek
            if peek > 0:
                tph += 60.0 / peek
        s["trips_per_hr"] = round(tph, 2)
        out.append(s)
    (ROOT / "data/gbis_stops.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    zero = sum(1 for s in out if s["trips_per_hr"] == 0)
    print(f"저장 data/gbis_stops.json ({len(out)}개, 배차정보 없는 정류소 {zero}개)")
    print("상위 5개:", sorted(((s["name"], s["trips_per_hr"]) for s in out), key=lambda t: -t[1])[:5])


if __name__ == "__main__":
    main()
