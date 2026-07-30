import { triggerWorkflow } from "../_shared/github.js";

export async function onRequestPost(context) {
  const { keyword } = await context.request.json();

  try {
    await triggerWorkflow(context.env, "profession-scan.yml", { keyword });
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
