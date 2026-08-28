(function () {
  "use strict";

  const POLL_MS = 4000;
  let selectedSessionId = null;

  const sessionsBody = document.querySelector("#sessions-table tbody");
  const tasksBody = document.querySelector("#tasks-table tbody");
  const eventsLog = document.getElementById("events-log");
  const detailTitle = document.getElementById("detail-title");

  function statusClass(status) {
    const s = (status || "unknown").toString().toLowerCase();
    return "status-" + s.replace(/[^a-z0-9_]/g, "_");
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
  }

  // -----------------------------------------------------------------
  // Top-level nav: Runs vs Skills library
  // -----------------------------------------------------------------
  const runsView = document.getElementById("runs-view");
  const skillsView = document.getElementById("skills-view");
  const topbarTitle = document.getElementById("topbar-title");
  const NAV_TITLES = { "runs-view": "Runs", "skills-view": "Skills library" };
  document.querySelectorAll(".nav-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".nav-tab").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const target = btn.dataset.view;
      runsView.hidden = target !== "runs-view";
      skillsView.hidden = target !== "skills-view";
      if (topbarTitle) topbarTitle.textContent = NAV_TITLES[target] || "";
      if (target === "skills-view") {
        refreshSkillsLibrary();
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

  async function refreshChat() {
    if (!selectedSessionId) return;
    try {
      const data = await fetchJson(
        "/api/sessions/" + encodeURIComponent(selectedSessionId) + "/inbox"
      );
      if (!data) return;
      const next = JSON.stringify(data.messages || []);
      if (next === lastRenderedChatJson) return;
      lastRenderedChatJson = next;
      chatMessagesCache = data.messages || [];
      renderChat();
    } catch (err) {
      console.error("failed to refresh chat", err);
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

  loadWhoami();
  tick();
  setInterval(tick, POLL_MS);
})();
