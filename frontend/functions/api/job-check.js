import { createClient } from "@supabase/supabase-js";

// Reconcile the dashboard's single job_status row with the GitHub Actions
// run. This route is intentionally small: it does not start or cancel jobs;
// it only prevents a dead workflow from leaving the UI stuck on "running".
//
// This file was referenced by the frontend (fetch("/api/job-check")) but
// never actually existed, so it always 404'd silently - meaning a crashed
// or hung GitHub Actions run never got reconciled, leaving "in progress..."
// stuck in Recent Activity indefinitely instead of eventually showing
// failed.
export async function onRequestPost(context) {
  const supabase = createClient(
    context.env.NEXT_PUBLIC_SUPABASE_URL,
    context.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data: job, error: jobError } = await supabase
    .from("job_status")
    .select("*")
    .eq("id", 1)
    .single();

  if (jobError || !job) {
    return new Response(JSON.stringify({ ok: false, error: String(jobError ?? "job_status not found") }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (job.status !== "running" || !job.run_id) {
    return new Response(JSON.stringify(job), {
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const gh = await fetch(
      `https://api.github.com/repos/${context.env.GITHUB_OWNER}/${context.env.GITHUB_REPO}/actions/runs/${job.run_id}`,
      {
        headers: {
          Authorization: `Bearer ${context.env.GITHUB_ACTIONS_TOKEN}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "review-monitor-app",
        },
      }
    );

    if (!gh.ok) {
      // Do not mark the job failed just because the GitHub API is temporarily
      // unavailable. The Python worker can still update job_status normally.
      return new Response(JSON.stringify(job), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const run = await gh.json();
    if (run.status === "completed") {
      const nextStatus = run.conclusion === "cancelled" ? "cancelled" : run.conclusion === "success" ? "done" : "failed";
      const updated = {
        ...job,
        status: nextStatus,
        updated_at: new Date().toISOString(),
      };
      await supabase.from("job_status").update({
        status: nextStatus,
        updated_at: updated.updated_at,
      }).eq("id", 1);
      return new Response(JSON.stringify(updated), {
        headers: { "Content-Type": "application/json" },
      });
    }
  } catch (e) {
    console.error("Failed to reconcile GitHub Actions run:", e);
  }

  return new Response(JSON.stringify(job), {
    headers: { "Content-Type": "application/json" },
  });
}
