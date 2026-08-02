import { createClient } from "@supabase/supabase-js";

export async function onRequestPost(context) {
  const supabase = createClient(
    context.env.NEXT_PUBLIC_SUPABASE_URL,
    context.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data: job } = await supabase
    .from("job_status")
    .select("run_id")
    .eq("id", 1)
    .single();

  // Mark cancelled in our own DB immediately - this is what the UI reacts
  // to, regardless of whether the GitHub API call below succeeds or the
  // Python process gets a chance to notice it was killed.
  await supabase
    .from("job_status")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("id", 1);

  if (job?.run_id) {
    try {
      await fetch(
        `https://api.github.com/repos/${context.env.GITHUB_OWNER}/${context.env.GITHUB_REPO}/actions/runs/${job.run_id}/cancel`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${context.env.GITHUB_ACTIONS_TOKEN}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "review-monitor-app",
          },
        }
      );
    } catch (e) {
      // job_status is already marked cancelled above, so the UI is correct
      // either way - a failed cancel call here just means the GitHub Actions
      // run itself may keep running a little longer in the background.
      console.error("Failed to cancel GitHub Actions run:", e);
    }
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json" },
  });
}
