"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import Script from "next/script";
import { Button } from "@/components/ui/button";
import { ATTRIBUTION_COOKIE, CONSENT_STORAGE, SESSION_STORAGE, VISIT_COOKIE, parseMarketingConsent, type MarketingConsent } from "@/lib/marketing-consent";

function snapshot() {
  try { return localStorage.getItem(CONSENT_STORAGE); } catch { return null; }
}
function clearTracking() {
  document.cookie = `${VISIT_COOKIE}=; Path=/; Secure; SameSite=Lax; Max-Age=0`;
  document.cookie = `${ATTRIBUTION_COOKIE}=; Path=/; Secure; SameSite=Lax; Max-Age=0`;
  for (const part of document.cookie.split(";")) {
    const name = part.trim().split("=")[0];
    if (name && /^(_ga|_gid|_gat|_gcl|_tw)/.test(name)) {
      for (const domain of ["", `; Domain=${location.hostname}`, "; Domain=.octopus-review.ai"]) {
        document.cookie = `${name}=; Path=/; Max-Age=0${domain}`;
      }
    }
  }
  try { sessionStorage.removeItem(SESSION_STORAGE); } catch { /* Storage may be disabled. */ }
}
function subscribe(listener: () => void) {
  const storage = (event: StorageEvent) => {
    if (event.key !== CONSENT_STORAGE) return;
    const consent = parseMarketingConsent(event.newValue);
    if (!consent?.analytics || !consent?.attribution) {
      clearTracking();
      window.location.reload();
    }
    listener();
  };
  window.addEventListener("storage", storage);
  window.addEventListener("octopus-consent", listener);
  return () => { window.removeEventListener("storage", storage); window.removeEventListener("octopus-consent", listener); };
}

export function MarketingConsentControls() {
  const saved = useSyncExternalStore(subscribe, snapshot, () => null);
  const consent = parseMarketingConsent(saved);
  const [open, setOpen] = useState(false);
  const [analytics, setAnalytics] = useState(false);
  const [attribution, setAttribution] = useState(false);
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const analyticsGranted = consent?.analytics === true;
  const attributionGranted = consent?.attribution === true;
  const hosted = typeof window !== "undefined" && window.location.origin === "https://octopus-review.ai";

  useEffect(() => {
    if (!analyticsGranted) return;
    const controller = new AbortController();
    void (async () => { try {
      const activation = await fetch("/api/marketing/visit", { credentials: "omit", cache: "no-store", signal: controller.signal });
      if (!activation.ok || (await activation.json()).enabled !== true || controller.signal.aborted) return;
      if (attributionGranted) document.cookie = `${ATTRIBUTION_COOKIE}=granted; Path=/; Secure; SameSite=Lax; Max-Age=2592000`;
      let sessionId = sessionStorage.getItem(SESSION_STORAGE);
      if (!sessionId) { sessionId = crypto.randomUUID(); sessionStorage.setItem(SESSION_STORAGE, sessionId); }
      const campaignLinkId = attributionGranted ? new URLSearchParams(search).get("uads_link") : null;
      void fetch("/api/marketing/visit", { method: "POST", credentials: "same-origin", referrerPolicy: "no-referrer",
        headers: { "Content-Type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ analyticsConsent: true, attributionConsent: attributionGranted, sessionId, ...(campaignLinkId ? { campaignLinkId } : {}) }),
      }).catch(() => { /* Collection failure must not interrupt the product. */ });
    } catch { /* No storage or activation proof means no collection. */ } })();
    return () => controller.abort();
  }, [analyticsGranted, attributionGranted, pathname, search]);

  function save(next: MarketingConsent) {
    const changed = consent !== null && (analyticsGranted !== next.analytics || attributionGranted !== next.attribution);
    if (!next.analytics || !next.attribution) clearTracking();
    try { localStorage.setItem(CONSENT_STORAGE, JSON.stringify(next)); } catch { clearTracking(); return; }
    window.dispatchEvent(new Event("octopus-consent"));
    setOpen(false);
    // Reload unloads already-running third-party scripts as well as our capture effect.
    if (changed) window.location.reload();
  }

  return <>
    {hosted && analyticsGranted && <>
      <Script src="https://www.googletagmanager.com/gtag/js?id=G-BNFCHLD0BY" strategy="afterInteractive" />
      <Script id="google-analytics" strategy="afterInteractive">{`window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('consent','default',{analytics_storage:'granted',ad_storage:'${attributionGranted ? 'granted' : 'denied'}',ad_user_data:'${attributionGranted ? 'granted' : 'denied'}',ad_personalization:'denied'});gtag('set','ads_data_redaction',true);gtag('js',new Date());gtag('config','G-BNFCHLD0BY',{allow_google_signals:false,allow_ad_personalization_signals:false});`}</Script>
    </>}
    {hosted && attributionGranted && <Script id="twitter-pixel" strategy="afterInteractive">{`!function(e,t,n,s,u,a){e.twq||(s=e.twq=function(){s.exe?s.exe.apply(s,arguments):s.queue.push(arguments);},s.version='1.1',s.queue=[],u=t.createElement(n),u.async=!0,u.src='https://static.ads-twitter.com/uwt.js',a=t.getElementsByTagName(n)[0],a.parentNode.insertBefore(u,a))}(window,document,'script');twq('config','rc11o');`}</Script>}
    {(!consent || open) ? <section aria-label="Privacy choices" className="fixed inset-x-3 bottom-3 z-50 mx-auto max-w-lg rounded-xl border bg-background p-5 text-foreground shadow-lg">
      <h2 className="text-base font-semibold">Your privacy choices</h2>
      <p className="mt-2 text-sm text-muted-foreground">Essential cookies keep you signed in. You can separately allow usage analytics and advertising measurement, and change your choices at any time.</p>
      <label className="mt-4 flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1" checked={analytics} onChange={e => setAnalytics(e.target.checked)} />
        <span><strong className="font-medium">Usage analytics</strong><br />Help us understand visits and improve Octopus.</span></label>
      <label className="mt-3 flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1" checked={attribution} onChange={e => setAttribution(e.target.checked)} />
        <span><strong className="font-medium">Advertising measurement</strong><br />Connect visits to signups and purchases, and allow our advertising pixel.</span></label>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => save({ analytics: false, attribution: false })}>Reject optional</Button>
        <Button onClick={() => save({ analytics, attribution })}>Save choices</Button>
      </div>
      <a href="/docs/privacy" className="mt-3 inline-block text-xs underline">Privacy policy</a>
    </section> : <button type="button" className="fixed bottom-2 left-3 z-40 rounded border bg-background px-2 py-1 text-xs text-muted-foreground" onClick={() => {
      setAnalytics(consent.analytics); setAttribution(consent.attribution); setOpen(true);
    }}>Privacy choices</button>}
  </>;
}
