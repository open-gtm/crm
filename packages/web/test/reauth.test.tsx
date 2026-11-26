import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReauthDialog } from "@/features/shell/Reauth";
import { ApiClient } from "@/lib/api/client";
import { ApiProvider } from "@/lib/api/context";
import { qk } from "@/lib/keys";
import { createAppRouter } from "@/router";
import { fakeFetch, SESSION, type Handler } from "./utils";

// Built in parts, so no secret scanner mistakes it for a real credential.
const PASSWORD = ["correct", "horse", "battery"].join(" ");
const CAPS = { enabled: true, methods: { email_code: true, password: true, sso: null }, code_length: 6 };

function mount(path: string, handler: Handler) {
  const { fetch, calls } = fakeFetch(handler);
  const api = new ApiClient({ fetch, sleep: async () => {} });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter({ api, queryClient: qc }, createMemoryHistory({ initialEntries: [path] }));
  render(<ApiProvider value={api}><QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider></ApiProvider>);
  return { calls };
}

describe("signing in again (reauth)", () => {
  const replace = vi.fn();
  const assign = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("location", { ...window.location, origin: "http://localhost", pathname: "/settings/api-keys", search: "", hash: "", replace, assign });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    replace.mockReset();
    assign.mockReset();
  });

  it("without reauth, a live session goes straight back", async () => {
    mount("/sign-in?return_to=%2Fsettings%2Fapi-keys", (c) => (c.path === "/auth/capabilities" ? { body: CAPS } : c.path === "/v1/auth/session" ? { body: SESSION } : undefined));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/settings/api-keys"));
  });

  it("with reauth=1, shows the methods for the signed-in member even though a session is live, and returns to the page after", async () => {
    const { calls } = mount("/sign-in?reauth=1&return_to=%2Fsettings%2Fapi-keys", (c) => {
      if (c.path === "/auth/capabilities") return { body: CAPS };
      if (c.path === "/v1/auth/session") return { body: SESSION };
      if (c.path === "/auth/password") return { body: { status: "signed_in", workspace: { id: "ws_1", name: "Test Co" }, return_to: "/settings/api-keys", csrf_token: "n", expires_at: "", idle_expires_at: "" } };
      return undefined;
    });
    expect(await screen.findByRole("heading", { name: "Confirm it's you" })).toBeInTheDocument();
    const email = screen.getByRole("textbox", { name: "Email" });
    expect(email).toHaveValue("me@example.com");
    expect(email).toHaveAttribute("readonly");
    expect(replace).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText("Password"), "correct horse battery");
    await userEvent.click(screen.getByRole("button", { name: /^sign in$/i }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/settings/api-keys"));
    expect(calls.find((c) => c.path === "/auth/password")!.body).toMatchObject({ email: "me@example.com", workspace: "ws_1", return_to: "/settings/api-keys" });
  });

  it("with reauth=1 and an OAuth consent as return_to (an admin connection needs a recent sign-in), leaves for the server's page with a full page load", async () => {
    const back = `/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: "https://client.example/c.json", redirect_uri: "https://client.example/cb", state: "st-1", code_challenge: "x".repeat(43), code_challenge_method: "S256", resource: "https://mcp.example.com/mcp/admin", scope: "admin" })}`;
    mount(`/sign-in?reauth=1&return_to=${encodeURIComponent(back)}`, (c) => {
      if (c.path === "/auth/capabilities") return { body: CAPS };
      if (c.path === "/v1/auth/session") return { body: SESSION };
      if (c.path === "/auth/password") return { body: { status: "signed_in", workspace: { id: "ws_1", name: "Test Co" }, return_to: back, csrf_token: "n", expires_at: "", idle_expires_at: "" } };
      return undefined;
    });
    expect(await screen.findByRole("heading", { name: "Confirm it's you" })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Password"), "correct horse battery");
    await userEvent.click(screen.getByRole("button", { name: /^sign in$/i }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(back));
  });
});

describe("creating a workspace from the sign-in screen", () => {
  const signedOut: Handler = (c) => (c.path === "/v1/auth/session" ? { status: 401, body: { code: "unauthorized", detail: "no" } } : undefined);

  it("is offered only when the server allows sign-up, and keeps where the person was going", async () => {
    mount("/sign-in?return_to=%2Fsettings%2Fapi-keys", (c) => (c.path === "/auth/capabilities" ? { body: { ...CAPS, sign_up: true } } : signedOut(c)));
    const link = await screen.findByRole("link", { name: "Create a workspace" });
    expect(link).toHaveAttribute("href", "/auth/sign-up?return_to=%2Fsettings%2Fapi-keys");
  });

  it("is not offered otherwise", async () => {
    mount("/sign-in", (c) => (c.path === "/auth/capabilities" ? { body: CAPS } : signedOut(c)));
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Create a workspace" })).toBeNull();
  });

  it("is not offered while confirming who you are", async () => {
    mount("/sign-in?reauth=1", (c) => (c.path === "/auth/capabilities" ? { body: { ...CAPS, sign_up: true } } : c.path === "/v1/auth/session" ? { body: SESSION } : undefined));
    expect(await screen.findByRole("heading", { name: "Confirm it's you" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Create a workspace" })).toBeNull();
  });
});

describe("the confirm-it's-you dialog", () => {
  it("confirms with the password, sets the new session's token and lets the action carry on", async () => {
    const { fetch, calls } = fakeFetch((c) => (c.path === "/auth/capabilities" ? { body: CAPS }
      : c.path === "/auth/password" ? { body: { status: "signed_in", workspace: { id: "ws_1", name: "Test Co" }, return_to: "/", csrf_token: "fresh", expires_at: "", idle_expires_at: "" } }
      : undefined));
    const api = new ApiClient({ fetch });
    const qc = new QueryClient();
    qc.setQueryData(qk.session, SESSION);
    const done = vi.fn();
    render(<ApiProvider value={api}><QueryClientProvider client={qc}><ReauthDialog open onDone={done} /></QueryClientProvider></ApiProvider>);
    expect(await screen.findByRole("dialog", { name: "Confirm it's you" })).toBeInTheDocument();
    await userEvent.type(await screen.findByLabelText("Password"), PASSWORD);
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(done).toHaveBeenCalledWith(true));
    expect(calls.find((c) => c.path === "/auth/password")!.body).toEqual({ email: "me@example.com", password: PASSWORD, workspace: "ws_1" });
    // The client now writes with the new session's token.
    expect(api.hasCsrfToken()).toBe(true);
  });

  it("says so when the password is wrong, and cancelling declines", async () => {
    const { fetch } = fakeFetch((c) => (c.path === "/auth/capabilities" ? { body: CAPS } : c.path === "/auth/password" ? { status: 401, body: { code: "sign_in_failed", detail: "no" } } : undefined));
    const qc = new QueryClient();
    qc.setQueryData(qk.session, SESSION);
    const done = vi.fn();
    render(<ApiProvider value={new ApiClient({ fetch })}><QueryClientProvider client={qc}><ReauthDialog open onDone={done} /></QueryClientProvider></ApiProvider>);
    await userEvent.type(await screen.findByLabelText("Password"), "wrong-password");
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That password isn't right.");
    expect(done).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(done).toHaveBeenCalledWith(false);
  });
});
