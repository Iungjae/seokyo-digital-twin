"""기존 학교 학생 수의 자연 변화(졸업·진급·저출생)를 오산시 연령별 인구로 추정한다.
사용: python3 scripts/build_cohort.py
입력: data/raw/population/pop_20260930.csv (행정안전부 주민등록 연령별 인구, 행정동·1세 단위, 2026-09-30)
출력: data/cohort.json = {elem|mid|high: {학년도: 2026학년도 대비 배율}}

방법: 인구를 해마다 한 살씩 올린다(전출입·사망 무시). 학년도 S의 학령 인구는 그해 학년에 해당하는 출생 연도 인구다.
  2026-09-30 기준 a세는 대략 (2026 - a)년생이므로, 학년도 S의 초등(1~6학년 = S-7 ~ S-12년생)은 지금 (2026-S+7) ~ (2026-S+12)세.
  중학교는 S-13 ~ S-15년생, 고등학교는 S-16 ~ S-18년생. 배율 = 학년도 S 학령 인구 / 2026학년도 학령 인구.
모델은 2024년 이전에 문을 연 학교의 현원에만 이 배율을 곱한다(신설교는 신규 단지 학생이라 따로 계산)."""
import csv, json, pathlib

ROOT = pathlib.Path(__file__).parent.parent
rows = list(csv.reader(open(ROOT / "data/raw/population/pop_20260930.csv", encoding="cp949")))
head = rows[0]
male = {int(h.replace("세남자", "")): i for i, h in enumerate(head) if h.endswith("세남자") and h[:-3].isdigit()}
female = {int(h.replace("세여자", "")): i for i, h in enumerate(head) if h.endswith("세여자") and h[:-3].isdigit()}
age = [0] * 111
for r in rows[1:]:
    if "오산" not in r[3]:
        continue
    for a in range(111):
        if a in male:
            age[a] += int(r[male[a]].replace(",", "") or 0)
        if a in female:
            age[a] += int(r[female[a]].replace(",", "") or 0)

GRADES = {"elem": (7, 12), "mid": (13, 15), "high": (16, 18)}   # 학년도 S에 다니는 학생 = S-lo ~ S-hi년생
out = {}
for lv, (lo, hi) in GRADES.items():
    pop = lambda S: sum(age[2026 - S + k] for k in range(lo, hi + 1))
    base = pop(2026)
    out[lv] = {S: round(pop(S) / base, 3) for S in range(2026, 2031)}
(ROOT / "data/cohort.json").write_text(json.dumps({"source": "주민등록 연령별 인구 2026-09-30(오산시)", "factors": out}, ensure_ascii=False, indent=1), encoding="utf-8")
for lv, f in out.items():
    print(lv, f)
