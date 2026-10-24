// Landing page: only live data, no build step.
const health = document.getElementById("health");
const count = document.getElementById("count");
const tbody = document.querySelector("#apps tbody");

fetch("./healthz")
  .then((r) => r.json())
  .then((d) => { health.textContent = d.ok ? "relay online" : "relay degraded"; health.classList.add(d.ok ? "ok" : "bad"); })
  .catch(() => { health.textContent = "unreachable"; health.classList.add("bad"); });

fetch("./v1/apps")
  .then((r) => r.json())
  .then(({ apps }) => {
    count.textContent = apps.length + (apps.length === 1 ? " game" : " games");
    tbody.replaceChildren();
    for (const app of apps) {
      const tr = document.createElement("tr");
      const id = document.createElement("td");
      const code = document.createElement("code");
      code.textContent = app.id;
      id.append(code);
      const name = document.createElement("td");
      name.textContent = app.name ?? app.id;
      const access = document.createElement("td");
      const badge = document.createElement("span");
      badge.className = "access " + app.access;
      badge.textContent = app.access === "key" ? "anyone with the game" : "Cloudflare login";
      access.append(badge);
      tr.append(id, name, access);
      tbody.append(tr);
    }
  })
  .catch(() => {
    count.textContent = "—";
    tbody.innerHTML = '<tr><td colspan="3">could not load the app list</td></tr>';
  });
