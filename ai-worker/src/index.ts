// 세교 디지털트윈 AI 중계 Worker. 정적 사이트(GitHub Pages)는 API 키를 가질 수 없어 이 Worker가 대신 Claude를 부른다.
// 허용한 주소(ALLOWED_ORIGINS)에서 온 요청만 받고, 실제 처리는 Gate(Durable Object)에 넘긴다.
import { Gate, MODEL, type Env } from "./gate";

export { Gate };

function cors(origin: string | null, env: Env): Record<string, string> {
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!origin || !allowed.includes(origin)) return {};
  return { "access-control-allow-origin": origin, "access-control-allow-methods": "POST, GET, OPTIONS", "access-control-allow-headers": "content-type", vary: "origin" };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url), origin = req.headers.get("origin");
    const headers = cors(origin, env);
    if (req.method === "OPTIONS") return new Response(null, { status: headers["access-control-allow-origin"] ? 204 : 403, headers });
    if (url.pathname === "/api/health") return Response.json({ ok: true, model: MODEL, ai: !!env.ANTHROPIC_API_KEY }, { headers });
    const route = { "/api/report": "/report", "/api/whatif": "/whatif" }[url.pathname];
    if (!route || req.method !== "POST") return Response.json({ error: "없는 주소입니다." }, { status: 404, headers });
    if (!headers["access-control-allow-origin"]) return Response.json({ error: "허용되지 않은 출처입니다." }, { status: 403 });
    if (Number(req.headers.get("content-length") || 0) > 32_000) return Response.json({ error: "요청이 너무 큽니다." }, { status: 413, headers });
    const stub = env.GATE.get(env.GATE.idFromName("gate-enam"), { locationHint: "enam" });
    const res = await stub.fetch(`https://gate${route}`, {
      method: "POST", body: await req.text(),
      headers: { "content-type": "application/json", "x-client-ip": req.headers.get("cf-connecting-ip") || "unknown" },
    });
    return new Response(res.body, { status: res.status, headers: { ...headers, "content-type": "application/json" } });
  },
};
