import { test } from "node:test";
import assert from "node:assert/strict";
import { validateOps, type Op, type Catalog } from "../src/whatif.ts";

const cat: Catalog = {
  currentYear: 2027, years: [2026, 2027, 2028, 2029, 2030], moveinYears: [2023, 2024, 2025, 2026, 2027, 2028, 2029, 2030],
  complexes: [{ id: "A5", name: "오산 세교 우미린 포레아시티", units: 1050, movein: 2027 }],
  params: [{ key: "busPeakPaxPerHH", label: "세대당 첨두 버스 이용객", min: 0.1, max: 0.8, value: 0.3 }],
};
const op = (o: Partial<Op>): Op => ({ op: "set_year", complex_id: null, facility: null, year: null, units: null, param: null, value: null, ...o });

test("정상 조작은 통과", () => {
  const r = validateOps([op({ op: "set_movein", complex_id: "A5", year: 2029 }), op({ op: "set_param", param: "busPeakPaxPerHH", value: 0.5 })], cat);
  assert.equal(r.ok.length, 2);
});

test("없는 단지·범위 밖 값은 거절", () => {
  const r = validateOps([
    op({ op: "set_units", complex_id: "ZZ", units: 100 }),
    op({ op: "set_units", complex_id: "A5", units: 99999 }),
    op({ op: "set_year", year: 2040 }),
    op({ op: "set_param", param: "busPeakPaxPerHH", value: 3 }),
    op({ op: "add_facility", facility: "bus", complex_id: null }),
  ], cat);
  assert.equal(r.ok.length, 0);
  assert.equal(r.rejected.length, 5);
});
