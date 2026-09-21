"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * `/login` is now just an alias for the root auth page — the sign-in / create-account form lives at
 * `/` (see app/page.tsx). This thin redirect keeps old links and any lingering `/login` references
 * working without duplicating the form (which would drift out of sync).
 */
export default function LoginRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/");
  }, [router]);

  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center" }}>
      <span className="spinner" />
    </main>
  );
}
