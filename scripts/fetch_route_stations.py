"""노선별 정류소 순서(GBIS)를 받아 기존 버스 이용객 추정(scripts/estimate_bus_background.py)에 쓴다.
사용: GBIS_KEY=발급키 python3 scripts/fetch_route_stations.py      (키는 Encoding/Decoding 어느 쪽이든 가능)
필요 활용신청: '경기도_버스노선 조회'(15080662). 호출 수 = 세교 일대 경유 노선 수(약 95회).
출력: data/raw/gbis/route_stations.json = {routeId: [{id, seq, name, turn}]}  (seq 순서, turn = 회차 정류소)"""
import json, pathlib, sys, time

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from fetch_gbis import ROOT, RAW, call, items, make_key


def main():
    key = make_key()
    stops = json.loads((ROOT / "data/gbis_stops.json").read_text(encoding="utf-8"))
    rids = sorted({r["id"] for s in stops for r in s["routes"]})
    out, empty = {}, []
    for i, rid in enumerate(rids, 1):
        r = call(key, "busrouteservice", "getBusRouteStationListv2", routeId=rid)
        lst = items(r, "busRouteStationList")
        if not lst:
            empty.append(rid)
        out[rid] = [dict(id=str(x["stationId"]), seq=int(x["stationSeq"]), name=x.get("stationName"), turn=x.get("turnYn") == "Y")
                    for x in sorted(lst, key=lambda x: int(x["stationSeq"]))]
        print(f"\r{i}/{len(rids)}", end="", flush=True)
        time.sleep(0.1)
    (RAW / "route_stations.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n저장 {RAW / 'route_stations.json'} (노선 {len(out)}개, 응답 없는 노선 {len(empty)}개)")


if __name__ == "__main__":
    main()
