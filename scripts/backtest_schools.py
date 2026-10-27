"""학교 부하 예측 백테스트(사후 검증): 2025학년도 → 2026학년도 실제 학급 수 변화와 모델 예측을 비교.

질문: "입주계획만으로 어느 학교가 붐빌지 맞힐 수 있는가?"
방법
  1. 구간: NEIS 학급 정보가 공개된 2025·2026학년도(그 이전은 API에 없음).
     이 사이(2025-03 ~ 2026-02)에 입주한 단지만 '새 수요'로 넣는다(data/complexes.csv의 movein).
  2. 예측: 앱 모델과 같은 배정 규칙
     - 초등: 학구도 통학구역의 학교(여럿이면 정원 비율로 분배)
     - 중등: 학교군 안 학교들에 정원 비율로 분배
     - 고등: 최근접 고등학교
     - 학령인구율: 세대당 초 0.17, 중·고 0.07(js/model.js PARAMS.kids와 같은 값)
     예측 학급 증가 = 예측 신규 학생 ÷ 그 학교의 실제 학급당 학생 수(학교알리미 2026)
  3. 실제: NEIS 교육정보 개방포털 classInfo의 학년도별 학급 수(키 불필요)
  4. 비교: 예측 대상 학교의 실제 학급 증가 vs 나머지 오산시 학교(대조군)의 변화, 전체 순위 상관(Spearman)
출력: data/backtest_schools.json, 표준출력 요약(docs/backtest.md에 옮겨 적음)
한계: 표본(입주 단지 2곳), 신설교(마루초·가수중 2025 개교)의 학년 채움 효과, 학구 밖 전입·저출생 추세는 분리하지 못함."""
import csv, json, math, pathlib, time, urllib.parse, urllib.request

ROOT = pathlib.Path(__file__).parent.parent
KIDS = {"elem": 0.17, "mid": 0.07, "high": 0.07}
WINDOW = ("2025-03", "2026-02")   # 2025학년도 학급 편성 이후 ~ 2026학년도 학급 편성 전
AYS = ("2025", "2026")


def neis(ep, **kw):
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


def dist(a, b):
    R, rad = 6371000, math.pi / 180
    dlat, dlng = (b["lat"] - a["lat"]) * rad, (b["lng"] - a["lng"]) * rad
    h = math.sin(dlat / 2) ** 2 + math.cos(a["lat"] * rad) * math.cos(b["lat"] * rad) * math.sin(dlng / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def spearman(xs, ys):
    def rank(v):
        order = sorted(range(len(v)), key=lambda i: v[i])
        r = [0.0] * len(v); i = 0
        while i < len(order):
            j = i
            while j + 1 < len(order) and v[order[j + 1]] == v[order[i]]:
                j += 1
            for k in range(i, j + 1):
                r[order[k]] = (i + j) / 2 + 1
            i = j + 1
        return r
    rx, ry = rank(xs), rank(ys)
    mx, my = sum(rx) / len(rx), sum(ry) / len(ry)
    cov = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    return cov / math.sqrt(sum((a - mx) ** 2 for a in rx) * sum((b - my) ** 2 for b in ry))


fac = json.loads((ROOT / "data/facilities.json").read_text(encoding="utf-8"))
schools = {f["name"]: f for f in fac if f["type"] == "school"}
zones = json.loads((ROOT / "data/zones.json").read_text(encoding="utf-8"))
cxs = [r for r in csv.DictReader(open(ROOT / "data/complexes.csv", encoding="utf-8-sig"))
       if r["lat"] and WINDOW[0] <= r["movein"] <= WINDOW[1]]

# 1) 예측: 신규 학생을 배정 규칙대로 학교에 분배
pred = {n: 0.0 for n in schools}
for c in cxs:
    hh, pos, z = int(c["units"]), {"lat": float(c["lat"]), "lng": float(c["lng"])}, zones.get(c["id"], {})
    for lv in ("elem", "mid"):
        names = [n for e in z.get(lv, []) for n in e["schools"] if n in schools]
        cap = sum(schools[n]["cap"] for n in names) or 1
        for n in names:
            pred[n] += hh * KIDS[lv] * schools[n]["cap"] / cap
    highs = [f for f in schools.values() if f["level"] == "high"]
    pred[min(highs, key=lambda f: dist(pos, f))["name"]] += hh * KIDS["high"]

# 2) 실제: NEIS 학년도별 학급 수
rows = []
for name, f in schools.items():
    _, info = neis("schoolInfo", SCHUL_NM=name)
    hit = [r for r in info if "오산" in (r["ORG_RDNMA"] or "")]
    if not hit:
        continue
    code = hit[0]["SD_SCHUL_CODE"]
    cls = {ay: neis("classInfo", SD_SCHUL_CODE=code, AY=ay, pSize=1)[0] for ay in AYS}
    per_class = f["enrolled"] / f["classes"] if f.get("classes") else None
    rows.append(dict(name=name, level=f["level"], opened=f["open"], students_2026=f["enrolled"], classes_2026_alimi=f.get("classes"),
                     classes={ay: cls[ay] for ay in AYS}, actual_delta=cls[AYS[1]] - cls[AYS[0]] if cls[AYS[0]] and cls[AYS[1]] else None,
                     pred_students=round(pred[name], 1), pred_delta=round(pred[name] / per_class, 2) if per_class else None))
    time.sleep(0.2)

ok = [r for r in rows if r["actual_delta"] is not None and r["pred_delta"] is not None]
target = [r for r in ok if r["pred_delta"] >= 0.5]
control = [r for r in ok if r["pred_delta"] < 0.5]
rho = spearman([r["pred_delta"] for r in ok], [r["actual_delta"] for r in ok])
summary = dict(window=WINDOW, complexes=[(c["name"], int(c["units"]), c["movein"]) for c in cxs], n_schools=len(ok), spearman=round(rho, 3),
               target=[(r["name"], r["pred_delta"], r["actual_delta"]) for r in sorted(target, key=lambda r: -r["pred_delta"])],
               control_mean_delta=round(sum(r["actual_delta"] for r in control) / len(control), 2),
               control_share_up=round(sum(r["actual_delta"] > 0 for r in control) / len(control), 2),
               control_top=sorted([(r["name"], r["actual_delta"]) for r in control], key=lambda x: -x[1])[:5])
(ROOT / "data/backtest_schools.json").write_text(json.dumps(dict(summary=summary, schools=rows), ensure_ascii=False, indent=1), encoding="utf-8")
print(json.dumps(summary, ensure_ascii=False, indent=1))
