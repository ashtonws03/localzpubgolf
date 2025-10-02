import { collection, doc, addDoc, setDoc, getDocs, deleteDoc, writeBatch, query, orderBy, onSnapshot, serverTimestamp, documentId } from "firebase/firestore";
import { db } from "./firebase";
import React, { useEffect, useMemo, useState, useRef } from "react";

/**
 * Self-contained Sportsbet-style Bet Builder
 * ------------------------------------------------------------
 * Framework-agnostic React (no external UI deps).
 *
 * Features:
 * - Access gate (code LOCALZPG25) + name/email + logout
 * - Admin PIN (2855) via in-app modal (no window.prompt) + toggle off
 * - Admin-only: edit title; CRUD markets/legs; settle legs
 * - Users: select legs, Singles/Multi, $200 max payout enforced
 * - Per-user "My Bets" via localStorage identity (name|email)
 * - Colour scheme: blue #0a58ff, yellow #ffd200
 * - Large, readable inputs for admin editing (incl. decimal odds)
 */

// -------------------- Constants & Helpers --------------------
const MAX_PAYOUT = 200;
const ACCESS_CODE = "LOCALZPG25";
const ADMIN_PIN = "2855";
const PRIMARY_BLUE = "#0a58ff";
const ACCENT_YELLOW = "#ffd200";
const LIGHT_BLUE_BG = "#e6f0ff";     // stronger light blue (Sportsbet vibe)
const LIGHT_YELLOW_BG = "#ffd200";   // solid yellow for small betslip
const NAVY_TEXT = "#002147";         // deep navy for headings in tinted areas
// -------------------- Constants & Helpers --------------------
const PUBGOLF_GOLD = "#d4af37";
const PUBGOLF_BLACK = "#0b0b0b";
const PUBGOLF_PAPER = "#111316";
const ROUND_ID = "cairns2025";

const LS_PAGE = "betbuilder_current_page_v1";

const uid = () => Math.random().toString(36).slice(2, 9);
const clamp2 = (n) => (Number.isFinite(n) ? Number(n.toFixed(2)) : 0);
const multiplyOdds = (odds) => clamp2(odds.reduce((a, v) => a * (v || 1), 1));
const payoutFrom = (stake, odds) => clamp2((stake || 0) * (odds || 1));
const stakeCapForOdds = (odds) => clamp2(Math.max(0, Math.floor((MAX_PAYOUT / Math.max(odds, 1.0000001)) * 100) / 100));
const makeUserKey = (name = "", email = "") => `${name}`.trim().toLowerCase() + "|" + `${email}`.trim().toLowerCase();
const formatPlacedAt = (ts) => {
  // Handles both Firestore Timestamp and legacy number
  if (ts && typeof ts.toDate === "function") return ts.toDate().toLocaleString();
  if (typeof ts === "number") return new Date(ts).toLocaleString();
  return "—";
};

// Storage keys
const LS_BETSLIP = "betbuilder_betslip_v2";
const LS_USER = "betbuilder_user_v2";
const LS_ADMIN = "betbuilder_admin_v2";
const LS_MARKET_STATE = "betbuilder_market_open_v1";

// Minimal toast fallback
const toast = {
  success: (m) => { try { console.info(m); } catch {} },
  error: (m) => { try { console.error(m); alert(m); } catch {} },
  info: (m) => { try { console.log(m); } catch {} },
};

const defaultConfig = {
  eventTitle: "Demo Match: Sydney vs Melbourne",
  markets: [
    {
      id: uid(),
      name: "Match Result",
      active: true,
      legs: [
        { id: uid(), label: "Sydney Win", odds: 1.85, active: true, result: "pending" },
        { id: uid(), label: "Melbourne Win", odds: 2.05, active: true, result: "pending" },
        { id: uid(), label: "Draw", odds: 26.0, active: true, result: "pending" },
      ],
    },
    {
      id: uid(),
      name: "Total Points",
      active: true,
      legs: [
        { id: uid(), label: "Over 38.5", odds: 1.9, active: true, result: "pending" },
        { id: uid(), label: "Under 38.5", odds: 1.9, active: true, result: "pending" },
      ],
    },
    {
      id: uid(),
      name: "Anytime Tryscorer",
      active: true,
      legs: [
        { id: uid(), label: "Player A", odds: 2.4, active: true, result: "pending" },
        { id: uid(), label: "Player B", odds: 3.1, active: true, result: "pending" },
        { id: uid(), label: "Player C", odds: 4.5, active: true, result: "pending" },
      ],
    },
  ],
};

// -------------------- Primitive UI helpers --------------------
const Row = ({ className = "", children }) => (
  <div className={`flex items-center ${className}`}>{children}</div>
);
const Col = ({ className = "", children }) => (
  <div className={`flex flex-col ${className}`}>{children}</div>
);
const Card = ({ className = "", children, variant = "default", style }) => {
  const chrome =
    variant === "plain"
      ? "rounded-2xl"                     // no border, no white bg, no shadow
      : "rounded-2xl border bg-white shadow-sm";
  return (
    <div className={`${chrome} ${className}`} style={style}>
      {children}
    </div>
  );
};
const CardContent = ({ className = "", children }) => (
  <div className={`p-4 ${className}`}>{children}</div>
);
const Button = ({
  className = "",
  variant = "default",
  size = "md",
  type = "button",
  ...props
}) => {
  const base =
    "inline-flex items-center justify-center rounded-xl font-medium " +
    "transition-colors transition-transform shadow-sm " +
    "focus:outline-none focus:ring-2 focus:ring-[#0a58ff]/30 " +
    "active:translate-y-[1px] active:scale-[.98] active:opacity-90 " +
    "disabled:opacity-60 disabled:cursor-not-allowed px-4";

  const sizes = {
    sm: "h-9 text-sm px-3",
    md: "h-11",
    lg: "h-12 text-lg",
  };

  const variants = {
    default: "bg-black text-white hover:opacity-90 active:opacity-80",
    outline: "border bg-white hover:bg-neutral-50 active:bg-neutral-100",
    ghost: "bg-transparent hover:bg-neutral-100 active:bg-neutral-200",
    destructive: "bg-red-600 text-white hover:bg-red-700 active:bg-red-800",
  };

  return (
    <button
      type={type}
      className={`${base} ${sizes[size]} ${variants[variant]} ${className}`}
      {...props}
    />
  );
};
const Input = React.forwardRef((props, ref) => <input ref={ref} {...props} className={`h-11 px-3 rounded-xl border w-full ${props.className || ""}`} />);
const Label = ({ children, className = "" }) => <label className={`text-sm text-neutral-700 ${className}`}>{children}</label>;
const Badge = ({ children, className = "" }) => (
  <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${className}`}>{children}</span>
);
const Separator = ({ className = "" }) => <hr className={`border-neutral-200 ${className}`} />;

// -------------------- Main App --------------------
export default function BetBuilderApp() {
  // Access state
const [authed, setAuthed] = useState(() => {
  try { return JSON.parse(localStorage.getItem(LS_USER) || "{}").authed || false; } catch { return false; }
});
const [userName, setUserName] = useState(() => {
  try { return JSON.parse(localStorage.getItem(LS_USER) || "{}").name || ""; } catch { return ""; }
});
const [userEmail, setUserEmail] = useState(() => {
  try { return JSON.parse(localStorage.getItem(LS_USER) || "{}").email || ""; } catch { return ""; }
});
const [teamName, setTeamName] = useState(() => {
  try { return JSON.parse(localStorage.getItem(LS_USER) || "{}").teamName || ""; } catch { return ""; }
});
const [accessCode, setAccessCode] = useState("");

// “page” switcher: "bet" | "golf"
const [page, setPage] = useState(() => {
  try { return localStorage.getItem(LS_PAGE) || "bet"; } catch { return "bet"; }
});
useEffect(() => {
  try { localStorage.setItem(LS_PAGE, page); } catch {}
}, [page]);

const userKey = useMemo(() => makeUserKey(userName, userEmail), [userName, userEmail]);

  // Admin
  const [isAdmin, setIsAdmin] = useState(() => {
    try { return localStorage.getItem(LS_ADMIN) === "1"; } catch { return false; }
  });
  const [showAdminModal, setShowAdminModal] = useState(false);
  const [adminPinInput, setAdminPinInput] = useState("");
  const pinInputRef = useRef(null);
  // Slide-out menu (top-right)
const [menuOpen, setMenuOpen] = useState(false);

// --- STATE ---
// Config state (markets/legs) — synced with Firestore
const [config, setConfig] = useState(defaultConfig);

// Bets (local init; Firestore subscription will overwrite after first snapshot)
const [bets, setBets] = useState([]);

// Betslip (which legs are currently selected by the player)
const [slip, setSlip] = useState(() => {
  try { 
    return JSON.parse(localStorage.getItem(LS_BETSLIP) || "[]"); 
  } catch { 
    return []; 
  }
});

// --- EFFECTS ---
// Subscribe to Firestore for live config updates (REPLACES old LS_KEY effect)
useEffect(() => {
  const configRef = doc(db, "config", "current");
  const unsubscribe = onSnapshot(configRef, (docSnap) => {
    if (docSnap.exists()) {
      setConfig(docSnap.data());
    } else {
      // If no config exists yet, create one
      setDoc(configRef, defaultConfig);
    }
  });
  return () => unsubscribe();
}, []);

useEffect(() => {
  try { localStorage.removeItem("betbuilder_config_v2"); } catch {}
}, []);

// Persist the current local betslip so user's selections survive refresh
useEffect(() => {
  localStorage.setItem(LS_BETSLIP, JSON.stringify(slip));
}, [slip]);

// Live-stream ALL bets from Firestore for Admin + players' "My Bets"
useEffect(() => {
  const q = query(
  collection(db, "bets"),
  orderBy("placedAt", "desc"),
  orderBy(documentId(), "desc") // tie-breaker for equal/pending timestamps
);
  const unsubscribe = onSnapshot(q, (snapshot) => {
    const allBets = snapshot.docs.map(d => ({ ...d.data(), id: d.id }));
    setBets(allBets);
  });
  return () => unsubscribe();
}, []);

// -------------------- Pub Golf state --------------------
const defaultHoles = Array.from({ length: 9 }, (_, i) => ({
  id: `h${i+1}`,
  name: `Hole ${i+1}`,
  active: true,
}));

const [golfConfig, setGolfConfig] = useState({ title: "Pub Golf 2025: Cairns", holes: defaultHoles });
const [golfScores, setGolfScores] = useState([]);

// Round config (golf_rounds/{ROUND_ID})
useEffect(() => {
  const roundRef = doc(db, "golf_rounds", ROUND_ID);
  const unsub = onSnapshot(roundRef, (snap) => {
    if (snap.exists()) {
      const data = snap.data();
      setGolfConfig({
        title: data.title || "Pub Golf 2025: Cairns",
        holes: Array.isArray(data.holes) && data.holes.length ? data.holes : defaultHoles
      });
    } else {
      setDoc(roundRef, { title: "Pub Golf 2025: Cairns", holes: defaultHoles });
    }
  });
  return () => unsub();
}, []);

// Scores for this round (golf_scores, filtered in-state by roundId)
useEffect(() => {
  const qScores = query(collection(db, "golf_scores"), orderBy("updatedAt", "desc"));
  const unsub = onSnapshot(qScores, (snap) => {
    const all = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(x => x.roundId === ROUND_ID);
    setGolfScores(all);
  });
  return () => unsub();
}, []);

// Persist the logged-in gate info (access code passed, name/email/team)
useEffect(() => {
  localStorage.setItem(LS_USER, JSON.stringify({ authed, name: userName, email: userEmail, teamName }));
}, [authed, userName, userEmail, teamName]);

// Focus the PIN input when admin modal opens
useEffect(() => {
  if (showAdminModal && pinInputRef.current) {
    pinInputRef.current.focus();
  }
}, [showAdminModal]);

// --- ADMIN: Bets maintenance (no Auth; PIN-gated UI only) ---
const deleteBet = async (betId) => {
  try {
    if (!isAdmin) return;
    await deleteDoc(doc(db, "bets", betId));
    toast.success("Bet deleted");
  } catch (e) {
    console.error(e);
    toast.error("Failed to delete bet");
  }
};

const clearAllBets = async () => {
  try {
    if (!isAdmin) return;
    const ok = window.confirm("This will permanently delete ALL bets. Continue?");
    if (!ok) return;
    const snap = await getDocs(collection(db, "bets"));
    const batch = writeBatch(db);
    snap.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    toast.success("All bets cleared");
  } catch (e) {
    console.error(e);
    toast.error("Failed to clear bets");
  }
};

const archiveAndClearAllBets = async () => {
  try {
    if (!isAdmin) return;
    const ok = window.confirm("Archive all bets to 'bets_archive' and clear current bets?");
    if (!ok) return;
    const snap = await getDocs(collection(db, "bets"));
    const batch = writeBatch(db);
    snap.forEach((d) => {
      // copy to bets_archive with the same id, then delete original
      batch.set(doc(db, "bets_archive", d.id), d.data());
      batch.delete(d.ref);
    });
    await batch.commit();
    toast.success("Bets archived and cleared");
  } catch (e) {
    console.error(e);
    toast.error("Failed to archive & clear");
  }
};

// Reset all legs in every market to "pending"
const resetAllLegsToPending = async () => {
  try {
    if (!isAdmin) return;

    const newConfig = {
      ...config,
      markets: (config.markets || []).map((m) => ({
        ...m,
        legs: (m.legs || []).map((l) => ({ ...l, result: "pending" })),
      })),
    };

    // Update local state so UI reflects immediately
    setConfig(newConfig);

    // Persist to Firestore so everyone sees the change
    await setDoc(doc(db, "config", "current"), newConfig);

    toast.success("All legs have been reset to pending");
  } catch (e) {
    console.error(e);
    toast.error("Failed to reset legs");
  }
};

// Manual admin save/refresh helpers
const [saving, setSaving] = useState(false);
const [lastSavedAt, setLastSavedAt] = useState(null);

const forceSave = async () => {
  try {
    setSaving(true);
    await setDoc(doc(db, "config", "current"), config); // push current config
    setLastSavedAt(Date.now());
    toast.success("Config saved to cloud");
  } catch (e) {
    console.error(e);
    toast.error("Failed to save to cloud");
  } finally {
    setSaving(false);
  }
};

const refreshFromCloud = () => {
  // onSnapshot already keeps you live; this button is a visible "pull" action.
  toast.info("Fetching latest config from cloud…");
};

  // Tabs
  const [tab, setTab] = useState("builder"); // builder | slip | admin

  // Derived
  const flatLegs = useMemo(
    () => config.markets.flatMap((m) => m.legs.map((l) => ({ ...l, marketId: m.id, marketName: m.name, marketActive: m.active !== false }))),
    [config]
  );
  const selectedLegs = flatLegs.filter((l) => slip.includes(l.id) && l.active !== false && l.marketActive);
  
  // Map of legId -> current result ("won" | "lost" | "pending") so BetSlip can live-read status
  const legResultMap = useMemo(
    () => Object.fromEntries(flatLegs.map(l => [l.id, l.result || "pending"])),
    [flatLegs]
  );

  // Betslip math
  const [mode, setMode] = useState("multi"); // 'multi' | 'singles'
  const [singleStakes, setSingleStakes] = useState({});
  const [multiStake, setMultiStake] = useState(10);

  const singleCaps = useMemo(() => Object.fromEntries(selectedLegs.map((l) => [l.id, stakeCapForOdds(l.odds)])), [selectedLegs]);
  const totalOdds = useMemo(() => multiplyOdds(selectedLegs.map((l) => l.odds)), [selectedLegs]);
  const multiCap = useMemo(() => stakeCapForOdds(totalOdds || 1), [totalOdds]);
  const clampedMultiStake = Math.min(multiStake, multiCap);

  // NOTE: parent-level totals (BetSlip computes its own too)
  const totalSinglesStake = selectedLegs.reduce((acc, l) => acc + Math.min(singleStakes[l.id] || 0, singleCaps[l.id] || 0), 0);
  const totalSinglesPayout = selectedLegs.reduce((acc, l) => acc + payoutFrom(Math.min(singleStakes[l.id] || 0, singleCaps[l.id] || 0), l.odds), 0);

  // Admin: market editing
// Add a new market
const addMarket = () => {
  const newConfig = {
    ...config,
    markets: [
      ...config.markets,
      { id: uid(), name: "New Market", active: true, legs: [] },
    ],
  };
  setConfig(newConfig);
};

// Remove a market
const removeMarket = (marketId) => {
  const newConfig = {
    ...config,
    markets: config.markets.filter((m) => m.id !== marketId),
  };
  setConfig(newConfig);
};

// Update a market (rename, toggle active, etc.)
const updateMarket = (marketId, patch) => {
  const newConfig = {
    ...config,
    markets: config.markets.map((m) =>
      m.id === marketId ? { ...m, ...patch } : m
    ),
  };
  setConfig(newConfig);
};

// Add a leg to a market
const addLeg = (marketId) => {
  const newConfig = {
    ...config,
    markets: config.markets.map((m) =>
      m.id === marketId
        ? {
            ...m,
            legs: [
              ...m.legs,
              { id: uid(), label: "New Leg", odds: 2.0, active: true, result: "pending" },
            ],
          }
        : m
    ),
  };
  setConfig(newConfig);
};

// Remove a leg
const removeLeg = (marketId, legId) => {
  const newConfig = {
    ...config,
    markets: config.markets.map((m) =>
      m.id === marketId
        ? { ...m, legs: m.legs.filter((l) => l.id !== legId) }
        : m
    ),
  };
  setConfig(newConfig);
  setSlip((ids) => ids.filter((id) => id !== legId));
};

// Update a leg (label, odds, status)
const updateLeg = (marketId, legId, patch) => {
  const newConfig = {
    ...config,
    markets: config.markets.map((m) =>
      m.id === marketId
        ? {
            ...m,
            legs: m.legs.map((l) =>
              l.id === legId ? { ...l, ...patch } : l
            ),
          }
        : m
    ),
  };
  setConfig(newConfig);
};

  // Place bet
  const placeBet = async () => {
  if (!authed || !userName) {
    toast.error("Enter access code & your name first");
    return;
  }
  if (selectedLegs.length === 0) {
    toast.error("Add some legs first");
    return;
  }

  const legsSnap = selectedLegs.map((l) => ({
    legId: l.id,
    label: l.label,
    marketName: l.marketName,
    odds: l.odds,
  }));

  const betRecord = {
    userName,
    userEmail,
    userKey,
    legs: legsSnap,
    placedAt: serverTimestamp(),
    mode,
    ...(mode === "multi"
      ? { multiStake: clamp2(multiStake) }
      : { stakesByLeg: singleStakes }),
  };

  try {
  await addDoc(collection(db, "bets"), betRecord);
  toast.success("Bet saved to cloud!");

  // Clear the slip after a successful bet
  setSlip([]);
  setSingleStakes({});
  setMultiStake(10);
  try { localStorage.removeItem(LS_BETSLIP); } catch {}
  // Optional: jump to the slip tab to show the empty/confirmation state
  // setTab("slip");
} catch (e) {
  console.error("Error adding bet:", e);
  toast.error("Failed to save bet");
}
};

  // Leg result lookup and settlement
  const legResult = (legId) => flatLegs.find((l) => l.id === legId)?.result || "pending";
  const settleBet = (bet) => {
    if (bet.mode === "multi") {
      const odds = multiplyOdds(bet.legs.map((l) => l.odds));
      const stake = bet.multiStake || 0;
      const anyLost = bet.legs.some((l) => legResult(l.legId) === "lost");
      const allWon = bet.legs.every((l) => legResult(l.legId) === "won");
      const status = anyLost ? "Lost" : allWon ? "Won" : "Pending";
      return { status, potentialPayout: payoutFrom(stake, odds) };
    } else {
      const legs = bet.legs.filter((l) => (bet.stakesByLeg || {})[l.legId] > 0);
      const anyPending = legs.some((l) => legResult(l.legId) === "pending");
      const anyLost = legs.some((l) => legResult(l.legId) === "lost");
      const anyWon = legs.some((l) => legResult(l.legId) === "won");
      const status = anyPending ? "Pending" : (anyLost && anyWon) ? "Mixed" : anyLost ? "Lost" : anyWon ? "Won" : "Pending";
      const potential = legs.reduce((acc, l) => acc + payoutFrom((bet.stakesByLeg || {})[l.legId] || 0, l.odds), 0);
      return { status, potentialPayout: potential };
    }
  };

  // --- Access Gate ---
  if (!authed) {
    return (
      <div className="min-h-screen bg-neutral-50 p-4 md:p-8 flex items-center justify-center">
        <Card className="w-full max-w-md">
          <CardContent className="space-y-4">
            <Row className="gap-2"><span className="text-xl font-semibold">Restricted Access</span></Row>
            <p className="text-sm text-neutral-600">Enter the access code to continue. Add your name (and optional email) so the admin can identify your bets.</p>
            <Col className="gap-3">
              <Col>
                <Label>Access code</Label>
                <Input value={accessCode} onChange={(e) => setAccessCode(e.target.value)} placeholder="Enter code" />
              </Col>
              <Col>
                <Label>Name (required)</Label>
                <Input value={userName} onChange={(e) => setUserName(e.target.value)} placeholder="Your name" />
              </Col>
              <Col>
                <Label>Email (optional)</Label>
                <Input value={userEmail} onChange={(e) => setUserEmail(e.target.value)} placeholder="you@example.com" />
              </Col>
              <Col>
  <Label>Team name (required, case sensitive)</Label>
  <Input value={teamName} onChange={(e) => setTeamName(e.target.value)} placeholder="Exact team name" />
</Col>
              <Button
  style={{ background: PRIMARY_BLUE, color: "white" }}
  onClick={() => {
    if (accessCode !== ACCESS_CODE) { toast.error("Incorrect access code"); return; }
    if (!userName.trim()) { toast.error("Please enter your name"); return; }
    if (!teamName.trim()) { toast.error("Enter your exact team name"); return; }
    setAuthed(true);
    toast.success("Welcome");
  }}
>Enter</Button>
              <p className="text-[11px] text-neutral-500">Demo only — no real betting or payments. Data stored locally.</p>
            </Col>
          </CardContent>
        </Card>
      </div>
    );
  }

// --- Main UI ---
if (page === "golf") {
  return (
    <PubGolfPage
      golfConfig={golfConfig}
      teamName={teamName}
      userName={userName}
      scores={golfScores}
    />
  );
}

// else: original Bet Builder page continues as-is:
return (
  <div className="min-h-screen bg-neutral-50 p-4 md:p-8">
    <div className="mx-auto max-w-6xl relative z-0">
      {/* Header with in-flow handle (scrolls away like the title) */}
<div className="relative mb-4 z-40">
  <Row className="justify-between gap-4 pr-14"> {/* pr to give the handle room */}
    <h1 className="text-2xl md:text-3xl font-bold">
      Bet Builder · <span className="text-neutral-500">{config.eventTitle}</span>
    </h1>
  </Row>

  {/* Handle sits in the header, absolutely positioned; it will scroll away with the header.
      Because tabs are sticky (z-50), they will naturally cover this as you scroll. */}
  <button
    aria-label={menuOpen ? "Close menu" : "Open menu"}
    title={menuOpen ? "Close menu" : "Open menu"}
    onClick={() => setMenuOpen((v) => !v)}
    className="
      absolute right-0 top-0
      w-11 h-12
      rounded-l-full rounded-r-none
      flex items-center justify-center
      shadow-md
      z-40
    "
    style={{
      background: PRIMARY_BLUE,
      color: "white",
      border: "none",
    }}
  >
    <span className="w-8 h-8 rounded-full bg-white flex items-center justify-center">
      {menuOpen ? (
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="#0a58ff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 6l6 6-6 6" />
        </svg>
      ) : (
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="#0a58ff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M15 18l-6-6 6-6" />
        </svg>
      )}
    </span>
  </button>
</div>
      {/* Sentinel that is visible only when we are at the top.
    When this scrolls out of view, we hide the handle. */}
      
{/* Slide-out side menu + attached top-right handle (animated, “backwards D” tab) */}
<div className="fixed inset-0 z-[120] pointer-events-none">
  {/* Backdrop (fade + click to close) */}
  <div
    className={`absolute inset-0 transition-opacity duration-300 ease-out ${
      menuOpen ? "opacity-100 pointer-events-auto bg-black/40" : "opacity-0"
    }`}
    onClick={() => setMenuOpen(false)}
  />

  {/* === Sliding panel (fully hidden when closed) === */}
  <div
    className="fixed top-0 right-0 h-full pointer-events-auto z-[125]"
    style={{
      width: "min(90vw, 20rem)",
      transform: menuOpen ? "translateX(0)" : "translateX(100%)",
      transition: "transform 300ms ease-in-out",
    }}
    role="dialog"
    aria-label="User menu"
  >
    {/* Panel surface (no black edge line) */}
    <div
      className="h-full shadow-xl"
      style={{
        background: LIGHT_BLUE_BG,
        borderLeft: "none",
      }}
    >
      {/* Header strip: same height as handle; aligned at top */}
      <div
  className="flex items-center justify-between h-12 px-3"
  style={{ background: PRIMARY_BLUE, color: "white" }}
>
  <div className="text-sm font-semibold">Menu</div>

  {/* Close button (same look as the handle) */}
  <button
    aria-label="Close menu"
    title="Close"
    onClick={() => setMenuOpen(false)}
    className="
      inline-flex items-center justify-center
      w-9 h-9 rounded-full
      shadow-sm
      focus:outline-none focus:ring-2 focus:ring-white/40
      hover:opacity-90 active:opacity-80
    "
    style={{ background: "white" }}
  >
    {/* Right-facing chevron (same as handle when open) */}
    <svg
      className="w-4 h-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke={PRIMARY_BLUE}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  </button>
</div>

      {/* Panel body */}
      <div className="p-4 space-y-4">
        {/* Page switcher */}
<Button
  className="w-full shadow-sm"
  style={{ background: page === "golf" ? PRIMARY_BLUE : PUBGOLF_GOLD, color: page === "golf" ? "white" : "black" }}
  onClick={() => { setPage(page === "golf" ? "bet" : "golf"); setMenuOpen(false); }}
>
  {page === "golf" ? "Back to Bet Builder" : "Go to Pub Golf 2025"}
</Button>
        <div className="text-xs text-neutral-700">
          Signed in as{" "}
          <strong className="text-[#0a58ff]">{userName || "—"}</strong>
          {userEmail ? (
            <span className="block text-neutral-600 break-all">{userEmail}</span>
          ) : null}
        </div>

        {/* Logout — force readable text color */}
        <Button
  variant="outline"
  className="w-full bg-white shadow-sm hover:bg-neutral-50 !text-black !border-0"
  onClick={() => {
            try { localStorage.removeItem(LS_USER); } catch {}
            try { localStorage.removeItem(LS_MARKET_STATE); } catch {}
            setAuthed(false);
            setUserName("");
            setUserEmail("");
            setAccessCode("");
            setMenuOpen(false);
            toast.success("Logged out");
          }}
        >
          Log out
        </Button>

        {/* Admin actions — soft shadow style */}
        {!isAdmin ? (
          <Button
            className="w-full shadow-sm"
            style={{ background: PRIMARY_BLUE, color: "white" }}
            onClick={() => {
              setMenuOpen(false);
              setShowAdminModal(true);
            }}
          >
            Admin login
          </Button>
        ) : (
          <div className="space-y-2">
            <Badge className="bg-[var(--accent-yellow,#ffd200)] text-black">Admin</Badge>
            <Button
  variant="outline"
  className="w-full bg-white shadow-sm hover:bg-neutral-50 !text-black !border-0"
  onClick={() => {
                setIsAdmin(false);
                localStorage.removeItem(LS_ADMIN);
                setMenuOpen(false);
                toast.success("Admin disabled");
              }}
            >
              Turn off admin
            </Button>
          </div>
        )}
      </div>
    </div>
  </div>
</div>

      {/* Admin PIN Modal */}
      {showAdminModal && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setShowAdminModal(false); }}
        >
          <div
            className="w-full max-w-sm rounded-2xl bg-white border shadow-lg p-4"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="text-lg font-semibold mb-2">Enter Admin PIN</div>
            <p className="text-sm text-neutral-600 mb-3">Access to admin tools is protected. Enter the 4-digit PIN.</p>
            <Input
              ref={pinInputRef}
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={4}
              placeholder="••••"
              value={adminPinInput}
              onChange={(e) => setAdminPinInput(e.target.value.replace(/[^0-9]/g, "").slice(0, 4))}
            />
            <Row className="justify-end gap-2 mt-3">
              <Button variant="ghost" onClick={() => { setShowAdminModal(false); setAdminPinInput(""); }}>
                Cancel
              </Button>
              <Button
                style={{ background: PRIMARY_BLUE, color: "white" }}
                onClick={() => {
                  if (adminPinInput === ADMIN_PIN) {
                    setIsAdmin(true);
                    localStorage.setItem(LS_ADMIN, "1");
                    setShowAdminModal(false);
                    setAdminPinInput("");
                    toast.success("Admin unlocked");
                    setTab("admin");
                  } else {
                    toast.error("Incorrect PIN");
                  }
                }}
              >
                Unlock
              </Button>
            </Row>
          </div>
        </div>
      )}

      {/* Tabs header */}
      <div
        className={`grid ${isAdmin ? "grid-cols-3" : "grid-cols-2"} rounded-none overflow-hidden mb-3 sticky top-0 z-50 shadow-sm isolate`}
        style={{ background: PRIMARY_BLUE }}
      >
        {[
          { id: "builder", label: "Builder" },
          { id: "slip", label: "Betslip" },
          ...(isAdmin ? [{ id: "admin", label: "Admin" }] : []),
        ].map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`py-2.5 text-sm w-full ${tab === t.id
              ? "bg-white text-[#0a58ff] border-b-4 border-[#ffd200]"
              : "text-white"}`}
          >
           {t.label}
         </button>
        ))}
      </div>

      {/* Admin Save Bar */}
{isAdmin && (
  <div className="mb-3 rounded-xl border bg-white p-3 flex flex-wrap items-center gap-3">
    <div className="text-sm font-medium">
      Admin controls
      {lastSavedAt && (
        <span className="ml-2 text-xs text-neutral-500">
          Last saved {new Date(lastSavedAt).toLocaleTimeString()}
        </span>
      )}
    </div>
    <div className="ml-auto flex items-center gap-2">
      <Button
        className="h-10 text-sm font-medium bg-[#ffd200] text-black hover:opacity-90 disabled:opacity-60"
        onClick={forceSave}
        disabled={saving}
        title="Write current markets/legs/odds to Firestore"
      >
        {saving ? "Saving…" : "Save changes"}
      </Button>

      <Button
        variant="outline"
        className="h-10 text-sm font-medium bg-white hover:bg-neutral-50"
        onClick={refreshFromCloud}
        title="Reload latest config from Firestore"
      >
        Refresh from cloud
      </Button>

      {/* 🔹 NEW BUTTON: Reset all legs to Pending */}
      <Button
        variant="outline"
        className="h-10 text-sm font-medium bg-white hover:bg-neutral-50"
        onClick={() => {
          const newConfig = {
            ...config,
            markets: config.markets.map(m => ({
              ...m,
              legs: m.legs.map(l => ({ ...l, result: "pending" }))
            }))
          };
          setConfig(newConfig);
          toast.success("All legs reset to pending");
        }}
      >
        Reset all legs
      </Button>
    </div>
  </div>
)}

      {/* Builder */}
      {tab === "builder" && (
        <div className="grid md:grid-cols-3 gap-4">
          <div className="md:col-span-2 space-y-4">
            {/* Admin-only title editor */}
            {isAdmin && (
              <Card>
                <CardContent className="space-y-3">
                  <h2 className="text-lg font-semibold">Competition / Event Title</h2>
                  <p className="text-sm text-neutral-600">Edit the name of the game/competition users are betting on.</p>
                  <div className="grid md:grid-cols-3 gap-2 items-center">
                    <Label className="md:col-span-1">Title</Label>
                    <Input
                      className="md:col-span-2 border-[#0a58ff]/40 bg-[#0a58ff]/5 focus-visible:outline-none"
                      value={config.eventTitle}
                      onChange={(e) => setConfig({ ...config, eventTitle: e.target.value })}
                    />
                  </div>
                </CardContent>
              </Card>
            )}

            <MarketList
  config={config}
  isAdmin={isAdmin}
  mode={isAdmin ? "edit" : "browse"}
  onAddMarket={addMarket}
  onRemoveMarket={removeMarket}
  onUpdateMarket={updateMarket}
  onAddLeg={addLeg}
  onRemoveLeg={removeLeg}
  onUpdateLeg={updateLeg}
  onToggleSelect={(legId) =>
    setSlip((prev) => (prev.includes(legId) ? prev.filter((id) => id !== legId) : [...prev, legId]))
  }
  selected={slip}
/>
          </div>

          <div className="md:col-span-1">
            <BetSlip
  mode={mode}
  setMode={setMode}
  selectedLegs={selectedLegs}
  singleStakes={singleStakes}
  setSingleStakes={setSingleStakes}
  singleCaps={singleCaps}
  multiStake={multiStake}
  setMultiStake={setMultiStake}
  multiCap={multiCap}
  onRemove={(legId) => setSlip((prev) => prev.filter((id) => id !== legId))}
  onPlace={placeBet}
  bets={bets}
  userKey={userKey}
  settleBet={settleBet}
  tint="yellow"
  legResults={legResultMap}
/>

          </div>
        </div>
      )}

      {/* Betslip (wide) */}
      {tab === "slip" && (
        <div className="mt-4">
          <BetSlip
  mode={mode}
  setMode={setMode}
  selectedLegs={selectedLegs}
  singleStakes={singleStakes}
  setSingleStakes={setSingleStakes}
  singleCaps={singleCaps}
  multiStake={multiStake}
  setMultiStake={setMultiStake}
  multiCap={multiCap}
  onRemove={(legId) => setSlip((prev) => prev.filter((id) => id !== legId))}
  onPlace={placeBet}
  bets={bets}
  userKey={userKey}
  settleBet={settleBet}
  wide
  tint="yellow"
  legResults={legResultMap}
/>
        </div>
      )}

      {/* Admin */}
      {tab === "admin" && isAdmin && (
        <div className="mt-4 grid md:grid-cols-3 gap-4">
          <div className="md:col-span-2 space-y-4">
            <div className="md:col-span-2">
  <Card>
    <CardContent className="flex flex-wrap gap-2">
      <Button
        variant="outline"
        onClick={archiveAndClearAllBets}
        style={{ borderColor: "#0a58ff" }}
      >
        Archive & Clear All Bets
      </Button>
      <Button variant="destructive" onClick={clearAllBets}>
        Clear All Bets
      </Button>
    </CardContent>
  </Card>
</div>
            <Card>
  <CardContent className="space-y-3">
    <h2 className="text-lg font-semibold">Settle Legs</h2>
    <p className="text-sm text-neutral-600">
      Tap a market to open, then mark each leg as Won, Lost, or Pending. Bets settle automatically.
    </p>
    <Separator />
    {/* this actually changes leg status */}
    <MarketList
      config={config}
      isAdmin={isAdmin}
      mode="settle"
      onAddMarket={() => {}}
      onRemoveMarket={() => {}}
      onUpdateMarket={() => {}}
      onAddLeg={() => {}}
      onRemoveLeg={() => {}}
      onUpdateLeg={updateLeg}
      onToggleSelect={() => {}}
      selected={[]}
    />
  </CardContent>
</Card>
          </div>
          <div className="md:col-span-1 space-y-4">
            <AdminBetsPanel bets={bets} settleBet={settleBet} onDeleteBet={deleteBet} />
          </div>
        </div>
      )}
    </div>
  </div>
);
}


// -------------------- Subcomponents --------------------
function MarketList({
  config,
  isAdmin,
  mode = "browse", // "browse" | "edit" | "settle"
  onAddMarket,
  onRemoveMarket,
  onUpdateMarket,
  onAddLeg,
  onRemoveLeg,
  onUpdateLeg,
  onToggleSelect,
  selected,
}) {
  // Persisted open/closed state per marketId
  const [openMap, setOpenMap] = React.useState(() => {
    try {
      return JSON.parse(localStorage.getItem(LS_MARKET_STATE) || "{}");
    } catch {
      return {};
    }
  });

  // Ensure every current market has a key in openMap (default CLOSED)
  React.useEffect(() => {
    const markets = config?.markets ?? [];
    let changed = false;
    const next = { ...openMap };
    for (const m of markets) {
      if (typeof next[m.id] === "undefined") {
        next[m.id] = false; // closed by default
        changed = true;
      }
    }
    if (changed) setOpenMap(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config?.markets?.length]);

  // Persist whenever openMap changes
  React.useEffect(() => {
    try {
      localStorage.setItem(LS_MARKET_STATE, JSON.stringify(openMap));
    } catch {}
  }, [openMap]);

  const showEditHeader = isAdmin && mode === "edit";

  return (
    <Card variant="plain" className="relative z-0" style={{ background: LIGHT_BLUE_BG }}>
      <CardContent className="p-0">
        <div className="flex items-center justify-between p-4">
          <h2 className="text-lg font-semibold">Markets</h2>
          {showEditHeader && (
            <Button onClick={onAddMarket} size="sm" style={{ background: PRIMARY_BLUE, color: "white" }}>
              Add market
            </Button>
          )}
        </div>
        <Separator />
        <div className="p-2 rounded-b-2xl" style={{ background: LIGHT_BLUE_BG }}>
          {(config.markets ?? []).map((m) => (
            <details
              key={m.id}
              className="py-2 group"
              open={!!openMap[m.id]}
              onToggle={(e) => {
                const isOpen = e.currentTarget.open;
                setOpenMap((prev) => ({ ...prev, [m.id]: isOpen }));
              }}
            >
              {/* Full-width bubble header */}
              <summary className="list-none cursor-pointer px-2 py-2">
                <div
                  className="
                    w-full rounded-xl border shadow-sm px-3 py-2
                    flex items-center justify-between
                    bg-white text-[#0a58ff] border-[#0a58ff]/30
                    transition-colors
                    hover:bg-[#0a58ff] hover:text-white
                    group-open:bg-[#0a58ff] group-open:text-white
                  "
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{m.name}</span>
                    {m.active === false && (
                      <span className="rounded-full bg-neutral-200 text-neutral-800 text-[11px] px-2 py-[2px]">
                        inactive
                      </span>
                    )}
                  </div>

                  <span
                    className="
                      w-6 h-6 rounded-full flex items-center justify-center border
                      shadow-sm text-white bg-[#0a58ff] border-[#0a58ff]/30
                      transition-colors
                      group-hover:bg-white group-hover:text-[#0a58ff]
                      group-open:bg-white group-open:text-[#0a58ff]
                    "
                    aria-hidden="true"
                  >
                    {/* Show ARROW when OPEN */}
                    <svg
                      className="w-3.5 h-3.5 hidden group-open:block"
                      viewBox="0 0 24 24" fill="none" stroke="currentColor"
                      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                    >
                      <path d="M6 9l6 6 6-6" />
                    </svg>
                    {/* Show HORIZONTAL LINE when CLOSED */}
                    <svg
                      className="w-3.5 h-3.5 block group-open:hidden"
                      viewBox="0 0 24 24" fill="none" stroke="currentColor"
                      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                    >
                      <path d="M4 12h16" />
                    </svg>
                  </span>
                </div>
              </summary>

              {/* Body */}
              <div className="px-2 pb-4">
                {/* Edit-only market controls (rename/active/add/delete) */}
                {showEditHeader && (
                  <div className="grid md:grid-cols-3 gap-2 mb-3">
                    <div className="md:col-span-2 flex items-center gap-2">
                      <Input
                        className="flex-1 min-w-[260px]"
                        value={m.name}
                        onChange={(e) => onUpdateMarket(m.id, { name: e.target.value })}
                      />
                      <label className="text-xs flex items-center gap-1 px-2">
                        <input
                          type="checkbox"
                          checked={m.active !== false}
                          onChange={(e) => onUpdateMarket(m.id, { active: e.target.checked })}
                        />
                        Active
                      </label>
                    </div>
                    <div className="flex items-center justify-end gap-2">
                      <Button variant="outline" size="sm" onClick={() => onAddLeg(m.id)}>
                        Add leg
                      </Button>
                      <Button variant="destructive" size="sm" onClick={() => onRemoveMarket(m.id)}>
                        Delete
                      </Button>
                    </div>
                  </div>
                )}

                <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
                  {m.legs.map((l) => {
                    const baseTile =
                      "rounded-2xl p-3 bg-white shadow-sm flex items-center justify-between relative z-0";
                    const isSelected =
                      Array.isArray(selected) && selected.includes?.(l.id);
                    const tileClass =
                      mode === "browse" && isSelected ? `${baseTile} ring-2 ring-[#0a58ff]` : baseTile;

                    return (
                      <div key={l.id} className={tileClass}>
                        <div className="flex-1 pr-2">
                          <div className="text-sm font-medium">{l.label}</div>
                          <div className="text-xs text-neutral-600">
                            Odds {l.odds.toFixed(2)} · Result {l.result ?? "pending"}
                          </div>

                          {/* EDIT mode: full inline inputs */}
                          {isAdmin && mode === "edit" && (
                            <div className="mt-2 flex flex-col gap-2">
                              <div className="w-full">
                                <Label className="text-xs text-neutral-600">Leg name</Label>
                                <Input
                                  className="w-full text-sm h-11"
                                  value={l.label}
                                  onChange={(e) => onUpdateLeg(m.id, l.id, { label: e.target.value })}
                                />
                              </div>
                              <div className="w-full">
                                <Label className="text-xs text-neutral-600">Odds</Label>
                                <Input
                                  className="w-full text-sm h-11"
                                  type="number"
                                  step="0.01"
                                  inputMode="decimal"
                                  value={l.odds}
                                  onChange={(e) =>
                                    onUpdateLeg(m.id, l.id, { odds: parseFloat(e.target.value) || 0 })
                                  }
                                />
                              </div>
                              <div className="w-full">
                                <Label className="text-xs text-neutral-600">Status</Label>
                                <select
                                  className="w-full border rounded-xl h-11 px-2 border-[#0a58ff]/40 bg-[#0a58ff]/5 focus:outline-none focus:ring-2 focus:ring-[#0a58ff]"
                                  value={l.result || "pending"}
                                  onChange={(e) => onUpdateLeg(m.id, l.id, { result: e.target.value })}
                                >
                                  <option value="pending">Pending</option>
                                  <option value="won">Won</option>
                                  <option value="lost">Lost</option>
                                </select>
                              </div>
                            </div>
                          )}

                          {/* SETTLE mode: compact status buttons */}
                          {isAdmin && mode === "settle" && (
                            <div className="mt-2">
                              <Badge className="bg-neutral-100 text-neutral-700 capitalize">
                                {l.result || "pending"}
                              </Badge>
                              <div className="mt-2 flex flex-wrap gap-2">
                                <Button
                                  size="sm"
                                  variant={l.result === "won" ? "default" : "outline"}
                                  onClick={() => onUpdateLeg(m.id, l.id, { result: "won" })}
                                >
                                  Won
                                </Button>
                                <Button
                                  size="sm"
                                  variant={l.result === "lost" ? "default" : "outline"}
                                  onClick={() => onUpdateLeg(m.id, l.id, { result: "lost" })}
                                >
                                  Lost
                                </Button>
                                <Button
                                  size="sm"
                                  variant={l.result === "pending" ? "default" : "outline"}
                                  onClick={() => onUpdateLeg(m.id, l.id, { result: "pending" })}
                                >
                                  Pending
                                </Button>
                              </div>
                            </div>
                          )}
                        </div>

                        <div className="flex items-center gap-2">
                          {/* BROWSE mode (players): Add/Selected button */}
                          {mode === "browse" && !isAdmin && (
                            <Button
                              variant="default"
                              size="sm"
                              className={
                                isSelected
                                  ? "!bg-[#ffd200] !text-black hover:!bg-[#ffd200] hover:!text-black focus:ring-0 focus:outline-none"
                                  : "!bg-[#0a58ff] !text-white hover:!bg-[#ffd200] hover:!text-black focus:ring-0 focus:outline-none"
                              }
                              onClick={() => onToggleSelect?.(l.id)}
                            >
                              {isSelected ? "Selected" : `Add @ ${l.odds.toFixed(2)}`}
                            </Button>
                          )}

                          {/* EDIT mode (admins): delete leg */}
                          {isAdmin && mode === "edit" && (
                            <Button variant="destructive" size="sm" onClick={() => onRemoveLeg(m.id, l.id)}>
                              Delete
                            </Button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </details>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function BetSlip({
  mode, setMode,
  selectedLegs,
  singleStakes, setSingleStakes,
  singleCaps,
  multiStake, setMultiStake,
  multiCap,
  onRemove,
  onPlace,
  wide,
  bets,
  userKey,
  settleBet,
  tint,
  legResults,  // ⬅ NEW: { [legId]: "won" | "lost" | "pending" }
}) {
  const oddsArr = selectedLegs.map((l) => l.odds);
  const totalOdds = multiplyOdds(oddsArr);
  const clampedMultiStake = Math.min(multiStake, multiCap);
  const payout = payoutFrom(clampedMultiStake, totalOdds);

  // Singles totals (local)
  const _totalSinglesStake = selectedLegs.reduce(
    (acc, l) => acc + Math.min(singleStakes[l.id] || 0, (singleCaps || {})[l.id] ?? Infinity),
    0
  );
  const _totalSinglesPayout = selectedLegs.reduce(
    (acc, l) => acc + payoutFrom(Math.min(singleStakes[l.id] || 0, (singleCaps || {})[l.id] ?? Infinity), l.odds),
    0
  );

  // Player's own active bets (anything still in the "bets" collection)
  const myBets = Array.isArray(bets)
    ? bets.filter((b) => (b.userKey || makeUserKey(b.userName, b.userEmail)) === userKey)
    : [];

  // Yellow mode applies to both small (builder) and wide (slip) betslips
  const isYellow = tint === "yellow";

  // Reusable tile styles: yellow mode = no border + faint shadow, else border
  const tileClass = isYellow
    ? "rounded-2xl bg-white shadow-sm p-3"
    : "rounded-2xl border p-3 bg-white";

  const sectionClass = isYellow
    ? "rounded-2xl bg-white shadow-sm p-3"
    : "rounded-2xl border p-3 bg-white";

  // Small status icons for each leg
  const LegStatusIcon = ({ status }) => {
    if (status === "won") {
      return (
        <svg
          className="w-4 h-4 inline-block align-middle"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="10" fill="#16a34a" />
          <path
            d="M7 12l3 3 7-7"
            stroke="#ffffff"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </svg>
      );
    }
    if (status === "lost") {
      return (
        <svg
          className="w-4 h-4 inline-block align-middle"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="10" fill="#dc2626" />
          <path
            d="M8 8l8 8M16 8l-8 8"
            stroke="#ffffff"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </svg>
      );
    }
    // pending
    return (
      <span className="text-orange-500 text-xs font-medium inline-block align-middle">
        pending
      </span>
    );
  };

  // Use the parent-provided `legResult` prop for per-leg status (avoid redeclaring `legResult` here).

  return (
    <Card
      variant="plain"
      className={`${wide ? "" : "sticky top-28 z-0"}`}
      style={{
        background: tint === "yellow" ? ACCENT_YELLOW : wide ? LIGHT_BLUE_BG : undefined,
      }}
    >
      <CardContent className="space-y-4">
        <Row className="justify-between">
          <h2 className="text-lg font-semibold">Betslip</h2>
          <Row className="gap-2 text-xs">
            <Button
              size="sm"
              variant={mode === "multi" ? "default" : "outline"}
              className={mode === "multi" ? "bg-[#0a58ff] text-white" : ""}
              onClick={() => setMode("multi")}
            >
              Multi
            </Button>
            <Button
              size="sm"
              variant={mode === "singles" ? "default" : "outline"}
              className={mode === "singles" ? "bg-[#0a58ff] text-white" : ""}
              onClick={() => setMode("singles")}
            >
              Singles
            </Button>
          </Row>
        </Row>

        <Separator />

        {/* --- Selections area (unchanged behavior) --- */}
        {selectedLegs.length === 0 ? (
          <p className="text-sm text-neutral-600">
            No selections yet. Add legs from the Markets list.
          </p>
        ) : (
          <div className="space-y-3">
            {selectedLegs.map((l) => (
              <div
                key={l.id}
                className={`${tileClass} flex items-start justify-between gap-2`}
              >
                <div className="flex-1">
                  <div className="text-xs text-neutral-500">{l.marketName}</div>
                  <div className="text-sm font-medium">{l.label}</div>
                  <div className="text-xs">
                    Odds <strong>{l.odds.toFixed(2)}</strong>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {mode === "singles" && (
                    <div className="flex items-center gap-2">
                      <div className="text-[11px] text-neutral-500 text-right">
                        Max stake ${stakeCapForOdds(l.odds).toFixed(2)} for $200
                        payout
                      </div>
                      <Input
                        className="w-28"
                        type="number"
                        step="0.01"
                        inputMode="decimal"
                        placeholder="Stake"
                        value={Math.min(
                          singleStakes[l.id] ?? 0,
                          (singleCaps || {})[l.id] ?? Infinity
                        )}
                        onChange={(e) => {
                          const val = parseFloat(e.target.value);
                          const cap = (singleCaps || {})[l.id] ?? Infinity;
                          const v = Math.max(
                            0,
                            Number.isFinite(val) ? clamp2(val) : 0
                          );
                          const valClamped = Math.min(v, cap);
                          setSingleStakes({ ...singleStakes, [l.id]: valClamped });
                        }}
                      />
                    </div>
                  )}
                  <Button variant="ghost" onClick={() => onRemove(l.id)}>
                    ×
                  </Button>
                </div>
              </div>
            ))}

            {mode === "multi" ? (
              <div className={sectionClass}>
                <Row className="justify-between mb-2">
                  <div className="text-sm font-semibold">Multi Builder</div>
                </Row>
                <div className="grid grid-cols-2 gap-3 items-end">
                  <div>
                    <Label>Total odds</Label>
                    <div className="text-2xl font-semibold">
                      {totalOdds.toFixed(2)}
                    </div>
                  </div>
                  <div>
                    <Label>Stake (max ${multiCap.toFixed(2)})</Label>
                    <Input
                      type="number"
                      step="0.01"
                      inputMode="decimal"
                      value={clampedMultiStake}
                      onChange={(e) => {
                        const val = parseFloat(e.target.value);
                        const v = Math.max(0, Number.isFinite(val) ? val : 0);
                        const capped = Math.min(v, multiCap);
                        setMultiStake(clamp2(capped));
                      }}
                    />
                  </div>
                </div>
                <Separator className="my-3" />
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <div className="text-sm text-neutral-600">Potential payout</div>
                    <div className="text-xl font-semibold">
                      ${payout.toFixed(2)}
                    </div>
                  </div>
                  <div>
                    <div className="text-sm text-neutral-600">Potential profit</div>
                    <div className="text-xl font-semibold">
                      ${clamp2(payout - clampedMultiStake).toFixed(2)}
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className={sectionClass}>
                <Row className="justify-between mb-2">
                  <div className="text-sm font-semibold">Singles Summary</div>
                  <Badge>{selectedLegs.length} legs</Badge>
                </Row>
                <div className="space-y-2">
                  {selectedLegs.map((l) => {
                    const stake = Math.min(
                      singleStakes[l.id] || 0,
                      (singleCaps || {})[l.id] ?? 0
                    );
                    const payout = payoutFrom(stake, l.odds);
                    const profit = clamp2(payout - stake);
                    return (
                      <div
                        key={l.id}
                        className="flex items-center justify-between text-sm"
                      >
                        <div className="truncate pr-2">{l.label}</div>
                        <div className="text-right w-48">
                          <div>Stake ${stake.toFixed(2)}</div>
                          <div>
                            Payout ${payout.toFixed(2)} · Profit $
                            {profit.toFixed(2)}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <Separator className="my-3" />
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <div className="text-sm text-neutral-600">Total stake</div>
                    <div className="text-xl font-semibold">
                      ${clamp2(_totalSinglesStake).toFixed(2)}
                    </div>
                  </div>
                  <div>
                    <div className="text-sm text-neutral-600">Total payout</div>
                    <div className="text-xl font-semibold">
                      ${clamp2(_totalSinglesPayout).toFixed(2)}
                    </div>
                  </div>
                </div>
              </div>
            )}

            <Button
              variant="default"
              className="w-full !bg-[#0a58ff] !text-white hover:!bg-white hover:!text-[#0a58ff] active:!bg-[#0044cc] active:!text-white active:translate-y-[1px] focus:ring-0 focus:outline-none"
              onClick={onPlace}
            >
              Place {mode === "multi" ? "Multi" : "Singles"}
            </Button>
            <p className="text-[11px] text-neutral-500">
              Max possible payout for any bet is $200. Stakes are capped automatically.
              Demo only – no real bets or payments.
            </p>
          </div>
        )}

        {/* --- My Bets: ALWAYS show if user has any bets (even with no selections) --- */}
        {myBets.length > 0 && (
          <div className="mt-2">
            <Separator className="my-3" />
            <h3 className="text-md font-semibold">My Bets</h3>
            <div className="space-y-2 max-h-[40vh] overflow-auto pr-1">
              {myBets.map((b) => {
                const s = typeof settleBet === "function"
                  ? settleBet(b)
                  : { status: "—", potentialPayout: 0 };

                return (
  <div
    key={b.id}
    className={`${isYellow ? "shadow-sm" : "border"} rounded-2xl p-3 bg-white ${
      s.status === "Won" ? "text-green-700 border-green-300" : ""
    }`}
  >
    <div className={`text-xs ${s.status === "Won" ? "text-green-600" : "text-neutral-600"}`}>
      {formatPlacedAt(b.placedAt)}
    </div>
    <div className="text-xs">
      Mode: <strong>{b.mode}</strong> · Status:{" "}
      <strong className={s.status === "Won" ? "text-green-700" : ""}>{s.status}</strong>
      {" · "}Potential payout: ${s.potentialPayout.toFixed(2)}
    </div>

    <div className="mt-2 space-y-1">
      {b.legs.map((l) => {
        const status = (legResults && legResults[l.legId]) || "pending";
        return (
          <div
            key={l.legId}
            className="text-sm flex items-center justify-between"
          >
            <div className="truncate pr-2">
              {l.marketName} — {l.label}
            </div>
            <div className="flex items-center gap-2">
              <div className="text-xs">@ {l.odds.toFixed(2)}</div>
              <LegStatusIcon status={status} />
            </div>
          </div>
        );
      })}
    </div>
  </div>
);
              })}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AdminBetsPanel({ bets, settleBet, onDeleteBet }) {
  return (
    <Card>
      <CardContent className="space-y-3">
        <h2 className="text-lg font-semibold">Placed Bets</h2>
        <p className="text-sm text-neutral-600">
          Shows bettor name/email, time, mode, legs, and current status based on leg results.
        </p>
        <Separator />
        <div className="space-y-3 max-h-[70vh] overflow-auto pr-2">
          {bets.length === 0 ? (
            <div className="text-sm text-neutral-600">No bets yet.</div>
          ) : (
            bets.map((b) => {
              const s = settleBet(b);
              return (
                <div key={b.id} className="border rounded-2xl p-3 bg-white">
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="text-sm">
                        <strong>{b.userName}</strong>
                        {b.userEmail ? ` · ${b.userEmail}` : ""}
                      </div>
                      <div className="text-xs text-neutral-600">{formatPlacedAt(b.placedAt)}</div>
                    </div>
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => {
                        if (confirm("Delete this bet? This cannot be undone.")) onDeleteBet?.(b.id);
                      }}
                    >
                      Delete
                    </Button>
                  </div>

                  <Separator className="my-2" />
                  <div className="text-xs">
                    Mode: <strong>{b.mode}</strong> · Status: <strong>{s.status}</strong> · Potential payout: ${s.potentialPayout.toFixed(2)}
                  </div>

                  <div className="mt-2 space-y-1">
                    {b.legs.map((l) => (
                      <div key={l.legId} className="text-sm flex items-center justify-between">
                        <div className="truncate pr-2">
                          {l.marketName} — {l.label}
                        </div>
                        <div className="text-xs">@ {l.odds.toFixed(2)}</div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </CardContent>
    </Card>
  );
}
// ---------- Pub Golf helpers ----------
function SpinNumber({ value, setValue, step=1, allowNegative=true, min, max }) {
  const clamp = (n) => {
    if (typeof min === "number") n = Math.max(min, n);
    if (typeof max === "number") n = Math.min(max, n);
    return n;
  };
  return (
    <div className="inline-flex items-stretch overflow-hidden rounded-xl border bg-white">
      <button className="px-3 text-lg" onClick={() => setValue(clamp((Number(value)||0) - step))}>–</button>
      <input
        className="w-16 text-center outline-none"
        type="number"
        step={step}
        value={value ?? 0}
        onChange={(e)=> {
          const n = parseFloat(e.target.value);
          if (!allowNegative && n < 0) return;
          setValue(clamp(Number.isFinite(n) ? n : 0));
        }}
      />
      <button className="px-3 text-lg" onClick={() => setValue(clamp((Number(value)||0) + step))}>+</button>
    </div>
  );
}
const teamHoleId = (roundId, team, holeId) => `${roundId}__${team}__${holeId}`;

// ---------- Scorecard ----------
function Scorecard({ roundId, golfConfig, teamName, userName }) {
  const [editMap, setEditMap] = useState({});
  const [local, setLocal] = useState({});

  const openEdit = (hId) => setEditMap(p => ({ ...p, [hId]: true }));
  const closeEdit = (hId) => setEditMap(p => ({ ...p, [hId]: false }));

  const setField = (hId, key, val) => {
    setLocal(prev => ({ ...prev, [hId]: { ...(prev[hId] || { sips:0, bonuses:0, penalties:0 }), [key]: val }}));
  };

  const confirmHole = async (hole) => {
    const vals = local[hole.id] || { sips:0, bonuses:0, penalties:0 };
    const total = (Number(vals.sips)||0) + (Number(vals.bonuses)||0) + (Number(vals.penalties)||0);
    try {
      await setDoc(
        doc(db, "golf_scores", teamHoleId(roundId, teamName, hole.id)),
        {
          roundId, teamName,
          holeId: hole.id, holeName: hole.name,
          sips: Number(vals.sips)||0,
          bonuses: Number(vals.bonuses)||0,
          penalties: Number(vals.penalties)||0,
          holeTotal: clamp2(total),
          confirmedBy: userName || "unknown",
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
      toast.success(`${hole.name} saved`);
      closeEdit(hole.id);
    } catch (e) {
      console.error(e);
      toast.error("Failed to save score");
    }
  };

  return (
    <div className="space-y-3">
      <Card variant="plain" className="relative z-0" style={{ background: PUBGOLF_PAPER }}>
        <CardContent className="p-0">
          <div className="flex items-center justify-between p-4">
            <h2 className="text-lg font-semibold text-white">Holes</h2>
          </div>
          <Separator className="border-neutral-800" />
          <div className="p-2 rounded-b-2xl" style={{ background: PUBGOLF_PAPER }}>
            {(golfConfig.holes || []).map((h) => {
              const vals = local[h.id] || { sips:0, bonuses:0, penalties:0 };
              const total = (Number(vals.sips)||0)+(Number(vals.bonuses)||0)+(Number(vals.penalties)||0);
              const editing = !!editMap[h.id];
              return (
                <details key={h.id} className="py-2 group">
                  <summary className="list-none cursor-pointer px-2 py-2">
                    <div
                      className="
                        w-full rounded-xl border shadow-sm px-3 py-2
                        flex items-center justify-between
                        bg-black/50 text-[color:var(--gold)]
                        transition-colors border-neutral-800
                      "
                      style={{ ["--gold"]: PUBGOLF_GOLD }}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-white">{h.name}</span>
                        <span className="rounded-full text-xs px-2 py-[2px]" style={{ background: "#1d1f22", color: PUBGOLF_GOLD }}>
                          {editing ? "editing" : "view"}
                        </span>
                      </div>
                      <span className="text-sm text-white">Total: <strong style={{ color: PUBGOLF_GOLD }}>{clamp2(total).toFixed(2)}</strong></span>
                    </div>
                  </summary>

                  <div className="px-2 pb-4">
                    <div className="rounded-2xl p-3 bg-black/60 border border-neutral-800 text-white space-y-3">
                      <div className="grid sm:grid-cols-3 gap-3">
                        <div>
                          <Label className="text-neutral-400">Total sips</Label><br/>
                          <SpinNumber value={vals.sips} setValue={(v)=>setField(h.id,"sips",v)} step={1} allowNegative={false} min={0} />
                        </div>
                        <div>
                          <Label className="text-neutral-400">Bonuses</Label><br/>
                          <SpinNumber value={vals.bonuses} setValue={(v)=>setField(h.id,"bonuses",v)} step={1} />
                        </div>
                        <div>
                          <Label className="text-neutral-400">Penalties</Label><br/>
                          <SpinNumber value={vals.penalties} setValue={(v)=>setField(h.id,"penalties",v)} step={1} />
                        </div>
                      </div>

                      <Separator className="border-neutral-800" />
                      <Row className="justify-between">
                        <div className="text-sm text-neutral-300">Hole total</div>
                        <div className="text-xl font-semibold" style={{ color: PUBGOLF_GOLD }}>{clamp2(total).toFixed(2)}</div>
                      </Row>

                      <Row className="gap-2 justify-end">
                        {!editing ? (
                          <Button variant="outline" className="bg-white text-black" onClick={()=>openEdit(h.id)}>
                            Edit
                          </Button>
                        ) : (
                          <>
                            <Button variant="ghost" onClick={()=>closeEdit(h.id)}>Cancel</Button>
                            <Button style={{ background: PUBGOLF_GOLD, color: "black" }} onClick={()=>confirmHole(h)}>
                              Confirm
                            </Button>
                          </>
                        )}
                      </Row>
                    </div>
                  </div>
                </details>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------- Ladder ----------
function GolfLadder({ roundId, scores }) {
  const totals = useMemo(() => {
    const map = new Map();
    for (const s of scores) {
      if (s.roundId !== roundId) continue;
      const key = s.teamName;
      const prev = map.get(key) || 0;
      map.set(key, clamp2(prev + (Number(s.holeTotal)||0)));
    }
    return Array.from(map.entries())
      .map(([team, total]) => ({ team, total }))
      .sort((a,b)=>a.total - b.total);
  }, [scores, roundId]);

  return (
    <Card variant="plain" style={{ background: PUBGOLF_PAPER }}>
      <CardContent>
        <h2 className="text-lg font-semibold mb-2 text-white">Live Ladder</h2>
        <div className="rounded-2xl overflow-hidden border border-neutral-800">
          <table className="w-full text-sm" style={{ color: "white", background: "#0f1113" }}>
            <thead style={{ background: "#15181c" }}>
              <tr>
                <th className="text-left p-3">#</th>
                <th className="text-left p-3">Team</th>
                <th className="text-right p-3">Total</th>
              </tr>
            </thead>
            <tbody>
              {totals.map((row, i)=>(
                <tr key={row.team} className="border-t border-neutral-800">
                  <td className="p-3" style={{ color: PUBGOLF_GOLD }}>{i+1}</td>
                  <td className="p-3">{row.team}</td>
                  <td className="p-3 text-right font-semibold">{row.total.toFixed(2)}</td>
                </tr>
              ))}
              {totals.length===0 && (
                <tr><td className="p-3 text-neutral-400" colSpan={3}>No scores yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------- Page shell ----------
function PubGolfPage({ golfConfig, teamName, userName, scores }) {
  const [t, setT] = useState("scorecard"); // "scorecard" | "ladder"
  return (
    <div className="min-h-screen p-4 md:p-8" style={{ background: PUBGOLF_BLACK }}>
      <div className="mx-auto max-w-6xl">
        <Row className="justify-between gap-4 mb-3">
          <h1 className="text-2xl md:text-3xl font-bold" style={{ color: "white" }}>
            {golfConfig.title} <span style={{ color: PUBGOLF_GOLD }}>• 5th Anniversary</span>
          </h1>
        </Row>

        {/* Sticky tabs */}
        <div className="grid grid-cols-2 rounded-none overflow-hidden mb-3 sticky top-0 z-50 shadow-sm isolate" style={{ background: PUBGOLF_GOLD }}>
          {[
            { id: "scorecard", label: "Scorecard" },
            { id: "ladder", label: "Ladder" },
          ].map((x)=>(
            <button key={x.id}
              onClick={()=>setT(x.id)}
              className={`py-2.5 text-sm w-full ${t===x.id ? "bg-white text-black border-b-4" : "text-black/90"}`}
              style={t===x.id ? { borderColor: PUBGOLF_GOLD } : {}}
            >
              {x.label}
            </button>
          ))}
        </div>

        {t==="scorecard" ? (
          <Scorecard roundId={ROUND_ID} golfConfig={golfConfig} teamName={teamName} userName={userName} />
        ) : (
          <GolfLadder roundId={ROUND_ID} scores={scores} />
        )}
      </div>
    </div>
  );
}

// -------------------- Runtime Smoke Tests --------------------
(function runSmokeTests(){
  try {
    console.assert(multiplyOdds([1.5, 2]).toFixed(2) === '3.00', 'multiplyOdds should multiply correctly');
    console.assert(multiplyOdds([]) === 1, 'multiplyOdds([]) should be 1');
    console.assert(stakeCapForOdds(2) <= 100 && stakeCapForOdds(2) >= 99.9, 'stakeCapForOdds ~100 at odds=2');
    const payout = payoutFrom(10, 1.85); console.assert(payout.toFixed(2) === '18.50', 'payoutFrom basic');
    const cap = stakeCapForOdds(5); console.assert(cap.toFixed(2) === '40.00', 'cap should be 40 at 5.00 odds');

    // Settlement tests
    const legs = [
      { legId: 'a', odds: 2.0 },
      { legId: 'b', odds: 3.0 },
    ];
    const flat = [ { id: 'a', result: 'won' }, { id: 'b', result: 'won' } ];
    const _legResult = (id) => flat.find(x=>x.id===id)?.result || 'pending';
    (function () {
      const odds = multiplyOdds(legs.map(l=>l.odds));
      const stake = 10;
      const anyLost = legs.some((l)=> _legResult(l.legId) === 'lost');
      const allWon = legs.every((l)=> _legResult(l.legId) === 'won');
      const status = anyLost ? 'Lost' : allWon ? 'Won' : 'Pending';
      console.assert(status === 'Won', 'multi settlement should be Won when all won');
      console.assert(Number.isFinite(odds) && odds > 0, 'multi odds valid');
    })();

    // Singles totals/ cap tests
    (function () {
      const selected = [{ id: 'x', odds: 2.0 }, { id: 'y', odds: 1.5 }];
      const stakes = { x: 60, y: 200 };
      const caps = { x: 100, y: 120 };
      const sumStake = selected.reduce((acc, l) => acc + Math.min(stakes[l.id] || 0, caps[l.id] || 0), 0);
      console.assert(sumStake === 180, 'totalSinglesStake should respect caps (60 + 120)');
      const payoutSum = selected.reduce((acc, l) => acc + payoutFrom(Math.min(stakes[l.id] || 0, caps[l.id] || 0), l.odds), 0);
      console.assert(payoutSum.toFixed(2) === (60*2 + 120*1.5).toFixed(2), 'totalSinglesPayout math');
    })();

    // User key formatting
    console.assert(makeUserKey('Alice', 'ALICE@EXAMPLE.com') === 'alice|alice@example.com', 'makeUserKey lowercases & pipes');
  } catch(e) { console.warn('Smoke tests warning:', e); }
})();
