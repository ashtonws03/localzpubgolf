import {
  collection,
  doc,
  setDoc,
  getDocs,
  deleteDoc,
  writeBatch,
  query,
  where,
  orderBy,
  onSnapshot,
  serverTimestamp,
} from "firebase/firestore";
import { db } from "./firebase";
import React, { useEffect, useMemo, useRef, useState } from "react";

// -------------------- Constants --------------------
const ACCESS_CODE = "LOCALZPG25";
const ADMIN_PIN = "2855";

// Pub Golf theme
const PUBGOLF_GOLD = "#d4af37";
const PUBGOLF_BLACK = "#0b0b0b";
const PUBGOLF_PAPER = "#111316";

// Round ID (Firestore doc key)
const ROUND_ID = "cairns2025";

// Storage keys
const LS_USER = "pubgolf_user_v1";
const LS_ADMIN = "pubgolf_admin_v1";

// -------------------- Helpers --------------------
const toast = {
  success: (m) => {
    try {
      console.info(m);
    } catch {}
  },
  error: (m) => {
    try {
      console.error(m);
      alert(m);
    } catch {}
  },
  info: (m) => {
    try {
      console.log(m);
    } catch {}
  },
};

const defaultHoles = Array.from({ length: 9 }, (_, i) => ({
  id: `h${i + 1}`,
  name: `Hole ${i + 1}`,
  active: true,
  locked: false,
}));

const docIdForScore = (roundId, team, holeId) => `${roundId}__${team}__${holeId}`;
const emptyVals = { sips: 0, bonuses: 0, penalties: 0, holeTotal: 0, confirmed: false };

// -------------------- Primitive UI helpers --------------------
const Row = ({ className = "", children }) => (
  <div className={`flex items-center ${className}`}>{children}</div>
);
const Col = ({ className = "", children }) => (
  <div className={`flex flex-col ${className}`}>{children}</div>
);
const Card = ({ className = "", children, variant = "default", style }) => {
  const chrome =
    variant === "plain" ? "rounded-2xl" : "rounded-2xl border bg-white shadow-sm";
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
    "focus:outline-none focus:ring-2 focus:ring-black/20 " +
    "active:translate-y-[1px] active:scale-[.98] active:opacity-90 " +
    "disabled:opacity-60 disabled:cursor-not-allowed px-4";

  const sizes = { sm: "h-9 text-sm px-3", md: "h-11", lg: "h-12 text-lg" };

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
const Input = React.forwardRef((props, ref) => (
  <input
    ref={ref}
    {...props}
    className={`h-11 px-3 rounded-xl border w-full ${props.className || ""}`}
  />
));
const Label = ({ children, className = "" }) => (
  <label className={`text-sm text-neutral-700 ${className}`}>{children}</label>
);
const Badge = ({ children, className = "" }) => (
  <span
    className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${className}`}
  >
    {children}
  </span>
);
const Separator = ({ className = "" }) => <hr className={`border-neutral-200 ${className}`} />;

// -------------------- Main App (Pub Golf Only) --------------------
export default function PubGolfApp() {
  // Access state
  const [authed, setAuthed] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(LS_USER) || "{}").authed || false;
    } catch {
      return false;
    }
  });
  const [userName, setUserName] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(LS_USER) || "{}").name || "";
    } catch {
      return "";
    }
  });
  const [userEmail, setUserEmail] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(LS_USER) || "{}").email || "";
    } catch {
      return "";
    }
  });
  const [teamName, setTeamName] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(LS_USER) || "{}").teamName || "";
    } catch {
      return "";
    }
  });
  const [accessCode, setAccessCode] = useState("");

  // Admin
  const [isAdmin, setIsAdmin] = useState(() => {
    try {
      return localStorage.getItem(LS_ADMIN) === "1";
    } catch {
      return false;
    }
  });
  const [showAdminModal, setShowAdminModal] = useState(false);
  const [adminPinInput, setAdminPinInput] = useState("");
  const pinInputRef = useRef(null);

  // Slide-out menu
  const [menuOpen, setMenuOpen] = useState(false);

  // Pub Golf state
  const [golfResetNonce, setGolfResetNonce] = useState(0);
  const [golfConfig, setGolfConfig] = useState({
    title: "Pub Golf 2025: Cairns",
    holes: defaultHoles,
  });
  const [golfScores, setGolfScores] = useState([]);

  // Persist gate info
  useEffect(() => {
    localStorage.setItem(
      LS_USER,
      JSON.stringify({ authed, name: userName, email: userEmail, teamName })
    );
  }, [authed, userName, userEmail, teamName]);

  // Focus PIN input
  useEffect(() => {
    if (showAdminModal && pinInputRef.current) pinInputRef.current.focus();
  }, [showAdminModal]);

  // Round config (golf_rounds/{ROUND_ID})
  useEffect(() => {
    const roundRef = doc(db, "golf_rounds", ROUND_ID);
    const unsub = onSnapshot(roundRef, (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        setGolfConfig({
          title: data.title || "Pub Golf 2025: Cairns",
          holes:
            Array.isArray(data.holes) && data.holes.length ? data.holes : defaultHoles,
        });
      } else {
        setDoc(roundRef, { title: "Pub Golf 2025: Cairns", holes: defaultHoles });
      }
    });
    return () => unsub();
  }, []);

  // Scores for this round
  useEffect(() => {
    const qScores = query(
      collection(db, "golf_scores"),
      orderBy("updatedAt", "desc")
    );
    const unsub = onSnapshot(qScores, (snap) => {
      const all = snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .filter((x) => x.roundId === ROUND_ID);
      setGolfScores(all);
    });
    return () => unsub();
  }, []);

  // Admin: lock/unlock a hole
  const toggleHoleLock = async (holeId, nextLocked) => {
    try {
      const roundRef = doc(db, "golf_rounds", ROUND_ID);
      const next = {
        ...golfConfig,
        holes: (golfConfig.holes || []).map((h) =>
          h.id === holeId ? { ...h, locked: !!nextLocked } : h
        ),
      };
      await setDoc(roundRef, next, { merge: true });
      toast.success(`${nextLocked ? "Locked" : "Unlocked"} ${holeId}`);
    } catch (e) {
      console.error(e);
      toast.error("Failed to toggle hole lock");
    }
  };

  // Admin: clear all scores for this round
  const clearAllGolfScores = async () => {
    try {
      if (!isAdmin) return;
      const ok = window.confirm(
        "This will delete ALL Pub Golf scores for this round. Continue?"
      );
      if (!ok) return;

      const qScores = query(
        collection(db, "golf_scores"),
        where("roundId", "==", ROUND_ID)
      );
      const snap = await getDocs(qScores);

      const batch = writeBatch(db);
      snap.forEach((d) => batch.delete(d.ref));
      await batch.commit();

      setGolfResetNonce((n) => n + 1);
      toast.success("All Pub Golf scores cleared");
    } catch (e) {
      console.error(e);
      toast.error("Failed to clear Pub Golf scores");
    }
  };

  // Logout
  const handleLogout = () => {
    try {
      localStorage.removeItem(LS_USER);
    } catch {}
    setAuthed(false);
    setUserName("");
    setUserEmail("");
    setTeamName("");
    setAccessCode("");
    setMenuOpen(false);
    toast.success("Logged out");
  };

  // -------------------- Access Gate --------------------
  if (!authed) {
    return (
      <div className="min-h-screen bg-neutral-50 p-4 md:p-8 flex items-center justify-center">
        <div className="w-full max-w-5xl grid grid-cols-1 md:grid-cols-2 gap-8 items-center">
          <div className="order-2 md:order-1">
            <Card className="w-full">
              <CardContent className="space-y-4">
                <Row className="gap-2">
                  <span className="text-xl font-semibold">Restricted Access</span>
                </Row>
                <p className="text-sm text-neutral-600">
                  Enter the access code to continue. Add your name (and team) so scores can be
                  tracked.
                </p>

                <Col className="gap-3">
                  <Col>
                    <Label>Access code</Label>
                    <Input
                      value={accessCode}
                      onChange={(e) => setAccessCode(e.target.value)}
                      placeholder="Enter code"
                    />
                  </Col>

                  <Col>
                    <Label>Name (required)</Label>
                    <Input
                      value={userName}
                      onChange={(e) => setUserName(e.target.value)}
                      placeholder="Your name"
                    />
                  </Col>

                  <Col>
                    <Label>Team name (required, case sensitive)</Label>
                    <Input
                      value={teamName}
                      onChange={(e) => setTeamName(e.target.value)}
                      placeholder="Exact team name"
                    />
                  </Col>

                  <Button
                    style={{ background: "#0a58ff", color: "white" }}
                    onClick={() => {
                      if (accessCode !== ACCESS_CODE) {
                        toast.error("Incorrect access code");
                        return;
                      }
                      if (!userName.trim()) {
                        toast.error("Please enter your name");
                        return;
                      }
                      if (!teamName.trim()) {
                        toast.error("Enter your exact team name");
                        return;
                      }
                      setAuthed(true);
                      toast.success("Welcome");
                    }}
                  >
                    Enter
                  </Button>

                  <p className="text-[11px] text-neutral-500">
                    Scores are stored in Firestore for the round.
                  </p>
                </Col>
              </CardContent>
            </Card>
          </div>

          <div className="order-1 md:order-2 flex items-center justify-center">
            <img
              src="/localz-5yr.png"
              alt="Localz • 5 Years"
              className="w-full max-w-[520px] max-h-[420px] object-contain select-none"
              style={{ filter: "drop-shadow(0 6px 14px rgba(0,0,0,.25))" }}
              onError={(e) => {
                e.currentTarget.style.opacity = "0.5";
                e.currentTarget.style.border = "1px dashed #bbb";
              }}
            />
          </div>
        </div>
      </div>
    );
  }

  // -------------------- Main UI (Pub Golf only) --------------------
  return (
    <>
      {/* Admin PIN Modal */}
      {showAdminModal && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setShowAdminModal(false);
          }}
        >
          <div
            className="w-full max-w-sm rounded-2xl bg-white border shadow-lg p-4"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="text-lg font-semibold mb-2">Enter Admin PIN</div>
            <p className="text-sm text-neutral-600 mb-3">
              Access to admin tools is protected. Enter the 4-digit PIN.
            </p>
            <Input
              ref={pinInputRef}
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={4}
              placeholder="••••"
              value={adminPinInput}
              onChange={(e) =>
                setAdminPinInput(
                  e.target.value.replace(/[^0-9]/g, "").slice(0, 4)
                )
              }
            />
            <Row className="justify-end gap-2 mt-3">
              <Button
                variant="ghost"
                onClick={() => {
                  setShowAdminModal(false);
                  setAdminPinInput("");
                }}
              >
                Cancel
              </Button>
              <Button
                style={{ background: "#0a58ff", color: "white" }}
                onClick={() => {
                  if (adminPinInput === ADMIN_PIN) {
                    setIsAdmin(true);
                    localStorage.setItem(LS_ADMIN, "1");
                    setShowAdminModal(false);
                    setAdminPinInput("");
                    toast.success("Admin unlocked");
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

      <PubGolfPage
        golfConfig={golfConfig}
        teamName={teamName}
        userName={userName}
        userEmail={userEmail}
        scores={golfScores}
        isAdmin={isAdmin}
        onToggleLock={toggleHoleLock}
        onClearAllScores={clearAllGolfScores}
        resetNonce={golfResetNonce}
        menuOpen={menuOpen}
        setMenuOpen={setMenuOpen}
        setIsAdmin={setIsAdmin}
        setShowAdminModal={setShowAdminModal}
        onLogout={handleLogout}
      />
    </>
  );
}

// ---------- Pub Golf helpers ----------
function SpinNumber({ value, setValue, step = 1, allowNegative = true, min, max }) {
  const clamp = (n) => {
    if (typeof min === "number") n = Math.max(min, n);
    if (typeof max === "number") n = Math.min(max, n);
    return n;
  };
  const toInt = (n) => (Number.isFinite(n) ? Math.round(n) : 0);

  return (
    <div className="inline-flex items-stretch overflow-hidden rounded-xl border border-neutral-700 bg-white">
      <button
        className="px-3 text-lg font-bold bg-black text-white"
        onClick={() => setValue(clamp(toInt((Number(value) || 0) - step)))}
        type="button"
      >
        –
      </button>
      <input
        className="w-20 text-center outline-none bg-white text-black font-semibold"
        type="number"
        step={step}
        value={value ?? 0}
        onChange={(e) => {
          const n = parseFloat(e.target.value);
          if (!allowNegative && n < 0) return;
          setValue(clamp(toInt(n)));
        }}
      />
      <button
        className="px-3 text-lg font-bold bg-black text-white"
        onClick={() => setValue(clamp(toInt((Number(value) || 0) + step)))}
        type="button"
      >
        +
      </button>
    </div>
  );
}

// ---------- Scorecard ----------
function Scorecard({ roundId, golfConfig, teamName, userName, isAdmin, onToggleLock, onRenameHole }) {
  const [editMap, setEditMap] = useState({});
  const editMapRef = useRef({});
  useEffect(() => {
    editMapRef.current = editMap;
  }, [editMap]);

  const [local, setLocal] = useState({});
  const [saved, setSaved] = useState({});
  const [renameBuf, setRenameBuf] = useState({});

  useEffect(() => {
    const holes = golfConfig?.holes || [];
    const unsubs = holes.map((h) => {
      const ref = doc(db, "golf_scores", docIdForScore(roundId, teamName, h.id));
      return onSnapshot(ref, (snap) => {
        const data = snap.exists() ? snap.data() : emptyVals;
        const v = {
          sips: Number(data.sips || 0),
          bonuses: Number(data.bonuses || 0),
          penalties: Number(data.penalties || 0),
          holeTotal: Number(data.holeTotal || 0),
          confirmed: !!data.confirmed,
        };
        setSaved((p) => ({ ...p, [h.id]: v }));

        setLocal((p) => {
          const isEditing = !!editMapRef.current[h.id];
          if (isEditing) return p;
          return { ...p, [h.id]: { sips: v.sips, bonuses: v.bonuses, penalties: v.penalties } };
        });

        setEditMap((p) => {
          const prev = p[h.id];
          if (v.confirmed) return { ...p, [h.id]: false };
          if (typeof prev !== "boolean") return { ...p, [h.id]: true };
          return p;
        });
      });
    });

    return () => unsubs.forEach((u) => u && u());
  }, [roundId, teamName, golfConfig?.holes?.length]);

  const setField = (hId, key, val) => {
    setLocal((prev) => ({
      ...prev,
      [hId]: { ...(prev[hId] || { sips: 0, bonuses: 0, penalties: 0 }), [key]: val },
    }));
  };

  const openEdit = (hId) => {
    const s = saved[hId] || emptyVals;
    setLocal((p) => ({ ...p, [hId]: { sips: s.sips, bonuses: s.bonuses, penalties: s.penalties } }));
    setEditMap((p) => ({ ...p, [hId]: true }));
  };

  const closeEdit = (hId) => setEditMap((p) => ({ ...p, [hId]: false }));

  const cancelEdit = (hole) => {
    const v = saved[hole.id] || emptyVals;
    setLocal((p) => ({ ...p, [hole.id]: { sips: v.sips, bonuses: v.bonuses, penalties: v.penalties } }));
    closeEdit(hole.id);
  };

  const confirmHole = async (hole) => {
    const vals = local[hole.id] || { sips: 0, bonuses: 0, penalties: 0 };
    const sips = Math.round(Number(vals.sips) || 0);
    const bonuses = Math.round(Number(vals.bonuses) || 0);
    const penalties = Math.round(Number(vals.penalties) || 0);
    const total = sips + bonuses + penalties;

    try {
      await setDoc(
        doc(db, "golf_scores", docIdForScore(roundId, teamName, hole.id)),
        {
          roundId,
          teamName,
          holeId: hole.id,
          holeName: hole.name,
          sips,
          bonuses,
          penalties,
          holeTotal: total,
          confirmed: true,
          confirmedBy: userName || "unknown",
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
      toast.success(`${hole.name} confirmed`);
      closeEdit(hole.id);
    } catch (e) {
      console.error(e);
      toast.error("Failed to confirm score");
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
              const vals = local[h.id] || { sips: 0, bonuses: 0, penalties: 0 };
              const editing = !!editMap[h.id];
              const savedVals = saved[h.id] || emptyVals;
              const liveTotal = Math.round(
                (Number(vals.sips) || 0) +
                  (Number(vals.bonuses) || 0) +
                  (Number(vals.penalties) || 0)
              );
              const displayTotal = editing ? liveTotal : Math.round(savedVals.holeTotal || 0);
              const isLocked = !!(golfConfig?.holes?.find((x) => x.id === h.id)?.locked);

              return (
                <details key={h.id} className="py-2 group">
                  <summary className="list-none cursor-pointer px-2 py-2">
                    <div
                      className="w-full rounded-xl border shadow-sm px-3 py-2 flex items-center justify-between bg-black/50 transition-colors border-neutral-800"
                      style={{ color: PUBGOLF_GOLD }}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-white">{h.name}</span>
                        <span
                          className="rounded-full text-xs px-2 py-[2px]"
                          style={{ background: "#1d1f22", color: PUBGOLF_GOLD }}
                        >
                          {editing ? "editing" : "view"}
                        </span>
                      </div>

                      <span className="text-sm text-white flex items-center gap-2">
                        Total: <strong style={{ color: PUBGOLF_GOLD }}>{displayTotal}</strong>
                        {savedVals.confirmed && !editing && (
                          <span
                            className="text-[11px] px-2 py-[2px] rounded-full"
                            style={{ background: "#1d1f22", color: PUBGOLF_GOLD }}
                          >
                            confirmed
                          </span>
                        )}
                        {isLocked && (
                          <span className="text-[11px] px-2 py-[2px] rounded-full bg-red-700/30 text-red-300">
                            locked
                          </span>
                        )}
                      </span>
                    </div>
                  </summary>

                  <div className="px-2 pb-4">
                    <div className="rounded-2xl p-3 bg-black/60 border border-neutral-800 text-white space-y-3">
                      {isAdmin && (
                        <div className="grid sm:grid-cols-[1fr_auto] gap-2 items-end">
                          <div>
                            <Label className="text-white">Hole name</Label>
                            <Input
                              className="mt-1 bg-white text-black"
                              value={renameBuf[h.id] ?? h.name}
                              onChange={(e) =>
                                setRenameBuf((p) => ({ ...p, [h.id]: e.target.value }))
                              }
                            />
                          </div>
                          <Button
                            style={{ background: PUBGOLF_GOLD, color: "black" }}
                            onClick={() => {
                              const newName = (renameBuf[h.id] ?? h.name).trim();
                              if (!newName) return toast.error("Name can’t be empty");
                              if (newName === h.name) return toast.info("No changes");
                              onRenameHole?.(h.id, newName);
                            }}
                          >
                            Save name
                          </Button>
                        </div>
                      )}

                      <div className="grid sm:grid-cols-3 gap-3">
                        <div>
                          <Label className="text-white">Total sips</Label>
                          <br />
                          <SpinNumber
                            value={vals.sips}
                            setValue={(v) => setField(h.id, "sips", v)}
                            step={1}
                            allowNegative={false}
                            min={0}
                          />
                        </div>
                        <div>
                          <Label className="text-white">Bonuses</Label>
                          <br />
                          <SpinNumber
                            value={vals.bonuses}
                            setValue={(v) => setField(h.id, "bonuses", v)}
                            step={1}
                          />
                        </div>
                        <div>
                          <Label className="text-white">Penalties</Label>
                          <br />
                          <SpinNumber
                            value={vals.penalties}
                            setValue={(v) => setField(h.id, "penalties", v)}
                            step={1}
                          />
                        </div>
                      </div>

                      <Separator className="border-neutral-800" />
                      <Row className="justify-between">
                        <div className="text-sm text-neutral-300">Hole total</div>
                        <div className="text-xl font-semibold" style={{ color: PUBGOLF_GOLD }}>
                          {displayTotal}
                        </div>
                      </Row>

                      <Row className="gap-2 justify-end">
                        {!editing ? (
                          <>
                            {isAdmin && (
                              <Button
                                variant="outline"
                                className="bg-white text-black"
                                onClick={() => onToggleLock?.(h.id, !isLocked)}
                              >
                                {isLocked ? "Unlock hole" : "Lock hole"}
                              </Button>
                            )}
                            {!isLocked && savedVals.confirmed && (
                              <Button
                                variant="outline"
                                className="bg-white text-black"
                                onClick={() => openEdit(h.id)}
                              >
                                Edit
                              </Button>
                            )}
                            {!isLocked && !savedVals.confirmed && (
                              <Button
                                style={{ background: PUBGOLF_GOLD, color: "black" }}
                                onClick={() => confirmHole(h)}
                              >
                                Confirm
                              </Button>
                            )}
                          </>
                        ) : (
                          <>
                            {isAdmin && (
                              <Button
                                variant="outline"
                                className="bg-white text-black"
                                onClick={() => onToggleLock?.(h.id, !isLocked)}
                              >
                                {isLocked ? "Unlock hole" : "Lock hole"}
                              </Button>
                            )}
                            <Button variant="ghost" onClick={() => cancelEdit(h)}>
                              Cancel
                            </Button>
                            <Button
                              style={{ background: PUBGOLF_GOLD, color: "black" }}
                              onClick={() => confirmHole(h)}
                            >
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
      if (!s.confirmed) continue; // only confirmed scores count
      const key = s.teamName;
      const prev = map.get(key) || 0;
      map.set(key, prev + Math.round(Number(s.holeTotal) || 0));
    }
    return Array.from(map.entries())
      .map(([team, total]) => ({ team, total }))
      .sort((a, b) => a.total - b.total);
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
              {totals.map((row, i) => (
                <tr key={row.team} className="border-t border-neutral-800">
                  <td className="p-3" style={{ color: PUBGOLF_GOLD }}>
                    {i + 1}
                  </td>
                  <td className="p-3">{row.team}</td>
                  <td className="p-3 text-right font-semibold">{row.total}</td>
                </tr>
              ))}
              {totals.length === 0 && (
                <tr>
                  <td className="p-3 text-neutral-400" colSpan={3}>
                    No scores yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------- Page shell ----------
function PubGolfPage({
  golfConfig,
  teamName,
  userName,
  userEmail,
  scores,
  menuOpen,
  setMenuOpen,
  isAdmin,
  setIsAdmin,
  setShowAdminModal,
  onLogout,
  onToggleLock,
  onClearAllScores,
  resetNonce,
}) {
  const [t, setT] = useState("scorecard"); // "scorecard" | "ladder"

  // Admin: rename hole and persist
  const renameHole = async (holeId, newName) => {
    const roundRef = doc(db, "golf_rounds", ROUND_ID);
    try {
      const holes = Array.isArray(golfConfig.holes) ? golfConfig.holes : [];
      const updated = holes.map((h) => (h.id === holeId ? { ...h, name: newName } : h));
      await setDoc(roundRef, { holes: updated }, { merge: true });
      toast.success("Hole name updated");
    } catch (e) {
      console.error(e);
      toast.error("Failed to update hole name");
    }
  };

  return (
    <div className="min-h-screen p-4 md:p-8" style={{ background: PUBGOLF_BLACK }}>
      <div className="mx-auto max-w-6xl">
        {/* Header */}
        <div className="relative mb-4 z-40">
          <Row className="items-center gap-3 pr-14">
            <img
              src="/localz-5yr.png"
              alt="Localz • 5 Year Anniversary"
              className="h-10 w-auto md:h-12 shrink-0"
              style={{ filter: "drop-shadow(0 1px 2px rgba(0,0,0,.5))" }}
              onError={(e) => (e.currentTarget.style.display = "none")}
            />
            <h1 className="text-2xl md:text-3xl font-bold text-white">
              {golfConfig?.title || "Pub Golf 2025: Cairns"}
            </h1>
          </Row>

          {/* Gold handle */}
          <button
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            title={menuOpen ? "Close menu" : "Open menu"}
            onClick={() => setMenuOpen((v) => !v)}
            className="absolute right-0 top-0 w-11 h-12 rounded-l-full rounded-r-none flex items-center justify-center shadow-md z-40"
            style={{ background: PUBGOLF_GOLD, border: "none" }}
          >
            <span className="w-8 h-8 rounded-full bg-white flex items-center justify-center">
              {menuOpen ? (
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke={PUBGOLF_GOLD} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 6l6 6-6 6" />
                </svg>
              ) : (
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke={PUBGOLF_GOLD} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M15 18l-6-6 6-6" />
                </svg>
              )}
            </span>
          </button>
        </div>

        {/* Slide-out side menu */}
        <div className="fixed inset-0 z-[120] pointer-events-none">
          <div
            className={`absolute inset-0 transition-opacity duration-300 ease-out ${
              menuOpen ? "opacity-100 pointer-events-auto" : "opacity-0"
            }`}
            style={{ background: "rgba(0,0,0,0.6)" }}
            onClick={() => setMenuOpen(false)}
          />

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
            <div className="h-full shadow-xl" style={{ background: "#111111", color: "#fff" }}>
              <div className="flex items-center justify-between h-12 px-3" style={{ background: PUBGOLF_GOLD, color: "#000" }}>
                <div className="text-sm font-semibold">Menu</div>
                <button
                  aria-label="Close menu"
                  title="Close"
                  onClick={() => setMenuOpen(false)}
                  className="inline-flex items-center justify-center w-9 h-9 rounded-full shadow-sm focus:outline-none focus:ring-2"
                  style={{ background: "#000", color: "#fff" }}
                >
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9 6l6 6-6 6" />
                  </svg>
                </button>
              </div>

              <div className="p-4 h-full flex flex-col">
                <div className="space-y-4">
                  <div className="text-xs opacity-90">
                    Signed in as <strong style={{ color: PUBGOLF_GOLD }}>{userName || "—"}</strong>
                    {userEmail ? <span className="block break-all opacity-90">{userEmail}</span> : null}
                    <div className="mt-1 opacity-80">
                      Team: <strong>{teamName || "—"}</strong>
                    </div>
                  </div>

                  <Button
                    variant="outline"
                    className="w-full shadow-sm !border-0"
                    style={{ background: "#000", color: "#fff" }}
                    onClick={onLogout}
                  >
                    Log out
                  </Button>

                  {!isAdmin ? (
                    <Button
                      className="w-full shadow-sm"
                      style={{ background: "#000", color: "#ffffff" }}
                      onClick={() => {
                        setMenuOpen(false);
                        setShowAdminModal(true);
                      }}
                    >
                      Admin login
                    </Button>
                  ) : (
                    <div className="space-y-2">
                      <Badge className="inline-block" style={{ background: PUBGOLF_GOLD, color: "#000" }}>
                        Admin
                      </Badge>

                      <Button
                        variant="outline"
                        className="w-full shadow-sm !border-0"
                        style={{ background: "#000", color: "#ffffff" }}
                        onClick={() => {
                          setIsAdmin(false);
                          localStorage.removeItem(LS_ADMIN);
                          setMenuOpen(false);
                          toast.success("Admin disabled");
                        }}
                      >
                        Turn off admin
                      </Button>

                      <Button
                        className="w-full shadow-sm"
                        style={{ background: PUBGOLF_GOLD, color: "#000" }}
                        onClick={() => {
                          setMenuOpen(false);
                          onClearAllScores?.();
                        }}
                      >
                        Clear all scores (round)
                      </Button>
                    </div>
                  )}
                </div>

                <div className="flex-1 flex items-center justify-center py-6">
                  <img
                    src="/localz-5yr.png"
                    alt="Localz • 5 Years"
                    className="max-w-[75%] max-h-48 object-contain"
                    style={{ filter: "drop-shadow(0 6px 14px rgba(0,0,0,.25))" }}
                    onError={(e) => (e.currentTarget.style.display = "none")}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div
          className="grid grid-cols-2 rounded-none overflow-hidden mb-3 sticky top-0 z-50 shadow-sm isolate"
          style={{ background: PUBGOLF_GOLD }}
        >
          {[
            { id: "scorecard", label: "Scorecard" },
            { id: "ladder", label: "Ladder" },
          ].map((x) => (
            <button
              key={x.id}
              onClick={() => setT(x.id)}
              className={`py-2.5 text-sm w-full ${
                t === x.id ? "bg-white text-black border-b-4" : "text-black/90"
              }`}
              style={t === x.id ? { borderColor: PUBGOLF_GOLD } : {}}
            >
              {x.label}
            </button>
          ))}
        </div>

        {t === "scorecard" ? (
          <Scorecard
            key={resetNonce}
            roundId={ROUND_ID}
            golfConfig={golfConfig}
            teamName={teamName}
            userName={userName}
            isAdmin={isAdmin}
            onToggleLock={onToggleLock}
            onRenameHole={renameHole}
          />
        ) : (
          <GolfLadder roundId={ROUND_ID} scores={scores} />
        )}
      </div>
    </div>
  );
}
