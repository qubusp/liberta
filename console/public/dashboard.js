(function () {
  "use strict";

  const POLL_MS = 4000;
  let selectedSessionId = null;

  const sessionsBody = document.querySelector("#sessions-table tbody");
  const tasksBody = document.querySelector("#tasks-table tbody");
  const eventsLog = document.getElementById("events-log");
  const detailTitle = document.getElementById("detail-title");

  // Last-known status per session id, taken from /api/sessions. The detail
  // payload does not always carry `status`, and this is only used to drive
  // the decorative t6 pixel-art treatment on the detail header.
  const sessionStatusById = new Map();

  function statusSlug(status) {
    return (status || "unknown").toString().toLowerCase().replace(/[^a-z0-9_]/g, "_");
  }

  function statusClass(status) {
    return "status-" + statusSlug(status);
  }

  function statusPill(status) {
    const span = document.createElement("span");
    span.className = "status-pill " + statusClass(status);
    span.textContent = status || "unknown";
    return span;
  }

  async function fetchJson(url) {
    const res = await fetch(url, { credentials: "same-origin" });
    if (res.status === 401) {
      window.location.href = "/login";
      return null;
    }
    if (!res.ok) {
      throw new Error("request failed: " + res.status);
    }
    return res.json();
  }

  function renderSessions(data) {
    sessionsBody.innerHTML = "";
    for (const s of data.sessions) {
      const tr = document.createElement("tr");
      tr.dataset.id = s.id;
      // Drives the pixel-art "working" row treatment in style.css (t6).
      // A data attribute, not a class, so it cannot collide with the
      // .status-* pill colour rules.
      tr.dataset.status = statusSlug(s.status);
      sessionStatusById.set(s.id, s.status);

      const idTd = document.createElement("td");
      idTd.textContent = s.id;
      tr.appendChild(idTd);

      const projTd = document.createElement("td");
      projTd.textContent = s.project_path || "-";
      tr.appendChild(projTd);

      const statusTd = document.createElement("td");
      statusTd.appendChild(statusPill(s.status));
      tr.appendChild(statusTd);

      const activeTd = document.createElement("td");
      activeTd.textContent = s.is_active ? "active" : "";
      activeTd.className = s.is_active ? "active-yes" : "active-no";
      tr.appendChild(activeTd);

      if (s.id === selectedSessionId) tr.classList.add("selected-row");
      tr.addEventListener("click", () => {
        sessionsBody.querySelectorAll("tr").forEach((row) => row.classList.remove("selected-row"));
        tr.classList.add("selected-row");
        selectSession(s.id);
      });
      sessionsBody.appendChild(tr);
    }

    // Default to the active session on first load, if nothing selected yet.
    if (!selectedSessionId && data.active_session_id) {
      selectSession(data.active_session_id);
    }
  }

  function renderDetail(data) {
    detailTitle.textContent = data.id;
    // Same purely-decorative hook for the detail header (t6). The title
    // text is unchanged, so the heading's accessible name is unaffected.
    detailTitle.dataset.status = statusSlug(
      data.state?.status != null ? data.state.status : sessionStatusById.get(data.id)
    );

    tasksBody.innerHTML = "";
    const tasks = Array.isArray(data.tasks) ? data.tasks : [];
    for (const t of tasks) {
      const tr = document.createElement("tr");

      const idTd = document.createElement("td");
      idTd.textContent = t.id || "-";
      tr.appendChild(idTd);

      const roleTd = document.createElement("td");
      roleTd.textContent = t.role || "-";
      tr.appendChild(roleTd);

      const waveTd = document.createElement("td");
      waveTd.textContent = t.wave != null ? t.wave : "-";
      tr.appendChild(waveTd);

      const statusTd = document.createElement("td");
      statusTd.appendChild(statusPill(t.status));
      tr.appendChild(statusTd);

      tasksBody.appendChild(tr);
    }

    const lines = (data.events || []).map((ev) => {
      if (ev && ev.raw) return ev.raw;
      try {
        return JSON.stringify(ev);
      } catch (err) {
        return String(ev);
      }
    });
    eventsLog.textContent = lines.join("\n") || "(no events yet)";
    eventsLog.scrollTop = eventsLog.scrollHeight;
  }

  async function selectSession(id) {
    if (id !== selectedSessionId) {
      lastRenderedChatJson = null;
      // The chat thread must never outlive the session it belongs to: if
      // the next session's inbox fetch fails (its run was reaped, the DB
      // is briefly unavailable, ...), refreshChat's catch would otherwise
      // leave the previous session's bubbles on screen under the new
      // title. Clear the cache and repaint synchronously on switch, before
      // any network round-trip, so there is never a moment where session
      // A's messages are shown under session B's heading.
      chatMessagesCache = [];
      renderChat();
    }
    selectedSessionId = id;
    await refreshDetail();
  }

  async function refreshSessions() {
    try {
      const data = await fetchJson("/api/sessions");
      if (data) renderSessions(data);
    } catch (err) {
      console.error("failed to refresh sessions", err);
    }
  }

  async function refreshDetail() {
    if (!selectedSessionId) return;
    try {
      const data = await fetchJson(
        "/api/sessions/" + encodeURIComponent(selectedSessionId)
      );
      if (data) renderDetail(data);
    } catch (err) {
      console.error("failed to refresh session detail", err);
    }
  }

  async function loadWhoami() {
    const whoamiEl = document.getElementById("whoami");
    if (!whoamiEl) return;
    try {
      const data = await fetchJson("/api/whoami");
      if (!data) return;
      whoamiEl.textContent = "";
      if (data.avatar_url) {
        const img = document.createElement("img");
        img.src = data.avatar_url;
        img.alt = data.username || "";
        img.className = "whoami-avatar";
        whoamiEl.appendChild(img);
      } else {
        const fallback = document.createElement("span");
        fallback.className = "whoami-avatar-fallback";
        const name = data.username || "admin";
        fallback.textContent = name.slice(0, 2).toUpperCase();
        whoamiEl.appendChild(fallback);
      }
      const label = document.createElement("span");
      label.textContent = data.username || "admin";
      whoamiEl.appendChild(label);
    } catch (err) {
      // Non-critical -- leave the header without an identity label.
    }
  }

  async function tick() {
    await refreshSessions();
    await refreshDetail();
    if (activeDetailTab === "skills") {
      await refreshRunSkills();
    }
    if (activeDetailTab === "chat") {
      await refreshChat();
    }
    // Gated exactly like refreshRunSkills/refreshChat: no /api/sessions/graph
    // traffic at all while the mindmap view is closed.
    if (mindmapActive) {
      await refreshMindmap();
    }
  }

  // -----------------------------------------------------------------
  // Top-level nav: Runs vs Skills library
  // -----------------------------------------------------------------
  const topbarTitle = document.getElementById("topbar-title");
  const NAV_TITLES = {
    "runs-view": "Runs",
    "mindmap-view": "Session mindmap",
    "skills-view": "Skills library",
  };
  document.querySelectorAll(".nav-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".nav-tab").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const target = btn.dataset.view;
      // Every top-level view is hidden except the target, so adding a
      // view only means adding its markup + a NAV_TITLES entry.
      document.querySelectorAll("main.view").forEach((view) => {
        view.hidden = view.id !== target;
      });
      if (topbarTitle) topbarTitle.textContent = NAV_TITLES[target] || "";
      mindmapActive = target === "mindmap-view";
      if (target === "skills-view") {
        refreshSkillsLibrary();
      }
      if (mindmapActive) {
        refreshMindmap();
      }
    });
  });

  // -----------------------------------------------------------------
  // Run detail: Task board vs Skills-for-this-run tabs
  // -----------------------------------------------------------------
  let activeDetailTab = "board";
  const boardTabPanel = document.getElementById("detail-board-tab");
  const skillsTabPanel = document.getElementById("detail-skills-tab");
  const chatTabPanel = document.getElementById("detail-chat-tab");
  document.querySelectorAll(".detail-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".detail-tab").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      activeDetailTab = btn.dataset.detailTab;
      boardTabPanel.classList.toggle("active", activeDetailTab === "board");
      skillsTabPanel.classList.toggle("active", activeDetailTab === "skills");
      chatTabPanel.classList.toggle("active", activeDetailTab === "chat");
      if (activeDetailTab === "skills") {
        refreshRunSkills();
      }
      if (activeDetailTab === "chat") {
        refreshChat();
      }
    });
  });

  // -----------------------------------------------------------------
  // Skills for the currently selected run
  // -----------------------------------------------------------------
  const runSkillsBody = document.querySelector("#run-skills-table tbody");
  const runSkillEditor = document.getElementById("run-skill-editor");
  const runSkillEditorTitle = document.getElementById("run-skill-editor-title");
  const runSkillEditorBadge = document.getElementById("run-skill-editor-badge");
  const runSkillEditorContent = document.getElementById("run-skill-editor-content");
  let runSkillsCache = [];
  let selectedRunSkillName = null;

  async function refreshRunSkills() {
    if (!selectedSessionId) return;
    try {
      const data = await fetchJson(
        "/api/sessions/" + encodeURIComponent(selectedSessionId) + "/skills"
      );
      if (!data) return;
      runSkillsCache = data.skills || [];
      renderRunSkills();
    } catch (err) {
      console.error("failed to refresh run skills", err);
    }
  }

  function renderRunSkills() {
    runSkillsBody.innerHTML = "";
    for (const s of runSkillsCache) {
      const tr = document.createElement("tr");

      const nameTd = document.createElement("td");
      nameTd.textContent = s.name;
      tr.appendChild(nameTd);

      const kindTd = document.createElement("td");
      kindTd.textContent = s.kind;
      tr.appendChild(kindTd);

      const statusTd = document.createElement("td");
      const badge = document.createElement("span");
      badge.className = "badge " + (s.overridden ? "badge-override" : "badge-library");
      badge.textContent = s.overridden ? "overridden for this run" : "library version";
      statusTd.appendChild(badge);
      tr.appendChild(statusTd);

      const actionTd = document.createElement("td");
      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "btn-table-action";
      editBtn.textContent = "Edit / override";
      editBtn.addEventListener("click", () => openRunSkillEditor(s.name));
      actionTd.appendChild(editBtn);
      tr.appendChild(actionTd);

      runSkillsBody.appendChild(tr);
    }
  }

  function openRunSkillEditor(name) {
    const s = runSkillsCache.find((x) => x.name === name);
    if (!s) return;
    selectedRunSkillName = name;
    runSkillEditorTitle.textContent = name;
    runSkillEditorBadge.className = "badge " + (s.overridden ? "badge-override" : "badge-library");
    runSkillEditorBadge.textContent = s.overridden
      ? "Editing an override for THIS RUN ONLY"
      : "No override yet -- saving will create one for THIS RUN ONLY";
    runSkillEditorContent.value = s.content;
    runSkillEditor.hidden = false;
  }

  document.getElementById("run-skill-save").addEventListener("click", async () => {
    if (!selectedRunSkillName || !selectedSessionId) return;
    try {
      const res = await fetch(
        "/api/sessions/" +
          encodeURIComponent(selectedSessionId) +
          "/skills/" +
          encodeURIComponent(selectedRunSkillName),
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ content: runSkillEditorContent.value }),
        }
      );
      if (!res.ok) throw new Error("save failed: " + res.status);
      await refreshRunSkills();
      openRunSkillEditor(selectedRunSkillName);
    } catch (err) {
      alert("Failed to save override: " + err.message);
    }
  });

  document.getElementById("run-skill-revert").addEventListener("click", async () => {
    if (!selectedRunSkillName || !selectedSessionId) return;
    try {
      const res = await fetch(
        "/api/sessions/" +
          encodeURIComponent(selectedSessionId) +
          "/skills/" +
          encodeURIComponent(selectedRunSkillName),
        { method: "DELETE", credentials: "same-origin" }
      );
      if (!res.ok && res.status !== 404) throw new Error("revert failed: " + res.status);
      await refreshRunSkills();
      openRunSkillEditor(selectedRunSkillName);
    } catch (err) {
      alert("Failed to revert override: " + err.message);
    }
  });

  document.getElementById("run-skill-close").addEventListener("click", () => {
    runSkillEditor.hidden = true;
    selectedRunSkillName = null;
  });

  // -----------------------------------------------------------------
  // Chat: an operator-facing UI over the inbox routes (steer/question/info
  // messages the controller drains, and its replies to them). Not a
  // chatbot -- no LLM is called from here.
  // -----------------------------------------------------------------
  const chatThread = document.getElementById("chat-thread");
  const chatForm = document.getElementById("chat-form");
  const chatText = document.getElementById("chat-text");
  const chatType = document.getElementById("chat-type");
  const chatSend = document.getElementById("chat-send");
  const chatError = document.getElementById("chat-error");
  let chatMessagesCache = [];
  let lastRenderedChatJson = null;

  function formatTs(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return ts;
    return d.toLocaleString();
  }

  // Message direction must never be carried by colour alone (a colour-blind
  // operator, or a greyscale print of a screenshot, has to parse the
  // thread too), so every bubble gets a real text label in the DOM -- not
  // a CSS ::before -- which also means the role=log live region announces
  // "You" / "Controller reply" along with the message.
  const CHAT_TYPES = ["steer", "question", "info"];

  function chatBubbleHead(roleLabel, type) {
    const head = document.createElement("div");
    head.className = "chat-bubble-head";

    const who = document.createElement("span");
    who.className = "chat-role";
    who.textContent = roleLabel;
    head.appendChild(who);

    if (type !== undefined) {
      const badge = document.createElement("span");
      // Only ever interpolate a class from a fixed allowlist; message
      // .type comes off disk and is not trusted as a class name.
      const safeType = CHAT_TYPES.indexOf(type) === -1 ? "other" : type;
      badge.className = "badge chat-type-badge chat-type-" + safeType;
      badge.textContent = type;
      head.appendChild(badge);
    }
    return head;
  }

  function renderChat() {
    chatThread.innerHTML = "";
    if (chatMessagesCache.length === 0) {
      const empty = document.createElement("p");
      empty.className = "hint chat-empty";
      empty.textContent = "No messages yet";
      chatThread.appendChild(empty);
      return;
    }
    for (const m of chatMessagesCache) {
      const outWrap = document.createElement("div");
      outWrap.className = "chat-bubble chat-bubble-out";

      outWrap.appendChild(chatBubbleHead("You", m.type || "steer"));

      const outText = document.createElement("p");
      outText.className = "chat-text";
      outText.textContent = m.text;
      outWrap.appendChild(outText);

      const outMeta = document.createElement("span");
      outMeta.className = "hint chat-ts";
      outMeta.textContent = formatTs(m.ts);
      outWrap.appendChild(outMeta);

      chatThread.appendChild(outWrap);

      if (m.reply) {
        const inWrap = document.createElement("div");
        inWrap.className = "chat-bubble chat-bubble-in";

        inWrap.appendChild(chatBubbleHead("Controller reply"));

        const inText = document.createElement("p");
        inText.className = "chat-text";
        inText.textContent = m.reply;
        inWrap.appendChild(inText);

        const inMeta = document.createElement("span");
        inMeta.className = "hint chat-ts";
        inMeta.textContent = formatTs(m.replied_ts);
        inWrap.appendChild(inMeta);

        chatThread.appendChild(inWrap);
      } else {
        const pending = document.createElement("p");
        pending.className = "hint chat-pending";
        pending.textContent = "Awaiting reply...";
        chatThread.appendChild(pending);
      }
    }
    chatThread.scrollTop = chatThread.scrollHeight;
  }

  // Rendered when the inbox fetch for the *currently selected* session
  // fails. Distinct from renderChat's "No messages yet" so the operator
  // can tell "this run has nothing to show" apart from "we couldn't load
  // this run's thread" -- the latter must never be silently mistaken for
  // an empty thread, and must never be the previous session's messages.
  function renderChatError() {
    chatThread.innerHTML = "";
    const error = document.createElement("p");
    error.className = "hint chat-empty chat-fetch-error";
    error.textContent = "Could not load this session's messages.";
    chatThread.appendChild(error);
  }

  async function refreshChat() {
    if (!selectedSessionId) return;
    // Snapshot the session this fetch is for -- if the operator switches
    // sessions again while the request is in flight, selectSession will
    // already have cleared/repainted the thread for the new session, and
    // a late-arriving response (success or failure) for the old id below
    // must not clobber it.
    const requestedSessionId = selectedSessionId;
    try {
      const data = await fetchJson(
        "/api/sessions/" + encodeURIComponent(requestedSessionId) + "/inbox"
      );
      if (!data) return;
      if (requestedSessionId !== selectedSessionId) return;
      const next = JSON.stringify(data.messages || []);
      if (next === lastRenderedChatJson) return;
      lastRenderedChatJson = next;
      chatMessagesCache = data.messages || [];
      renderChat();
    } catch (err) {
      console.error("failed to refresh chat", err);
      if (requestedSessionId !== selectedSessionId) return;
      chatMessagesCache = [];
      lastRenderedChatJson = null;
      renderChatError();
    }
  }

  chatForm.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (!selectedSessionId) return;
    const text = chatText.value.trim();
    if (!text) return;
    chatError.hidden = true;
    chatError.textContent = "";
    chatSend.disabled = true;
    try {
      const res = await fetch(
        "/api/sessions/" + encodeURIComponent(selectedSessionId) + "/inbox",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ type: chatType.value, text }),
        }
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "send failed: " + res.status);
      }
      chatText.value = "";
      await refreshChat();
    } catch (err) {
      chatError.textContent = "Failed to send: " + err.message;
      chatError.hidden = false;
    } finally {
      chatSend.disabled = false;
    }
  });

  // -----------------------------------------------------------------
  // Skills library (global, not run-scoped)
  // -----------------------------------------------------------------
  const skillsBody = document.querySelector("#skills-table tbody");
  const skillDetail = document.getElementById("skill-detail");
  const skillDetailTitle = document.getElementById("skill-detail-title");
  const skillDetailBadge = document.getElementById("skill-detail-badge");
  const skillDetailDescription = document.getElementById("skill-detail-description");
  const skillDetailContent = document.getElementById("skill-detail-content");
  const skillNote = document.getElementById("skill-note");
  let selectedSkillName = null;
  let selectedSkillSource = null;

  async function refreshSkillsLibrary() {
    try {
      const data = await fetchJson("/api/skills");
      if (!data) return;
      renderSkillsLibrary(data.skills || []);
    } catch (err) {
      console.error("failed to refresh skills library", err);
    }
  }

  function renderSkillsLibrary(skills) {
    skillsBody.innerHTML = "";
    for (const s of skills) {
      const tr = document.createElement("tr");
      tr.title = s.description || "";

      const nameTd = document.createElement("td");
      nameTd.textContent = s.name;
      tr.appendChild(nameTd);

      const kindTd = document.createElement("td");
      kindTd.textContent = s.kind;
      tr.appendChild(kindTd);

      const sourceTd = document.createElement("td");
      const badge = document.createElement("span");
      badge.className = "badge " + (s.source === "imported" ? "badge-override" : "badge-library");
      badge.textContent = s.source;
      sourceTd.appendChild(badge);
      tr.appendChild(sourceTd);

      tr.addEventListener("click", () => openSkillDetail(s.name));
      skillsBody.appendChild(tr);
    }
  }

  async function openSkillDetail(name) {
    try {
      const data = await fetchJson("/api/skills/" + encodeURIComponent(name));
      if (!data) return;
      selectedSkillName = data.name;
      selectedSkillSource = data.source;
      skillDetailTitle.textContent = data.name;
      skillDetailBadge.className = "badge " + (data.source === "imported" ? "badge-override" : "badge-library");
      skillDetailBadge.textContent = data.source;
      skillDetailDescription.textContent = data.description || "";
      skillDetailContent.value = data.content;
      skillNote.textContent = "";
      document.getElementById("skill-delete").hidden = data.source !== "imported";
      skillDetail.hidden = false;
    } catch (err) {
      console.error("failed to load skill", err);
    }
  }

  document.getElementById("skill-save").addEventListener("click", async () => {
    if (!selectedSkillName) return;
    try {
      const res = await fetch("/api/skills/" + encodeURIComponent(selectedSkillName), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ content: skillDetailContent.value }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "save failed: " + res.status);
      skillNote.textContent = body.note || "Saved.";
      await refreshSkillsLibrary();
    } catch (err) {
      alert("Failed to save: " + err.message);
    }
  });

  document.getElementById("skill-delete").addEventListener("click", async () => {
    if (!selectedSkillName) return;
    if (!confirm("Delete imported skill '" + selectedSkillName + "'?")) return;
    try {
      const res = await fetch("/api/skills/" + encodeURIComponent(selectedSkillName), {
        method: "DELETE",
        credentials: "same-origin",
      });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error || "delete failed: " + res.status);
      }
      skillDetail.hidden = true;
      selectedSkillName = null;
      await refreshSkillsLibrary();
    } catch (err) {
      alert("Failed to delete: " + err.message);
    }
  });

  document.getElementById("import-skill-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const name = document.getElementById("import-name").value.trim();
    const kind = document.getElementById("import-kind").value;
    const description = document.getElementById("import-description").value.trim();
    const content = document.getElementById("import-content").value;
    try {
      const res = await fetch("/api/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ name, kind, description, content }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "import failed: " + res.status);
      document.getElementById("import-skill-form").reset();
      await refreshSkillsLibrary();
      openSkillDetail(name);
    } catch (err) {
      alert("Failed to import: " + err.message);
    }
  });

  // -----------------------------------------------------------------
  // Session mindmap: the whole run store as a lineage graph.
  //
  // Data comes only from GET /api/sessions/graph (t10); this module does
  // no derivation of its own beyond LAYOUT. Nodes are real <button>s
  // absolutely positioned over an <svg> that carries only the edges, so
  // the graph is keyboard-reachable and every label goes through
  // textContent (ids, task titles and event summaries are read off disk
  // and are not trusted).
  //
  // Re-render UPDATES nodes in place -- a full rebuild each poll would
  // steal keyboard focus from whichever node the operator is on.
  // -----------------------------------------------------------------
  // --- Constellation geometry (t12) -------------------------------------
  // Nodes are STARS: a luminous orb centred on the layout point, with a
  // caption (id, badges, counts, lineage) hanging underneath it. The
  // caption box is a fixed width so captions never reflow between polls.
  const NODE_W = 178; // caption column width
  const ORB_SLOT = 84; // fixed vertical slot the orb is centred in
  const CAP_H = 152; // caption height reserved below the orb
  const ORB_MIN = 30;
  const ORB_MAX = 74;
  const MIN_ARC = 216; // minimum arc length per node on a ring
  const MIN_RING = 252; // minimum radial gap between generations
  const MAX_TILT = 0.8; // radians: per-constellation rotation, hash-derived
  const COLLIDE_STEPS = 40; // hard cap on collision nudges per node
  const COLLIDE_STEP_PX = 22;
  const MAX_SPAN = 2.4; // radians: cap on a non-root node's angular wedge
  const CLUSTER_GAP = 96;
  const CANVAS_PAD = 56;
  const MAX_DEPTH = 64;

  const mindmapCanvas = document.getElementById("mindmap-canvas");
  const mindmapEdgesSvg = document.getElementById("mindmap-edges");
  const mindmapEdgeDefs = document.getElementById("mindmap-edge-defs");
  const mindmapNodesLayer = document.getElementById("mindmap-nodes");
  const mindmapList = document.getElementById("mindmap-list");
  const mindmapEmpty = document.getElementById("mindmap-empty");
  const mindmapErrorEl = document.getElementById("mindmap-error");
  const mindmapHideFixtures = document.getElementById("mindmap-hide-fixtures");

  let mindmapActive = false;
  let mindmapGraph = { nodes: [], edges: [] };
  // id -> { el, parts } for in-place updates.
  const mindmapNodeEls = new Map();

  function mindmapVisibleNodes() {
    const nodes = Array.isArray(mindmapGraph.nodes) ? mindmapGraph.nodes : [];
    if (mindmapHideFixtures && mindmapHideFixtures.checked) {
      return nodes.filter((n) => !n.is_fixture);
    }
    return nodes;
  }

  // Deterministic 32-bit string hash. Used ONLY for stable cosmetic
  // choices (which way an edge bows, which twinkle phase a star gets).
  // It must be a pure function of the id so nothing moves on a poll --
  // Math.random() here would make the whole map jitter every 4 seconds.
  function mindmapHash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i += 1) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  // Orb radius from the session's task count, so the map has a visual
  // hierarchy: a big run is a big star. sqrt so a 100-task run is not
  // 25x the area of a 4-task one.
  function mindmapOrbSize(node) {
    const total = (node.task_counts && Number(node.task_counts.total)) || 0;
    const scale = Math.min(Math.sqrt(Math.max(total, 0)), 6.5) / 6.5;
    let size = ORB_MIN + scale * (ORB_MAX - 10 - ORB_MIN);
    if (node.status === "running" || node.is_active) size += 10;
    return Math.round(Math.min(size, ORB_MAX));
  }

  // Lineage depth. Walks the parent chain with an EXPLICIT visited set
  // (and a hard cap) so a self-parent or an a->b->a cycle can never hang
  // the browser -- it just stops and treats the node as a root.
  function mindmapDepth(node, byId) {
    let depth = 0;
    const seen = new Set([node.id]);
    let cur = node;
    while (depth < MAX_DEPTH) {
      const parentId = cur.parent_session_id;
      if (!parentId || parentId === cur.id) break;
      if (!byId.has(parentId) || seen.has(parentId)) break;
      seen.add(parentId);
      cur = byId.get(parentId);
      depth += 1;
    }
    return depth;
  }

  // parent id -> [child ids]. Exactly the edge rule the payload uses: a
  // self-parent is not a parent link, and an unresolved parent is not a
  // parent link (that node is drawn as its own root, and its caption
  // still says the parent is not in the store).
  function mindmapChildMap(nodes, byId) {
    const children = new Map();
    for (const n of nodes) {
      const p = n.parent_session_id;
      if (p && p !== n.id && byId.has(p)) {
        if (!children.has(p)) children.set(p, []);
        children.get(p).push(n.id);
      }
    }
    return children;
  }

  // Depth-first order from every root-ish node, so children sit near
  // their mother. MULTIPLE ROOTS ARE THE NORM. Anything not reachable
  // from a root (i.e. a member of a cycle) is emitted afterwards, so no
  // node is ever dropped from the drawing.
  function mindmapOrder(nodes, byId) {
    const children = mindmapChildMap(nodes, byId);
    const visited = new Set();
    const order = [];
    const walk = (startId) => {
      const stack = [startId];
      while (stack.length > 0) {
        const id = stack.pop();
        if (visited.has(id)) continue;
        visited.add(id);
        const node = byId.get(id);
        if (node) order.push(node);
        const kids = children.get(id) || [];
        for (let i = kids.length - 1; i >= 0; i -= 1) stack.push(kids[i]);
      }
    };
    for (const n of nodes) {
      const p = n.parent_session_id;
      const rootish = !p || p === n.id || !byId.has(p);
      if (rootish) walk(n.id);
    }
    for (const n of nodes) {
      if (!visited.has(n.id)) walk(n.id);
    }
    return order;
  }

  // Split the forest into constellations: one cluster per root-ish node,
  // then one per group of nodes only reachable from inside a cycle. The
  // BFS carries a shared `visited` set, so a self-parent or an a->b->a
  // cycle terminates instead of looping -- no recursion anywhere.
  function mindmapClusters(nodes, byId) {
    const children = mindmapChildMap(nodes, byId);
    const visited = new Set();
    const clusters = [];
    const build = (rootId) => {
      const members = [];
      const depthOf = new Map([[rootId, 0]]);
      const queue = [rootId];
      visited.add(rootId);
      while (queue.length > 0) {
        const id = queue.shift();
        members.push(id);
        for (const kid of children.get(id) || []) {
          if (visited.has(kid)) continue; // cycle guard
          visited.add(kid);
          depthOf.set(kid, depthOf.get(id) + 1);
          queue.push(kid);
        }
      }
      clusters.push({ rootId, members, depthOf, children });
    };
    for (const n of nodes) {
      const p = n.parent_session_id;
      const rootish = !p || p === n.id || !byId.has(p);
      if (rootish && !visited.has(n.id)) build(n.id);
    }
    // Cycle-only groups: nothing in them is root-ish, so start anywhere.
    for (const n of nodes) {
      if (!visited.has(n.id)) build(n.id);
    }
    return clusters;
  }

  // Radial ("star chart") placement of one cluster around its root.
  // Angular wedge per node is proportional to its subtree size; ring
  // radius grows with the crowd on that ring so nodes cannot collide.
  // Fully deterministic: no randomness, so a poll never moves anything.
  function mindmapPlaceCluster(cluster) {
    const { rootId, members, depthOf, children } = cluster;
    const memberSet = new Set(members);
    const kidsOf = new Map();
    for (const id of members) {
      const kids = (children.get(id) || []).filter(
        (k) => memberSet.has(k) && depthOf.get(k) === depthOf.get(id) + 1
      );
      kidsOf.set(id, kids);
    }
    // Subtree leaf weight, computed deepest-first (no recursion).
    const byDepthDesc = members
      .slice()
      .sort((a, b) => depthOf.get(b) - depthOf.get(a));
    const weight = new Map();
    for (const id of byDepthDesc) {
      const kids = kidsOf.get(id);
      weight.set(
        id,
        kids.length === 0 ? 1 : kids.reduce((s, k) => s + (weight.get(k) || 1), 0)
      );
    }
    // Ring radii: wide enough that MIN_ARC fits every node on the ring.
    const countAt = new Map();
    let maxD = 0;
    for (const id of members) {
      const d = depthOf.get(id);
      countAt.set(d, (countAt.get(d) || 0) + 1);
      if (d > maxD) maxD = d;
    }
    const radii = [0];
    for (let d = 1; d <= maxD; d += 1) {
      const need = ((countAt.get(d) || 1) * MIN_ARC) / (2 * Math.PI);
      radii[d] = Math.max(radii[d - 1] + MIN_RING, need);
    }

    const pos = new Map([[rootId, { x: 0, y: 0, r: 0, a: 0 }]]);
    // Each constellation is rotated by a small amount derived from its
    // root id, so a forest of similar-shaped families does not line up
    // into rows. Hash-derived, therefore stable across every poll.
    const tilt = ((mindmapHash(rootId) % 1000) / 1000 - 0.5) * 2 * MAX_TILT;
    const stack = [
      { id: rootId, a0: -Math.PI / 2 + tilt, a1: Math.PI * 1.5 + tilt },
    ];
    while (stack.length > 0) {
      const frame = stack.pop();
      const kids = kidsOf.get(frame.id) || [];
      if (kids.length === 0) continue;
      const total = kids.reduce((s, k) => s + (weight.get(k) || 1), 0) || 1;
      let a = frame.a0;
      for (const k of kids) {
        const span = (frame.a1 - frame.a0) * ((weight.get(k) || 1) / total);
        const mid = a + span / 2;
        const r = radii[depthOf.get(k)] || MIN_RING;
        pos.set(k, { x: Math.cos(mid) * r, y: Math.sin(mid) * r, r: r, a: mid });
        // Clamp a descendant's wedge so a deep branch cannot wrap all the
        // way round and land on top of its own ancestors.
        const cs = Math.min(span, MAX_SPAN);
        stack.push({ id: k, a0: mid - cs / 2, a1: mid + cs / 2 });
        a += span;
      }
    }

    // COLLISION PASS. The rings guarantee enough ARC between siblings, but
    // a node placed diagonally from its mother can still have its caption
    // plate clip hers. Walk the stars from the inside out and push any
    // colliding one further along its own radius (never sideways, so the
    // lineage geometry is preserved). Bounded and deterministic: at most
    // COLLIDE_STEPS nudges per node, no randomness, so nothing moves
    // between polls.
    const boxOf = (p) => ({
      x0: p.x - NODE_W / 2 - 6,
      x1: p.x + NODE_W / 2 + 6,
      y0: p.y - ORB_SLOT / 2,
      y1: p.y - ORB_SLOT / 2 + ORB_SLOT + CAP_H,
    });
    const hits = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
    const settled = [];
    const byRadius = members
      .slice()
      .sort((a, b) => (pos.get(a).r || 0) - (pos.get(b).r || 0));
    for (const id of byRadius) {
      const p = pos.get(id);
      if (!p) continue;
      for (let step = 0; step < COLLIDE_STEPS; step += 1) {
        const box = boxOf(p);
        if (!settled.some((q) => hits(box, boxOf(q)))) break;
        if (p.r === 0) {
          // The cluster root has no radius to grow along; nudge it up
          // instead so it still crowns its own constellation.
          p.y -= COLLIDE_STEP_PX;
        } else {
          p.r += COLLIDE_STEP_PX;
          p.x = Math.cos(p.a) * p.r;
          p.y = Math.sin(p.a) * p.r;
        }
      }
      settled.push(p);
    }
    return pos;
  }

  function mindmapLayout(nodes) {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const order = mindmapOrder(nodes, byId);
    const clusters = mindmapClusters(nodes, byId);

    const positions = new Map();
    // Pack constellations left to right, staggered vertically so the row
    // of clusters does not read as a line of boxes.
    let cursorX = 0;
    let minY = Infinity;
    let maxY = -Infinity;
    clusters.forEach((cluster, ci) => {
      const local = mindmapPlaceCluster(cluster);
      let lMinX = Infinity;
      let lMaxX = -Infinity;
      local.forEach((p) => {
        if (p.x < lMinX) lMinX = p.x;
        if (p.x > lMaxX) lMaxX = p.x;
      });
      const stagger = (ci % 3) * 58 - 58;
      const shiftX = cursorX - lMinX + NODE_W / 2;
      local.forEach((p, id) => {
        const node = byId.get(id);
        const y = p.y + stagger;
        positions.set(id, {
          cx: p.x + shiftX + CANVAS_PAD,
          cy: y,
          depth: cluster.depthOf.get(id) || 0,
          orb: node ? mindmapOrbSize(node) : ORB_MIN,
        });
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      });
      cursorX += lMaxX - lMinX + NODE_W + CLUSTER_GAP;
    });

    if (!Number.isFinite(minY)) {
      minY = 0;
      maxY = 0;
    }
    // Shift so every star (and its caption) sits inside the canvas.
    const offsetY = CANVAS_PAD + ORB_SLOT / 2 - minY;
    positions.forEach((p) => {
      p.cy += offsetY;
      p.x = p.cx - NODE_W / 2; // button box top-left
      p.y = p.cy - ORB_SLOT / 2;
    });

    const width = Math.max(
      CANVAS_PAD * 2 + Math.max(cursorX - CLUSTER_GAP, NODE_W),
      NODE_W + CANVAS_PAD * 2
    );
    const height = CANVAS_PAD * 2 + (maxY - minY) + ORB_SLOT + CAP_H;
    return { order, byId, positions, clusters, width, height };
  }

  function mindmapLineageText(node, byId) {
    const parentId = node.parent_session_id;
    if (!parentId) return "root session";
    if (parentId === node.id) return "child of itself (anomalous lineage)";
    if (!byId.has(parentId)) return "child of " + parentId + " (not in the store)";
    return "child of " + parentId;
  }

  function mindmapTasksText(node) {
    const tasks = Array.isArray(node.in_flight_tasks) ? node.in_flight_tasks : [];
    if (tasks.length === 0) return "no tasks in flight";
    return (
      "in flight: " +
      tasks
        .map((t) => {
          const id = t && t.id != null ? String(t.id) : "?";
          const title = t && t.title ? " " + t.title : "";
          return id + title;
        })
        .join(", ")
    );
  }

  function mindmapCountsText(node) {
    const c = node.task_counts || {};
    const wave = node.current_wave != null ? "wave " + node.current_wave : "no wave";
    return (
      wave +
      " · " +
      (c.done || 0) +
      "/" +
      (c.total || 0) +
      " done · " +
      (c.pending || 0) +
      " pending · " +
      (c.blocked || 0) +
      " blocked · " +
      (c.failed || 0) +
      " failed"
    );
  }

  function createMindmapNodeEl(id) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "mindmap-node";
    el.dataset.sessionId = id;

    // The star itself. Purely decorative -- every fact it encodes (status,
    // running, degraded) is also written in the caption below it, so the
    // map never depends on colour or glow alone.
    const orb = document.createElement("span");
    orb.className = "mindmap-orb";
    orb.setAttribute("aria-hidden", "true");
    const orbCore = document.createElement("span");
    orbCore.className = "mindmap-orb-core";
    orb.appendChild(orbCore);
    el.appendChild(orb);

    const caption = document.createElement("span");
    caption.className = "mindmap-caption";
    el.appendChild(caption);

    const head = document.createElement("span");
    head.className = "mindmap-node-id";
    caption.appendChild(head);

    const badges = document.createElement("span");
    badges.className = "mindmap-node-badges";
    caption.appendChild(badges);

    const meta = document.createElement("span");
    meta.className = "mindmap-node-meta";
    caption.appendChild(meta);

    const tasks = document.createElement("span");
    tasks.className = "mindmap-node-tasks";
    caption.appendChild(tasks);

    const lineage = document.createElement("span");
    lineage.className = "mindmap-node-lineage";
    caption.appendChild(lineage);

    // Reuses the dashboard's own selection path; a native <button> gives
    // Enter/Space and tab order for free.
    el.addEventListener("click", () => {
      selectSession(el.dataset.sessionId);
      mindmapMarkSelected();
    });

    const entry = { el, orb, head, badges, meta, tasks, lineage };
    mindmapNodeEls.set(id, entry);
    mindmapNodesLayer.appendChild(el);
    return entry;
  }

  function mindmapBadge(parent, text, cls) {
    const span = document.createElement("span");
    span.className = "badge mindmap-badge " + cls;
    span.textContent = text;
    parent.appendChild(span);
  }

  function mindmapMarkSelected() {
    mindmapNodeEls.forEach((entry, id) => {
      entry.el.classList.toggle("mindmap-node-selected", id === selectedSessionId);
      entry.el.setAttribute("aria-pressed", id === selectedSessionId ? "true" : "false");
    });
  }

  function updateMindmapNode(entry, node, byId) {
    entry.head.textContent = node.id;

    entry.badges.textContent = "";
    mindmapBadge(entry.badges, node.status || "unknown", statusClass(node.status));
    if (node.is_active) mindmapBadge(entry.badges, "active", "mindmap-badge-active");
    if (node.is_fixture) mindmapBadge(entry.badges, "fixture", "mindmap-badge-fixture");
    if (node.degraded) {
      const sources = Array.isArray(node.degraded_sources) ? node.degraded_sources : [];
      mindmapBadge(
        entry.badges,
        sources.length > 0 ? "degraded: " + sources.join(", ") : "degraded",
        "mindmap-badge-degraded"
      );
    }

    entry.meta.textContent = mindmapCountsText(node);
    entry.tasks.textContent = mindmapTasksText(node);
    entry.lineage.textContent = mindmapLineageText(node, byId);
    entry.el.classList.toggle("mindmap-node-fixture", !!node.is_fixture);
    entry.el.classList.toggle("mindmap-node-degraded", !!node.degraded);
    entry.el.classList.toggle(
      "mindmap-node-live",
      !node.degraded && (node.status === "running" || !!node.is_active)
    );
    entry.el.dataset.status = statusSlug(node.status);
    // Twinkle phase is a pure function of the id, so it is stable across
    // polls (and is switched off entirely under reduced motion).
    entry.el.style.setProperty(
      "--star-delay",
      ((mindmapHash(node.id) % 40) / 10).toFixed(1) + "s"
    );
  }

  // Edges as curved threads of light. Each edge is a quadratic bezier
  // bowed to one side (deterministically, by a hash of its endpoints) and
  // painted with its OWN gradient running bright-at-the-mother to
  // faint-at-the-child, so direction stays readable without relying on
  // the arrowhead alone. The whole layer is aria-hidden; the lineage list
  // below carries the same information as words.
  function renderMindmapEdges(layout, visibleIds) {
    const edges = Array.isArray(mindmapGraph.edges) ? mindmapGraph.edges : [];
    // Edges carry no focus and no text, so rebuilding them each tick is
    // safe (unlike the nodes, which are updated in place).
    mindmapEdgesSvg
      .querySelectorAll(".mindmap-edge")
      .forEach((line) => line.remove());
    if (mindmapEdgeDefs) mindmapEdgeDefs.textContent = "";
    const SVG_NS = "http://www.w3.org/2000/svg";
    let i = 0;
    for (const edge of edges) {
      if (!edge || !visibleIds.has(edge.from) || !visibleIds.has(edge.to)) continue;
      const from = layout.positions.get(edge.from);
      const to = layout.positions.get(edge.to);
      if (!from || !to) continue;
      i += 1;

      const dx = to.cx - from.cx;
      const dy = to.cy - from.cy;
      const dist = Math.hypot(dx, dy) || 1;
      const ux = dx / dist;
      const uy = dy / dist;
      // Start/end on the rim of each orb, not at its centre.
      const x1 = from.cx + ux * (from.orb / 2 + 2);
      const y1 = from.cy + uy * (from.orb / 2 + 2);
      const x2 = to.cx - ux * (to.orb / 2 + 7);
      const y2 = to.cy - uy * (to.orb / 2 + 7);
      const bow = mindmapHash(edge.from + ">" + edge.to) % 2 === 0 ? 1 : -1;
      const bend = Math.min(dist * 0.16, 64) * bow;
      const mx = (x1 + x2) / 2 - uy * bend;
      const my = (y1 + y2) / 2 + ux * bend;

      const gradId = "mindmap-edge-grad-" + i;
      if (mindmapEdgeDefs) {
        const grad = document.createElementNS(SVG_NS, "linearGradient");
        grad.setAttribute("id", gradId);
        grad.setAttribute("gradientUnits", "userSpaceOnUse");
        grad.setAttribute("x1", String(x1));
        grad.setAttribute("y1", String(y1));
        grad.setAttribute("x2", String(x2));
        grad.setAttribute("y2", String(y2));
        const s0 = document.createElementNS(SVG_NS, "stop");
        s0.setAttribute("offset", "0");
        s0.setAttribute("stop-color", "#e6dbff");
        s0.setAttribute("stop-opacity", "0.95");
        const s1 = document.createElementNS(SVG_NS, "stop");
        s1.setAttribute("offset", "1");
        s1.setAttribute("stop-color", "#8a6fd6");
        s1.setAttribute("stop-opacity", "0.38");
        grad.appendChild(s0);
        grad.appendChild(s1);
        mindmapEdgeDefs.appendChild(grad);
      }

      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("class", "mindmap-edge");
      path.setAttribute(
        "d",
        "M " + x1 + " " + y1 + " Q " + mx + " " + my + " " + x2 + " " + y2
      );
      path.setAttribute("stroke", "url(#" + gradId + ")");
      path.setAttribute("marker-end", "url(#mindmap-arrow)");
      path.dataset.from = edge.from;
      path.dataset.to = edge.to;
      mindmapEdgesSvg.appendChild(path);
    }
  }

  // The accessible text alternative: an SVG-and-divs drawing conveys
  // nothing to a screen reader, so the same lineage is also a plain list.
  function renderMindmapList(layout) {
    mindmapList.textContent = "";
    for (const node of layout.order) {
      const li = document.createElement("li");
      li.className = "mindmap-list-item";

      const idEl = document.createElement("strong");
      idEl.textContent = node.id;
      li.appendChild(idEl);

      const detail = document.createElement("span");
      detail.className = "mindmap-list-detail";
      const bits = [
        "status " + (node.status || "unknown"),
        mindmapCountsText(node),
        mindmapTasksText(node),
        mindmapLineageText(node, layout.byId),
      ];
      if (node.is_fixture) bits.push("fixture session");
      if (node.degraded) bits.push("degraded (unreadable session files)");
      detail.textContent = " -- " + bits.join(" -- ");
      li.appendChild(detail);

      mindmapList.appendChild(li);
    }
  }

  function renderMindmap() {
    const nodes = mindmapVisibleNodes();
    mindmapEmpty.hidden = nodes.length > 0;
    mindmapCanvas.hidden = nodes.length === 0;

    const visibleIds = new Set(nodes.map((n) => n.id));
    // Drop elements for sessions that are gone (or filtered out); every
    // surviving element is UPDATED, never recreated, so focus survives.
    mindmapNodeEls.forEach((entry, id) => {
      if (!visibleIds.has(id)) {
        entry.el.remove();
        mindmapNodeEls.delete(id);
      }
    });

    const layout = mindmapLayout(nodes);
    mindmapCanvas.style.width = layout.width + "px";
    mindmapCanvas.style.height = layout.height + "px";
    mindmapEdgesSvg.setAttribute("width", String(layout.width));
    mindmapEdgesSvg.setAttribute("height", String(layout.height));
    mindmapEdgesSvg.setAttribute("viewBox", "0 0 " + layout.width + " " + layout.height);

    for (const node of layout.order) {
      const entry = mindmapNodeEls.get(node.id) || createMindmapNodeEl(node.id);
      const pos = layout.positions.get(node.id);
      entry.el.style.left = pos.x + "px";
      entry.el.style.top = pos.y + "px";
      entry.el.style.setProperty("--orb-size", pos.orb + "px");
      updateMindmapNode(entry, node, layout.byId);
    }

    renderMindmapEdges(layout, visibleIds);
    renderMindmapList(layout);
    mindmapMarkSelected();
  }

  async function refreshMindmap() {
    try {
      const data = await fetchJson("/api/sessions/graph");
      if (!data) return; // 401 -> fetchJson already redirected to /login
      mindmapGraph = {
        nodes: Array.isArray(data.nodes) ? data.nodes : [],
        edges: Array.isArray(data.edges) ? data.edges : [],
      };
      mindmapErrorEl.hidden = true;
      renderMindmap();
    } catch (err) {
      // Slow/failed/malformed responses show an explicit error state --
      // never a silently blank canvas, and never an unhandled rejection.
      mindmapErrorEl.hidden = false;
    }
  }

  if (mindmapHideFixtures) {
    mindmapHideFixtures.addEventListener("change", () => renderMindmap());
  }

  loadWhoami();
  tick();
  setInterval(tick, POLL_MS);
})();
