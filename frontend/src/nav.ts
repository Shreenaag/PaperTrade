// Four pages don't need a router: the path is the state, history.pushState changes it.
import { useEffect, useState } from "react";

export function navigate(path: string, replace = false) {
  if (replace) history.replaceState(null, "", path);
  else history.pushState(null, "", path);
  dispatchEvent(new PopStateEvent("popstate"));
}

export function usePath(): string {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
  return path;
}

// <a> that navigates without reloading the page.
export function linkProps(path: string) {
  return {
    href: path,
    onClick: (e: { preventDefault(): void; metaKey: boolean; ctrlKey: boolean }) => {
      if (e.metaKey || e.ctrlKey) return;
      e.preventDefault();
      navigate(path);
    },
  };
}
