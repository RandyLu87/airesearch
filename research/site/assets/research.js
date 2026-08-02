window.addEventListener("load", () => {
  const sections = Array.from(document.querySelectorAll("main section[id]"));
  const navLinks = Array.from(document.querySelectorAll(".section-nav a"));

  if ("IntersectionObserver" in window && sections.length > 0) {
    const observer = new IntersectionObserver(
      (entries) => {
        const current = entries.find((entry) => entry.isIntersecting);
        if (!current) return;
        navLinks.forEach((link) => {
          link.toggleAttribute(
            "aria-current",
            link.getAttribute("href") === `#${current.target.id}`,
          );
        });
      },
      { rootMargin: "-20% 0px -65% 0px" },
    );
    sections.forEach((section) => observer.observe(section));
  }
});
