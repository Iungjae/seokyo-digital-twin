"""전국도시공원정보표준데이터(공공데이터포털 15012890) OpenAPI에서 오산시 공원(면적·좌표) 수집. (키 필요, 요청 주소는 명세로 확인·실행은 미검증)
사용: PARK_KEY=발급키 python3 scripts/fetch_parks.py        (Encoding/Decoding 키 모두 가능)
필요: 공공데이터포털에서 '전국도시공원정보표준데이터' API 활용신청(무료). GBIS 키와 별개로 서비스별 신청이 필요할 수 있음.
응답 필드: PARK_NM 공원명, PARK_SE 구분, RDNMADR/LNMADR 주소, LATITUDE/LONGITUDE, PARK_AR 면적(㎡), instt_nm 제공기관.
출력: data/parks_osan.json = [{name,kind,lat,lng,area,addr,ref_date}], 원본은 data/raw/parks_raw.json
요청 주소는 공공데이터포털 명세 페이지(15012890)에서 확인함. 실패 시 오류 본문을 그대로 출력."""
import json, os, pathlib, sys, time, urllib.parse, urllib.request

ROOT = pathlib.Path(__file__).parent.parent
ENDPOINT = "https://api.data.go.kr/openapi/tn_pubr_public_cty_park_info_api"


def make_key():
    k = os.environ.get("PARK_KEY")
    if not k:
        sys.exit("PARK_KEY 환경변수가 없습니다.")
    return urllib.parse.quote(urllib.parse.unquote(k), safe="")


def fetch(key, page, **flt):
    q = "&".join([f"serviceKey={key}", f"pageNo={page}", "numOfRows=1000", "type=json"] +
                 [f"{k}={urllib.parse.quote(v)}" for k, v in flt.items()])
    try:
        return json.loads(urllib.request.urlopen(f"{ENDPOINT}?{q}", timeout=40).read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        sys.exit(f"HTTP {e.code}: {e.read().decode('utf-8', 'replace')[:400]}\n(활용신청 승인/키/요청주소를 확인하세요)")


def norm(r):
    """응답 필드명 정규화: 명세는 PARK_NM, 실제 응답은 parkNm -> 소문자·밑줄 제거 키(parknm)로 통일"""
    return {k.replace("_", "").lower(): v for k, v in r.items()}


def rows_of(resp):
    body = resp.get("response", resp).get("body", {})
    items = body.get("items") or []
    if isinstance(items, dict):
        items = items.get("item", [])
    return (items if isinstance(items, list) else [items]), int(body.get("totalCount") or 0)


def main():
    if "--from-raw" in sys.argv:       # data/raw/parks_raw.json 재해석 (키 불필요)
        got = json.loads((ROOT / "data/raw/parks_raw.json").read_text(encoding="utf-8")); page = 0
    else:
        key = make_key(); got, page = [], 1
    while page:
        items, total = rows_of(fetch(key, page, instt_nm="경기도 오산시"))
        got += items
        if not items or len(got) >= total or page >= 80:   # 기관명 필터가 무시돼도 전국(수만 건)까지 훑을 수 있게 여유 있게
            break
        page += 1
        time.sleep(0.2)
    got = [norm(r) for r in got]
    # 필터가 무시되는 경우를 대비해 주소로 한 번 더 거름
    osan = [r for r in got if "오산시" in (r.get("rdnmadr") or "") + (r.get("lnmadr") or "") + (r.get("insttnm") or "")]
    print(f"수신 {len(got)}건 -> 오산시 {len(osan)}건")
    out = []
    for r in osan:
        try:
            out.append(dict(name=r["parknm"], kind=r.get("parkse"), lat=float(r["latitude"]), lng=float(r["longitude"]),
                            area=float(r["parkar"]), addr=r.get("rdnmadr") or r.get("lnmadr"), ref_date=r.get("referencedate")))
        except (KeyError, TypeError, ValueError):
            continue
    (ROOT / "data/raw").mkdir(exist_ok=True)
    (ROOT / "data/raw/parks_raw.json").write_text(json.dumps(got, ensure_ascii=False), encoding="utf-8")
    (ROOT / "data/parks_osan.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"저장 data/parks_osan.json ({len(out)}건, 좌표/면적 유효)")
    for p in sorted(out, key=lambda p: -p["area"])[:8]:
        print(f"  {p['name']} {p['kind']} {p['area']:.0f}㎡ ({p['lat']:.4f},{p['lng']:.4f})")


if __name__ == "__main__":
    main()
