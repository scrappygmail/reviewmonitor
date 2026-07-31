"use client";

import { useEffect, useState } from "react";
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
};

export default function Dashboard() {
  const [tab, setTab] = useState<"discover" | "mine">("mine");

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

        <div className="mt-6 pb-16">
          {tab === "discover" ? <DiscoverTab /> : <MyBusinessesTab />}
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
// Discover tab
// ---------------------------------------------------------------------------

function DiscoverTab() {
  const [keyword, setKeyword] = useState("");
  const [city, setCity] = useState("");
  const [savedKeywords, setSavedKeywords] = useState<string[]>([]);
  const [activeKeyword, setActiveKeyword] = useState<string | null>(null);
  const [results, setResults] = useState<Business[]>([]);
  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    loadSavedKeywords();
  }, []);

  async function loadSavedKeywords() {
    const { data } = await supabase.from("businesses").select("keyword");
    const unique = Array.from(new Set((data ?? []).map((r) => r.keyword)));
    setSavedKeywords(unique);
  }

  async function runDiscovery() {
    if (!keyword || !city) return;
    setLoading(true);
    await fetch("/api/discover", {
      method: "POST",
      body: JSON.stringify({ keyword, city }),
    });
    // Discovery runs as a background GitHub Action — poll for results.
    await pollForResults(keyword);
    setLoading(false);
  }

  async function pollForResults(kw: string) {
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 15000));
      const { data } = await supabase.from("businesses").select("*").eq("keyword", kw);
      if (data && data.length > 0) {
        setResults(data as Business[]);
        loadSavedKeywords();
        return;
      }
    }
  }

  async function loadKeywordList(kw: string) {
    setActiveKeyword(kw);
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
    setScanning(true);
    await fetch("/api/profession-scan", {
      method: "POST",
      body: JSON.stringify({ keyword: kw }),
    });
    setScanning(false);
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
            disabled={loading}
            className="bg-brand-500 hover:bg-brand-600 text-white font-semibold text-sm rounded-lg px-5 py-2.5 focus-ring disabled:opacity-50"
          >
            {loading ? "Searching…" : "Search"}
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
          <span className="text-sm text-muted">
            {results.length} results for <strong className="text-ink">{activeKeyword}</strong>
          </span>
          <button
            onClick={() => runProfessionScan(activeKeyword)}
            disabled={scanning}
            className="text-sm font-semibold text-brand-600 hover:text-brand-500 focus-ring disabled:opacity-50"
          >
            {scanning ? "Scanning reviews…" : "Scan all reviews for negatives →"}
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

function MyBusinessesTab() {
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [checking, setChecking] = useState(false);
  const [lastChecked, setLastChecked] = useState<string | null>(null);
  const [view, setView] = useState<"negative" | "all" | "businesses">("negative");
  const [removingId, setRemovingId] = useState<string | null>(null);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    const { data: biz } = await supabase.from("businesses").select("*").eq("monitored", true);
    setBusinesses((biz ?? []) as Business[]);

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
  }

  async function checkNow() {
    setChecking(true);
    await fetch("/api/check-now", { method: "POST" });
    await load();
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

  const businessName = (id: string) => businesses.find((b) => b.id === id)?.name ?? "Unknown";
  const shown = view === "negative" ? reviews.filter((r) => r.is_negative) : reviews;

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
          {checking ? "Checking…" : "Check now"}
        </button>
      </div>

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
        {shown.map((r) => (
          <div key={r.id} className="bg-surface border border-line rounded-xl2 p-4 shadow-card">
            <div className="flex items-center justify-between mb-1">
              <span className="font-semibold text-sm">{businessName(r.business_id)}</span>
              <RatingBadge rating={r.rating} />
            </div>
            <p className="text-sm text-muted">{r.review_text}</p>
            <div className="text-xs text-muted mt-2">
              {r.author} {r.review_date ? `· ${new Date(r.review_date).toLocaleDateString()}` : ""}
            </div>
          </div>
        ))}
      </div>
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
