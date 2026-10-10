// Minimal import dependencies for lifecycle tests; no live Pi session or credentials.
export function getAgentDir() {
  return process.env.PI_CLAUDE_CODE_USE_TEST_AGENT_DIR;
}
export const keyHint = () => "";
export const keyText = () => "";
export const getCapabilities = () => ({});
export const getImageDimensions = () => undefined;
export const imageFallback = () => "[image]";
export class Text {
  constructor(text) { this.text = text; }
  render() { return [this.text]; }
  invalidate() {}
}
