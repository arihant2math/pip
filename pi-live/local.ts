/**
 * A view of *this* pi session, fed in-process by the LiveHost (no iroh, no share code). Used by `/gui`
 * so the host can follow and drive their own session in the browser GUI.
 */
import type { ClientFrame } from "./protocol.ts";
import type { LiveHost } from "./host.ts";
import { ViewModel } from "./client.ts";

export class LocalView extends ViewModel {
	private unsubscribe?: () => void;
	private readonly host: LiveHost;

	constructor(host: LiveHost) {
		super();
		this.host = host;
		this.unsubscribe = host.addLocal((frame) => this.apply(frame));
		this.setConn("live");
	}

	send(frame: ClientFrame): boolean {
		if (this.state.conn !== "live") return false;
		const r = this.host.localCommand(frame);
		if (r.error) {
			this.notice("error", r.error);
			return false;
		}
		if (r.info) this.notice("info", r.info);
		return true;
	}

	requestControl(): boolean {
		return true; // always in control of your own session
	}

	async close(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.setConn("closed", "GUI closed");
	}
}
