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

      tr.addEventListener("click", () => selectSession(s.id));
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

  async function tick() {
    await refreshSessions();
    await refreshDetail();
  }

  tick();
  setInterval(tick, POLL_MS);
})();
