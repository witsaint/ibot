"use client";

import { useEffect } from "react";
import { api } from "@/lib/api";

/** Check on resume and while visible so an open, idle workspace can renew its login too. */
export function SessionMonitor() {
  useEffect(() => {
    let checking = false;
    let lastCheck = 0;
    const check = () => {
      if (checking || document.visibilityState === "hidden" || !navigator.onLine) return;
      // Focus and visibilitychange often arrive together. Share one check within five seconds.
      if (Date.now() - lastCheck < 5000) return;
      checking = true;
      lastCheck = Date.now();
      void api
        .me()
        .catch(() => {
          // sessionFetch handles expiry. A network/server failure must not clear a valid login.
        })
        .finally(() => {
          checking = false;
        });
    };
    check();
    const interval = window.setInterval(check, 15 * 60 * 1000);
    window.addEventListener("focus", check);
    window.addEventListener("pageshow", check);
    window.addEventListener("online", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", check);
      window.removeEventListener("pageshow", check);
      window.removeEventListener("online", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, []);
  return null;
}
