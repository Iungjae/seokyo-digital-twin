"""NEIS 교육정보 개방포털(키 불필요)에서 오산시 초·중·고 학교정보와 학급 수 수집.
키 없이는 호출당 5행만 반환되므로 학교명으로 개별 조회하고, 학급 수는 응답 헤더의 list_total_count 사용.
입력: data/facilities.json의 학교명 + EXTRA 이름. 출력: data/neis_schools.json
학급 수 x 학급당 정원(가정)으로 정원 추정. 실제 학생수는 학교알리미 공시 원자료 필요."""
import json, pathlib, time, urllib.parse, urllib.request
ROOT = pathlib.Path(__file__).parent.parent
AY = "2026"
# OSM에 없을 수 있는 세교2 신설교 후보(기사 기준). 필요 시 추가.
EXTRA = ["세덤초등학교", "마루초등학교", "오산초등학교", "가수중학교", "마루고등학교", "오산소프트웨어고등학교",
         "세교2초등학교", "물빛나리초등학교", "세교2-3고등학교"]


def call(ep, **kw):
    q = urllib.parse.urlencode({"Type": "json", "ATPT_OFCDC_SC_CODE": "J10", **kw})
    for _ in range(3):
        try:
            d = json.load(urllib.request.urlopen(f"https://open.neis.go.kr/hub/{ep}?{q}", timeout=40))
            break
        except Exception:
            time.sleep(1.5)
    else:
        return 0, []
    body = d.get(ep)
    if not body:
        return 0, []
    return body[0]["head"][0]["list_total_count"], (body[1]["row"] if len(body) > 1 else [])


fac = json.loads((ROOT / "data/facilities.json").read_text(encoding="utf-8"))
names = sorted({f["name"] for f in fac if f["type"] == "school"} | set(EXTRA))
out, miss = [], []
for nm in names:
    _, rows = call("schoolInfo", SCHUL_NM=nm)
    hit = [r for r in rows if "오산시" in (r["ORG_RDNMA"] or "") and r["SCHUL_KND_SC_NM"] in ("초등학교", "중학교", "고등학교")]
    if not hit:
        miss.append(nm); continue
    r = hit[0]
    n_cls, _ = call("classInfo", SD_SCHUL_CODE=r["SD_SCHUL_CODE"], AY=AY, pSize=1)
    out.append(dict(code=r["SD_SCHUL_CODE"], name=r["SCHUL_NM"], kind=r["SCHUL_KND_SC_NM"], addr=r["ORG_RDNMA"],
                    founded=r["FOND_YMD"], fond=r["FOND_SC_NM"], classes=n_cls))
(ROOT / "data/neis_schools.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
print(f"오산시 학교 {len(out)}개 / 미매칭 {len(miss)}개")
for s in out: print(s["kind"][:1], s["name"], s["classes"], s["founded"], s["addr"])
print("미매칭(타 지역 또는 이름 불일치):", ", ".join(miss))
