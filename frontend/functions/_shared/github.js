// Shared by every function that needs to trigger a GitHub Actions workflow.
// Files/folders starting with "_" inside functions/ are never treated as
// routes by Cloudflare Pages, so this is safe to import from siblings.
export async function triggerWorkflow(env, workflowFile, inputs) {
  const res = await fetch(
    `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/workflows/${workflowFile}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GITHUB_ACTIONS_TOKEN}`,
        Accept: "application/vnd.github+json",
      },
      body: JSON.stringify({ ref: "main", inputs }),
    }
  );
  if (!res.ok) {
    throw new Error(`Failed to trigger ${workflowFile}: ${res.status} ${await res.text()}`);
  }
}
