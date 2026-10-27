// 미국 동부(enam)에 고정한 Durable Object 하나가 사용량 제한 · Claude 호출 · 결과 검사를 모두 맡는다.
// Worker는 사용자와 가까운 지역(예: 홍콩)에서 돌 수 있는데, 그런 곳에서 나간 Anthropic 요청은 403으로 거부되기 때문(prompt-factory에서 확인).
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { checkSentences, type Fact } from "./numbers";
import { CatalogSchema, WhatIfSchema, validateOps } from "./whatif";

export interface Env {
  ANTHROPIC_API_KEY?: string;
  ALLOWED_ORIGINS?: string;
  DAILY_LIMIT_PER_IP?: string;
  DAILY_LIMIT_TOTAL?: string;
  GATE: DurableObjectNamespace;
}

export const MODEL = "claude-haiku-5-5";

const ReportIn = z.object({
  year: z.number().int(),
  facts: z.array(z.object({ id: z.string().max(8), text: z.string().max(160) })).min(1).max(60),
});
const ReportOut = z.object({ sentences: z.array(z.object({ text: z.string(), facts: z.array(z.string()) })) });
const WhatIfIn = z.object({ question: z.string().min(2).max(200), catalog: CatalogSchema });

const REPORT_SYSTEM = `당신은 오산시 세교2지구 입주 인프라 시뮬레이터의 정책 리포트를 쓰는 사람입니다.
사용자가 준 사실 목록(F번호)만 근거로, 시청 담당 공무원이 읽을 짧은 리포트를 씁니다.

규칙
- 3~5문장을 씁니다. 한 문장은 한 줄에 들어가게 짧게(45자 안팎) 씁니다.
- 문장마다 근거로 쓴 사실 번호를 facts에 넣습니다. 근거 없는 문장은 쓰지 않습니다.
- 숫자는 그 문장이 든 근거 사실에 있는 값을 그대로 씁니다. 계산·반올림·추정으로 새 숫자를 만들지 않습니다. 순위나 개수를 말할 때도 사실에 있는 숫자만 씁니다.
- 점수는 가정에 기반한 상대 비교 값입니다. "부족하다"고 단정하지 말고 "먼저 점검할 곳"처럼 씁니다.
- 순서: 정원·수송력을 넘는 시설 → 가장 취약한 단지와 원인 → 시나리오 변화가 있으면 그 효과.
- 존댓말 평서문(…입니다, …합니다)으로 쓰고, 이모지나 장식 기호는 쓰지 않습니다.`;

const WHATIF_SYSTEM = `당신은 시뮬레이터 화면의 조작 도우미입니다. 사용자의 질문을 시나리오 조작 목록(ops)으로 바꿉니다.
사용자 메시지에 카탈로그(JSON)가 있습니다. 단지 id·가정값 key는 카탈로그에 있는 것만 씁니다.

조작 종류(쓰지 않는 필드는 null)
- set_year: 화면의 기준 연도를 바꿈. year 사용.
- set_units: 단지 세대수를 바꿈. complex_id, units 사용.
- set_movein: 단지 입주 연도를 바꿈. complex_id, year 사용.
- add_facility: 시설 추가. facility(school-elem 초등학교, school-mid 중학교, bus 정류장, park 공원), 시설을 둘 단지 complex_id, 개통 연도 year(말이 없으면 null).
- set_param: 가정값을 바꿈. param(key), value 사용.

지침
- 질문이 "~하면?"처럼 결과를 묻더라도, 결과는 화면이 계산하므로 조작만 만듭니다. 결과 수치를 지어내지 않습니다.
- 질문에 연도가 있고 그 연도의 결과를 보려는 뜻이면 set_year도 넣습니다.
- 시설 위치가 질문에 없으면 질문에 나온 단지를 쓰고, 단지도 없으면 ops를 비우고 unsupported에 "어느 단지 근처에 둘지 알려 주세요."라고 씁니다.
- 할 수 없는 요청(카탈로그 밖 단지·시설, 시뮬레이터와 무관한 질문)은 ops를 비우고 unsupported에 짧은 이유를 씁니다.
- summary에는 무엇을 바꾸는지 한 문장으로 씁니다(예: "우미린 포레아시티 입주를 2029년으로 미룹니다.").`;

const json = (body: unknown, status = 200) => Response.json(body, { status });
const day = () => new Date().toISOString().slice(0, 10);

export class Gate {
  private client: Anthropic | null;
  constructor(private state: DurableObjectState, private env: Env) {
    this.client = env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1, timeout: 25_000 }) : null;
  }

  /** 하루 사용량 제한(접속 주소별·전체). 넘으면 이유를 돌려준다 */
  private async allow(ip: string): Promise<string | null> {
    const perIp = Number(this.env.DAILY_LIMIT_PER_IP || 30), total = Number(this.env.DAILY_LIMIT_TOTAL || 500);
    const kIp = `${day()}:ip:${ip}`, kAll = `${day()}:all`;
    const [nIp, nAll] = [((await this.state.storage.get<number>(kIp)) ?? 0), ((await this.state.storage.get<number>(kAll)) ?? 0)];
    if (nAll >= total) return "오늘 AI 사용량이 모두 찼습니다. 내일 다시 써 주세요.";
    if (nIp >= perIp) return "이 접속에서 오늘 쓸 수 있는 AI 요청을 모두 썼습니다.";
    await this.state.storage.put(kIp, nIp + 1);
    await this.state.storage.put(kAll, nAll + 1);
    return null;
  }

  async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (!this.client) return json({ error: "AI 키가 설정되지 않았습니다." }, 503);
    const body = await req.json().catch(() => null);
    const limited = await this.allow(req.headers.get("x-client-ip") || "unknown");
    if (limited) return json({ error: limited }, 429);
    try {
      if (path === "/report") return await this.report(body);
      if (path === "/whatif") return await this.whatif(body);
      return json({ error: "없는 기능입니다." }, 404);
    } catch (e) {
      // 재시도할 만한 오류(429·5xx·연결)와 요청 문제(400)를 구분해 화면에 짧게 알린다
      if (e instanceof Anthropic.RateLimitError) return json({ error: "AI가 잠시 바쁩니다. 조금 뒤에 다시 시도해 주세요." }, 503);
      if (e instanceof Anthropic.APIConnectionError) return json({ error: "AI 서버에 연결하지 못했습니다." }, 503);
      if (e instanceof Anthropic.APIError) return json({ error: `AI 요청 오류(${e.status ?? "?"})` }, 502);
      return json({ error: "요청을 처리하지 못했습니다." }, 500);
    }
  }

  private async report(raw: unknown): Promise<Response> {
    const p = ReportIn.safeParse(raw);
    if (!p.success) return json({ error: "입력 형식이 맞지 않습니다." }, 400);
    const facts: Fact[] = p.data.facts;
    const res = await this.client!.messages.parse({
      model: MODEL,
      max_tokens: 4000,
      system: REPORT_SYSTEM,
      output_config: { effort: "low", format: zodOutputFormat(ReportOut) },
      messages: [{ role: "user", content: `${p.data.year}년 기준 사실 목록\n${facts.map((f) => `${f.id}: ${f.text}`).join("\n")}` }],
    });
    if (res.stop_reason === "refusal") return json({ error: "AI가 이 요청에 답하지 않았습니다." }, 422);
    if (res.stop_reason === "max_tokens" || !res.parsed_output) return json({ error: "AI 응답이 잘렸습니다. 다시 시도해 주세요." }, 502);
    const { kept, dropped } = checkSentences(res.parsed_output.sentences, facts);
    return json({ model: MODEL, sentences: kept, dropped });
  }

  private async whatif(raw: unknown): Promise<Response> {
    const p = WhatIfIn.safeParse(raw);
    if (!p.success) return json({ error: "질문은 2~200자로 써 주세요." }, 400);
    const res = await this.client!.messages.parse({
      model: MODEL,
      max_tokens: 4000,
      system: WHATIF_SYSTEM,
      output_config: { effort: "low", format: zodOutputFormat(WhatIfSchema) },
      messages: [{ role: "user", content: `카탈로그\n${JSON.stringify(p.data.catalog)}\n\n질문\n${p.data.question}` }],
    });
    if (res.stop_reason === "refusal") return json({ error: "AI가 이 요청에 답하지 않았습니다." }, 422);
    if (res.stop_reason === "max_tokens" || !res.parsed_output) return json({ error: "AI 응답이 잘렸습니다. 다시 시도해 주세요." }, 502);
    const out = res.parsed_output;
    const { ok, rejected } = validateOps(out.ops, p.data.catalog);
    return json({ model: MODEL, ops: ok, rejected, summary: out.summary, unsupported: out.unsupported });
  }
}
