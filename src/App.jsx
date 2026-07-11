import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  collection,
  deleteDoc,
  deleteField,
  doc,
  getDocs,
  getDocsFromServer,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  where,
  writeBatch,
} from "firebase/firestore";
import { db } from "./firebase";
import { findPlayerByLoginCode, PLAYER_BY_ID, PLAYERS } from "./data/players";

// -----------------------------------------------------------------------------
// Event settings
// -----------------------------------------------------------------------------
const ROUND_ID = "auckland2026";
const DEFAULT_TITLE = "Pub Golf 2026: Auckland";
const DEFAULT_LOCATION = "Auckland";
const DEFAULT_YEAR = 2026;
const ADMIN_PIN = "2855";

const LS_PLAYER_ID = "pubgolf_player_id_v2";
const LS_ADMIN = "pubgolf_admin_v2";

const COLORS = {
  midnight: "#020817",
  deepNavy: "#061a46",
  royalBlue: "#0b46c8",
  electricBlue: "#2878ff",
  panel: "#071225",
  gold: "#d5ae52",
  brightGold: "#f3da8a",
  paleGold: "#fff1bd",
};

const defaultHoles = Array.from({ length: 9 }, (_, index) => ({
  id: `h${index + 1}`,
  name: `Hole ${index + 1}`,
  venue: "",
  drink: "",
  active: true,
  locked: false,
}));

const DEFAULT_BONUS_RULES = [
  { id: "bonus_save_drink", description: "Save a drink from spilling", value: 1 },
  { id: "bonus_perfect_hole", description: "Perfect hole (no penalties)", value: 1 },
  { id: "bonus_team_hole_one", description: "Team hole in 1", value: 1 },
  { id: "bonus_outfit_compliment", description: "Outfit compliment", value: 1 },
  { id: "bonus_win_skull_off", description: "Win skull-off", value: 2 },
  { id: "bonus_split_g", description: "Split the G", value: 3 },
  { id: "bonus_catch_vomit", description: "Catch and drink your vomit", value: 9 },
];

const DEFAULT_PENALTY_RULES = [
  { id: "penalty_fall_over", description: "Fall over", value: 1 },
  { id: "penalty_spill_drink", description: "Spill a drink", value: 1 },
  { id: "penalty_buffalo", description: "Buffalo", value: 1 },
  { id: "penalty_lose_skull_off", description: "Lose skull-off", value: 2 },
  { id: "penalty_refused_service", description: "Refused service", value: 2 },
  { id: "penalty_taxi", description: "Taxi (smash a glass)", value: 2 },
  { id: "penalty_failing_water_hole", description: "Failing water hole", value: 3 },
  { id: "penalty_throwing_up", description: "Throwing up", value: 3 },
  { id: "penalty_kicked_out", description: "Get kicked out", value: 3 },
];

const emptyScore = {
  sips: 0,
  bonuses: 0,
  penalties: 0,
  modifier: 0,
  holeTotal: 0,
  confirmed: false,
};

const toast = {
  success(message) {
    console.info(message);
  },
  info(message) {
    console.log(message);
  },
  error(message) {
    console.error(message);
    window.alert(message);
  },
};

function scoreDocumentId(roundId, teamId, holeId) {
  return `${roundId}__${teamId}__${holeId}`;
}

function teamDocumentId(roundId, teamId) {
  return `${roundId}__${teamId}`;
}

function assignmentDocumentId(roundId, playerId) {
  return `${roundId}__${playerId}`;
}

function assignmentDocumentRef(playerId) {
  return doc(
    db,
    "golf_player_assignments",
    assignmentDocumentId(ROUND_ID, playerId),
  );
}

function sortTeamsByName(teams) {
  return [...teams].sort((a, b) =>
    String(a.name || "").localeCompare(String(b.name || "")),
  );
}

function buildPlayerTeamState(teams) {
  const playerTeamMap = {};
  const conflictMap = new Map();

  for (const team of teams) {
    for (const memberId of team.memberIds || []) {
      const existingTeamId = playerTeamMap[memberId];
      if (existingTeamId && existingTeamId !== team.teamId) {
        const teamIds = conflictMap.get(memberId) || new Set([existingTeamId]);
        teamIds.add(team.teamId);
        conflictMap.set(memberId, teamIds);
      } else if (!existingTeamId) {
        playerTeamMap[memberId] = team.teamId;
      }
    }
  }

  const conflicts = Array.from(conflictMap.entries()).map(
    ([playerId, teamIds]) => ({
      playerId,
      teamIds: Array.from(teamIds),
    }),
  );

  return { playerTeamMap, conflicts };
}

async function fetchRoundTeamsFromServer() {
  const teamsQuery = query(
    collection(db, "golf_teams"),
    where("roundId", "==", ROUND_ID),
  );
  const snapshot = await getDocsFromServer(teamsQuery);
  return sortTeamsByName(
    snapshot.docs.map((teamDoc) => ({ id: teamDoc.id, ...teamDoc.data() })),
  );
}

async function reconcilePlayerAssignments(liveTeams) {
  const { playerTeamMap, conflicts } = buildPlayerTeamState(liveTeams);
  const conflictingPlayerIds = new Set(
    conflicts.map((conflict) => conflict.playerId),
  );

  const assignmentsQuery = query(
    collection(db, "golf_player_assignments"),
    where("roundId", "==", ROUND_ID),
  );
  const assignmentSnapshot = await getDocsFromServer(assignmentsQuery);
  const batch = writeBatch(db);
  const existingByPlayerId = new Map();

  assignmentSnapshot.docs.forEach((assignmentDoc) => {
    const data = assignmentDoc.data();
    const playerId = data.playerId;
    if (!playerId || conflictingPlayerIds.has(playerId)) {
      batch.delete(assignmentDoc.ref);
      return;
    }

    existingByPlayerId.set(playerId, { ref: assignmentDoc.ref, data });
    if (playerTeamMap[playerId] !== data.teamId) {
      batch.delete(assignmentDoc.ref);
    }
  });

  Object.entries(playerTeamMap).forEach(([playerId, teamId]) => {
    if (conflictingPlayerIds.has(playerId)) return;
    const existing = existingByPlayerId.get(playerId)?.data;
    if (existing?.teamId === teamId) return;
    batch.set(
      assignmentDocumentRef(playerId),
      {
        roundId: ROUND_ID,
        playerId,
        teamId,
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );
  });

  // The old round-level playerTeamMap is never used as a source of truth.
  // It is deleted during every repair so stale values cannot block team creation.
  batch.set(
    doc(db, "golf_rounds", ROUND_ID),
    {
      playerTeamMap: deleteField(),
      teamAssignmentVersion: 2,
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );

  await batch.commit();
}

function createTeamId() {
  const randomPart = Math.random().toString(36).slice(2, 7);
  return `team_${Date.now()}_${randomPart}`;
}

function formatSignedNumber(value) {
  const number = Math.round(Number(value) || 0);
  if (number > 0) return `+${number}`;
  return String(number);
}

function getInitials(name) {
  return String(name || "?")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("") || "?";
}

function getFirstName(name) {
  return String(name || "Player").trim().split(/\s+/)[0] || "Player";
}

function makeDefaultTeamName(memberIds) {
  const memberNames = memberIds
    .map((id) => PLAYER_BY_ID[id]?.name)
    .filter(Boolean)
    .map(getFirstName);

  if (memberNames.length === 1) return `${memberNames[0]}'s Team`;
  if (memberNames.length >= 2) return `${memberNames[0]} & ${memberNames[1]}`;
  return "New Team";
}

function normalizeHoles(holes) {
  const source = Array.isArray(holes) && holes.length ? holes : defaultHoles;
  return source.map((hole, index) => ({
    id: hole.id || `h${index + 1}`,
    name: hole.name || `Hole ${index + 1}`,
    venue: hole.venue || "",
    drink: hole.drink || "",
    active: hole.active !== false,
    locked: Boolean(hole.locked),
  }));
}

function normalizeRules(rules, fallback) {
  const source = Array.isArray(rules) ? rules : fallback;
  return source.map((rule, index) => ({
    id: rule.id || `rule_${index + 1}`,
    description: String(rule.description || "").trim(),
    value: Math.max(1, Math.round(Number(rule.value) || 1)),
  }));
}

function createRuleId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function formatTimestamp(value) {
  try {
    const date = typeof value?.toDate === "function" ? value.toDate() : new Date(value);
    if (Number.isNaN(date.getTime())) return "Not recorded";
    return new Intl.DateTimeFormat("en-AU", {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  } catch {
    return "Not recorded";
  }
}

// -----------------------------------------------------------------------------
// Reusable UI pieces
// -----------------------------------------------------------------------------
function Row({ className = "", children }) {
  return <div className={`flex items-center ${className}`}>{children}</div>;
}

function Col({ className = "", children }) {
  return <div className={`flex flex-col ${className}`}>{children}</div>;
}

function PremiumCard({ className = "", children, ...props }) {
  return (
    <div className={`premium-card ${className}`} {...props}>
      {children}
    </div>
  );
}

function Button({
  className = "",
  variant = "gold",
  size = "md",
  type = "button",
  ...props
}) {
  const variants = {
    gold: "button-gold",
    blue: "button-blue",
    outline: "button-outline",
    ghost: "button-ghost",
    danger: "button-danger",
  };

  const sizes = {
    sm: "h-9 px-3 text-sm",
    md: "h-11 px-4",
    lg: "h-12 px-5 text-lg",
  };

  return (
    <button
      type={type}
      className={`app-button ${variants[variant]} ${sizes[size]} ${className}`}
      {...props}
    />
  );
}

const Input = React.forwardRef(function Input(
  { className = "", ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      className={`app-input ${className}`}
      {...props}
    />
  );
});

function Select({ className = "", children, ...props }) {
  return (
    <select className={`app-input ${className}`} {...props}>
      {children}
    </select>
  );
}

function Label({ className = "", children }) {
  return <label className={`app-label ${className}`}>{children}</label>;
}

function Badge({ className = "", children }) {
  return <span className={`app-badge ${className}`}>{children}</span>;
}

function PlayerAvatar({ player, size = "md", className = "" }) {
  const [imageFailed, setImageFailed] = useState(false);
  const sizes = {
    xs: "avatar-xs",
    sm: "avatar-sm",
    md: "avatar-md",
    lg: "avatar-lg",
    xl: "avatar-xl",
  };
  const avatarName = player?.fullName || player?.name || "Unknown player";
  const photoPosition = player?.photoPosition || "50% 50%";
  const photoScale = Math.max(1, Number(player?.photoScale) || 1);

  useEffect(() => {
    setImageFailed(false);
  }, [player?.photoUrl]);

  return (
    <div
      className={`player-avatar ${sizes[size] || sizes.md} ${className}`}
      title={avatarName}
    >
      <div className="player-avatar-inner">
        {player?.photoUrl && !imageFailed ? (
          <img
            src={player.photoUrl}
            alt={avatarName}
            style={{
              objectPosition: photoPosition,
              transform: `scale(${photoScale})`,
              transformOrigin: photoPosition,
            }}
            onError={() => setImageFailed(true)}
          />
        ) : (
          <span>{getInitials(avatarName)}</span>
        )}
      </div>
    </div>
  );
}

function PlayerFifaCard({ player, size = "md", className = "" }) {
  const [imageFailed, setImageFailed] = useState(false);
  const sizes = {
    sm: "fifa-card-sm",
    md: "fifa-card-md",
    lg: "fifa-card-lg",
    xl: "fifa-card-xl",
  };
  const playerName = player?.fullName || player?.name || "Unknown player";

  useEffect(() => {
    setImageFailed(false);
  }, [player?.cardUrl]);

  if (!player?.cardUrl || imageFailed) {
    return (
      <div className={`fifa-card fifa-card-fallback ${sizes[size] || sizes.md} ${className}`}>
        <PlayerAvatar player={player} size="xl" />
        <strong>{playerName}</strong>
      </div>
    );
  }

  return (
    <img
      src={player.cardUrl}
      alt={`${playerName} player card`}
      className={`fifa-card ${sizes[size] || sizes.md} ${className}`}
      loading="lazy"
      onError={() => setImageFailed(true)}
    />
  );
}

function findTeamForPlayer(playerId, teams) {
  return (
    teams.find((team) =>
      Array.isArray(team.memberIds) ? team.memberIds.includes(playerId) : false,
    ) || null
  );
}

function getTeamPlayers(team) {
  return (team?.memberIds || [])
    .map((memberId) => PLAYER_BY_ID[memberId])
    .filter(Boolean);
}

function PremiumBackground() {
  return (
    <div className="premium-background" aria-hidden="true">
      <div className="background-video-shell">
        <video
          className="background-video"
          autoPlay
          muted
          loop
          playsInline
          preload="auto"
          poster="/toty-theme/graphics/toty-bg-main.png"
        >
          <source src="/toty-theme/graphics/toty-bg-animated.mp4" type="video/mp4" />
        </video>
        <img
          src="/toty-theme/graphics/toty-bg-animated.gif"
          alt=""
          className="background-video-fallback"
        />
      </div>
      <div className="background-scene background-scene-soft" />
      <div className="background-scene background-scene-side" />
      <div className="background-overlay background-overlay-top" />
      <div className="background-overlay background-overlay-bottom" />
      <div className="background-grid-shine" />
      <div className="background-stars" />
    </div>
  );
}

function SectionHeading({ eyebrow, title, description, action }) {
  return (
    <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        {eyebrow ? <div className="section-eyebrow">{eyebrow}</div> : null}
        <h2 className="section-title">{title}</h2>
        {description ? (
          <p className="mt-1 max-w-2xl text-sm text-blue-100/70">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Main application
// -----------------------------------------------------------------------------
export default function PubGolfApp() {
  const [playerId, setPlayerId] = useState(() => {
    try {
      return localStorage.getItem(LS_PLAYER_ID) || "";
    } catch {
      return "";
    }
  });
  const [loginCode, setLoginCode] = useState("");
  const [isAdmin, setIsAdmin] = useState(() => {
    try {
      return localStorage.getItem(LS_ADMIN) === "1";
    } catch {
      return false;
    }
  });
  const [showAdminModal, setShowAdminModal] = useState(false);
  const [adminPinInput, setAdminPinInput] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [resetNonce, setResetNonce] = useState(0);
  const [golfConfig, setGolfConfig] = useState({
    title: DEFAULT_TITLE,
    location: DEFAULT_LOCATION,
    year: DEFAULT_YEAR,
    holes: defaultHoles,
    bonusRules: DEFAULT_BONUS_RULES,
    penaltyRules: DEFAULT_PENALTY_RULES,
  });
  const [teams, setTeams] = useState([]);
  const [scores, setScores] = useState([]);
  const [roundLoaded, setRoundLoaded] = useState(false);
  const [teamsLoaded, setTeamsLoaded] = useState(false);
  const [scoresLoaded, setScoresLoaded] = useState(false);
  const [syncError, setSyncError] = useState("");
  const teamMutationRef = useRef(false);
  const assignmentRepairSignatureRef = useRef("");
  const legacyMapCleanupInFlightRef = useRef(false);
  const pinInputRef = useRef(null);

  const currentPlayer = PLAYER_BY_ID[playerId] || null;
  const currentTeam = useMemo(
    () =>
      teams.find((team) =>
        Array.isArray(team.memberIds) ? team.memberIds.includes(playerId) : false,
      ) || null,
    [playerId, teams],
  );

  const dataReady = roundLoaded && teamsLoaded && scoresLoaded;

  useEffect(() => {
    if (showAdminModal) pinInputRef.current?.focus();
  }, [showAdminModal]);

  useEffect(() => {
    const roundRef = doc(db, "golf_rounds", ROUND_ID);
    const unsubscribe = onSnapshot(
      roundRef,
      { includeMetadataChanges: true },
      (snapshot) => {
        if (snapshot.exists()) {
          const data = snapshot.data();
          setGolfConfig({
            title: data.title || DEFAULT_TITLE,
            location: data.location || DEFAULT_LOCATION,
            year: Math.round(Number(data.year) || DEFAULT_YEAR),
            holes: normalizeHoles(data.holes),
            bonusRules: normalizeRules(data.bonusRules, DEFAULT_BONUS_RULES),
            penaltyRules: normalizeRules(data.penaltyRules, DEFAULT_PENALTY_RULES),
          });

          const legacyMap = data.playerTeamMap;
          const legacyMapExists =
            legacyMap &&
            typeof legacyMap === "object" &&
            Object.keys(legacyMap).length > 0;
          if (legacyMapExists && !legacyMapCleanupInFlightRef.current) {
            legacyMapCleanupInFlightRef.current = true;
            setDoc(
              roundRef,
              {
                playerTeamMap: deleteField(),
                teamAssignmentVersion: 2,
                updatedAt: serverTimestamp(),
              },
              { merge: true },
            )
              .catch((error) => {
                console.error("Legacy playerTeamMap cleanup failed", error);
              })
              .finally(() => {
                legacyMapCleanupInFlightRef.current = false;
              });
          }
        } else if (!snapshot.metadata.fromCache) {
          setDoc(roundRef, {
            title: DEFAULT_TITLE,
            location: DEFAULT_LOCATION,
            year: DEFAULT_YEAR,
            holes: defaultHoles,
            bonusRules: DEFAULT_BONUS_RULES,
            penaltyRules: DEFAULT_PENALTY_RULES,
            createdAt: serverTimestamp(),
          }).catch((error) => {
            console.error(error);
            setSyncError("The event could not be created in Firebase.");
          });
        }

        if (!snapshot.metadata.fromCache) {
          setRoundLoaded(true);
        }
      },
      (error) => {
        console.error(error);
        setSyncError("The event details could not be loaded from Firebase.");
      },
    );

    return () => unsubscribe();
  }, []);

  useEffect(() => {
    const teamsQuery = query(
      collection(db, "golf_teams"),
      where("roundId", "==", ROUND_ID),
    );
    const unsubscribe = onSnapshot(
      teamsQuery,
      { includeMetadataChanges: true },
      (snapshot) => {
        const nextTeams = sortTeamsByName(
          snapshot.docs.map((teamDoc) => ({ id: teamDoc.id, ...teamDoc.data() })),
        );
        setTeams(nextTeams);

        if (!snapshot.metadata.fromCache) {
          setTeamsLoaded(true);
        }
      },
      (error) => {
        console.error(error);
        setSyncError("Teams could not be loaded from Firebase.");
      },
    );

    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!teamsLoaded) return;

    const signature = JSON.stringify(
      teams.map((team) => ({
        teamId: team.teamId,
        memberIds: [...(team.memberIds || [])].sort(),
      })),
    );
    if (assignmentRepairSignatureRef.current === signature) return;
    assignmentRepairSignatureRef.current = signature;

    reconcilePlayerAssignments(teams).catch((error) => {
      console.error("Player assignment repair failed", error);
      assignmentRepairSignatureRef.current = "";
    });
  }, [teams, teamsLoaded]);

  useEffect(() => {
    const scoresQuery = query(
      collection(db, "golf_scores"),
      where("roundId", "==", ROUND_ID),
    );
    const unsubscribe = onSnapshot(
      scoresQuery,
      { includeMetadataChanges: true },
      (snapshot) => {
        const nextScores = snapshot.docs.map((scoreDoc) => ({
          id: scoreDoc.id,
          ...scoreDoc.data(),
        }));
        setScores(nextScores);

        if (!snapshot.metadata.fromCache) {
          setScoresLoaded(true);
        }
      },
      (error) => {
        console.error(error);
        setSyncError("Scores could not be loaded from Firebase.");
      },
    );

    return () => unsubscribe();
  }, []);

  const handlePlayerLogin = () => {
    const player = findPlayerByLoginCode(loginCode);
    if (!player) {
      toast.error("That player login code was not recognised.");
      return;
    }

    try {
      localStorage.setItem(LS_PLAYER_ID, player.id);
    } catch {
      // The app still works for the current page if local storage is unavailable.
    }

    setPlayerId(player.id);
    setLoginCode("");
    toast.success(`Welcome, ${player.name}`);
  };

  const handleLogout = () => {
    try {
      localStorage.removeItem(LS_PLAYER_ID);
      localStorage.removeItem(LS_ADMIN);
    } catch {
      // Nothing else is required if local storage is unavailable.
    }
    setPlayerId("");
    setIsAdmin(false);
    setMenuOpen(false);
    toast.success("Logged out");
  };

  const unlockAdmin = () => {
    if (adminPinInput !== ADMIN_PIN) {
      toast.error("Incorrect admin PIN.");
      return;
    }

    try {
      localStorage.setItem(LS_ADMIN, "1");
    } catch {
      // The admin session will still work until the page is refreshed.
    }

    setIsAdmin(true);
    setAdminPinInput("");
    setShowAdminModal(false);
    toast.success("Admin tools unlocked");
  };

  const disableAdmin = () => {
    try {
      localStorage.removeItem(LS_ADMIN);
    } catch {
      // Ignore local storage errors.
    }
    setIsAdmin(false);
    setMenuOpen(false);
  };

  const toggleHoleLock = async (holeId, nextLocked) => {
    if (!isAdmin) return;

    try {
      const updatedHoles = (golfConfig.holes || []).map((hole) =>
        hole.id === holeId ? { ...hole, locked: Boolean(nextLocked) } : hole,
      );
      await setDoc(
        doc(db, "golf_rounds", ROUND_ID),
        { holes: updatedHoles },
        { merge: true },
      );
      toast.success(nextLocked ? "Hole locked" : "Hole unlocked");
    } catch (error) {
      console.error(error);
      toast.error("The hole lock could not be changed.");
    }
  };

  const renameHole = async (holeId, newName) => {
    if (!isAdmin) return;

    try {
      const updatedHoles = (golfConfig.holes || []).map((hole) =>
        hole.id === holeId ? { ...hole, name: newName } : hole,
      );
      await setDoc(
        doc(db, "golf_rounds", ROUND_ID),
        { holes: updatedHoles },
        { merge: true },
      );
      toast.success("Hole name updated");
    } catch (error) {
      console.error(error);
      toast.error("The hole name could not be updated.");
    }
  };

  const saveEventDetails = async ({ title, location, year }) => {
    if (!isAdmin) return;

    const cleanTitle = String(title || "").trim();
    const cleanLocation = String(location || "").trim();
    const cleanYear = Math.round(Number(year) || 0);

    if (!cleanTitle || !cleanLocation || cleanYear < 2000 || cleanYear > 2100) {
      toast.error("Enter a title, location and valid event year.");
      return;
    }

    try {
      await setDoc(
        doc(db, "golf_rounds", ROUND_ID),
        {
          title: cleanTitle,
          location: cleanLocation,
          year: cleanYear,
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );
      toast.success("Event details updated");
    } catch (error) {
      console.error(error);
      toast.error("The event details could not be updated.");
    }
  };

  const updateHole = async (holeId, changes, successMessage = "Hole updated") => {
    if (!isAdmin) return;

    try {
      const updatedHoles = (golfConfig.holes || []).map((hole) =>
        hole.id === holeId ? { ...hole, ...changes } : hole,
      );
      await setDoc(
        doc(db, "golf_rounds", ROUND_ID),
        { holes: updatedHoles, updatedAt: serverTimestamp() },
        { merge: true },
      );
      toast.success(successMessage);
    } catch (error) {
      console.error(error);
      toast.error("The hole could not be updated.");
    }
  };

  const addHole = async () => {
    if (!isAdmin) return;

    const nextNumber = (golfConfig.holes || []).length + 1;
    const newHole = {
      id: `h_${Date.now()}`,
      name: `Hole ${nextNumber}`,
      venue: "",
      drink: "",
      active: true,
      locked: false,
    };

    try {
      await setDoc(
        doc(db, "golf_rounds", ROUND_ID),
        {
          holes: [...(golfConfig.holes || []), newHole],
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );
      toast.success("Hole added");
    } catch (error) {
      console.error(error);
      toast.error("The hole could not be added.");
    }
  };

  const moveHole = async (holeId, direction) => {
    if (!isAdmin) return;

    const holes = [...(golfConfig.holes || [])];
    const currentIndex = holes.findIndex((hole) => hole.id === holeId);
    const nextIndex = currentIndex + direction;
    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= holes.length) return;

    [holes[currentIndex], holes[nextIndex]] = [holes[nextIndex], holes[currentIndex]];

    try {
      await setDoc(
        doc(db, "golf_rounds", ROUND_ID),
        { holes, updatedAt: serverTimestamp() },
        { merge: true },
      );
      toast.success("Hole order updated");
    } catch (error) {
      console.error(error);
      toast.error("The hole order could not be updated.");
    }
  };

  const deleteHole = async (hole) => {
    if (!isAdmin || !hole?.id) return;
    if ((golfConfig.holes || []).length <= 1) {
      toast.error("The event must keep at least one hole.");
      return;
    }

    if (
      !window.confirm(
        `Delete ${hole.name}? Any saved scores for this hole will also be deleted.`,
      )
    ) {
      return;
    }

    try {
      const nextHoles = (golfConfig.holes || []).filter(
        (existingHole) => existingHole.id !== hole.id,
      );
      await setDoc(
        doc(db, "golf_rounds", ROUND_ID),
        { holes: nextHoles, updatedAt: serverTimestamp() },
        { merge: true },
      );

      const scoreSnapshot = await getDocs(
        query(collection(db, "golf_scores"), where("roundId", "==", ROUND_ID)),
      );
      const matchingScores = scoreSnapshot.docs.filter(
        (scoreDoc) => scoreDoc.data().holeId === hole.id,
      );
      if (matchingScores.length) {
        const batch = writeBatch(db);
        matchingScores.forEach((scoreDoc) => batch.delete(scoreDoc.ref));
        await batch.commit();
      }

      toast.success("Hole deleted");
    } catch (error) {
      console.error(error);
      toast.error("The hole could not be deleted.");
    }
  };

  const setAllHoleLocks = async (locked) => {
    if (!isAdmin) return;

    try {
      const holes = (golfConfig.holes || []).map((hole) => ({
        ...hole,
        locked: Boolean(locked),
      }));
      await setDoc(
        doc(db, "golf_rounds", ROUND_ID),
        { holes, updatedAt: serverTimestamp() },
        { merge: true },
      );
      toast.success(locked ? "All holes locked" : "All holes unlocked");
    } catch (error) {
      console.error(error);
      toast.error("The hole locks could not be updated.");
    }
  };

  const saveBonusPenaltyRules = async (bonusRules, penaltyRules) => {
    if (!isAdmin) return;

    const cleanRules = (rules) =>
      rules.map((rule) => ({
        id: rule.id,
        description: String(rule.description || "").trim(),
        value: Math.max(1, Math.round(Number(rule.value) || 1)),
      }));
    const cleanBonuses = cleanRules(bonusRules);
    const cleanPenalties = cleanRules(penaltyRules);

    if (
      [...cleanBonuses, ...cleanPenalties].some((rule) => !rule.description)
    ) {
      toast.error("Every bonus and penalty needs a description.");
      return;
    }

    try {
      await setDoc(
        doc(db, "golf_rounds", ROUND_ID),
        {
          bonusRules: cleanBonuses,
          penaltyRules: cleanPenalties,
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );
      toast.success("Bonuses and penalties updated");
    } catch (error) {
      console.error(error);
      toast.error("The bonuses and penalties could not be updated.");
    }
  };

  const saveAdminScore = async (team, hole, values) => {
    if (!isAdmin || !team?.teamId || !hole?.id) return;

    const sips = Math.max(0, Math.round(Number(values.sips) || 0));
    const bonuses = Math.max(0, Math.round(Number(values.bonuses) || 0));
    const penalties = Math.max(0, Math.round(Number(values.penalties) || 0));
    const modifier = penalties - bonuses;
    const holeTotal = sips + modifier;

    try {
      await setDoc(
        doc(db, "golf_scores", scoreDocumentId(ROUND_ID, team.teamId, hole.id)),
        {
          roundId: ROUND_ID,
          teamId: team.teamId,
          holeId: hole.id,
          holeName: hole.name,
          sips,
          bonuses,
          penalties,
          modifier,
          holeTotal,
          confirmed: true,
          confirmedByPlayerId: "admin",
          confirmedByName: "Admin correction",
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );
      toast.success(`${team.name} - ${hole.name} updated`);
    } catch (error) {
      console.error(error);
      toast.error("The score could not be updated.");
    }
  };

  const deleteAdminScore = async (team, hole) => {
    if (!isAdmin || !team?.teamId || !hole?.id) return;
    if (!window.confirm(`Delete ${team.name}'s score for ${hole.name}?`)) return;

    try {
      await deleteDoc(
        doc(db, "golf_scores", scoreDocumentId(ROUND_ID, team.teamId, hole.id)),
      );
      toast.success("Score deleted");
    } catch (error) {
      console.error(error);
      toast.error("The score could not be deleted.");
    }
  };

  const beginTeamMutation = () => {
    if (teamMutationRef.current) {
      toast.info("A team change is already being saved.");
      return false;
    }
    teamMutationRef.current = true;
    return true;
  };

  const endTeamMutation = () => {
    teamMutationRef.current = false;
  };

  const createTeam = async (memberIds) => {
    if (!isAdmin) return false;
    if (!teamsLoaded) {
      toast.error("Please wait for the current teams to finish syncing.");
      return false;
    }

    const cleanMemberIds = [...new Set(memberIds.filter(Boolean))];
    if (cleanMemberIds.length < 1 || cleanMemberIds.length > 2) {
      toast.error("A team must contain one or two players.");
      return false;
    }

    if (!beginTeamMutation()) return false;

    try {
      const liveTeams = await fetchRoundTeamsFromServer();
      const { playerTeamMap: livePlayerTeamMap, conflicts } =
        buildPlayerTeamState(liveTeams);

      if (conflicts.length) {
        toast.error(
          "Duplicate player assignments already exist. Disband the incorrect duplicate team before creating another team.",
        );
        return false;
      }

      const alreadyAssigned = cleanMemberIds.find(
        (memberId) => livePlayerTeamMap[memberId],
      );
      if (alreadyAssigned) {
        toast.error(
          `${PLAYER_BY_ID[alreadyAssigned]?.name || "That player"} is already on a team.`,
        );
        return false;
      }

      const teamId = createTeamId();
      const baseName = makeDefaultTeamName(cleanMemberIds);
      const usedNames = new Set(
        liveTeams.map((liveTeam) =>
          String(liveTeam.name || "").trim().toLowerCase(),
        ),
      );
      let name = baseName;
      let suffix = 2;
      while (usedNames.has(name.toLowerCase())) {
        name = `${baseName} ${suffix}`;
        suffix += 1;
      }

      const roundRef = doc(db, "golf_rounds", ROUND_ID);
      const teamRef = doc(
        db,
        "golf_teams",
        teamDocumentId(ROUND_ID, teamId),
      );
      const assignmentRefs = cleanMemberIds.map(assignmentDocumentRef);

      await runTransaction(db, async (transaction) => {
        const assignmentSnapshots = await Promise.all(
          assignmentRefs.map((assignmentRef) => transaction.get(assignmentRef)),
        );
        const referencedTeamIds = [
          ...new Set(
            assignmentSnapshots
              .map((snapshot) => snapshot.data()?.teamId)
              .filter(Boolean),
          ),
        ];
        const referencedTeamRefs = referencedTeamIds.map((assignedTeamId) =>
          doc(db, "golf_teams", teamDocumentId(ROUND_ID, assignedTeamId)),
        );
        const referencedTeamSnapshots = await Promise.all(
          referencedTeamRefs.map((assignedTeamRef) =>
            transaction.get(assignedTeamRef),
          ),
        );
        const referencedTeamsById = new Map(
          referencedTeamIds.map((assignedTeamId, index) => [
            assignedTeamId,
            referencedTeamSnapshots[index],
          ]),
        );

        cleanMemberIds.forEach((memberId, index) => {
          const assignmentSnapshot = assignmentSnapshots[index];
          if (!assignmentSnapshot.exists()) return;
          const assignedTeamId = assignmentSnapshot.data()?.teamId;
          const assignedTeamSnapshot = referencedTeamsById.get(assignedTeamId);
          const assignedTeamData = assignedTeamSnapshot?.data();
          const assignmentIsValid =
            assignedTeamSnapshot?.exists() &&
            assignedTeamData?.roundId === ROUND_ID &&
            Array.isArray(assignedTeamData?.memberIds) &&
            assignedTeamData.memberIds.includes(memberId);

          if (assignmentIsValid) {
            const error = new Error("PLAYER_ALREADY_ASSIGNED");
            error.playerId = memberId;
            throw error;
          }
        });

        transaction.set(teamRef, {
          roundId: ROUND_ID,
          teamId,
          name,
          memberIds: cleanMemberIds,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });

        cleanMemberIds.forEach((memberId, index) => {
          transaction.set(
            assignmentRefs[index],
            {
              roundId: ROUND_ID,
              playerId: memberId,
              teamId,
              updatedAt: serverTimestamp(),
            },
            { merge: true },
          );
        });

        transaction.set(
          roundRef,
          {
            playerTeamMap: deleteField(),
            teamAssignmentVersion: 2,
            updatedAt: serverTimestamp(),
          },
          { merge: true },
        );
      });

      toast.success(`${name} created`);
      return true;
    } catch (error) {
      console.error(error);
      if (error?.message === "PLAYER_ALREADY_ASSIGNED") {
        toast.error(
          `${PLAYER_BY_ID[error.playerId]?.name || "That player"} is already assigned to an existing team. The app has refreshed the assignment check automatically.`,
        );
      } else {
        toast.error(
          "The team could not be created. The current Firebase team list was not changed.",
        );
      }
      return false;
    } finally {
      endTeamMutation();
    }
  };

  const updateTeam = async (team, changes, { skipConfirm = false } = {}) => {
    if (!team?.teamId) return false;
    if (!teamsLoaded) {
      toast.error("Please wait for the current teams to finish syncing.");
      return false;
    }

    const nextName = String(changes.name ?? team.name ?? "").trim();
    const nextMemberIds = [
      ...new Set((changes.memberIds ?? team.memberIds ?? []).filter(Boolean)),
    ];

    if (!nextName) {
      toast.error("The team name cannot be empty.");
      return false;
    }
    if (nextMemberIds.length < 1 || nextMemberIds.length > 2) {
      toast.error("A team must contain one or two players.");
      return false;
    }

    const membershipChanged =
      [...(team.memberIds || [])].sort().join("|") !==
      [...nextMemberIds].sort().join("|");
    const teamHasScores = scores.some(
      (score) => score.teamId === team.teamId && score.confirmed,
    );

    if (membershipChanged && teamHasScores && !skipConfirm) {
      const confirmed = window.confirm(
        "This team already has confirmed scores. The scores will stay with the team after you change its players. Continue?",
      );
      if (!confirmed) return false;
    }

    if (!beginTeamMutation()) return false;

    try {
      const liveTeams = await fetchRoundTeamsFromServer();
      const duplicateName = liveTeams.some(
        (otherTeam) =>
          otherTeam.teamId !== team.teamId &&
          String(otherTeam.name || "").trim().toLowerCase() ===
            nextName.toLowerCase(),
      );
      if (duplicateName) {
        toast.error("Another team is already using that team name.");
        return false;
      }

      const roundRef = doc(db, "golf_rounds", ROUND_ID);
      const teamRef = doc(
        db,
        "golf_teams",
        teamDocumentId(ROUND_ID, team.teamId),
      );

      await runTransaction(db, async (transaction) => {
        const teamSnapshot = await transaction.get(teamRef);
        if (!teamSnapshot.exists()) {
          throw new Error("TEAM_NO_LONGER_EXISTS");
        }

        const currentMemberIds = teamSnapshot.data()?.memberIds || [];
        const affectedMemberIds = [
          ...new Set([...currentMemberIds, ...nextMemberIds]),
        ];
        const assignmentRefs = affectedMemberIds.map(assignmentDocumentRef);
        const assignmentSnapshots = await Promise.all(
          assignmentRefs.map((assignmentRef) => transaction.get(assignmentRef)),
        );
        const otherTeamIds = [
          ...new Set(
            assignmentSnapshots
              .map((snapshot) => snapshot.data()?.teamId)
              .filter(
                (assignedTeamId) =>
                  assignedTeamId && assignedTeamId !== team.teamId,
              ),
          ),
        ];
        const otherTeamSnapshots = await Promise.all(
          otherTeamIds.map((otherTeamId) =>
            transaction.get(
              doc(db, "golf_teams", teamDocumentId(ROUND_ID, otherTeamId)),
            ),
          ),
        );
        const otherTeamsById = new Map(
          otherTeamIds.map((otherTeamId, index) => [
            otherTeamId,
            otherTeamSnapshots[index],
          ]),
        );

        nextMemberIds.forEach((memberId) => {
          const affectedIndex = affectedMemberIds.indexOf(memberId);
          const assignmentSnapshot = assignmentSnapshots[affectedIndex];
          if (!assignmentSnapshot?.exists()) return;
          const assignedTeamId = assignmentSnapshot.data()?.teamId;
          if (!assignedTeamId || assignedTeamId === team.teamId) return;

          const otherTeamSnapshot = otherTeamsById.get(assignedTeamId);
          const otherTeamData = otherTeamSnapshot?.data();
          const assignmentIsValid =
            otherTeamSnapshot?.exists() &&
            otherTeamData?.roundId === ROUND_ID &&
            Array.isArray(otherTeamData?.memberIds) &&
            otherTeamData.memberIds.includes(memberId);

          if (assignmentIsValid) {
            const error = new Error("PLAYER_ALREADY_ASSIGNED");
            error.playerId = memberId;
            throw error;
          }
        });

        currentMemberIds.forEach((memberId) => {
          if (nextMemberIds.includes(memberId)) return;
          const affectedIndex = affectedMemberIds.indexOf(memberId);
          const assignmentSnapshot = assignmentSnapshots[affectedIndex];
          if (
            assignmentSnapshot?.exists() &&
            assignmentSnapshot.data()?.teamId === team.teamId
          ) {
            transaction.delete(assignmentRefs[affectedIndex]);
          }
        });

        nextMemberIds.forEach((memberId) => {
          const affectedIndex = affectedMemberIds.indexOf(memberId);
          transaction.set(
            assignmentRefs[affectedIndex],
            {
              roundId: ROUND_ID,
              playerId: memberId,
              teamId: team.teamId,
              updatedAt: serverTimestamp(),
            },
            { merge: true },
          );
        });

        transaction.set(
          teamRef,
          {
            name: nextName,
            memberIds: nextMemberIds,
            updatedAt: serverTimestamp(),
          },
          { merge: true },
        );
        transaction.set(
          roundRef,
          {
            playerTeamMap: deleteField(),
            teamAssignmentVersion: 2,
            updatedAt: serverTimestamp(),
          },
          { merge: true },
        );
      });

      toast.success("Team updated");
      return true;
    } catch (error) {
      console.error(error);
      if (error?.message === "PLAYER_ALREADY_ASSIGNED") {
        toast.error(
          `${PLAYER_BY_ID[error.playerId]?.name || "That player"} is already on another team.`,
        );
      } else if (error?.message === "TEAM_NO_LONGER_EXISTS") {
        toast.error("That team no longer exists in Firebase.");
      } else {
        toast.error("The team could not be updated.");
      }
      return false;
    } finally {
      endTeamMutation();
    }
  };

  const deleteTeam = async (team) => {
    if (!isAdmin || !team?.teamId) return false;

    const hasScores = scores.some((score) => score.teamId === team.teamId);
    const message = hasScores
      ? `Disband ${team.name}? Its existing scores will be kept in Firebase but will no longer appear on the ladder.`
      : `Disband ${team.name}?`;

    if (!window.confirm(message)) return false;
    if (!beginTeamMutation()) return false;

    try {
      const roundRef = doc(db, "golf_rounds", ROUND_ID);
      const teamRef = doc(
        db,
        "golf_teams",
        teamDocumentId(ROUND_ID, team.teamId),
      );

      await runTransaction(db, async (transaction) => {
        const teamSnapshot = await transaction.get(teamRef);
        const memberIds = teamSnapshot.exists()
          ? teamSnapshot.data()?.memberIds || []
          : team.memberIds || [];
        const assignmentRefs = memberIds.map(assignmentDocumentRef);
        const assignmentSnapshots = await Promise.all(
          assignmentRefs.map((assignmentRef) => transaction.get(assignmentRef)),
        );

        assignmentSnapshots.forEach((assignmentSnapshot, index) => {
          if (
            assignmentSnapshot.exists() &&
            assignmentSnapshot.data()?.teamId === team.teamId
          ) {
            transaction.delete(assignmentRefs[index]);
          }
        });

        transaction.delete(teamRef);
        transaction.set(
          roundRef,
          {
            playerTeamMap: deleteField(),
            teamAssignmentVersion: 2,
            updatedAt: serverTimestamp(),
          },
          { merge: true },
        );
      });

      toast.success("Team disbanded");
      return true;
    } catch (error) {
      console.error(error);
      toast.error("The team could not be disbanded.");
      return false;
    } finally {
      endTeamMutation();
    }
  };

  const clearAllScores = async () => {
    if (!isAdmin) return;
    if (
      !window.confirm(
        "This permanently deletes every confirmed and unconfirmed score for this event. Continue?",
      )
    ) {
      return;
    }

    try {
      const scoresQuery = query(
        collection(db, "golf_scores"),
        where("roundId", "==", ROUND_ID),
      );
      const snapshot = await getDocs(scoresQuery);
      const batch = writeBatch(db);
      snapshot.forEach((scoreDoc) => batch.delete(scoreDoc.ref));
      await batch.commit();
      setResetNonce((value) => value + 1);
      toast.success("All event scores cleared");
    } catch (error) {
      console.error(error);
      toast.error("The scores could not be cleared.");
    }
  };

  if (!currentPlayer) {
    return (
      <LoginScreen
        loginCode={loginCode}
        setLoginCode={setLoginCode}
        onLogin={handlePlayerLogin}
      />
    );
  }

  if (!dataReady) {
    return (
      <DataSyncScreen
        error={syncError}
        roundLoaded={roundLoaded}
        teamsLoaded={teamsLoaded}
        scoresLoaded={scoresLoaded}
      />
    );
  }

  return (
    <>
      <AdminPinModal
        open={showAdminModal}
        value={adminPinInput}
        setValue={setAdminPinInput}
        inputRef={pinInputRef}
        onClose={() => {
          setShowAdminModal(false);
          setAdminPinInput("");
        }}
        onUnlock={unlockAdmin}
      />

      <PubGolfPage
        golfConfig={golfConfig}
        player={currentPlayer}
        team={currentTeam}
        teams={teams}
        scores={scores}
        isAdmin={isAdmin}
        menuOpen={menuOpen}
        setMenuOpen={setMenuOpen}
        onShowAdminLogin={() => setShowAdminModal(true)}
        onDisableAdmin={disableAdmin}
        onLogout={handleLogout}
        onToggleHoleLock={toggleHoleLock}
        onRenameHole={renameHole}
        onSaveEventDetails={saveEventDetails}
        onUpdateHole={updateHole}
        onAddHole={addHole}
        onMoveHole={moveHole}
        onDeleteHole={deleteHole}
        onSetAllHoleLocks={setAllHoleLocks}
        onSaveBonusPenaltyRules={saveBonusPenaltyRules}
        onSaveAdminScore={saveAdminScore}
        onDeleteAdminScore={deleteAdminScore}
        onCreateTeam={createTeam}
        onUpdateTeam={updateTeam}
        onDeleteTeam={deleteTeam}
        onClearAllScores={clearAllScores}
        resetNonce={resetNonce}
      />
    </>
  );
}

// -----------------------------------------------------------------------------
// Login and admin PIN
// -----------------------------------------------------------------------------
function LoginScreen({ loginCode, setLoginCode, onLogin }) {
  return (
    <div className="app-shell flex min-h-screen items-center justify-center px-4 py-10">
      <PremiumBackground />
      <div className="relative z-10 grid w-full max-w-5xl items-center gap-8 lg:grid-cols-[1fr_0.9fr]">
        <div className="order-2 lg:order-1">
          <PremiumCard className="p-5 sm:p-7">
            <h1 className="login-title text-3xl font-black tracking-tight text-white sm:text-4xl">
              Enter the tournament
            </h1>

            <form
              className="mt-7 space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                onLogin();
              }}
            >
              <div>
                <Label className="mb-2">Player login code</Label>
                <Input
                  value={loginCode}
                  onChange={(event) => setLoginCode(event.target.value)}
                  placeholder="Enter your code"
                  autoComplete="off"
                  autoCapitalize="characters"
                  className="mt-1 uppercase tracking-[0.16em]"
                />
              </div>
              <Button type="submit" size="lg" className="w-full">
                Login
              </Button>
            </form>
          </PremiumCard>
        </div>

        <div className="order-1 flex flex-col items-center justify-center text-center lg:order-2">
          <div className="logo-halo">
            <img
              src="/localz-auckland-2026.png"
              alt="Pub Golf"
              className="relative z-10 max-h-[290px] w-full max-w-[420px] object-contain"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function DataSyncScreen({ error, roundLoaded, teamsLoaded, scoresLoaded }) {
  const status = !roundLoaded
    ? "Loading event settings"
    : !teamsLoaded
      ? "Loading current teams"
      : !scoresLoaded
        ? "Loading saved scores"
        : "Finishing sync";

  return (
    <div className="app-shell flex min-h-screen items-center justify-center px-4 py-10">
      <PremiumBackground />
      <div className="relative z-10 w-full max-w-md">
        <PremiumCard className="p-6 text-center sm:p-8">
          <img
            src="/localz-auckland-2026.png"
            alt="Pub Golf"
            className="mx-auto h-32 w-auto object-contain sm:h-40"
          />
          {error ? (
            <>
              <h1 className="mt-5 text-2xl font-black text-white">
                Unable to sync event data
              </h1>
              <p className="mt-3 text-sm leading-6 text-blue-100/70">{error}</p>
              <Button className="mt-5 w-full" onClick={() => window.location.reload()}>
                Try again
              </Button>
            </>
          ) : (
            <>
              <div className="mx-auto mt-5 h-9 w-9 animate-spin rounded-full border-2 border-amber-200/25 border-t-amber-200" />
              <h1 className="mt-4 text-xl font-black text-white">Syncing event data</h1>
              <p className="mt-2 text-sm text-blue-100/65">{status}…</p>
              <p className="mt-3 text-xs leading-5 text-blue-100/45">
                The scorecard and team manager will open only after the latest Firebase data has loaded.
              </p>
            </>
          )}
        </PremiumCard>
      </div>
    </div>
  );
}

function AdminPinModal({
  open,
  value,
  setValue,
  inputRef,
  onClose,
  onUnlock,
}) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <PremiumCard className="w-full max-w-sm p-5">
        <div className="section-eyebrow">Admin access</div>
        <h2 className="mt-1 text-xl font-bold text-white">Enter admin PIN</h2>
        <p className="mt-2 text-sm text-blue-100/65">
          Unlock team management, hole settings and score controls.
        </p>
        <Input
          ref={inputRef}
          value={value}
          onChange={(event) =>
            setValue(event.target.value.replace(/[^0-9]/g, "").slice(0, 4))
          }
          onKeyDown={(event) => {
            if (event.key === "Enter") onUnlock();
          }}
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={4}
          placeholder="••••"
          className="mt-4 text-center text-xl tracking-[0.4em]"
        />
        <Row className="mt-4 justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onUnlock}>Unlock</Button>
        </Row>
      </PremiumCard>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Main page shell
// -----------------------------------------------------------------------------
function PubGolfPage({
  golfConfig,
  player,
  team,
  teams,
  scores,
  isAdmin,
  menuOpen,
  setMenuOpen,
  onShowAdminLogin,
  onDisableAdmin,
  onLogout,
  onToggleHoleLock,
  onSaveEventDetails,
  onUpdateHole,
  onAddHole,
  onMoveHole,
  onDeleteHole,
  onSetAllHoleLocks,
  onSaveBonusPenaltyRules,
  onSaveAdminScore,
  onDeleteAdminScore,
  onCreateTeam,
  onUpdateTeam,
  onDeleteTeam,
  onClearAllScores,
  resetNonce,
}) {
  const [activeTab, setActiveTab] = useState("scorecard");

  useEffect(() => {
    if (!isAdmin && activeTab === "admin") setActiveTab("profile");
  }, [activeTab, isAdmin]);

  const tabs = [
    { id: "scorecard", label: "Scorecard" },
    { id: "ladder", label: "Ladder" },
    { id: "rules", label: "Bonuses & Penalties", shortLabel: "B & P" },
    { id: "profile", label: "Profile" },
    ...(isAdmin ? [{ id: "admin", label: "Admin" }] : []),
  ];

  return (
    <div className="app-shell min-h-screen px-3 py-4 sm:px-5 sm:py-6">
      <PremiumBackground />
      <div className="relative z-10 mx-auto max-w-6xl">
        <header className="mb-4 flex items-center justify-between gap-3">
          <Row className="min-w-0 gap-3">
            <img
              src="/localz-auckland-2026.png"
              alt="Pub Golf"
              className="h-11 w-auto shrink-0 object-contain sm:h-14"
            />
            <div className="min-w-0">
              <div className="section-eyebrow hidden sm:block">
                {golfConfig.location || DEFAULT_LOCATION}
              </div>
              <h1 className="header-title truncate text-xl font-black tracking-tight text-white sm:text-3xl">
                {golfConfig.title || DEFAULT_TITLE}
              </h1>
            </div>
          </Row>

          <button
            type="button"
            aria-label="Open menu"
            onClick={() => setMenuOpen(true)}
            className="menu-button"
          >
            <PlayerAvatar player={player} size="sm" />
            <span className="hidden text-left sm:block">
              <span className="block text-[10px] font-bold uppercase tracking-[0.18em] text-blue-100/50">
                Signed in
              </span>
              <span className="block max-w-28 truncate text-sm font-semibold text-white">
                {player.name}
              </span>
            </span>
            <span className="text-xl text-amber-200">☰</span>
          </button>
        </header>

        <SideMenu
          open={menuOpen}
          setOpen={setMenuOpen}
          player={player}
          team={team}
          isAdmin={isAdmin}
          onShowAdminLogin={onShowAdminLogin}
          onDisableAdmin={onDisableAdmin}
          onLogout={onLogout}
          onGoToAdmin={() => {
            setActiveTab("admin");
            setMenuOpen(false);
          }}
        />

        <nav
          className="tab-bar mb-4"
          style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}
        >
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={activeTab === tab.id ? "tab-active" : ""}
            >
              <span className="tab-label-full">{tab.label}</span>
              <span className="tab-label-short">{tab.shortLabel || tab.label}</span>
            </button>
          ))}
        </nav>

        {activeTab === "scorecard" ? (
          team ? (
            <Scorecard
              key={`${team.teamId}-${resetNonce}`}
              roundId={ROUND_ID}
              golfConfig={golfConfig}
              team={team}
              player={player}
              isAdmin={isAdmin}
              onToggleHoleLock={onToggleHoleLock}
            />
          ) : (
            <WaitingForTeam player={player} isAdmin={isAdmin} />
          )
        ) : null}

        {activeTab === "ladder" ? (
          <GolfLadder
            roundId={ROUND_ID}
            teams={teams}
            scores={scores}
            loggedInTeamId={team?.teamId}
            activeHoleIds={(golfConfig.holes || [])
              .filter((hole) => hole.active !== false)
              .map((hole) => hole.id)}
          />
        ) : null}

        {activeTab === "rules" ? (
          <BonusesPenaltiesPage
            bonusRules={golfConfig.bonusRules || DEFAULT_BONUS_RULES}
            penaltyRules={golfConfig.penaltyRules || DEFAULT_PENALTY_RULES}
            isAdmin={isAdmin}
            onSaveRules={onSaveBonusPenaltyRules}
          />
        ) : null}

        {activeTab === "profile" ? (
          <PlayerProfile
            player={player}
            team={team}
            teams={teams}
            onUpdateTeam={onUpdateTeam}
          />
        ) : null}

        {activeTab === "admin" && isAdmin ? (
          <AdminControlCentre
            golfConfig={golfConfig}
            teams={teams}
            scores={scores}
            onCreateTeam={onCreateTeam}
            onUpdateTeam={onUpdateTeam}
            onDeleteTeam={onDeleteTeam}
            onClearAllScores={onClearAllScores}
            onSaveEventDetails={onSaveEventDetails}
            onUpdateHole={onUpdateHole}
            onAddHole={onAddHole}
            onMoveHole={onMoveHole}
            onDeleteHole={onDeleteHole}
            onSetAllHoleLocks={onSetAllHoleLocks}
            onSaveAdminScore={onSaveAdminScore}
            onDeleteAdminScore={onDeleteAdminScore}
          />
        ) : null}
      </div>
    </div>
  );
}

function SideMenu({
  open,
  setOpen,
  player,
  team,
  isAdmin,
  onShowAdminLogin,
  onDisableAdmin,
  onLogout,
  onGoToAdmin,
}) {
  return (
    <div className={`side-menu-root ${open ? "side-menu-open" : ""}`}>
      <button
        type="button"
        aria-label="Close menu"
        className="side-menu-backdrop"
        onClick={() => setOpen(false)}
      />
      <aside className="side-menu-panel" aria-label="Player menu">
        <div className="side-menu-header">
          <span>Player menu</span>
          <button type="button" onClick={() => setOpen(false)} aria-label="Close menu">
            ×
          </button>
        </div>

        <div className="flex h-[calc(100%-64px)] flex-col p-5">
          <div className="flex flex-col items-center text-center">
            <PlayerAvatar player={player} size="lg" />
            <div className="mt-3 text-xl font-bold text-white">{player.fullName || player.name}</div>
            <div className="mt-1 text-sm text-blue-100/60">
              {team ? team.name : "Waiting for team assignment"}
            </div>
            {isAdmin ? <Badge className="mt-3">Admin unlocked</Badge> : null}
          </div>

          <div className="mt-7 space-y-2">
            {isAdmin ? (
              <>
                <Button className="w-full" onClick={onGoToAdmin}>
                  Open team manager
                </Button>
                <Button variant="outline" className="w-full" onClick={onDisableAdmin}>
                  Turn off admin
                </Button>
              </>
            ) : (
              <Button
                variant="outline"
                className="w-full"
                onClick={() => {
                  setOpen(false);
                  onShowAdminLogin();
                }}
              >
                Admin login
              </Button>
            )}
            <Button variant="ghost" className="w-full" onClick={onLogout}>
              Log out
            </Button>
          </div>

          <div className="mt-auto flex justify-center pb-4 pt-8">
            <img
              src="/localz-auckland-2026.png"
              alt="Pub Golf"
              className="max-h-40 max-w-[75%] object-contain opacity-90"
            />
          </div>
        </div>
      </aside>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Waiting and profile screens
// -----------------------------------------------------------------------------
function WaitingForTeam({ player, isAdmin, showPlayerCard = true }) {
  return (
    <PremiumCard className="mx-auto max-w-2xl p-6 text-center sm:p-9">
      {showPlayerCard ? (
        <div className="flex justify-center">
          <PlayerFifaCard player={player} size="md" />
        </div>
      ) : null}
      <div className={`section-eyebrow ${showPlayerCard ? "mt-5" : ""}`}>Profile ready</div>
      <h2 className="mt-2 text-2xl font-black text-white sm:text-3xl">
        Waiting for team assignment
      </h2>
      <p className="mx-auto mt-3 max-w-lg text-sm leading-6 text-blue-100/70">
        Your player profile is working. Your scorecard will appear automatically after the admin places you in a solo or two-player team.
      </p>
      {isAdmin ? (
        <p className="mt-4 text-sm font-semibold text-amber-200">
          Open the Admin tab to create the first teams.
        </p>
      ) : null}
    </PremiumCard>
  );
}

function PlayerProfile({ player, team, teams, onUpdateTeam }) {
  const [expandedPlayerId, setExpandedPlayerId] = useState("");
  const otherPlayers = PLAYERS.filter((otherPlayer) => otherPlayer.id !== player.id);

  return (
    <div className="space-y-4">
      <PremiumCard className="profile-fifa-hero overflow-hidden">
        <div className="profile-fifa-layout">
          <div className="profile-fifa-card-wrap">
            <PlayerFifaCard player={player} size="xl" />
          </div>
          <div className="profile-fifa-copy">
            <div className="section-eyebrow">Player profile</div>
            <h2 className="mt-1 text-3xl font-black text-white sm:text-4xl">
              {player.fullName || player.name}
            </h2>
            <div className="mt-3 flex flex-wrap gap-2">
              <Badge className="badge-blue">{player.name}</Badge>
              <Badge>{player.nickname}</Badge>
            </div>
            <p className="mt-4 text-sm leading-6 text-blue-100/70">
              {team ? `Member of ${team.name}` : "Not assigned to a team yet"}
            </p>
            <div className="profile-trait-grid mt-5">
              <ProfileTrait label="Strength" value={player.strength} variant="strength" />
              <ProfileTrait label="Weakness" value={player.weakness} variant="weakness" />
            </div>
          </div>
        </div>
      </PremiumCard>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Years played" value={player.stats?.yearsPlayed ?? 0} />
        <StatCard label="Wins" value={player.stats?.wins ?? 0} />
        <StatCard label="Debut" value={player.stats?.debutYear ?? "—"} />
        <StatCard label="Nickname" value={player.nickname || "—"} />
      </div>

      {team ? (
        <TeamProfileCard
          team={team}
          player={player}
          onUpdateTeam={onUpdateTeam}
        />
      ) : (
        <WaitingForTeam player={player} isAdmin={false} showPlayerCard={false} />
      )}

      <PremiumCard className="p-5 sm:p-6">
        <SectionHeading
          eyebrow="All Players"
          title="Player Directory"
          description="Tap a player to view their card, career statistics, strengths, weaknesses and current team."
        />

        <div className="player-directory-list">
          {otherPlayers.map((otherPlayer) => {
            const otherTeam = findTeamForPlayer(otherPlayer.id, teams);
            const expanded = expandedPlayerId === otherPlayer.id;
            return (
              <div
                key={otherPlayer.id}
                className={`player-directory-item ${expanded ? "player-directory-open" : ""}`}
              >
                <button
                  type="button"
                  className="player-directory-toggle"
                  aria-expanded={expanded}
                  onClick={() =>
                    setExpandedPlayerId((current) =>
                      current === otherPlayer.id ? "" : otherPlayer.id,
                    )
                  }
                >
                  <PlayerAvatar player={otherPlayer} size="sm" />
                  <div className="min-w-0 flex-1 text-left">
                    <div className="truncate font-black text-white">
                      {otherPlayer.fullName || otherPlayer.name}
                    </div>
                    <div className="mt-0.5 truncate text-xs text-blue-100/55">
                      {otherPlayer.nickname} · {otherTeam ? otherTeam.name : "Unassigned"}
                    </div>
                  </div>
                  <span className="player-directory-chevron" aria-hidden="true">
                    {expanded ? "−" : "+"}
                  </span>
                </button>

                {expanded ? (
                  <div className="player-directory-content">
                    <PlayerProfileDetails player={otherPlayer} teams={teams} />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </PremiumCard>
    </div>
  );
}

function ProfileTrait({ label, value, variant = "strength" }) {
  return (
    <div className={`profile-trait profile-trait-${variant}`}>
      <span>{label}</span>
      <strong>{value || "—"}</strong>
    </div>
  );
}

function StatCard({ label, value }) {
  const displayValue = String(value ?? "—");
  const valueSize =
    displayValue.length > 14
      ? "text-sm sm:text-base"
      : displayValue.length > 9
        ? "text-base sm:text-lg"
        : displayValue.length > 6
          ? "text-xl sm:text-2xl"
          : "text-2xl sm:text-3xl";

  return (
    <PremiumCard className="flex min-h-28 flex-col items-center justify-center p-4 text-center">
      <div className={`${valueSize} break-words font-black leading-tight text-amber-200`}>
        {displayValue}
      </div>
      <div className="mt-2 text-xs font-bold uppercase tracking-[0.16em] text-blue-100/55">
        {label}
      </div>
    </PremiumCard>
  );
}

function PlayerMiniStat({ label, value }) {
  return (
    <div className="player-mini-stat">
      <strong>{value ?? "—"}</strong>
      <span>{label}</span>
    </div>
  );
}

function TeamProfileCard({ team, player, onUpdateTeam }) {
  const [teamName, setTeamName] = useState(team.name || "");

  useEffect(() => {
    setTeamName(team.name || "");
  }, [team.name]);

  const members = getTeamPlayers(team);

  return (
    <PremiumCard className="p-5 sm:p-6">
      <SectionHeading
        eyebrow="Your team"
        title={team.name}
      />

      <div className={`team-fifa-grid ${members.length === 1 ? "team-fifa-grid-solo" : ""}`}>
        {members.map((member) => (
          <div key={member.id} className="team-fifa-member">
            <PlayerFifaCard player={member} size="lg" />
            <div className="team-fifa-member-info">
              <div className="section-eyebrow">
                {member.id === player.id ? "You" : "Teammate"}
              </div>
              <h3>{member.fullName || member.name}</h3>
              <div className="mt-2 flex flex-wrap gap-2">
                <Badge className="badge-blue">{member.name}</Badge>
                <Badge>{member.nickname}</Badge>
              </div>
              <div className="player-mini-stat-grid mt-4">
                <PlayerMiniStat label="Years" value={member.stats?.yearsPlayed} />
                <PlayerMiniStat label="Wins" value={member.stats?.wins} />
                <PlayerMiniStat label="Debut" value={member.stats?.debutYear} />
              </div>
              <div className="profile-trait-grid mt-4">
                <ProfileTrait label="Strength" value={member.strength} variant="strength" />
                <ProfileTrait label="Weakness" value={member.weakness} variant="weakness" />
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-5 rounded-2xl border border-blue-300/15 bg-blue-950/30 p-4">
        <Label>Edit team name</Label>
        <div className="mt-1 grid gap-2 sm:grid-cols-[1fr_auto]">
          <Input value={teamName} onChange={(event) => setTeamName(event.target.value)} />
          <Button
            onClick={() =>
              onUpdateTeam(
                team,
                { name: teamName, memberIds: team.memberIds },
                { skipConfirm: true },
              )
            }
          >
            Save name
          </Button>
        </div>
      </div>
    </PremiumCard>
  );
}

function PlayerProfileDetails({ player, teams }) {
  const playerTeam = findTeamForPlayer(player.id, teams);
  const teammates = getTeamPlayers(playerTeam).filter(
    (teamPlayer) => teamPlayer.id !== player.id,
  );

  return (
    <div className="directory-profile-grid">
      <div className="directory-profile-card-wrap">
        <PlayerFifaCard player={player} size="lg" />
      </div>
      <div className="directory-profile-info">
        <div className="section-eyebrow">Player profile</div>
        <h3 className="mt-1 text-2xl font-black text-white">
          {player.fullName || player.name}
        </h3>
        <div className="mt-2 flex flex-wrap gap-2">
          <Badge className="badge-blue">{player.name}</Badge>
          <Badge>{player.nickname}</Badge>
        </div>

        <div className="player-mini-stat-grid mt-4">
          <PlayerMiniStat label="Years" value={player.stats?.yearsPlayed} />
          <PlayerMiniStat label="Wins" value={player.stats?.wins} />
          <PlayerMiniStat label="Debut" value={player.stats?.debutYear} />
        </div>

        <div className="profile-trait-grid mt-4">
          <ProfileTrait label="Strength" value={player.strength} variant="strength" />
          <ProfileTrait label="Weakness" value={player.weakness} variant="weakness" />
        </div>

        <div className="directory-team-info mt-4">
          <span>Current team</span>
          <strong>{playerTeam ? playerTeam.name : "Not assigned"}</strong>
          {playerTeam ? (
            <small>
              {teammates.length
                ? `Teammate: ${teammates.map((teammate) => teammate.name).join(" & ")}`
                : "Solo team"}
            </small>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Scorecard
// -----------------------------------------------------------------------------
function SpinNumber({ value, setValue, min = 0, max = 99 }) {
  const clamp = (number) => Math.min(max, Math.max(min, Math.round(number || 0)));

  return (
    <div className="spin-number">
      <button type="button" onClick={() => setValue(clamp(Number(value) - 1))}>
        −
      </button>
      <input
        type="number"
        min={min}
        max={max}
        step={1}
        value={value ?? 0}
        onChange={(event) => setValue(clamp(Number(event.target.value)))}
      />
      <button type="button" onClick={() => setValue(clamp(Number(value) + 1))}>
        +
      </button>
    </div>
  );
}

function Scorecard({
  roundId,
  golfConfig,
  team,
  player,
  isAdmin,
  onToggleHoleLock,
}) {
  const [localScores, setLocalScores] = useState({});
  const [savedScores, setSavedScores] = useState({});
  const [editingMap, setEditingMap] = useState({});
  const editingMapRef = useRef({});

  useEffect(() => {
    editingMapRef.current = editingMap;
  }, [editingMap]);

  useEffect(() => {
    const holes = (golfConfig.holes || []).filter((hole) => hole.active !== false);
    const unsubscribers = holes.map((hole) => {
      const scoreRef = doc(
        db,
        "golf_scores",
        scoreDocumentId(roundId, team.teamId, hole.id),
      );

      return onSnapshot(scoreRef, (snapshot) => {
        const data = snapshot.exists() ? snapshot.data() : emptyScore;
        const normalized = {
          sips: Math.max(0, Math.round(Number(data.sips) || 0)),
          bonuses: Math.max(0, Math.round(Number(data.bonuses) || 0)),
          penalties: Math.max(0, Math.round(Number(data.penalties) || 0)),
          modifier: Math.round(Number(data.modifier) || 0),
          holeTotal: Math.round(Number(data.holeTotal) || 0),
          confirmed: Boolean(data.confirmed),
        };

        setSavedScores((previous) => ({ ...previous, [hole.id]: normalized }));
        setLocalScores((previous) => {
          if (editingMapRef.current[hole.id]) return previous;
          return {
            ...previous,
            [hole.id]: {
              sips: normalized.sips,
              bonuses: normalized.bonuses,
              penalties: normalized.penalties,
            },
          };
        });
        setEditingMap((previous) => {
          const existing = previous[hole.id];
          if (normalized.confirmed) return { ...previous, [hole.id]: false };
          if (typeof existing !== "boolean") return { ...previous, [hole.id]: true };
          return previous;
        });
      });
    });

    return () => unsubscribers.forEach((unsubscribe) => unsubscribe?.());
  }, [golfConfig.holes, roundId, team.teamId]);

  const setField = (holeId, field, value) => {
    setLocalScores((previous) => ({
      ...previous,
      [holeId]: {
        ...(previous[holeId] || { sips: 0, bonuses: 0, penalties: 0 }),
        [field]: value,
      },
    }));
  };

  const startEditing = (holeId) => {
    const saved = savedScores[holeId] || emptyScore;
    setLocalScores((previous) => ({
      ...previous,
      [holeId]: {
        sips: saved.sips,
        bonuses: saved.bonuses,
        penalties: saved.penalties,
      },
    }));
    setEditingMap((previous) => ({ ...previous, [holeId]: true }));
  };

  const cancelEditing = (holeId) => {
    const saved = savedScores[holeId] || emptyScore;
    setLocalScores((previous) => ({
      ...previous,
      [holeId]: {
        sips: saved.sips,
        bonuses: saved.bonuses,
        penalties: saved.penalties,
      },
    }));
    setEditingMap((previous) => ({ ...previous, [holeId]: false }));
  };

  const confirmHole = async (hole) => {
    const values = localScores[hole.id] || {
      sips: 0,
      bonuses: 0,
      penalties: 0,
    };
    const sips = Math.max(0, Math.round(Number(values.sips) || 0));
    const bonuses = Math.max(0, Math.round(Number(values.bonuses) || 0));
    const penalties = Math.max(0, Math.round(Number(values.penalties) || 0));
    const modifier = penalties - bonuses;
    const holeTotal = sips + modifier;

    try {
      await setDoc(
        doc(
          db,
          "golf_scores",
          scoreDocumentId(roundId, team.teamId, hole.id),
        ),
        {
          roundId,
          teamId: team.teamId,
          holeId: hole.id,
          holeName: hole.name,
          sips,
          bonuses,
          penalties,
          modifier,
          holeTotal,
          confirmed: true,
          confirmedByPlayerId: player.id,
          confirmedByName: player.fullName || player.name,
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );
      setEditingMap((previous) => ({ ...previous, [hole.id]: false }));
      toast.success(`${hole.name} confirmed`);
    } catch (error) {
      console.error(error);
      toast.error("The score could not be confirmed.");
    }
  };

  const activeHoleIdSet = new Set(
    (golfConfig.holes || [])
      .filter((hole) => hole.active !== false)
      .map((hole) => hole.id),
  );
  const completedHoles = Object.entries(savedScores).filter(
    ([holeId, score]) => activeHoleIdSet.has(holeId) && score.confirmed,
  ).length;

  return (
    <div className="space-y-4">
      <PremiumCard className="p-4 sm:p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="section-eyebrow">Team scorecard</div>
            <h2 className="mt-1 text-2xl font-black text-white">{team.name}</h2>
            <p className="mt-1 text-sm text-blue-100/65">
              Bonuses are entered as positive amounts and automatically subtract from the score.
            </p>
          </div>
          <div className="scorecard-progress">
            <span className="text-2xl font-black text-amber-200">{completedHoles}</span>
            <span className="text-sm text-blue-100/55">/{(golfConfig.holes || []).filter((hole) => hole.active !== false).length} holes</span>
          </div>
        </div>
      </PremiumCard>

      <div className="space-y-3">
        {(golfConfig.holes || [])
          .filter((hole) => hole.active !== false)
          .map((hole, index) => {
          const local = localScores[hole.id] || {
            sips: 0,
            bonuses: 0,
            penalties: 0,
          };
          const saved = savedScores[hole.id] || emptyScore;
          const editing = Boolean(editingMap[hole.id]);
          const locked = Boolean(hole.locked);
          const liveModifier = Number(local.penalties) - Number(local.bonuses);
          const liveTotal = Number(local.sips) + liveModifier;
          const displayTotal = editing ? liveTotal : saved.holeTotal;

          return (
            <details key={hole.id} className="hole-card" open={!saved.confirmed}>
              <summary>
                <div className="flex min-w-0 items-center gap-3">
                  <div className="hole-number">{index + 1}</div>
                  <div className="min-w-0">
                    <div className="truncate font-bold text-white">{hole.name}</div>
                    {hole.venue || hole.drink ? (
                      <div className="mt-0.5 truncate text-xs text-blue-100/55">
                        {[hole.venue, hole.drink].filter(Boolean).join(" · ")}
                      </div>
                    ) : null}
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {saved.confirmed && !editing ? <Badge>Confirmed</Badge> : null}
                      {editing ? <Badge className="badge-blue">Editing</Badge> : null}
                      {locked ? <Badge className="badge-red">Locked</Badge> : null}
                    </div>
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[10px] font-bold uppercase tracking-[0.15em] text-blue-100/45">
                    Hole total
                  </div>
                  <div className="text-2xl font-black text-amber-200">{displayTotal}</div>
                </div>
              </summary>

              <div className="hole-card-body">
                {isAdmin ? (
                  <div className="mb-4 flex flex-col gap-3 rounded-xl border border-amber-300/15 bg-amber-300/5 p-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <div className="text-sm font-bold text-white">Quick admin control</div>
                      <div className="text-xs text-blue-100/55">
                        Edit venue, drink and hole order in Admin → Event setup.
                      </div>
                    </div>
                    <Button
                      variant={locked ? "blue" : "outline"}
                      onClick={() => onToggleHoleLock(hole.id, !locked)}
                    >
                      {locked ? "Unlock scoring" : "Lock scoring"}
                    </Button>
                  </div>
                ) : null}

                <div className="grid gap-3 sm:grid-cols-3">
                  <ScoreInputBlock
                    label="Total sips"
                    helper="Base score"
                    value={local.sips}
                    disabled={!editing || locked}
                    setValue={(value) => setField(hole.id, "sips", value)}
                  />
                  <ScoreInputBlock
                    label="Bonuses earned"
                    helper={`Counts as −${local.bonuses}`}
                    value={local.bonuses}
                    disabled={!editing || locked}
                    setValue={(value) => setField(hole.id, "bonuses", value)}
                  />
                  <ScoreInputBlock
                    label="Penalties"
                    helper={`Counts as +${local.penalties}`}
                    value={local.penalties}
                    disabled={!editing || locked}
                    setValue={(value) => setField(hole.id, "penalties", value)}
                  />
                </div>

                <div className="score-breakdown mt-4">
                  <div>
                    <span>Sips</span>
                    <strong>{local.sips}</strong>
                  </div>
                  <div>
                    <span>Bonuses</span>
                    <strong>−{local.bonuses}</strong>
                  </div>
                  <div>
                    <span>Penalties</span>
                    <strong>+{local.penalties}</strong>
                  </div>
                  <div className="score-breakdown-total">
                    <span>Hole total</span>
                    <strong>{liveTotal}</strong>
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap justify-end gap-2">
                  {!editing ? (
                    !locked ? (
                      <Button variant="outline" onClick={() => startEditing(hole.id)}>
                        Edit score
                      </Button>
                    ) : null
                  ) : (
                    <>
                      {saved.confirmed ? (
                        <Button variant="ghost" onClick={() => cancelEditing(hole.id)}>
                          Cancel
                        </Button>
                      ) : null}
                      <Button
                        disabled={locked}
                        onClick={() => confirmHole(hole)}
                      >
                        Confirm score
                      </Button>
                    </>
                  )}
                </div>
              </div>
            </details>
          );
        })}
      </div>
    </div>
  );
}

function ScoreInputBlock({ label, helper, value, setValue, disabled }) {
  return (
    <div className={`score-input-block ${disabled ? "score-input-disabled" : ""}`}>
      <div>
        <div className="font-bold text-white">{label}</div>
        <div className="text-xs text-blue-100/50">{helper}</div>
      </div>
      <fieldset disabled={disabled}>
        <SpinNumber value={value} setValue={setValue} />
      </fieldset>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Ladder
// -----------------------------------------------------------------------------
function GolfLadder({ roundId, teams, scores, loggedInTeamId, activeHoleIds }) {
  const [expandedTeamId, setExpandedTeamId] = useState("");
  const rows = useMemo(() => {
    const activeHoleSet = new Set(activeHoleIds || []);
    return teams
      .map((team) => {
        const confirmedScores = scores.filter(
          (score) =>
            score.roundId === roundId &&
            score.teamId === team.teamId &&
            score.confirmed &&
            activeHoleSet.has(score.holeId),
        );
        const sips = confirmedScores.reduce(
          (sum, score) => sum + Math.max(0, Math.round(Number(score.sips) || 0)),
          0,
        );
        const total = confirmedScores.reduce(
          (sum, score) => sum + Math.round(Number(score.holeTotal) || 0),
          0,
        );
        const bonuses = confirmedScores.reduce(
          (sum, score) => sum + Math.max(0, Math.round(Number(score.bonuses) || 0)),
          0,
        );
        const penalties = confirmedScores.reduce(
          (sum, score) => sum + Math.max(0, Math.round(Number(score.penalties) || 0)),
          0,
        );
        const forAgainst = penalties - bonuses;
        const holesCompleted = new Set(
          confirmedScores.map((score) => score.holeId),
        ).size;

        return {
          ...team,
          total,
          sips,
          bonuses,
          penalties,
          forAgainst,
          holesCompleted,
        };
      })
      .sort((a, b) => {
        if (a.holesCompleted === 0 && b.holesCompleted > 0) return 1;
        if (b.holesCompleted === 0 && a.holesCompleted > 0) return -1;
        if (a.total !== b.total) return a.total - b.total;
        if (a.forAgainst !== b.forAgainst) return a.forAgainst - b.forAgainst;
        if (a.penalties !== b.penalties) return a.penalties - b.penalties;
        return String(a.name || "").localeCompare(String(b.name || ""));
      });
  }, [activeHoleIds, roundId, scores, teams]);

  return (
    <div className="space-y-4">
      <PremiumCard className="p-5 sm:p-6">
        <SectionHeading
          eyebrow="Live standings"
          title="Tournament ladder"
          description="Lowest total score ranks first. F/A is the first tie-breaker, followed by the fewest penalties."
        />

        <div className="grid grid-cols-3 gap-2 rounded-xl border border-blue-300/10 bg-blue-950/30 p-3 text-center text-xs text-blue-100/60 sm:max-w-lg">
          <div>
            <strong className="block text-sm text-white">Score</strong>
            Sips − bonuses + penalties
          </div>
          <div>
            <strong className="block text-sm text-white">F/A</strong>
            Penalties − bonuses
          </div>
          <div>
            <strong className="block text-sm text-white">Thru</strong>
            Confirmed holes
          </div>
        </div>
      </PremiumCard>

      <div className="space-y-3">
        {rows.map((row, index) => (
          <LadderRow
            key={row.teamId}
            row={row}
            position={index + 1}
            highlighted={row.teamId === loggedInTeamId}
            totalHoles={(activeHoleIds || []).length}
            expanded={expandedTeamId === row.teamId}
            onToggle={() =>
              setExpandedTeamId((current) =>
                current === row.teamId ? "" : row.teamId,
              )
            }
          />
        ))}

        {rows.length === 0 ? (
          <PremiumCard className="p-8 text-center text-blue-100/65">
            No teams have been created yet.
          </PremiumCard>
        ) : null}
      </div>
    </div>
  );
}

function LadderRow({
  row,
  position,
  highlighted,
  totalHoles,
  expanded,
  onToggle,
}) {
  const members = (row.memberIds || [])
    .map((memberId) => PLAYER_BY_ID[memberId])
    .filter(Boolean);
  const podiumClass = position <= 3 ? `ladder-podium ladder-podium-${position}` : "";

  return (
    <PremiumCard
      className={`ladder-row ${podiumClass} ${highlighted ? "ladder-highlighted" : ""} ${expanded ? "ladder-row-expanded" : ""}`}
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      onClick={onToggle}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onToggle();
        }
      }}
    >
      {position <= 3 ? (
        <div className={`ladder-podium-banner ladder-podium-banner-${position}`} />
      ) : null}

      <div className="ladder-position">
        <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-blue-100/45">
          Rank
        </span>
        <strong>{position}</strong>
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="truncate text-lg font-black text-white sm:text-xl">{row.name}</h3>
          {highlighted ? <Badge className="badge-blue">Your team</Badge> : null}
        </div>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-blue-100/60">
          <span>
            Score <strong className="text-white">{row.total}</strong>
          </span>
          <span>
            F/A{" "}
            <strong className={row.forAgainst <= 0 ? "text-amber-200" : "text-orange-300"}>
              {formatSignedNumber(row.forAgainst)}
            </strong>
          </span>
          <span>
            Thru <strong className="text-white">{row.holesCompleted}/{totalHoles}</strong>
          </span>
        </div>
      </div>

      <div className="ladder-score">
        <span>Total</span>
        <strong>{row.total}</strong>
      </div>

      <div className="ladder-members">
        {members.map((member) => (
          <div key={member.id} className="ladder-member">
            <PlayerAvatar player={member} size="sm" />
            <span>{member.name}</span>
          </div>
        ))}
      </div>

      {expanded ? (
        <div className="ladder-expanded-totals">
          <div>
            <span>Total sips</span>
            <strong>{row.sips}</strong>
          </div>
          <div>
            <span>Total bonuses</span>
            <strong>−{row.bonuses}</strong>
          </div>
          <div>
            <span>Total penalties</span>
            <strong>+{row.penalties}</strong>
          </div>
        </div>
      ) : null}
    </PremiumCard>
  );
}

// -----------------------------------------------------------------------------
// Bonuses and penalties
// -----------------------------------------------------------------------------
function BonusesPenaltiesPage({
  bonusRules,
  penaltyRules,
  isAdmin,
  onSaveRules,
}) {
  const [draftBonuses, setDraftBonuses] = useState(bonusRules);
  const [draftPenalties, setDraftPenalties] = useState(penaltyRules);

  useEffect(() => {
    setDraftBonuses(bonusRules);
  }, [bonusRules]);

  useEffect(() => {
    setDraftPenalties(penaltyRules);
  }, [penaltyRules]);

  return (
    <div className="space-y-4">
      <PremiumCard className="p-5 sm:p-7">
        <SectionHeading
          eyebrow="Scoring reference"
          title="Bonuses & penalties"
        />

        <div className="rules-grid">
          <RuleDisplayColumn
            title="Bonuses"
            sign="−"
            rules={bonusRules}
            variant="bonus"
          />
          <RuleDisplayColumn
            title="Penalties"
            sign="+"
            rules={penaltyRules}
            variant="penalty"
          />
        </div>
      </PremiumCard>

      {isAdmin ? (
        <PremiumCard className="p-5 sm:p-7">
          <SectionHeading
            eyebrow="Admin editing"
            title="Manage scoring rules"
            description="Change point values or wording, remove old items, or add new bonuses and penalties. Changes appear for every player immediately after saving."
          />

          <div className="grid gap-5 lg:grid-cols-2">
            <RuleEditor
              title="Bonus list"
              sign="−"
              rules={draftBonuses}
              setRules={setDraftBonuses}
              prefix="bonus"
            />
            <RuleEditor
              title="Penalty list"
              sign="+"
              rules={draftPenalties}
              setRules={setDraftPenalties}
              prefix="penalty"
            />
          </div>

          <div className="mt-5 flex justify-end">
            <Button
              onClick={() => onSaveRules(draftBonuses, draftPenalties)}
            >
              Save bonuses & penalties
            </Button>
          </div>
        </PremiumCard>
      ) : null}
    </div>
  );
}

function RuleDisplayColumn({ title, sign, rules, variant }) {
  return (
    <section className={`rule-column rule-column-${variant}`}>
      <div className="rule-column-heading">
        <span>{title}</span>
        <span>{rules.length}</span>
      </div>
      <div className="rule-list">
        {rules.map((rule) => (
          <div key={rule.id} className="rule-display-row">
            <div className="rule-value">
              {sign}{rule.value}
            </div>
            <div className="rule-description">{rule.description}</div>
          </div>
        ))}
        {rules.length === 0 ? (
          <p className="p-4 text-sm text-blue-100/55">No items have been added.</p>
        ) : null}
      </div>
    </section>
  );
}

function RuleEditor({ title, sign, rules, setRules, prefix }) {
  const updateRule = (ruleId, changes) => {
    setRules((current) =>
      current.map((rule) =>
        rule.id === ruleId ? { ...rule, ...changes } : rule,
      ),
    );
  };

  const removeRule = (ruleId) => {
    setRules((current) => current.filter((rule) => rule.id !== ruleId));
  };

  const addRule = () => {
    setRules((current) => [
      ...current,
      { id: createRuleId(prefix), description: "", value: 1 },
    ]);
  };

  return (
    <div className="admin-panel">
      <div className="flex items-center justify-between gap-3">
        <h3>{title}</h3>
        <Button variant="outline" size="sm" onClick={addRule}>
          Add item
        </Button>
      </div>

      <div className="mt-4 space-y-3">
        {rules.map((rule) => (
          <div key={rule.id} className="rule-editor-row">
            <div>
              <Label>Points</Label>
              <div className="rule-point-input">
                <span>{sign}</span>
                <Input
                  type="number"
                  min="1"
                  max="99"
                  value={rule.value}
                  onChange={(event) =>
                    updateRule(rule.id, {
                      value: Math.max(1, Math.round(Number(event.target.value) || 1)),
                    })
                  }
                />
              </div>
            </div>
            <div>
              <Label>Description</Label>
              <Input
                className="mt-1"
                value={rule.description}
                onChange={(event) =>
                  updateRule(rule.id, { description: event.target.value })
                }
                placeholder="Describe the bonus or penalty"
              />
            </div>
            <Button
              variant="danger"
              size="sm"
              onClick={() => removeRule(rule.id)}
            >
              Remove
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Admin control centre
// -----------------------------------------------------------------------------
function AdminControlCentre({
  golfConfig,
  teams,
  scores,
  onCreateTeam,
  onUpdateTeam,
  onDeleteTeam,
  onClearAllScores,
  onSaveEventDetails,
  onUpdateHole,
  onAddHole,
  onMoveHole,
  onDeleteHole,
  onSetAllHoleLocks,
  onSaveAdminScore,
  onDeleteAdminScore,
}) {
  const [adminSection, setAdminSection] = useState("teams");
  const sections = [
    { id: "teams", label: "Teams" },
    { id: "event", label: "Event setup" },
    { id: "scores", label: "Score correction" },
  ];

  return (
    <div className="space-y-4">
      <PremiumCard className="p-3 sm:p-4">
        <div className="admin-subnav">
          {sections.map((section) => (
            <button
              key={section.id}
              type="button"
              className={adminSection === section.id ? "admin-subnav-active" : ""}
              onClick={() => setAdminSection(section.id)}
            >
              {section.label}
            </button>
          ))}
        </div>
      </PremiumCard>

      {adminSection === "teams" ? (
        <AdminTeamManager
          teams={teams}
          scores={scores}
          onCreateTeam={onCreateTeam}
          onUpdateTeam={onUpdateTeam}
          onDeleteTeam={onDeleteTeam}
          onClearAllScores={onClearAllScores}
        />
      ) : null}

      {adminSection === "event" ? (
        <EventSetup
          golfConfig={golfConfig}
          onSaveEventDetails={onSaveEventDetails}
          onUpdateHole={onUpdateHole}
          onAddHole={onAddHole}
          onMoveHole={onMoveHole}
          onDeleteHole={onDeleteHole}
          onSetAllHoleLocks={onSetAllHoleLocks}
        />
      ) : null}

      {adminSection === "scores" ? (
        <AdminScoreCorrection
          golfConfig={golfConfig}
          teams={teams}
          scores={scores}
          onSaveScore={onSaveAdminScore}
          onDeleteScore={onDeleteAdminScore}
        />
      ) : null}
    </div>
  );
}

function EventSetup({
  golfConfig,
  onSaveEventDetails,
  onUpdateHole,
  onAddHole,
  onMoveHole,
  onDeleteHole,
  onSetAllHoleLocks,
}) {
  const [title, setTitle] = useState(golfConfig.title || DEFAULT_TITLE);
  const [location, setLocation] = useState(
    golfConfig.location || DEFAULT_LOCATION,
  );
  const [year, setYear] = useState(golfConfig.year || DEFAULT_YEAR);

  useEffect(() => {
    setTitle(golfConfig.title || DEFAULT_TITLE);
    setLocation(golfConfig.location || DEFAULT_LOCATION);
    setYear(golfConfig.year || DEFAULT_YEAR);
  }, [golfConfig.location, golfConfig.title, golfConfig.year]);

  const activeCount = (golfConfig.holes || []).filter(
    (hole) => hole.active !== false,
  ).length;
  const lockedCount = (golfConfig.holes || []).filter(
    (hole) => hole.locked,
  ).length;

  return (
    <div className="space-y-4">
      <PremiumCard className="p-5 sm:p-6">
        <SectionHeading
          eyebrow="Admin event setup"
          title="Event details"
          description="These details appear in the website header and can be updated without changing the code."
        />

        <div className="grid gap-3 md:grid-cols-[1.4fr_0.8fr_0.45fr_auto] md:items-end">
          <div>
            <Label>Event title</Label>
            <Input className="mt-1" value={title} onChange={(event) => setTitle(event.target.value)} />
          </div>
          <div>
            <Label>Location</Label>
            <Input className="mt-1" value={location} onChange={(event) => setLocation(event.target.value)} />
          </div>
          <div>
            <Label>Year</Label>
            <Input
              className="mt-1"
              type="number"
              min="2000"
              max="2100"
              value={year}
              onChange={(event) => setYear(event.target.value)}
            />
          </div>
          <Button onClick={() => onSaveEventDetails({ title, location, year })}>
            Save details
          </Button>
        </div>
      </PremiumCard>

      <PremiumCard className="p-5 sm:p-6">
        <SectionHeading
          eyebrow="Scorecard configuration"
          title="Holes & venues"
          description="Inactive holes disappear from player scorecards and do not count on the ladder. Locked holes remain visible but cannot be edited by players."
          action={
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => onSetAllHoleLocks(true)}>
                Lock all
              </Button>
              <Button variant="outline" size="sm" onClick={() => onSetAllHoleLocks(false)}>
                Unlock all
              </Button>
              <Button size="sm" onClick={onAddHole}>
                Add hole
              </Button>
            </div>
          }
        />

        <div className="mb-4 grid grid-cols-3 gap-2 sm:max-w-xl">
          <AdminNumber label="Configured" value={(golfConfig.holes || []).length} />
          <AdminNumber label="Active" value={activeCount} />
          <AdminNumber label="Locked" value={lockedCount} />
        </div>

        <div className="space-y-3">
          {(golfConfig.holes || []).map((hole, index) => (
            <HoleSetupEditor
              key={hole.id}
              hole={hole}
              index={index}
              totalHoles={(golfConfig.holes || []).length}
              onSave={onUpdateHole}
              onMove={onMoveHole}
              onDelete={onDeleteHole}
            />
          ))}
        </div>
      </PremiumCard>
    </div>
  );
}

function HoleSetupEditor({ hole, index, totalHoles, onSave, onMove, onDelete }) {
  const [name, setName] = useState(hole.name || "");
  const [venue, setVenue] = useState(hole.venue || "");
  const [drink, setDrink] = useState(hole.drink || "");
  const [active, setActive] = useState(hole.active !== false);
  const [locked, setLocked] = useState(Boolean(hole.locked));

  useEffect(() => {
    setName(hole.name || "");
    setVenue(hole.venue || "");
    setDrink(hole.drink || "");
    setActive(hole.active !== false);
    setLocked(Boolean(hole.locked));
  }, [hole]);

  const saveHole = () => {
    const cleanName = name.trim();
    if (!cleanName) {
      toast.error("The hole name cannot be empty.");
      return;
    }
    onSave(
      hole.id,
      {
        name: cleanName,
        venue: venue.trim(),
        drink: drink.trim(),
        active,
        locked,
      },
      `${cleanName} updated`,
    );
  };

  return (
    <div className={`hole-setup-card ${active ? "" : "hole-setup-inactive"}`}>
      <div className="hole-setup-number">{index + 1}</div>
      <div className="min-w-0 flex-1">
        <div className="grid gap-3 md:grid-cols-3">
          <div>
            <Label>Hole name</Label>
            <Input className="mt-1" value={name} onChange={(event) => setName(event.target.value)} />
          </div>
          <div>
            <Label>Pub / venue</Label>
            <Input
              className="mt-1"
              value={venue}
              onChange={(event) => setVenue(event.target.value)}
              placeholder="Optional venue name"
            />
          </div>
          <div>
            <Label>Drink</Label>
            <Input
              className="mt-1"
              value={drink}
              onChange={(event) => setDrink(event.target.value)}
              placeholder="Optional drink"
            />
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <label className="admin-checkbox">
            <input
              type="checkbox"
              checked={active}
              onChange={(event) => setActive(event.target.checked)}
            />
            Active
          </label>
          <label className="admin-checkbox">
            <input
              type="checkbox"
              checked={locked}
              onChange={(event) => setLocked(event.target.checked)}
            />
            Locked
          </label>
          <span className="text-xs text-blue-100/45">
            {active ? "Visible to players" : "Hidden from scorecard and ladder"}
          </span>
        </div>
      </div>

      <div className="hole-setup-actions">
        <Button
          variant="ghost"
          size="sm"
          disabled={index === 0}
          onClick={() => onMove(hole.id, -1)}
          aria-label="Move hole up"
        >
          ↑
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={index === totalHoles - 1}
          onClick={() => onMove(hole.id, 1)}
          aria-label="Move hole down"
        >
          ↓
        </Button>
        <Button size="sm" onClick={saveHole}>
          Save
        </Button>
        <Button variant="danger" size="sm" onClick={() => onDelete(hole)}>
          Delete
        </Button>
      </div>
    </div>
  );
}

function AdminScoreCorrection({
  golfConfig,
  teams,
  scores,
  onSaveScore,
  onDeleteScore,
}) {
  const [selectedTeamId, setSelectedTeamId] = useState(teams[0]?.teamId || "");

  useEffect(() => {
    if (selectedTeamId && !teams.some((team) => team.teamId === selectedTeamId)) {
      setSelectedTeamId(teams[0]?.teamId || "");
    }
    if (!selectedTeamId && teams.length) setSelectedTeamId(teams[0].teamId);
  }, [selectedTeamId, teams]);

  const selectedTeam = teams.find((team) => team.teamId === selectedTeamId);

  return (
    <PremiumCard className="p-5 sm:p-6">
      <SectionHeading
        eyebrow="Admin score controls"
        title="Score correction"
        description="Select a team, correct any saved score, or enter a missing score on their behalf. Saving here immediately updates the live ladder."
      />

      <div className="max-w-md">
        <Label>Team</Label>
        <Select
          className="mt-1"
          value={selectedTeamId}
          onChange={(event) => setSelectedTeamId(event.target.value)}
        >
          {teams.length === 0 ? <option value="">No teams created</option> : null}
          {teams.map((team) => (
            <option key={team.teamId} value={team.teamId}>
              {team.name}
            </option>
          ))}
        </Select>
      </div>

      {selectedTeam ? (
        <div className="mt-5 space-y-3">
          {(golfConfig.holes || []).map((hole, index) => {
            const score = scores.find(
              (item) =>
                item.teamId === selectedTeam.teamId && item.holeId === hole.id,
            );
            return (
              <AdminScoreRow
                key={`${selectedTeam.teamId}-${hole.id}`}
                team={selectedTeam}
                hole={hole}
                index={index}
                score={score}
                onSave={onSaveScore}
                onDelete={onDeleteScore}
              />
            );
          })}
        </div>
      ) : (
        <div className="mt-5 rounded-xl border border-blue-300/10 bg-blue-950/30 p-6 text-center text-sm text-blue-100/60">
          Create a team before using score correction.
        </div>
      )}
    </PremiumCard>
  );
}

function AdminScoreRow({ team, hole, index, score, onSave, onDelete }) {
  const [sips, setSips] = useState(score?.sips || 0);
  const [bonuses, setBonuses] = useState(score?.bonuses || 0);
  const [penalties, setPenalties] = useState(score?.penalties || 0);

  useEffect(() => {
    setSips(Math.max(0, Math.round(Number(score?.sips) || 0)));
    setBonuses(Math.max(0, Math.round(Number(score?.bonuses) || 0)));
    setPenalties(Math.max(0, Math.round(Number(score?.penalties) || 0)));
  }, [score]);

  const total = Number(sips) - Number(bonuses) + Number(penalties);

  return (
    <div className={`admin-score-row ${hole.active === false ? "admin-score-inactive" : ""}`}>
      <div className="admin-score-heading">
        <div className="hole-number">{index + 1}</div>
        <div className="min-w-0">
          <div className="truncate font-bold text-white">{hole.name}</div>
          <div className="text-xs text-blue-100/50">
            {score
              ? `Last entered by ${score.confirmedByName || "Unknown"} · ${formatTimestamp(score.updatedAt)}`
              : "No saved score"}
          </div>
          {hole.active === false ? <Badge className="mt-1">Inactive hole</Badge> : null}
        </div>
      </div>

      <div className="admin-score-inputs">
        <AdminScoreInput label="Sips" value={sips} setValue={setSips} />
        <AdminScoreInput label="Bonuses" value={bonuses} setValue={setBonuses} prefix="−" />
        <AdminScoreInput label="Penalties" value={penalties} setValue={setPenalties} prefix="+" />
        <div className="admin-score-total">
          <span>Total</span>
          <strong>{total}</strong>
        </div>
      </div>

      <div className="admin-score-actions">
        <Button
          size="sm"
          onClick={() => onSave(team, hole, { sips, bonuses, penalties })}
        >
          {score ? "Update score" : "Save score"}
        </Button>
        {score ? (
          <Button variant="danger" size="sm" onClick={() => onDelete(team, hole)}>
            Delete score
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function AdminScoreInput({ label, value, setValue, prefix = "" }) {
  return (
    <label>
      <span>{label}</span>
      <div>
        {prefix ? <b>{prefix}</b> : null}
        <input
          type="number"
          min="0"
          max="99"
          value={value}
          onChange={(event) =>
            setValue(Math.max(0, Math.round(Number(event.target.value) || 0)))
          }
        />
      </div>
    </label>
  );
}

// -----------------------------------------------------------------------------
// Admin team manager
// -----------------------------------------------------------------------------
function AdminTeamManager({
  teams,
  scores,
  onCreateTeam,
  onUpdateTeam,
  onDeleteTeam,
  onClearAllScores,
}) {
  const assignedIds = useMemo(
    () => new Set(teams.flatMap((team) => team.memberIds || [])),
    [teams],
  );
  const duplicateAssignments = useMemo(
    () => buildPlayerTeamState(teams).conflicts,
    [teams],
  );
  const unassignedPlayers = PLAYERS.filter((player) => !assignedIds.has(player.id));
  const [firstPlayerId, setFirstPlayerId] = useState("");
  const [secondPlayerId, setSecondPlayerId] = useState("");
  const [soloTeam, setSoloTeam] = useState(false);
  const [expandedTeamId, setExpandedTeamId] = useState("");

  useEffect(() => {
    if (firstPlayerId && assignedIds.has(firstPlayerId)) setFirstPlayerId("");
    if (secondPlayerId && assignedIds.has(secondPlayerId)) setSecondPlayerId("");
  }, [assignedIds, firstPlayerId, secondPlayerId]);

  useEffect(() => {
    if (
      expandedTeamId &&
      !teams.some((team) => team.teamId === expandedTeamId)
    ) {
      setExpandedTeamId("");
    }
  }, [expandedTeamId, teams]);

  const createSelectedTeam = async () => {
    if (!firstPlayerId) {
      toast.error("Select the first player.");
      return;
    }
    if (!soloTeam && !secondPlayerId) {
      toast.error("Select the second player or choose Solo team.");
      return;
    }
    if (!soloTeam && firstPlayerId === secondPlayerId) {
      toast.error("Choose two different players.");
      return;
    }

    const created = await onCreateTeam(
      soloTeam ? [firstPlayerId] : [firstPlayerId, secondPlayerId],
    );
    if (!created) return;

    setFirstPlayerId("");
    setSecondPlayerId("");
    setSoloTeam(false);
  };

  return (
    <div className="space-y-5">
      {duplicateAssignments.length ? (
        <PremiumCard className="border-red-400/45 p-5 sm:p-6">
          <div className="section-eyebrow text-red-200">Duplicate assignment detected</div>
          <h2 className="mt-1 text-xl font-black text-white">
            A player is currently listed on more than one team
          </h2>
          <p className="mt-2 text-sm leading-6 text-blue-100/70">
            New team creation is blocked until the incorrect duplicate team is disbanded below.
          </p>
          <div className="mt-4 space-y-2">
            {duplicateAssignments.map((conflict) => {
              const player = PLAYER_BY_ID[conflict.playerId];
              const teamNames = conflict.teamIds
                .map((teamId) => teams.find((team) => team.teamId === teamId)?.name)
                .filter(Boolean);
              return (
                <div
                  key={conflict.playerId}
                  className="rounded-xl border border-red-300/20 bg-red-950/20 p-3 text-sm text-white"
                >
                  <strong>{player?.fullName || player?.name || conflict.playerId}</strong>
                  <span className="block mt-1 text-xs text-red-100/70">
                    Appears in: {teamNames.join(" and ") || "multiple teams"}
                  </span>
                </div>
              );
            })}
          </div>
        </PremiumCard>
      ) : null}

      <PremiumCard className="p-5 sm:p-6">
        <SectionHeading
          eyebrow="Admin control centre"
          title="Team manager"
          description="Players only appear on the ladder after you create a solo or two-player team for them."
          action={
            <Button variant="danger" size="sm" onClick={onClearAllScores}>
              Clear all scores
            </Button>
          }
        />

        <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="admin-panel">
            <h3>Create a team</h3>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div>
                <Label>Player 1</Label>
                <Select
                  className="mt-1"
                  value={firstPlayerId}
                  onChange={(event) => setFirstPlayerId(event.target.value)}
                >
                  <option value="">Select a player</option>
                  {unassignedPlayers.map((player) => (
                    <option key={player.id} value={player.id}>
                      {player.fullName || player.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label>Player 2</Label>
                <Select
                  className="mt-1"
                  value={secondPlayerId}
                  disabled={soloTeam}
                  onChange={(event) => setSecondPlayerId(event.target.value)}
                >
                  <option value="">Select a player</option>
                  {unassignedPlayers
                    .filter((player) => player.id !== firstPlayerId)
                    .map((player) => (
                      <option key={player.id} value={player.id}>
                        {player.fullName || player.name}
                      </option>
                    ))}
                </Select>
              </div>
            </div>

            <label className="mt-4 flex cursor-pointer items-center gap-3 rounded-xl border border-blue-300/15 bg-blue-950/30 p-3 text-sm text-white">
              <input
                type="checkbox"
                checked={soloTeam}
                onChange={(event) => {
                  setSoloTeam(event.target.checked);
                  if (event.target.checked) setSecondPlayerId("");
                }}
                className="h-4 w-4 accent-amber-400"
              />
              Create this as a solo-player team
            </label>

            <Button className="mt-4 w-full" onClick={createSelectedTeam}>
              Create team
            </Button>
          </div>

          <div className="admin-panel">
            <h3>Event overview</h3>
            <div className="mt-4 grid grid-cols-3 gap-2 text-center">
              <AdminNumber label="Players" value={PLAYERS.length} />
              <AdminNumber label="Teams" value={teams.length} />
              <AdminNumber label="Unassigned" value={unassignedPlayers.length} />
            </div>
            <p className="mt-4 text-xs leading-5 text-blue-100/55">
              Team membership is stored in Firebase. Player names, photos, login codes and career statistics are stored in <code>src/data/players.js</code>.
            </p>
          </div>
        </div>
      </PremiumCard>

      <PremiumCard className="p-5 sm:p-6">
        <SectionHeading
          eyebrow="Available players"
          title={`Unassigned players (${unassignedPlayers.length})`}
          description="These players can be selected when creating or editing a team."
        />
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {unassignedPlayers.map((player) => (
            <div key={player.id} className="member-tile">
              <PlayerAvatar player={player} size="sm" />
              <div className="min-w-0">
                <div className="truncate font-bold text-white">{player.name}</div>
                <div className="truncate text-xs text-blue-100/55">
                  {player.fullName || player.name}
                </div>
                <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-amber-200/65">
                  Not assigned
                </div>
              </div>
            </div>
          ))}
          {unassignedPlayers.length === 0 ? (
            <p className="text-sm text-blue-100/60">Every player has been assigned.</p>
          ) : null}
        </div>
      </PremiumCard>

      <div className="space-y-3">
        {teams.map((team) => (
          <AdminTeamEditor
            key={team.teamId}
            team={team}
            teams={teams}
            scoreCount={scores.filter((score) => score.teamId === team.teamId).length}
            onSave={onUpdateTeam}
            onDelete={onDeleteTeam}
            expanded={expandedTeamId === team.teamId}
            onToggle={() =>
              setExpandedTeamId((current) =>
                current === team.teamId ? "" : team.teamId,
              )
            }
          />
        ))}
      </div>
    </div>
  );
}

function AdminNumber({ label, value }) {
  return (
    <div className="rounded-xl border border-blue-300/10 bg-blue-950/35 p-3">
      <strong className="block text-2xl text-amber-200">{value}</strong>
      <span className="text-[10px] font-bold uppercase tracking-[0.13em] text-blue-100/50">
        {label}
      </span>
    </div>
  );
}

function AdminTeamEditor({
  team,
  teams,
  scoreCount,
  onSave,
  onDelete,
  expanded,
  onToggle,
}) {
  const [name, setName] = useState(team.name || "");
  const [memberOne, setMemberOne] = useState(team.memberIds?.[0] || "");
  const [memberTwo, setMemberTwo] = useState(team.memberIds?.[1] || "");

  useEffect(() => {
    setName(team.name || "");
    setMemberOne(team.memberIds?.[0] || "");
    setMemberTwo(team.memberIds?.[1] || "");
  }, [team]);

  const assignedToOtherTeam = new Set(
    teams
      .filter((otherTeam) => otherTeam.teamId !== team.teamId)
      .flatMap((otherTeam) => otherTeam.memberIds || []),
  );
  const availablePlayers = PLAYERS.filter(
    (player) =>
      !assignedToOtherTeam.has(player.id) || team.memberIds?.includes(player.id),
  );

  const members = getTeamPlayers(team);

  return (
    <PremiumCard className={`admin-team-accordion ${expanded ? "admin-team-accordion-open" : ""}`}>
      <button
        type="button"
        className="admin-team-summary"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div className="flex -space-x-3">
            {members.map((member) => (
              <PlayerAvatar key={member.id} player={member} size="md" />
            ))}
          </div>
          <div className="min-w-0 text-left">
            <h3 className="truncate text-xl font-black text-white">{team.name}</h3>
            <p className="mt-0.5 text-xs text-blue-100/55">
              {members.map((member) => member.name).join(" & ")} · {scoreCount} saved score record{scoreCount === 1 ? "" : "s"}
            </p>
          </div>
        </div>
        <span className="admin-team-chevron" aria-hidden="true">
          {expanded ? "−" : "+"}
        </span>
      </button>

      {expanded ? (
        <div className="admin-team-editor-content">
          <div className="grid gap-3 lg:grid-cols-[1fr_0.8fr_0.8fr_auto] lg:items-end">
            <div>
              <Label>Team name</Label>
              <Input className="mt-1" value={name} onChange={(event) => setName(event.target.value)} />
            </div>
            <div>
              <Label>Player 1</Label>
              <Select
                className="mt-1"
                value={memberOne}
                onChange={(event) => setMemberOne(event.target.value)}
              >
                <option value="">Select player</option>
                {availablePlayers
                  .filter((player) => player.id !== memberTwo)
                  .map((player) => (
                    <option key={player.id} value={player.id}>
                      {player.fullName || player.name}
                    </option>
                  ))}
              </Select>
            </div>
            <div>
              <Label>Player 2 / solo</Label>
              <Select
                className="mt-1"
                value={memberTwo}
                onChange={(event) => setMemberTwo(event.target.value)}
              >
                <option value="">Solo team</option>
                {availablePlayers
                  .filter((player) => player.id !== memberOne)
                  .map((player) => (
                    <option key={player.id} value={player.id}>
                      {player.fullName || player.name}
                    </option>
                  ))}
              </Select>
            </div>
            <Button
              onClick={() =>
                onSave(team, {
                  name,
                  memberIds: [memberOne, memberTwo].filter(Boolean),
                })
              }
            >
              Save team
            </Button>
          </div>

          <div className="mt-4 flex justify-end">
            <Button variant="danger" size="sm" onClick={() => onDelete(team)}>
              Disband team
            </Button>
          </div>
        </div>
      ) : null}
    </PremiumCard>
  );
}
