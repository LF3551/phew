// Phew website: the demo in the hero, the feature tabs, and the header line.

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

// The demo plays one task: read, the tests fail, edit, the tests pass, done.
const demo = document.querySelector(".demo-window");
const replay = document.querySelector(".replay");
const statusText = document.querySelector(".status-text");
const statuses = [
  "Reading the code",
  "Reading the code",
  "Running the tests",
  "Fixing src/auth.ts",
  "Checking the fix",
  "Bug fixed. Phew.",
];
// Quick at the start, so the first screen is never empty for long.
const delays = [350, 600, 1100, 1200, 1200, 900];
let timer;

function show(step) {
  demo.dataset.step = String(step);
  for (const item of demo.querySelectorAll("[data-at]"))
    item.classList.toggle("shown", Number(item.dataset.at) <= step);
  statusText.textContent = statuses[step];
  demo.classList.toggle("finished", step >= 5);
}

function play() {
  clearTimeout(timer);
  replay.hidden = true;
  if (reduceMotion.matches) {
    show(5);
    return;
  }
  let step = 0;
  show(step);
  const next = () => {
    step += 1;
    show(step);
    if (step < 5) timer = setTimeout(next, delays[step]);
    else replay.hidden = false;
  };
  timer = setTimeout(next, delays[0]);
}

if (demo) {
  replay.addEventListener("click", play);
  // Starts when the demo is in view, so a reader who scrolls back sees the end, not a restart.
  const observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer.disconnect();
        play();
      }
    },
    { threshold: 0.25 },
  );
  observer.observe(demo);
}

// The feature tabs show one picture at a time; arrow keys move between them.
const tabs = [...document.querySelectorAll('[role="tab"]')];
const panel = document.getElementById("panel");
const image = panel?.querySelector("img");
const caption = panel?.querySelector(".caption");

function select(tab, focus) {
  for (const other of tabs) {
    const selected = other === tab;
    other.setAttribute("aria-selected", String(selected));
    other.tabIndex = selected ? 0 : -1;
  }
  panel.setAttribute("aria-labelledby", tab.id);
  image.srcset = tab.dataset.srcset;
  image.src = tab.dataset.image;
  image.alt = tab.dataset.alt;
  caption.textContent = tab.querySelector("span").textContent;
  if (focus) tab.focus();
  if (window.matchMedia("(max-width: 960px)").matches) tab.scrollIntoView({ block: "nearest", inline: "nearest" });
}

for (const tab of tabs) {
  tab.addEventListener("click", () => select(tab, false));
  tab.addEventListener("keydown", (event) => {
    const index = tabs.indexOf(tab);
    const moves = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };
    if (event.key in moves) {
      event.preventDefault();
      select(tabs[(index + moves[event.key] + tabs.length) % tabs.length], true);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      select(tabs[event.key === "Home" ? 0 : tabs.length - 1], true);
    }
  });
}

// Loads the other pictures after the page, in the size that this screen needs, so switching tabs is instant.
window.addEventListener("load", () => {
  for (const tab of tabs) {
    const next = new Image();
    next.sizes = image.sizes;
    next.srcset = tab.dataset.srcset;
    next.src = tab.dataset.image;
  }
});

// The header gets a line once the page scrolls.
const header = document.querySelector(".top");
const onScroll = () => header.classList.toggle("scrolled", window.scrollY > 8);
window.addEventListener("scroll", onScroll, { passive: true });
onScroll();
