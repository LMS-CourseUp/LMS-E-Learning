import type { Metadata } from "next";
import CodeStudioShell from "@/components/code-studio-shell";

export const metadata: Metadata = {
	title: "Code Editor",
	description: "Online code editor for HTML, CSS, JavaScript, PHP, and React projects.",
};

export default function CodePage() {
	return <CodeStudioShell />;
}