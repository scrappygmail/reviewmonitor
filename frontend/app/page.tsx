"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, MouseEvent, SetStateAction } from "react";
import { supabase } from "@/lib/supabase";

type Business = {
  id: string;
  name: string;
  google_maps_url: string;
  address: string | null;
  phone: string | null;
  email: string | null;
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

  // Lifted out of DiscoverTab (instead of living as local state there) so
  // the last search's results and the saved-keyword pills survive
  // switching to "My Businesses" and back. They only reset when a new
  // manual search runs, or when the user explicitly hits a "Clear" button.
  const [discoverActiveKeyword, setDiscoverActiveKeyword] = useState<string | null>(null);
  const [discoverResults, setDiscoverResults] = useState<Business[]>([]);
  const [discoverSearching, setDiscoverSearching] = useState(false);
  const [keywordsCleared, setKeywordsCleared] = useState(false);

  // Component state alone only survives switching tabs inside the app - a
  // real page reload/refresh (or the mobile browser reloading a
  // backgrounded tab) wipes it completely since it never leaves memory.
  // Persist the keyword (not the actual result rows - those get re-fetched
  // fresh) and the cleared-keywords flag to localStorage so a refresh
  // restores the same view instead of coming back empty.
  useEffect(() => {
    try {
      const savedKeyword = localStorage.getItem("rm_active_keyword");
      if (savedKeyword) setDiscoverActiveKeyword(savedKeyword);
      const savedCleared = localStorage.getItem("rm_keywords_cleared");
      if (savedCleared === "1") setKeywordsCleared(true);
    } catch {
      // localStorage unavailable (private browsing etc.) - just skip persistence
    }
  }, []);

  useEffect(() => {
    try {
      if (discoverActiveKeyword) localStorage.setItem("rm_active_keyword", discoverActiveKeyword);
      else localStorage.removeItem("rm_active_keyword");
    } catch {
      // ignore
    }
  }, [discoverActiveKeyword]);

  useEffect(() => {
    try {
      localStorage.setItem("rm_keywords_cleared", keywordsCleared ? "1" : "0");
    } catch {
      // ignore
    }
  }, [keywordsCleared]);

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
              activeKeyword={discoverActiveKeyword}
              setActiveKeyword={setDiscoverActiveKeyword}
              results={discoverResults}
              setResults={setDiscoverResults}
              searching={discoverSearching}
              setSearching={setDiscoverSearching}
              keywordsCleared={keywordsCleared}
              setKeywordsCleared={setKeywordsCleared}
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
          <span className="font-display font-extrabold text-base tracking-tight select-none">
            <span style={{ color: "#DC2626" }}>J</span>
            <span style={{ color: "#1B1464" }}>afriLabs</span>
          </span>
        </div>
      </div>
    </header>
  );
}

function csvEscape(field: string): string {
  const needsQuotes = /[",\n\r]/.test(field);
  const escaped = field.replace(/"/g, '""');
  return needsQuotes ? `"${escaped}"` : escaped;
}

// Some businesses saved before the scraper fix have a raw JSON string
// (e.g. {"borough":"","street":"","city":"",...}) sitting in the address
// field instead of plain text. Parse it into something readable, or drop
// it if every part inside is empty, instead of showing the JSON blob.
function formatAddress(raw?: string | null): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parts = JSON.parse(trimmed) as Record<string, string>;
      const order = ["street", "borough", "city", "state", "postal_code", "country"];
      return order
        .map((k) => (parts[k] ? String(parts[k]).trim() : ""))
        .filter(Boolean)
        .join(", ");
    } catch {
      return "";
    }
  }
  return trimmed;
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
  activeKeyword,
  setActiveKeyword,
  results,
  setResults,
  searching,
  setSearching,
  keywordsCleared,
  setKeywordsCleared,
}: {
  refreshKey: number;
  onStart: () => void;
  pendingKeyword: string | null;
  onPendingKeywordHandled: () => void;
  activeKeyword: string | null;
  setActiveKeyword: (kw: string | null) => void;
  results: Business[];
  setResults: Dispatch<SetStateAction<Business[]>>;
  searching: boolean;
  setSearching: (v: boolean) => void;
  keywordsCleared: boolean;
  setKeywordsCleared: (v: boolean) => void;
}) {
  const [keyword, setKeyword] = useState("");
  const [city, setCity] = useState("");
  const [savedKeywords, setSavedKeywords] = useState<string[]>([]);
  const [starting, setStarting] = useState(false);
  const [scanStarting, setScanStarting] = useState(false);

  // "Show negative reviews" reads whatever has already been scanned for
  // these businesses (fast, no new job) - separate from "Scan all reviews
  // for negatives", which actually kicks off a new scraping run.
  const [negativeReviews, setNegativeReviews] = useState<Review[]>([]);
  const [showingNegatives, setShowingNegatives] = useState(false);
  const [loadingNegatives, setLoadingNegatives] = useState(false);

  const resultsLookup = useMemo(() => {
    const map: Record<string, Business> = {};
    results.forEach((b) => {
      map[b.id] = b;
    });
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results]);

  useEffect(() => {
    loadSavedKeywords();
  }, []);

  // Whenever a job finishes (banner tells the parent, which bumps
  // refreshKey), reload whichever keyword's results are on screen.
  useEffect(() => {
    loadSavedKeywords();
    if (activeKeyword) loadKeywordList(activeKeyword);
    if (showingNegatives) loadNegativeReviews();
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

  // Handles the page-refresh case: the parent restores activeKeyword from
  // localStorage shortly AFTER this component's first render (its own
  // effect fires one tick later), so the [refreshKey] effect above already
  // ran once with activeKeyword still null and won't fire again on its
  // own. Watching activeKeyword directly catches that restore and
  // re-fetches its businesses.
  useEffect(() => {
    if (activeKeyword && results.length === 0 && !searching) {
      loadKeywordList(activeKeyword);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKeyword]);

  async function loadSavedKeywords() {
    const { data } = await supabase.from("businesses").select("keyword");
    const unique = Array.from(new Set((data ?? []).map((r) => r.keyword)));
    setSavedKeywords(unique);
  }

  async function runDiscovery() {
    if (!keyword || !city) return;
    setStarting(true);
    onStart();
    try {
      const res = await fetch("/api/discover", {
        method: "POST",
        body: JSON.stringify({ keyword, city }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || body?.ok === false) {
        alert(
          `Couldn't start the search: ${body?.error ?? `server returned ${res.status}`}\n\n` +
            `Check Cloudflare Pages → Settings → Environment variables (GITHUB_OWNER, GITHUB_REPO, GITHUB_ACTIONS_TOKEN).`
        );
        setStarting(false);
        return;
      }
    } catch (e) {
      alert(`Network error starting the search: ${e}`);
      setStarting(false);
      return;
    }
    // Optimistically switch to this keyword's results view - the
    // JobStatusBanner above will show live progress, and results appear
    // here automatically once the job finishes (via refreshKey).
    setActiveKeyword(keyword);
    setResults([]);
    setSearching(true);
    setShowingNegatives(false);
    setNegativeReviews([]);
    // NOTE: keywordsCleared is intentionally left alone here - once the
    // user hides the saved-keyword pills, they stay hidden. Auto-restoring
    // them on every new search was the bug being fixed.
    setStarting(false);
  }

  async function loadKeywordList(kw: string) {
    setActiveKeyword(kw);
    setSearching(false);
    setShowingNegatives(false);
    setNegativeReviews([]);
    const { data } = await supabase.from("businesses").select("*").eq("keyword", kw);
    setResults((data ?? []) as Business[]);
  }

  // Only clears what's on screen - saved businesses stay in the database.
  // Results otherwise persist (even across tab switches) until either this
  // is clicked or a new manual search overwrites them.
  function clearResults() {
    setActiveKeyword(null);
    setResults([]);
    setSearching(false);
    setShowingNegatives(false);
    setNegativeReviews([]);
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
    try {
      const res = await fetch("/api/profession-scan", {
        method: "POST",
        body: JSON.stringify({ keyword: kw }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || body?.ok === false) {
        alert(`Couldn't start the scan: ${body?.error ?? `server returned ${res.status}`}`);
      }
    } catch (e) {
      alert(`Network error starting the scan: ${e}`);
    }
    setScanStarting(false);
  }

  // Shows negative reviews already sitting in the database for the
  // businesses currently on screen - does NOT trigger a new scan. Use
  // "Scan all reviews for negatives" for that.
  async function loadNegativeReviews() {
    if (results.length === 0) return;
    setLoadingNegatives(true);
    setShowingNegatives(true);
    const { data } = await supabase
      .from("reviews")
      .select("*")
      .in(
        "business_id",
        results.map((b) => b.id)
      )
      .eq("is_negative", true)
      .order("review_date", { ascending: false });
    setNegativeReviews((data ?? []) as Review[]);
    setLoadingNegatives(false);
  }

  function downloadDiscoverNegativesCsv() {
    if (negativeReviews.length === 0) return;
    const header = [
      "Business Name",
      "Phone",
      "Email",
      "Address",
      "City",
      "Keyword",
      "Rating",
      "Review Text",
      "Author",
      "Review Date",
      "Google Maps Link",
    ];
    const rows = negativeReviews.map((r) => {
      const biz = resultsLookup[r.business_id];
      return [
        biz?.name ?? "",
        biz?.phone ?? "",
        biz?.email ?? "",
        formatAddress(biz?.address),
        biz?.city ?? "",
        biz?.keyword ?? "",
        String(r.rating),
        r.review_text ?? "",
        r.author ?? "",
        r.review_date ? new Date(r.review_date).toLocaleDateString() : "",
        biz?.google_maps_url ?? "",
      ];
    });
    const csv = [header, ...rows].map((row) => row.map(csvEscape).join(",")).join("\r\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const dateStr = new Date().toISOString().slice(0, 10);
    const label = (activeKeyword ?? "search").replace(/\s+/g, "-").toLowerCase();
    a.href = url;
    a.download = `negative-reviews_${label}_${dateStr}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
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

      {savedKeywords.length > 0 && !keywordsCleared && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold text-muted">Saved searches</h3>
            <button
              onClick={() => setKeywordsCleared(true)}
              className="text-xs font-semibold text-muted hover:text-alert-600 focus-ring"
            >
              Clear keywords
            </button>
          </div>
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
        <div className="space-y-2.5">
          <div>
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
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={loadNegativeReviews}
              disabled={loadingNegatives || results.length === 0}
              className="text-xs font-semibold text-alert-600 border border-alert-400 rounded-full px-3 py-1.5 hover:bg-alert-50 focus-ring disabled:opacity-50"
              title="Shows negative reviews already scanned for these businesses - no new scan"
            >
              {loadingNegatives ? "Loading…" : "Show negative reviews"}
            </button>
            <button
              onClick={() => runProfessionScan(activeKeyword)}
              disabled={scanStarting || searching}
              className="text-xs font-semibold text-brand-600 border border-brand-400 rounded-full px-3 py-1.5 hover:bg-brand-50 focus-ring disabled:opacity-50"
              title="Starts a new scan of every business's reviews - takes a while"
            >
              {scanStarting ? "Starting…" : "Scan all reviews for negatives →"}
            </button>
            <button
              onClick={clearResults}
              className="text-xs font-semibold text-muted border border-line rounded-full px-3 py-1.5 hover:bg-alert-50 hover:text-alert-600 hover:border-alert-400 focus-ring"
            >
              ✕ Clear results
            </button>
          </div>
        </div>
      )}

      {showingNegatives && (
        <div className="bg-alert-50 border border-alert-400 rounded-xl2 p-4 shadow-card space-y-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <div className="text-sm font-semibold text-alert-600">
                {loadingNegatives
                  ? "Loading…"
                  : `${negativeReviews.length} negative review${negativeReviews.length === 1 ? "" : "s"} found so far`}
              </div>
              <div className="text-xs text-muted">
                From reviews already scanned for these businesses — run a scan above to check for more.
              </div>
            </div>
            <div className="flex items-center gap-2">
              {negativeReviews.length > 0 && (
                <button
                  onClick={downloadDiscoverNegativesCsv}
                  className="text-sm font-semibold text-brand-600 hover:text-brand-500 focus-ring px-3 py-1.5"
                >
                  ⬇ Download CSV
                </button>
              )}
              <button
                onClick={() => setShowingNegatives(false)}
                className="text-sm font-semibold text-muted hover:text-ink focus-ring px-3 py-1.5"
              >
                ✕ Hide
              </button>
            </div>
          </div>
          {!loadingNegatives && negativeReviews.length === 0 && (
            <p className="text-sm text-muted">
              No negative reviews found yet — click &quot;Scan all reviews for negatives&quot; above to check
              these businesses.
            </p>
          )}
          <div className="grid gap-3">
            {negativeReviews.map((r) => {
              const biz = resultsLookup[r.business_id];
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
                  {formatAddress(biz?.address) && <div className="text-xs text-muted mb-1">{formatAddress(biz.address)}</div>}
                  <p className="text-sm text-muted">{r.review_text}</p>
                  <div className="text-xs text-muted mt-2">
                    {r.author} {r.review_date ? `· ${new Date(r.review_date).toLocaleDateString()}` : ""}
                  </div>
                </div>
              );
            })}
          </div>
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
                {formatAddress(b.address)} {b.rating ? `· ★ ${b.rating}` : ""}
              </div>
              {b.phone && <div className="text-xs text-muted mt-0.5">📞 {b.phone}</div>}
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
  const [scanLogLookup, setScanLogLookup] = useState<Record<string, ScrapeLog>>({});
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

    // Recent activity drives both the compact list below AND which runs'
    // reviews get grouped into boxes - fetched first so the two always
    // agree on counts.
    const { data: logs } = await supabase
      .from("scrape_logs")
      .select("*")
      .order("ran_at", { ascending: false })
      .limit(8);
    const recentLogs = (logs ?? []) as ScrapeLog[];
    setActivity(recentLogs);

    const scanLookup: Record<string, ScrapeLog> = {};
    recentLogs.forEach((l) => {
      scanLookup[l.id] = l;
    });
    setScanLogLookup(scanLookup);

    // IMPORTANT: fetch every review belonging to these specific runs (by
    // scan_id), not just "the most recent 200 reviews by review_date".
    // review_date is when the review was posted on Google, not when it
    // was scraped - a "full rotation sweep" can surface hundreds of newly
    // found reviews that were posted months/years ago, and sorting by
    // review_date alone would bury most of a big run outside a small
    // limit, undercounting its negative reviews on screen.
    const scanIds = recentLogs.map((l) => l.id);
    let rev: Review[] = [];
    if (scanIds.length > 0) {
      const { data } = await supabase
        .from("reviews")
        .select("*")
        .in("scan_id", scanIds)
        .order("review_date", { ascending: false });
      rev = (data ?? []) as Review[];
    }
    setReviews(rev);

    const { data: log } = await supabase
      .from("scrape_logs")
      .select("ran_at")
      .eq("run_type", "monitor")
      .order("ran_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    setLastChecked(log?.ran_at ?? null);
  }

  async function checkNow() {
    setChecking(true);
    onStart();
    try {
      const res = await fetch("/api/check-now", { method: "POST" });
      const body = await res.json().catch(() => null);
      if (!res.ok || body?.ok === false) {
        alert(`Couldn't start the check: ${body?.error ?? `server returned ${res.status}`}`);
      }
    } catch (e) {
      alert(`Network error starting the check: ${e}`);
    }
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

  // Exports the negative reviews found by ONE specific run as a CSV -
  // positive reviews are deliberately excluded, this file is meant to be a
  // clean lead list the client can hand off / import elsewhere.
  const [exportingRunId, setExportingRunId] = useState<string | null>(null);

  async function downloadRunCsv(log: ScrapeLog, e?: MouseEvent) {
    e?.stopPropagation(); // don't also trigger the row's "open session" click
    setExportingRunId(log.id);
    try {
      const { data } = await supabase
        .from("reviews")
        .select("*")
        .eq("scan_id", log.id)
        .eq("is_negative", true)
        .order("review_date", { ascending: false });

      const negativeReviews = (data ?? []) as Review[];
      if (negativeReviews.length === 0) {
        alert("This run found no negative reviews - nothing to export.");
        return;
      }

      const header = [
        "Business Name",
        "Phone",
        "Email",
        "Address",
        "City",
        "Keyword",
        "Rating",
        "Review Text",
        "Author",
        "Review Date",
        "Google Maps Link",
      ];

      const rows = negativeReviews.map((r) => {
        const biz = businessLookup[r.business_id];
        return [
          biz?.name ?? "",
          biz?.phone ?? "",
          biz?.email ?? "",
          formatAddress(biz?.address),
          biz?.city ?? "",
          biz?.keyword ?? "",
          String(r.rating),
          r.review_text ?? "",
          r.author ?? "",
          r.review_date ? new Date(r.review_date).toLocaleDateString() : "",
          biz?.google_maps_url ?? "",
        ];
      });

      const csv = [header, ...rows].map((row) => row.map(csvEscape).join(",")).join("\r\n");
      // \uFEFF BOM so Excel opens it correctly instead of mangling special characters
      const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const dateStr = new Date(log.ran_at).toISOString().slice(0, 10);
      const label = runTypeLabel(log.run_type).replace(/\s+/g, "-").toLowerCase();
      a.href = url;
      a.download = `negative-reviews_${label}_${dateStr}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } finally {
      setExportingRunId(null);
    }
  }

  const shown = view === "negative" ? reviews.filter((r) => r.is_negative) : reviews;

  // Groups the loaded reviews by which run found them, newest run first,
  // so "new" and "previous" results never end up mixed in one flat list.
  // Reviews with no scan_id (older data from before runs were tracked)
  // fall into their own trailing group.
  type ReviewGroup = { scanId: string | null; log: ScrapeLog | null; reviews: Review[] };
  const groupedReviews: ReviewGroup[] = useMemo(() => {
    const map = new Map<string, ReviewGroup>();
    const unlinked: Review[] = [];
    for (const r of reviews) {
      if (!r.scan_id) {
        unlinked.push(r);
        continue;
      }
      if (!map.has(r.scan_id)) {
        map.set(r.scan_id, { scanId: r.scan_id, log: scanLogLookup[r.scan_id] ?? null, reviews: [] });
      }
      map.get(r.scan_id)!.reviews.push(r);
    }
    const groups = Array.from(map.values()).sort((a, b) => {
      const at = a.log?.ran_at ? new Date(a.log.ran_at).getTime() : 0;
      const bt = b.log?.ran_at ? new Date(b.log.ran_at).getTime() : 0;
      return bt - at;
    });
    if (unlinked.length > 0) {
      groups.push({ scanId: null, log: null, reviews: unlinked });
    }
    return groups;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviews, scanLogLookup]);

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
        {formatAddress(biz?.address) && <div className="text-xs text-muted mb-1">{formatAddress(biz.address)}</div>}
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
              <div
                key={log.id}
                className="w-full flex items-center justify-between text-sm py-2 px-2 -mx-2 rounded-lg border-b border-line last:border-0 hover:bg-brand-50"
              >
                <button
                  onClick={() => openActivity(log)}
                  className="flex items-center gap-2 min-w-0 flex-1 focus-ring text-left"
                >
                  <span
                    className={`w-2 h-2 rounded-full flex-shrink-0 ${
                      log.status === "failed" ? "bg-alert-500" : "bg-brand-500"
                    }`}
                  />
                  <span className="truncate">
                    {runTypeLabel(log.run_type)}
                    {log.keyword ? ` · ${log.keyword}` : ""}
                  </span>
                </button>
                <div className="flex items-center gap-3 text-xs text-muted whitespace-nowrap">
                  {log.status === "running" ? (
                    <span className="text-brand-600 font-medium">in progress…</span>
                  ) : log.status === "failed" ? (
                    <span className="text-alert-600 font-medium">failed</span>
                  ) : (
                    <button
                      onClick={() => openActivity(log)}
                      className="focus-ring"
                    >
                      {log.new_reviews_found} new
                      {log.negative_reviews_found > 0 && (
                        <span className="text-alert-600 font-medium"> · {log.negative_reviews_found} negative</span>
                      )}
                    </button>
                  )}
                  <span>{timeAgo(log.ran_at)}</span>
                  {log.run_type !== "discover" && log.negative_reviews_found > 0 && (
                    <button
                      onClick={(e) => downloadRunCsv(log, e)}
                      disabled={exportingRunId === log.id}
                      title="Download negative reviews as CSV"
                      className="w-7 h-7 flex-shrink-0 rounded-md flex items-center justify-center text-brand-600 hover:bg-brand-100 focus-ring disabled:opacity-50"
                    >
                      {exportingRunId === log.id ? "…" : "⬇"}
                    </button>
                  )}
                </div>
              </div>
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
                {timeAgo(sessionLog.ran_at)} · {sessionReviews.length} reviews found ·{" "}
                {sessionReviews.filter((r) => r.is_negative).length} negative
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={(e) => downloadRunCsv(sessionLog, e)}
                disabled={
                  exportingRunId === sessionLog.id ||
                  sessionReviews.filter((r) => r.is_negative).length === 0
                }
                className="text-sm font-semibold text-brand-600 hover:text-brand-500 focus-ring px-3 py-1.5 disabled:opacity-40"
              >
                {exportingRunId === sessionLog.id ? "Exporting…" : "⬇ Download CSV"}
              </button>
              <button
                onClick={closeSession}
                className="text-sm font-semibold text-muted hover:text-ink focus-ring px-3 py-1.5"
              >
                ✕ Back
              </button>
            </div>
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
                      {formatAddress(b.address)} {b.rating ? `· ★ ${b.rating}` : ""}
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
            <div className="space-y-5">
              {shown.length === 0 && (
                <div className="text-sm text-muted py-10 text-center">No reviews to show yet.</div>
              )}
              {groupedReviews.map((g) => {
                const groupShown = view === "negative" ? g.reviews.filter((r) => r.is_negative) : g.reviews;
                if (groupShown.length === 0) return null;
                return (
                  <div key={g.scanId ?? "unlinked"} className="space-y-3">
                    <div className="bg-brand-50 border border-brand-400 rounded-xl2 px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
                      <div>
                        <div className="text-sm font-semibold text-brand-600">
                          {g.log ? runTypeLabel(g.log.run_type) : "Earlier reviews"}
                        </div>
                        <div className="text-xs text-muted">
                          {g.log ? new Date(g.log.ran_at).toLocaleString() : "Run details unavailable"} ·{" "}
                          {groupShown.length} {view === "negative" ? "negative " : ""}
                          review{groupShown.length === 1 ? "" : "s"}
                        </div>
                      </div>
                      {g.log && g.log.run_type !== "discover" && (
                        <button
                          onClick={(e) => downloadRunCsv(g.log!, e)}
                          disabled={exportingRunId === g.log.id}
                          className="text-sm font-semibold text-brand-600 hover:text-brand-500 focus-ring px-3 py-1.5 disabled:opacity-50"
                        >
                          {exportingRunId === g.log.id ? "Exporting…" : "⬇ Download CSV"}
                        </button>
                      )}
                    </div>
                    <div className="grid gap-3 pl-1">{groupShown.map(reviewCard)}</div>
                  </div>
                );
              })}
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
