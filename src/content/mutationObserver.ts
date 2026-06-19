export function startMangaMutationObserver(onChange: () => void): () => void {
  let timer: number | null = null;
  const schedule = () => {
    if (timer !== null) {
      window.clearTimeout(timer);
    }
    timer = window.setTimeout(() => {
      timer = null;
      onChange();
    }, 250);
  };

  const observer = new MutationObserver((mutations) => {
    if (
      mutations.some(
        (mutation) =>
          mutation.type === "childList" ||
          (mutation.type === "attributes" && ["src", "srcset", "style", "class"].includes(mutation.attributeName || ""))
      )
    ) {
      schedule();
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src", "srcset", "style", "class"]
  });

  return () => observer.disconnect();
}
