/**
 * Minimal ambient types for `@novnc/novnc` (the package ships no bundled `.d.ts`).
 * Only the RFB surface we actually drive is declared — enough to embed the client
 * directly in our own React component instead of the vnc_lite.html iframe.
 *
 * Verified against @novnc/novnc@1.7.0 `core/rfb.js`:
 *   constructor(target, urlOrChannel, options)
 *   accessors: viewOnly / scaleViewport / clipViewport / resizeSession / background …
 *   methods:   disconnect() / sendCtrlAltDel() …
 *   events (via EventTarget): "connect", "disconnect" (detail:{clean}), "credentialsrequired", …
 */
declare module "@novnc/novnc" {
  export interface RFBCredentials {
    username?: string;
    password?: string;
    target?: string;
  }
  export interface RFBOptions {
    shared?: boolean;
    credentials?: RFBCredentials;
    repeaterID?: string;
    wsProtocols?: string[];
  }
  export default class RFB extends EventTarget {
    constructor(
      target: HTMLElement,
      urlOrChannel: string | WebSocket | RTCDataChannel,
      options?: RFBOptions,
    );
    viewOnly: boolean;
    focusOnClick: boolean;
    clipViewport: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    showDotCursor: boolean;
    background: string;
    qualityLevel: number;
    compressionLevel: number;
    readonly capabilities: { power?: boolean };
    disconnect(): void;
    sendCtrlAltDel(): void;
    focus(options?: FocusOptions): void;
    blur(): void;
    machineShutdown(): void;
    machineReboot(): void;
    machineReset(): void;
    sendKey(keysym: number, code: string | null, down?: boolean): void;
    clipboardPasteFrom(text: string): void;
  }
}
