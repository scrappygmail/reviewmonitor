import { createClient } from "@supabase/supabase-js";

export async function onRequestPost(context) {
  const { id, monitored } = await context.request.json();

  const supabase = createClient(
    context.env.NEXT_PUBLIC_SUPABASE_URL,
    context.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { error } = await supabase.from("businesses").update({ monitored }).eq("id", id);

  if (error) {
    return new Response(JSON.stringify({ ok: false, error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json" },
  });
}
