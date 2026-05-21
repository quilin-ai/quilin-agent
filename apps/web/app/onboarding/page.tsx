"use client";

import { useMemo, useState } from "react";

type Step = "welcome" | "frameworks" | "preview" | "confirm";
type PreviewKind = "soul" | "user" | "project";

interface FrameworkScan {
	readonly id: string;
	readonly present: boolean;
	readonly configPath: string | null;
	readonly binaryPath: string | null;
	readonly files: readonly string[];
}

interface Snippet {
	readonly framework: string;
	readonly label: string;
	readonly text: string;
	readonly sources: readonly string[];
}

interface ScanData {
	readonly approvalToken: string;
	readonly scan: {
		readonly frameworks: Record<string, FrameworkScan>;
		readonly personaSnippets: readonly Snippet[];
		readonly userSnippets: readonly Snippet[];
		readonly projectGuides: readonly Snippet[];
	};
	readonly previews: Record<
		PreviewKind,
		{ readonly path: string; readonly content: string; readonly exists: boolean }
	>;
}

interface InstallData {
	readonly installed: boolean;
	readonly needsApproval: boolean;
	readonly approvalRequest: {
		readonly approvalToken: string | null;
		readonly prompt: string;
		readonly detail: string;
	} | null;
	readonly written?: ReadonlyArray<{ readonly kind: PreviewKind; readonly path: string }>;
}

const FRAMEWORK_LABELS: Record<string, string> = {
	openclaw: "OpenClaw",
	hermes: "Hermes",
	"claude-code": "Claude Code",
	codex: "Codex",
	"gemini-cli": "Gemini CLI",
	opencode: "OpenCode",
};

async function postJson<T>(url: string, body: unknown): Promise<T> {
	const response = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	const payload = (await response.json()) as {
		ok?: boolean;
		data?: T;
		error?: { message?: string };
	};
	if (!response.ok || payload.ok !== true || payload.data == null) {
		throw new Error(payload.error?.message ?? `Request failed: ${response.status}`);
	}
	return payload.data;
}

function statusLabel(scan: FrameworkScan): string {
	if (scan.present) {
		return "Detected";
	}
	return "Not found";
}

function previewTitle(kind: PreviewKind): string {
	if (kind === "soul") return "soul.md";
	if (kind === "user") return "user.md";
	return "QUILIN.md";
}

export default function OnboardingPage() {
	const [step, setStep] = useState<Step>("welcome");
	const [scanData, setScanData] = useState<ScanData | null>(null);
	const [installData, setInstallData] = useState<InstallData | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const detectedCount = useMemo(() => {
		if (scanData == null) return 0;
		return Object.values(scanData.scan.frameworks).filter((framework) => framework.present).length;
	}, [scanData]);

	async function scan() {
		setBusy(true);
		setError(null);
		try {
			const data = await postJson<ScanData>("/api/onboarding/scan", {});
			setScanData(data);
			setStep("frameworks");
		} catch (scanError) {
			setError(scanError instanceof Error ? scanError.message : String(scanError));
		} finally {
			setBusy(false);
		}
	}

	async function install() {
		if (scanData == null) {
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const data = await postJson<InstallData>("/api/onboarding/install", {
				confirmed: true,
				approvalToken: scanData.approvalToken,
			});
			setInstallData(data);
			if (data.needsApproval && data.approvalRequest == null) {
				setError(
					"Approval token expired or no longer matches the preview. Start a fresh scan before installing.",
				);
				setScanData(null);
				setStep("welcome");
			}
		} catch (installError) {
			setError(installError instanceof Error ? installError.message : String(installError));
		} finally {
			setBusy(false);
		}
	}

	return (
		<main
			className="min-h-screen px-6 py-10 md:px-12"
			style={{ background: "var(--bg)", color: "var(--fg)" }}
		>
			<div className="mx-auto flex w-full max-w-6xl flex-col gap-8">
				<header
					className="flex flex-col gap-3 border-b pb-6"
					style={{ borderColor: "var(--border)" }}
				>
					<p
						className="q-mono text-xs uppercase tracking-[0.18em]"
						style={{ color: "var(--fg-subtle)" }}
					>
						QUI-81 onboarding
					</p>
					<div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
						<div>
							<h1 className="text-4xl font-medium md:text-5xl">Soul Import</h1>
							<p className="mt-2 max-w-2xl text-base" style={{ color: "var(--fg-muted)" }}>
								Scan existing agent framework instructions, preview the generated profile files,
								then write only after the critical approval step.
							</p>
						</div>
						<nav className="q-mono flex gap-2 text-xs" aria-label="Onboarding steps">
							{(["welcome", "frameworks", "preview", "confirm"] as const).map((item, index) => (
								<span
									key={item}
									className="border px-3 py-2"
									style={{
										borderColor: item === step ? "var(--border-strong)" : "var(--border)",
										color: item === step ? "var(--fg)" : "var(--fg-subtle)",
									}}
								>
									{index + 1}
								</span>
							))}
						</nav>
					</div>
				</header>

				{error == null ? null : (
					<div
						className="border px-4 py-3 text-sm"
						style={{ borderColor: "var(--destructive)", color: "var(--destructive)" }}
					>
						{error}
					</div>
				)}

				{step === "welcome" ? (
					<section
						data-testid="onboarding-step-welcome"
						className="grid gap-8 md:grid-cols-[1fr_360px]"
					>
						<div className="flex min-h-[360px] flex-col justify-center gap-6">
							<h2 className="text-2xl font-medium">Welcome</h2>
							<p className="max-w-2xl" style={{ color: "var(--fg-muted)" }}>
								This wizard looks for OpenClaw, Hermes, Claude Code, Codex, Gemini CLI, and OpenCode
								configuration files. The scan is read-only and redacts likely secrets before
								anything reaches the preview.
							</p>
							<div>
								<button
									type="button"
									data-testid="onboarding-start-scan"
									onClick={scan}
									disabled={busy}
									className="border px-5 py-3 text-sm font-medium disabled:opacity-50"
									style={{
										borderColor: "var(--border-strong)",
										background: "var(--fg)",
										color: "var(--bg)",
									}}
								>
									{busy ? "Scanning..." : "Start scan"}
								</button>
							</div>
						</div>
						<aside className="border p-5" style={{ borderColor: "var(--border)" }}>
							<p
								className="q-mono text-xs uppercase tracking-[0.14em]"
								style={{ color: "var(--fg-subtle)" }}
							>
								Targets
							</p>
							<ul className="mt-4 flex flex-col gap-3 text-sm" style={{ color: "var(--fg-muted)" }}>
								<li>~/.quilin/soul.md</li>
								<li>~/.quilin/user.md</li>
								<li>./QUILIN.md</li>
							</ul>
						</aside>
					</section>
				) : null}

				{step === "frameworks" && scanData != null ? (
					<section data-testid="onboarding-step-frameworks" className="flex flex-col gap-6">
						<div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
							<div>
								<h2 className="text-2xl font-medium">Framework Scan</h2>
								<p style={{ color: "var(--fg-muted)" }}>
									{detectedCount} of 6 frameworks detected.
								</p>
							</div>
							<button
								type="button"
								data-testid="onboarding-next-to-preview"
								onClick={() => setStep("preview")}
								className="border px-4 py-2 text-sm"
								style={{ borderColor: "var(--border-strong)" }}
							>
								Preview files
							</button>
						</div>
						<div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
							{Object.entries(scanData.scan.frameworks).map(([id, framework]) => (
								<article
									key={id}
									data-testid={`framework-card-${id}`}
									className="border p-4"
									style={{
										borderColor: framework.present ? "var(--accent-jade)" : "var(--border)",
									}}
								>
									<div className="flex items-center justify-between gap-3">
										<h3 className="text-lg font-medium">{FRAMEWORK_LABELS[id] ?? id}</h3>
										<span
											className="q-mono text-xs"
											style={{
												color: framework.present ? "var(--accent-jade)" : "var(--fg-subtle)",
											}}
										>
											{statusLabel(framework)}
										</span>
									</div>
									<p className="q-mono mt-3 break-all text-xs" style={{ color: "var(--fg-muted)" }}>
										{framework.configPath ??
											framework.binaryPath ??
											"No readable config or binary found"}
									</p>
									<p className="mt-3 text-sm" style={{ color: "var(--fg-muted)" }}>
										{framework.files.length} files considered
									</p>
								</article>
							))}
						</div>
					</section>
				) : null}

				{step === "preview" && scanData != null ? (
					<section data-testid="onboarding-step-preview" className="flex flex-col gap-6">
						<div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
							<div>
								<h2 className="text-2xl font-medium">File Preview</h2>
								<p style={{ color: "var(--fg-muted)" }}>
									Review all generated content before the critical write.
								</p>
							</div>
							<button
								type="button"
								data-testid="onboarding-next-to-confirm"
								onClick={() => setStep("confirm")}
								className="border px-4 py-2 text-sm"
								style={{ borderColor: "var(--border-strong)" }}
							>
								Continue
							</button>
						</div>
						<div className="grid gap-4 xl:grid-cols-3">
							{(["soul", "user", "project"] as const).map((kind) => (
								<section key={kind} className="border" style={{ borderColor: "var(--border)" }}>
									<div className="border-b px-4 py-3" style={{ borderColor: "var(--border)" }}>
										<h3 className="font-medium">{previewTitle(kind)}</h3>
										<p
											className="q-mono mt-1 break-all text-xs"
											style={{ color: "var(--fg-subtle)" }}
										>
											{scanData.previews[kind].path}
										</p>
									</div>
									<pre
										data-testid={`preview-${kind}`}
										className="q-mono min-h-[320px] overflow-auto whitespace-pre-wrap p-4 text-xs leading-6"
										style={{ background: "var(--bg-raised)", color: "var(--fg)" }}
									>
										{scanData.previews[kind].content}
									</pre>
								</section>
							))}
						</div>
					</section>
				) : null}

				{step === "confirm" && scanData != null ? (
					<section
						data-testid="onboarding-step-confirm"
						className="grid gap-6 md:grid-cols-[1fr_360px]"
					>
						<div className="flex flex-col gap-5">
							<h2 className="text-2xl font-medium">Confirm Write</h2>
							<p style={{ color: "var(--fg-muted)" }}>
								Install is a CRITICAL write operation. The API routes it through WriteAuthority with
								origin=install before writing profile files.
							</p>
							<div className="grid gap-3">
								{(["soul", "user", "project"] as const).map((kind) => (
									<div
										key={kind}
										className="border px-4 py-3"
										style={{ borderColor: "var(--border)" }}
									>
										<p className="font-medium">{previewTitle(kind)}</p>
										<p className="q-mono break-all text-xs" style={{ color: "var(--fg-subtle)" }}>
											{scanData.previews[kind].path}
										</p>
									</div>
								))}
							</div>
							<button
								type="button"
								data-testid="onboarding-confirm-install"
								onClick={install}
								disabled={busy || installData?.installed === true}
								className="w-fit border px-5 py-3 text-sm font-medium disabled:opacity-50"
								style={{
									borderColor: "var(--border-strong)",
									background: "var(--fg)",
									color: "var(--bg)",
								}}
							>
								{busy ? "Writing..." : "Confirm install"}
							</button>
						</div>
						<aside
							className="border p-5"
							style={{
								borderColor: installData?.installed ? "var(--accent-jade)" : "var(--border)",
							}}
						>
							<p
								className="q-mono text-xs uppercase tracking-[0.14em]"
								style={{ color: "var(--fg-subtle)" }}
							>
								Result
							</p>
							{installData == null ? (
								<p className="mt-4 text-sm" style={{ color: "var(--fg-muted)" }}>
									Waiting for confirmation.
								</p>
							) : installData.installed ? (
								<div className="mt-4 flex flex-col gap-3">
									<p className="text-lg font-medium" style={{ color: "var(--accent-jade)" }}>
										Installed
									</p>
									<ul className="flex flex-col gap-2 text-sm" style={{ color: "var(--fg-muted)" }}>
										{installData.written?.map((item) => (
											<li key={`${item.kind}:${item.path}`} className="break-all">
												{previewTitle(item.kind)} · {item.path}
											</li>
										))}
									</ul>
								</div>
							) : installData.needsApproval && installData.approvalRequest != null ? (
								<div className="mt-4 flex flex-col gap-3 text-sm">
									<p>{installData.approvalRequest.prompt}</p>
									<pre
										className="q-mono whitespace-pre-wrap text-xs"
										style={{ color: "var(--fg-muted)" }}
									>
										{installData.approvalRequest.detail}
									</pre>
								</div>
							) : null}
						</aside>
					</section>
				) : null}
			</div>
		</main>
	);
}
