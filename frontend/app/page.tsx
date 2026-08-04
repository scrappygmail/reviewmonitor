"use client";

import { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";

type Business = {
  id: string;
  name: string;
  google_maps_url: string;
  address: string | null;
  keyword: string;
  city: string | null;
  rating: number | null;
  monitored: boolean;
  last_scanned_at: string | null;
};

type Review = {
  id: string;
  business_id: string;
  author: string | null;
  rating: number;
  review_text: string | null;
  review_date: string | null;
  is_negative: boolean;
  scan_id: string | null;
};

type ScrapeLog = {
  id: string;
  run_type: string;
  keyword: string | null;
  new_reviews_found: number;
  negative_reviews_found: number;
  status: string;
  ran_at: string;
};

type JobStatus = {
  job_type: string | null;
  status: "idle" | "running" | "done" | "failed" | "cancelled";
  current_index: number;
  total_count: number;
  current_label: string | null;
  started_at: string | null;
};

export default function Dashboard() {
  const [tab, setTab] = useState<"discover" | "mine">("mine");
  const [refreshKey, setRefreshKey] = useState(0);
  const [localStarting, setLocalStarting] = useState(false);
  const [pendingKeyword, setPendingKeyword] = useState<string | null>(null);

  return (
    <main className="min-h-screen">
      <Header />
      <div className="max-w-5xl mx-auto px-5 pt-6">
        <div className="inline-flex bg-surface border border-line rounded-xl2 p-1 shadow-card">
          <TabButton active={tab === "discover"} onClick={() => setTab("discover")}>
            Discover
          </TabButton>
          <TabButton active={tab === "mine"} onClick={() => setTab("mine")}>
            My Businesses
          </TabButton>
        </div>

        <div className="mt-4">
          <JobStatusBanner
            starting={localStarting}
            onConfirmedRunning={() => setLocalStarting(false)}
            onFinished={() => {
              setLocalStarting(false);
              setRefreshKey((k) => k + 1);
            }}
          />
        </div>

        <div className="mt-6 pb-16">
          {tab === "discover" ? (
            <DiscoverTab
              refreshKey={refreshKey}
              onStart={() => setLocalStarting(true)}
              pendingKeyword={pendingKeyword}
              onPendingKeywordHandled={() => setPendingKeyword(null)}
            />
          ) : (
            <MyBusinessesTab
              refreshKey={refreshKey}
              onStart={() => setLocalStarting(true)}
              onOpenDiscoverKeyword={(kw) => {
                setPendingKeyword(kw);
                setTab("discover");
              }}
            />
          )}
        </div>
      </div>
    </main>
  );
}

function Header() {
  return (
    <header className="border-b border-line bg-surface/80 backdrop-blur sticky top-0 z-10">
      <div className="max-w-5xl mx-auto px-5 py-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-brand-500 flex items-center justify-center text-white font-display font-bold text-sm">
            R
          </div>
          <span className="font-display font-bold text-lg tracking-tight">Review Monitor</span>
        </div>
        <div className="flex items-center gap-4">
          <EnableNotificationsButton />
          <span className="text-xs text-muted font-medium tracking-wide">JafriLabs</span>
        </div>
      </div>
    </header>
  );
}

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function runTypeLabel(runType: string): string {
  const labels: Record<string, string> = {
    monitor: "Watch list scan",
    full_scan: "Full rotation sweep",
    profession_scan: "Profession scan",
    discover: "Discovery search",
  };
  return labels[runType] ?? runType;
}

function LoadingDots() {
  return (
    <span className="inline-flex gap-1 ml-1.5">
      <span className="w-1.5 h-1.5 bg-current rounded-full animate-bounce [animation-delay:-0.3s]" />
      <span className="w-1.5 h-1.5 bg-current rounded-full animate-bounce [animation-delay:-0.15s]" />
      <span className="w-1.5 h-1.5 bg-current rounded-full animate-bounce" />
    </span>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-5 py-2 rounded-lg text-sm font-semibold transition-colors focus-ring ${
        active ? "bg-brand-500 text-white" : "text-muted hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Live job progress banner - polls job_status, shows elapsed time + a real
// progress bar (when the job knows its total), and a Stop button. Calls
// onFinished() the moment a running job transitions to done/failed/cancelled
// so the tabs can refresh their data automatically.
// ---------------------------------------------------------------------------

function JobStatusBanner({
  starting,
  onConfirmedRunning,
  onFinished,
}: {
  starting: boolean;
  onConfirmedRunning: () => void;
  onFinished: () => void;
}) {
  const [job, setJob] = useState<JobStatus | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [stopping, setStopping] = useState(false);
  const prevStatus = useRef<string | null>(null);

  useEffect(() => {
    async function poll() {
      const { data } = await supabase.from("job_status").select("*").eq("id", 1).maybeSingle();
      if (data) {
        const j = data as JobStatus;
        if (j.status === "running") {
          onConfirmedRunning();
        }
        if (prevStatus.current === "running" && j.status !== "running") {
          onFinished();
        }
        prevStatus.current = j.status;
        setJob(j);
      }
    }
    poll();
    const interval = setInterval(poll, 2000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!job || job.status !== "running" || !job.started_at) return;
    const startedMs = new Date(job.started_at).getTime();
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - startedMs) / 1000)));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [job?.started_at, job?.status]);

  // Every 15s while we think we're running, ask GitHub directly whether
  // the run is actually still going. This is what stops the timer/progress
  // bar from running forever if the workflow died without ever updating
  // its own status (crash, orphaned process, etc).
  useEffect(() => {
    if (job?.status !== "running") return;

    async function reconcile() {
      try {
        const res = await fetch("/api/job-check", { method: "POST" });
        if (res.ok) {
          const j = (await res.json()) as JobStatus;
          if (prevStatus.current === "running" && j.status !== "running") {
            onFinished();
          }
          prevStatus.current = j.status;
          setJob(j);
        }
      } catch (e) {
        console.error("Failed to reconcile job status with GitHub:", e);
      }
    }

    const interval = setInterval(reconcile, 15000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.status]);

  async function stop() {
    setStopping(true);
    await fetch("/api/cancel", { method: "POST" });
    setStopping(false);
  }

  const confirmedRunning = job?.status === "running";
  if (!starting && !confirmedRunning) return null;

  // Optimistic phase: button was just clicked, but GitHub Actions hasn't
  // reported back to Supabase yet (VM boot + checkout + deps install,
  // typically 15-25s). Show an indeterminate banner immediately instead
  // of nothing - it seamlessly becomes the real banner once confirmed.
  if (!confirmedRunning) {
    return (
      <div className="bg-brand-50 border border-brand-400 rounded-xl2 p-4 shadow-card">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-sm font-semibold text-brand-600 flex items-center">
            Starting…
            <LoadingDots />
          </span>
        </div>
        <div className="w-full h-2 bg-brand-100 rounded-full overflow-hidden">
          <div className="h-full bg-brand-500 animate-pulse w-1/3 rounded-full" />
        </div>
      </div>
    );
  }

  const pct = job!.total_count > 0 ? Math.round((job!.current_index / job!.total_count) * 100) : null;
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  const label = job!.job_type === "discover" ? "Searching…" : "Scanning reviews…";

  return (
    <div className="bg-brand-50 border border-brand-400 rounded-xl2 p-4 shadow-card flex items-center gap-4">
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-sm font-semibold text-brand-600">{label}</span>
          <span className="text-xs text-muted whitespace-nowrap">
            {mins}:{secs.toString().padStart(2, "0")} elapsed
          </span>
        </div>
        {job!.current_label && (
          <div className="text-xs text-muted mb-2 truncate">{job!.current_label}</div>
        )}
        <div className="w-full h-2 bg-brand-100 rounded-full overflow-hidden">
          {pct !== null ? (
            <div
              className="h-full bg-brand-500 transition-all duration-500"
              style={{ width: `${pct}%` }}
            />
          ) : (
            <div className="h-full bg-brand-500 animate-pulse w-1/3 rounded-full" />
          )}
        </div>
        {job!.total_count > 0 && (
          <div className="text-xs text-muted mt-1">
            {job!.current_index} / {job!.total_count}
          </div>
        )}
      </div>
      <button
        onClick={stop}
        disabled={stopping}
        className="text-sm font-semibold text-alert-600 border border-alert-400 rounded-lg px-3 py-1.5 hover:bg-alert-50 focus-ring disabled:opacity-50 whitespace-nowrap"
      >
        {stopping ? "Stopping…" : "Stop"}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Discover tab
// ---------------------------------------------------------------------------

function DiscoverTab({
  refreshKey,
  onStart,
  pendingKeyword,
  onPendingKeywordHandled,
}: {
  refreshKey: number;
  onStart: () => void;
  pendingKeyword: string | null;
  onPendingKeywordHandled: () => void;
}) {
  const [keyword, setKeyword] = useState("");
  const [city, setCity] = useState("");
  const [savedKeywords, setSavedKeywords] = useState<string[]>([]);
  const [activeKeyword, setActiveKeyword] = useState<string | null>(null);
  const [results, setResults] = useState<Business[]>([]);
  const [starting, setStarting] = useState(false);
  const [scanStarting, setScanStarting] = useState(false);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    loadSavedKeywords();
  }, []);

  // Whenever a job finishes (banner tells the parent, which bumps
  // refreshKey), reload whichever keyword's results are on screen.
  useEffect(() => {
    loadSavedKeywords();
    if (activeKeyword) loadKeywordList(activeKeyword);
    setSearching(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  // Arriving here from a "Recent activity" click on My Businesses -
  // jump straight to that keyword's results.
  useEffect(() => {
    if (pendingKeyword) {
      loadKeywordList(pendingKeyword);
      onPendingKeywordHandled();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingKeyword]);

  async function loadSavedKeywords() {
    const { data } = await supabase.from("businesses").select("keyword");
    const unique = Array.from(new Set((data ?? []).map((r) => r.keyword)));
    setSavedKeywords(unique);
  }

  async function runDiscovery() {
    if (!keyword || !city) return;
    setStarting(true);
    onStart();
    await fetch("/api/discover", {
      method: "POST",
      body: JSON.stringify({ keyword, city }),
    });
    // Optimistically switch to this keyword's results view - the
    // JobStatusBanner above will show live progress, and results appear
    // here automatically once the job finishes (via refreshKey).
    setActiveKeyword(keyword);
    setResults([]);
    setSearching(true);
    setStarting(false);
  }

  async function loadKeywordList(kw: string) {
    setActiveKeyword(kw);
    setSearching(false);
    const { data } = await supabase.from("businesses").select("*").eq("keyword", kw);
    setResults((data ?? []) as Business[]);
  }

  async function toggleMonitored(id: string, monitored: boolean) {
    await fetch("/api/businesses/toggle", {
      method: "POST",
      body: JSON.stringify({ id, monitored: !monitored }),
    });
    setResults((r) => r.map((b) => (b.id === id ? { ...b, monitored: !monitored } : b)));
  }

  async function runProfessionScan(kw: string) {
    setScanStarting(true);
    onStart();
    await fetch("/api/profession-scan", {
      method: "POST",
      body: JSON.stringify({ keyword: kw }),
    });
    setScanStarting(false);
  }

  return (
    <div className="space-y-6">
      <div className="bg-surface border border-line rounded-xl2 p-5 shadow-card">
        <h2 className="font-display font-bold text-lg mb-1">Find businesses</h2>
        <p className="text-sm text-muted mb-4">
          Search a profession and area. Results are saved permanently — add the ones you want to watch.
        </p>
        <div className="flex flex-col sm:flex-row gap-3">
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="e.g. plumber"
            className="flex-1 border border-line rounded-lg px-4 py-2.5 text-sm focus-ring outline-none"
          />
          <input
            value={city}
            onChange={(e) => setCity(e.target.value)}
            placeholder="e.g. Manchester"
            className="flex-1 border border-line rounded-lg px-4 py-2.5 text-sm focus-ring outline-none"
          />
          <button
            onClick={runDiscovery}
            disabled={starting}
            className="bg-brand-500 hover:bg-brand-600 text-white font-semibold text-sm rounded-lg px-5 py-2.5 focus-ring disabled:opacity-50"
          >
            {starting ? "Starting…" : "Search"}
          </button>
        </div>
      </div>

      {savedKeywords.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-muted mb-2">Saved searches</h3>
          <div className="flex flex-wrap gap-2">
            {savedKeywords.map((kw) => (
              <button
                key={kw}
                onClick={() => loadKeywordList(kw)}
                className={`px-3 py-1.5 rounded-full text-sm border focus-ring ${
                  activeKeyword === kw
                    ? "bg-brand-50 border-brand-400 text-brand-600"
                    : "bg-surface border-line text-muted hover:text-ink"
                }`}
              >
                {kw}
              </button>
            ))}
          </div>
        </div>
      )}

      {activeKeyword && (
        <div className="flex items-center justify-between">
          {searching ? (
            <span className="text-sm text-muted flex items-center">
              Searching for <strong className="text-ink mx-1">{activeKeyword}</strong>
              <LoadingDots />
            </span>
          ) : (
            <span className="text-sm text-muted">
              {results.length} results for <strong className="text-ink">{activeKeyword}</strong>
            </span>
          )}
          <button
            onClick={() => runProfessionScan(activeKeyword)}
            disabled={scanStarting || searching}
            className="text-sm font-semibold text-brand-600 hover:text-brand-500 focus-ring disabled:opacity-50"
          >
            {scanStarting ? "Starting…" : "Scan all reviews for negatives →"}
          </button>
        </div>
      )}

      <div className="grid gap-3">
        {results.map((b) => (
          <div
            key={b.id}
            className="bg-surface border border-line rounded-xl2 p-4 shadow-card flex items-center justify-between"
          >
            <div>
              <div className="font-semibold text-sm">{b.name}</div>
              <div className="text-xs text-muted mt-0.5">
                {b.address} {b.rating ? `· ★ ${b.rating}` : ""}
              </div>
            </div>
            <button
              onClick={() => toggleMonitored(b.id, b.monitored)}
              className={`w-9 h-9 rounded-full flex items-center justify-center font-bold text-lg focus-ring ${
                b.monitored
                  ? "bg-brand-50 text-brand-600 border border-brand-400"
                  : "bg-brand-500 text-white hover:bg-brand-600"
              }`}
              title={b.monitored ? "Already in watch list" : "Add to watch list"}
            >
              {b.monitored ? "✓" : "+"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// My Businesses tab
// ---------------------------------------------------------------------------

function MyBusinessesTab({
  refreshKey,
  onStart,
  onOpenDiscoverKeyword,
}: {
  refreshKey: number;
  onStart: () => void;
  onOpenDiscoverKeyword: (keyword: string) => void;
}) {
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [businessLookup, setBusinessLookup] = useState<Record<string, Business>>({});
  const [reviews, setReviews] = useState<Review[]>([]);
  const [checking, setChecking] = useState(false);
  const [lastChecked, setLastChecked] = useState<string | null>(null);
  const [view, setView] = useState<"negative" | "all" | "businesses">("negative");
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [activity, setActivity] = useState<ScrapeLog[]>([]);

  // Session view: when set, shows only the reviews found by that one
  // specific scan run instead of everything mixed together.
  const [sessionLog, setSessionLog] = useState<ScrapeLog | null>(null);
  const [sessionReviews, setSessionReviews] = useState<Review[]>([]);
  const [sessionLoading, setSessionLoading] = useState(false);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  async function load() {
    const { data: biz } = await supabase.from("businesses").select("*").eq("monitored", true);
    setBusinesses((biz ?? []) as Business[]);

    // Reviews can belong to ANY discovered business, not just monitored
    // ones (e.g. from "Scan all reviews for negatives") - so the name/link
    // lookup needs every business, not just the watch list.
    const { data: allBiz } = await supabase.from("businesses").select("*");
    const lookup: Record<string, Business> = {};
    (allBiz ?? []).forEach((b) => {
      lookup[(b as Business).id] = b as Business;
    });
    setBusinessLookup(lookup);

    const { data: rev } = await supabase
      .from("reviews")
      .select("*")
      .order("review_date", { ascending: false })
      .limit(100);
    setReviews((rev ?? []) as Review[]);

    const { data: log } = await supabase
      .from("scrape_logs")
      .select("ran_at")
      .eq("run_type", "monitor")
      .order("ran_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    setLastChecked(log?.ran_at ?? null);

    const { data: logs } = await supabase
      .from("scrape_logs")
      .select("*")
      .order("ran_at", { ascending: false })
      .limit(8);
    setActivity((logs ?? []) as ScrapeLog[]);
  }

  async function checkNow() {
    setChecking(true);
    onStart();
    await fetch("/api/check-now", { method: "POST" });
    setChecking(false);
  }

  async function removeBusiness(id: string) {
    setRemovingId(id);
    await fetch("/api/businesses/delete", {
      method: "POST",
      body: JSON.stringify({ id }),
    });
    setBusinesses((b) => b.filter((biz) => biz.id !== id));
    setRemovingId(null);
  }

  async function openActivity(log: ScrapeLog) {
    if (log.run_type === "discover") {
      onOpenDiscoverKeyword(log.keyword ?? "");
      return;
    }
    setSessionLog(log);
    setSessionLoading(true);
    const { data } = await supabase.from("reviews").select("*").eq("scan_id", log.id);
    setSessionReviews((data ?? []) as Review[]);
    setSessionLoading(false);
  }

  function closeSession() {
    setSessionLog(null);
    setSessionReviews([]);
  }

  const shown = view === "negative" ? reviews.filter((r) => r.is_negative) : reviews;

  function reviewCard(r: Review) {
    const biz = businessLookup[r.business_id];
    return (
      <div key={r.id} className="bg-surface border border-line rounded-xl2 p-4 shadow-card">
        <div className="flex items-center justify-between mb-1">
          {biz ? (
            <a
              href={biz.google_maps_url}
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-sm text-brand-600 hover:underline"
            >
              {biz.name}
            </a>
          ) : (
            <span className="font-semibold text-sm text-muted">Unknown business</span>
          )}
          <RatingBadge rating={r.rating} />
        </div>
        {biz?.address && <div className="text-xs text-muted mb-1">{biz.address}</div>}
        <p className="text-sm text-muted">{r.review_text}</p>
        <div className="text-xs text-muted mt-2">
          {r.author} {r.review_date ? `· ${new Date(r.review_date).toLocaleDateString()}` : ""}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="bg-surface border border-line rounded-xl2 p-5 shadow-card flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="font-display font-bold text-lg">Watch list</h2>
          <p className="text-sm text-muted mt-0.5">
            {businesses.length} businesses ·{" "}
            {lastChecked ? `last checked ${new Date(lastChecked).toLocaleString()}` : "never checked"}
          </p>
        </div>
        <button
          onClick={checkNow}
          disabled={checking}
          className="bg-brand-500 hover:bg-brand-600 text-white font-semibold text-sm rounded-lg px-5 py-2.5 focus-ring disabled:opacity-50 whitespace-nowrap"
        >
          {checking ? "Starting…" : "Check now"}
        </button>
      </div>

      {activity.length > 0 && (
        <div className="bg-surface border border-line rounded-xl2 p-5 shadow-card">
          <h3 className="text-sm font-semibold text-muted mb-3">Recent activity</h3>
          <p className="text-xs text-muted mb-3">Click any run to see exactly what it found.</p>
          <div className="space-y-1">
            {activity.map((log) => (
              <button
                key={log.id}
                onClick={() => openActivity(log)}
                className="w-full flex items-center justify-between text-sm py-2 px-2 -mx-2 rounded-lg border-b border-line last:border-0 hover:bg-brand-50 focus-ring text-left"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className={`w-2 h-2 rounded-full flex-shrink-0 ${
                      log.status === "failed" ? "bg-alert-500" : "bg-brand-500"
                    }`}
                  />
                  <span className="truncate">
                    {runTypeLabel(log.run_type)}
                    {log.keyword ? ` · ${log.keyword}` : ""}
                  </span>
                </div>
                <div className="flex items-center gap-3 text-xs text-muted whitespace-nowrap">
                  {log.status === "running" ? (
                    <span className="text-brand-600 font-medium">in progress…</span>
                  ) : log.status === "failed" ? (
                    <span className="text-alert-600 font-medium">failed</span>
                  ) : (
                    <span>
                      {log.new_reviews_found} new
                      {log.negative_reviews_found > 0 && (
                        <span className="text-alert-600 font-medium"> · {log.negative_reviews_found} negative</span>
                      )}
                    </span>
                  )}
                  <span>{timeAgo(log.ran_at)}</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {sessionLog ? (
        <div className="space-y-4">
          <div className="bg-brand-50 border border-brand-400 rounded-xl2 p-4 shadow-card flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold text-brand-600">
                {runTypeLabel(sessionLog.run_type)}
              </div>
              <div className="text-xs text-muted">
                {timeAgo(sessionLog.ran_at)} · {sessionReviews.length} reviews found
              </div>
            </div>
            <button
              onClick={closeSession}
              className="text-sm font-semibold text-muted hover:text-ink focus-ring px-3 py-1.5"
            >
              ✕ Back
            </button>
          </div>
          <div className="grid gap-3">
            {sessionLoading && (
              <div className="text-sm text-muted py-10 text-center">Loading…</div>
            )}
            {!sessionLoading && sessionReviews.length === 0 && (
              <div className="text-sm text-muted py-10 text-center">
                No new reviews were found in this run.
              </div>
            )}
            {!sessionLoading && sessionReviews.map(reviewCard)}
          </div>
        </div>
      ) : (
        <>
          <div className="inline-flex bg-surface border border-line rounded-xl2 p-1 shadow-card">
            <TabButton active={view === "negative"} onClick={() => setView("negative")}>
              Negative reviews
            </TabButton>
            <TabButton active={view === "all"} onClick={() => setView("all")}>
              All reviews
            </TabButton>
            <TabButton active={view === "businesses"} onClick={() => setView("businesses")}>
              Saved businesses
            </TabButton>
          </div>

          {view === "businesses" ? (
            <div className="grid gap-3">
              {businesses.length === 0 && (
                <div className="text-sm text-muted py-10 text-center">No businesses saved yet.</div>
              )}
              {businesses.map((b) => (
                <div
                  key={b.id}
                  className="bg-surface border border-line rounded-xl2 p-4 shadow-card flex items-center justify-between"
                >
                  <div>
                    <div className="font-semibold text-sm">{b.name}</div>
                    <div className="text-xs text-muted mt-0.5">
                      {b.address} {b.rating ? `· ★ ${b.rating}` : ""}
                    </div>
                  </div>
                  <button
                    onClick={() => removeBusiness(b.id)}
                    disabled={removingId === b.id}
                    className="w-9 h-9 rounded-full flex items-center justify-center font-bold text-lg bg-alert-50 text-alert-600 border border-alert-400 hover:bg-alert-100 focus-ring disabled:opacity-50"
                    title="Remove from watch list"
                  >
                    {removingId === b.id ? "…" : "−"}
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="grid gap-3">
              {shown.length === 0 && (
                <div className="text-sm text-muted py-10 text-center">No reviews to show yet.</div>
              )}
              {shown.map(reviewCard)}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function RatingBadge({ rating }: { rating: number }) {
  const negative = rating <= 3;
  return (
    <span
      className={`text-xs font-bold px-2 py-0.5 rounded-full ${
        negative ? "bg-alert-50 text-alert-600" : "bg-brand-50 text-brand-600"
      }`}
    >
      ★ {rating}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Push notification opt-in
// ---------------------------------------------------------------------------

function EnableNotificationsButton() {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    if ("serviceWorker" in navigator && "PushManager" in window) {
      navigator.serviceWorker.ready.then((reg) => {
        reg.pushManager.getSubscription().then((sub) => setEnabled(!!sub));
      });
    }
  }, []);

  async function enable() {
    const reg = await navigator.serviceWorker.register("/sw.js");
    const perm = await Notification.requestPermission();
    if (perm !== "granted") return;

    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!),
    });

    await fetch("/api/push/subscribe", {
      method: "POST",
      body: JSON.stringify(sub),
    });
    setEnabled(true);
  }

  // Web Push requires the VAPID public key as a raw Uint8Array, not the
  // base64 string it's stored/shared as - this converts between the two.
  function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(new ArrayBuffer(rawData.length));
    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }

  if (enabled) {
    return <span className="text-xs text-muted">🔔 Notifications on</span>;
  }

  return (
    <button
      onClick={enable}
      className="text-xs font-semibold text-brand-600 hover:text-brand-500 focus-ring"
    >
      Enable notifications
    </button>
  );
}
