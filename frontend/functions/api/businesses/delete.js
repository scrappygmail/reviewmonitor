import { createClient } from "@supabase/supabase-js";

export async function onRequestPost(context) {
  const { id } = await context.request.json();

  const supabase = createClient(
    context.env.NEXT_PUBLIC_SUPABASE_URL,
    context.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // The reviews table has ON DELETE CASCADE on business_id, so this also
  // removes that business's stored reviews.
  const { error } = await supabase.from("businesses").delete().eq("id", id);

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
