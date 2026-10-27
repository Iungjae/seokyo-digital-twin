// LLM이 쓴 문장의 숫자 검사: 문장에 나온 숫자가 그 문장이 근거로 든 사실(fact)들에 모두 있어야 통과.
// "115%", "1,068세대", "26.5점"처럼 단위·쉼표가 붙어도 숫자만 뽑아 비교한다.

/** 문자열 안의 숫자를 정규화해 뽑는다(쉼표 제거, 끝의 .0 제거). "2026-04" 같은 날짜는 2026, 04 두 개로 본다 */
export function numbersIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    let n = m[0].replace(/,/g, "");
    if (n.includes(".")) n = n.replace(/\.?0+$/, "");
    out.push(String(Number(n)));
  }
  return out;
}

export interface Fact { id: string; text: string }
export interface Sentence { text: string; facts: string[] }

/** 근거 사실에 없는 숫자를 쓴 문장, 없는 사실 id를 든 문장, 근거가 하나도 없는 문장을 걸러 낸다 */
export function checkSentences(sentences: Sentence[], facts: Fact[]): { kept: Sentence[]; dropped: { text: string; reason: string }[] } {
  const byId = new Map(facts.map((f) => [f.id, f]));
  const kept: Sentence[] = [], dropped: { text: string; reason: string }[] = [];
  for (const s of sentences) {
    const refs = s.facts.filter((id) => byId.has(id));
    if (!refs.length) { dropped.push({ text: s.text, reason: "근거 없음" }); continue; }
    if (refs.length !== s.facts.length) { dropped.push({ text: s.text, reason: "없는 근거 번호" }); continue; }
    const allowed = new Set(refs.flatMap((id) => numbersIn(byId.get(id)!.text)));
    const stray = numbersIn(s.text).filter((n) => !allowed.has(n));
    if (stray.length) { dropped.push({ text: s.text, reason: `근거에 없는 숫자 ${stray.join(", ")}` }); continue; }
    kept.push({ text: s.text, facts: refs });
  }
  return { kept, dropped };
}
