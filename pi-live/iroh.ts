/**
 * Lazy loader for @number0/iroh. The native module is only loaded when sharing or watching starts,
 * so pi still starts (and reports a clear error) on platforms without a prebuilt binary.
 */
type IrohModule = typeof import("@number0/iroh");

let mod: Promise<IrohModule> | undefined;

export function loadIroh(): Promise<IrohModule> {
	mod ??= import("@number0/iroh").catch((err) => {
		mod = undefined;
		throw new Error(
			`could not load @number0/iroh (${err?.message ?? err}). Run \`npm install\` in the pi-live directory; ` +
				"prebuilt binaries exist for macOS arm64, Linux x64/arm64 and Windows x64/arm64.",
		);
	});
	return mod;
}

