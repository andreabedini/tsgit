// Progressive enhancement for the repo index: filters cards as you type
// instead of waiting for the search form's full-page GET. No-op on any
// page that doesn't render the repo grid (e.g. mid-repo pages).
(() => {
  const input = document.querySelector('.cg-search input[name="q"]');
  const grid = document.querySelector("[data-search-grid]");
  if (!input || !grid) return;

  const cards = Array.from(grid.querySelectorAll(".cg-repocard"));
  const count = document.querySelector("[data-repo-count]");
  const empty = document.querySelector("[data-search-empty]");

  input.addEventListener("input", () => {
    const needle = input.value.trim().toLowerCase();
    let visible = 0;
    for (const card of cards) {
      const name = card.querySelector(".name")?.textContent.toLowerCase() ?? "";
      const desc = card.querySelector(".desc")?.textContent.toLowerCase() ?? "";
      const match = !needle || name.includes(needle) || desc.includes(needle);
      card.style.display = match ? "" : "none";
      if (match) visible++;
    }
    if (count) count.textContent = `${visible} ${visible === 1 ? "repo" : "repos"}`;
    if (empty) empty.style.display = visible === 0 ? "" : "none";
  });
})();
