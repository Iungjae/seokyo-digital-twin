// 실행: node --test ai-worker/test/numbers.test.ts (Node 22.6+ 타입 제거 실행)
import { test } from "node:test";
import assert from "node:assert/strict";
import { numbersIn, checkSentences } from "../src/numbers.ts";

test("numbersIn: 쉼표·단위·소수점 정규화", () => {
  assert.deepEqual(numbersIn("1,068세대가 115% 넘고 26.50점"), ["1068", "115", "26.5"]);
  assert.deepEqual(numbersIn("2026-04 입주"), ["2026", "4"]);
});

const facts = [
  { id: "F1", text: "마루초 이용률 115%" },
  { id: "F2", text: "오산 세교파라곤 1,068세대, 종합 부족도 30점" },
];

test("근거 숫자만 쓰면 통과", () => {
  const r = checkSentences([{ text: "마루초는 정원의 115%로 가장 붐빕니다.", facts: ["F1"] }], facts);
  assert.equal(r.kept.length, 1);
});

test("근거에 없는 숫자는 걸러짐", () => {
  const r = checkSentences([{ text: "마루초는 120% 수준입니다.", facts: ["F1"] }], facts);
  assert.equal(r.kept.length, 0);
  assert.match(r.dropped[0].reason, /120/);
});

test("다른 근거의 숫자를 섞으면 걸러짐(문장이 든 근거 안에서만 허용)", () => {
  const r = checkSentences([{ text: "마루초 115%, 파라곤 1068세대", facts: ["F1"] }], facts);
  assert.equal(r.kept.length, 0);
});

test("없는 근거 번호·근거 없음은 걸러짐", () => {
  assert.equal(checkSentences([{ text: "학교가 붐빕니다.", facts: [] }], facts).kept.length, 0);
  assert.equal(checkSentences([{ text: "학교가 붐빕니다.", facts: ["F9"] }], facts).kept.length, 0);
});
