"use client";

import dynamic from "next/dynamic";

const CodeStudio = dynamic(() => import("@/components/code-studio"), { ssr: false });

export default function CodeStudioShell() {
  return <CodeStudio />;
}
