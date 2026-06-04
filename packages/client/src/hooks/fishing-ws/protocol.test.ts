import { describe, it, expect, afterEach, vi } from "vitest";
import { httpBase, wsUrl, DEFAULT_GATEWAY_HTTP } from "./protocol";

describe("fishing-ws protocol", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("httpBase defaults when no override is set", () => {
    vi.stubEnv("VITE_GATEWAY_HTTP", undefined);
    expect(httpBase()).toBe(DEFAULT_GATEWAY_HTTP);
  });

  it("httpBase honors the env override", () => {
    vi.stubEnv("VITE_GATEWAY_HTTP", "https://api.example.com");
    expect(httpBase()).toBe("https://api.example.com");
  });

  it("wsUrl converts http→ws and appends the gateway path", () => {
    vi.stubEnv("VITE_WS_URL", "");
    vi.stubEnv("VITE_GATEWAY_HTTP", "https://api.example.com");
    expect(wsUrl()).toBe("wss://api.example.com/ws/gateway");
  });

  it("wsUrl honors a full VITE_WS_URL override", () => {
    vi.stubEnv("VITE_WS_URL", "wss://edge.example.com/ws/gateway");
    expect(wsUrl()).toBe("wss://edge.example.com/ws/gateway");
  });
});
