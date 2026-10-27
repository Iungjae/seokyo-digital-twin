// 자연어 What-if: 모델이 돌려준 "시나리오 조작 목록"을 카탈로그(실제 단지·시설 종류·가정값 범위)로 검사한다.
// 통과한 조작만 화면에 넘기고, 화면은 사용자가 확인한 뒤에 적용한다.
import { z } from "zod";

export const FACILITIES = ["school-elem", "school-mid", "bus", "park"] as const;
export const OPS = ["set_year", "set_units", "set_movein", "add_facility", "set_param"] as const;

// 구조화 출력은 모든 필드를 required로 두고, 쓰지 않는 필드는 null
export const OpSchema = z.object({
  op: z.enum(OPS),
  complex_id: z.string().nullable(),
  facility: z.enum(FACILITIES).nullable(),
  year: z.number().int().nullable(),
  units: z.number().int().nullable(),
  param: z.string().nullable(),
  value: z.number().nullable(),
});
export const WhatIfSchema = z.object({
  ops: z.array(OpSchema),
  summary: z.string(),
  unsupported: z.string().nullable(),
});
export type Op = z.infer<typeof OpSchema>;

export interface Catalog {
  currentYear: number;
  years: number[];            // 화면에서 고를 수 있는 연도(2026~2030)
  moveinYears: number[];      // 입주 연도로 고를 수 있는 값(2023~2030)
  complexes: { id: string; name: string; units: number; movein: number }[];
  params: { key: string; label: string; min: number; max: number; value: number }[];
}

export const CatalogSchema = z.object({
  currentYear: z.number().int(),
  years: z.array(z.number().int()).max(10),
  moveinYears: z.array(z.number().int()).max(12),
  complexes: z.array(z.object({ id: z.string().max(20), name: z.string().max(60), units: z.number(), movein: z.number() })).max(40),
  params: z.array(z.object({ key: z.string().max(40), label: z.string().max(60), min: z.number(), max: z.number(), value: z.number() })).max(20),
});

/** 카탈로그에 없는 단지·범위 밖 값은 거절. 사람이 읽을 이유를 함께 돌려준다 */
export function validateOps(ops: Op[], cat: Catalog): { ok: Op[]; rejected: { op: Op; reason: string }[] } {
  const cx = new Map(cat.complexes.map((c) => [c.id, c]));
  const pm = new Map(cat.params.map((p) => [p.key, p]));
  const ok: Op[] = [], rejected: { op: Op; reason: string }[] = [];
  const no = (op: Op, reason: string) => rejected.push({ op, reason });
  for (const op of ops.slice(0, 8)) {
    switch (op.op) {
      case "set_year":
        if (op.year == null || !cat.years.includes(op.year)) no(op, `연도는 ${cat.years[0]}~${cat.years.at(-1)}만 고를 수 있습니다.`); else ok.push(op);
        break;
      case "set_units":
        if (!op.complex_id || !cx.has(op.complex_id)) no(op, "없는 단지입니다.");
        else if (op.units == null || op.units < 0 || op.units > 5000) no(op, "세대수는 0~5,000 사이여야 합니다.");
        else ok.push(op);
        break;
      case "set_movein":
        if (!op.complex_id || !cx.has(op.complex_id)) no(op, "없는 단지입니다.");
        else if (op.year == null || !cat.moveinYears.includes(op.year)) no(op, `입주 연도는 ${cat.moveinYears[0]}~${cat.moveinYears.at(-1)}만 됩니다.`);
        else ok.push(op);
        break;
      case "add_facility":
        if (!op.facility) no(op, "시설 종류가 없습니다.");
        else if (!op.complex_id || !cx.has(op.complex_id)) no(op, "시설을 둘 단지를 알 수 없습니다.");
        else if (op.year != null && !cat.years.includes(op.year)) no(op, `개통 연도는 ${cat.years[0]}~${cat.years.at(-1)}만 됩니다.`);
        else ok.push(op);
        break;
      case "set_param": {
        const p = op.param ? pm.get(op.param) : undefined;
        if (!p) no(op, "없는 가정값입니다.");
        else if (op.value == null || op.value < p.min || op.value > p.max) no(op, `${p.label}은 ${p.min}~${p.max} 사이여야 합니다.`);
        else ok.push(op);
        break;
      }
    }
  }
  return { ok, rejected };
}
