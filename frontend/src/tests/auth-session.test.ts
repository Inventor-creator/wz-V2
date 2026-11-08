import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api", () => ({
  default: {
    request: vi.fn(),
    defaults: { baseURL: "http://localhost:8080", withCredentials: true },
  },
}));

const user = {
  id: "verified-user-id",
  email: "aryapat1234@gmail.com",
  name: "Arya",
  role: "SUPER_ADMIN",
  status: "ACTIVE",
};

describe("real backend session restoration", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("VITE_MOCK_API", "false");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("reads the cookie-backed session rather than an empty demo session", async () => {
    const { default: http } = await import("../api");
    vi.mocked(http.request).mockResolvedValue({ data: user });
    const { auth, MOCK_MODE } = await import("../lib/api");
    expect(MOCK_MODE).toBe(false);
    expect(await auth.getCurrentUser()).toEqual(user);
    expect(http.request).toHaveBeenCalledWith({
      method: "GET",
      url: "/auth/me",
      data: undefined,
    });
  });

  it("restores login after module state is reset, as on a page reload", async () => {
    for (let reload = 0; reload < 2; reload++) {
      vi.resetModules();
      const { default: http } = await import("../api");
      vi.mocked(http.request).mockResolvedValue({ data: user });
      const { auth } = await import("../lib/api");
      expect(await auth.getCurrentUser()).toEqual(user);
    }
  });

  it("does not invent a user when the backend rejects the session", async () => {
    const { default: http } = await import("../api");
    vi.mocked(http.request).mockRejectedValue({ response: { status: 401 } });
    const { auth } = await import("../lib/api");
    await expect(auth.getCurrentUser()).rejects.toMatchObject({
      response: { status: 401 },
    });
  });
});
