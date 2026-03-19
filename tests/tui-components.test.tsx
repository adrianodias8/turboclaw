/**
 * TUI component tests using ink-testing-library.
 *
 * Tests the Nav, StatusBar, and App navigation state machine.
 */
import React from "react";
import { describe, it, expect } from "bun:test";
import { render } from "ink-testing-library";
import { Text, Box } from "ink";
import { Nav, type Screen } from "../src/tui/components/nav";
import { StatusBar } from "../src/tui/components/status-bar";

describe("Nav component", () => {
  it("renders all 9 screen tabs", () => {
    const { lastFrame } = render(<Nav active="dashboard" />);
    const output = lastFrame()!;

    // Ink may render shortcut and label on separate lines, so check individually
    expect(output).toContain("[1]");
    expect(output).toContain("Dashboard");
    expect(output).toContain("[2]");
    expect(output).toContain("Tasks");
    expect(output).toContain("[3]");
    expect(output).toContain("Crons");
    expect(output).toContain("[4]");
    expect(output).toContain("Memory");
    expect(output).toContain("[5]");
    expect(output).toContain("Alerts");
    expect(output).toContain("[6]");
    expect(output).toContain("Logs");
    expect(output).toContain("[7]");
    expect(output).toContain("Settings");
    expect(output).toContain("[8]");
    expect(output).toContain("Experiments");
    expect(output).toContain("[9]");
    expect(output).toContain("Pipelines");
  });

  it("highlights the active tab", () => {
    const { lastFrame } = render(<Nav active="tasks" />);
    const output = lastFrame()!;
    // Active tab should be present (we can't easily check color in text output,
    // but we verify the component renders without errors for each screen)
    expect(output).toContain("Tasks");
  });

  it("renders correctly for each screen", () => {
    const screens: Screen[] = [
      "dashboard", "tasks", "crons", "memory", "alerts",
      "logs", "settings", "experiments", "pipelines",
    ];

    for (const screen of screens) {
      const { lastFrame } = render(<Nav active={screen} />);
      expect(lastFrame()).toBeTruthy();
    }
  });
});

describe("StatusBar component", () => {
  it("renders queue depth and worker count", () => {
    const { lastFrame } = render(
      <StatusBar queueDepth={5} activeWorkers={2} uptime={120} />
    );
    const output = lastFrame()!;

    expect(output).toContain("Queue:");
    expect(output).toContain("5");
    expect(output).toContain("Workers:");
    expect(output).toContain("2");
  });

  it("renders uptime in seconds format", () => {
    const { lastFrame } = render(
      <StatusBar queueDepth={0} activeWorkers={0} uptime={45} />
    );
    expect(lastFrame()!).toContain("45s");
  });

  it("renders uptime in minutes format", () => {
    const { lastFrame } = render(
      <StatusBar queueDepth={0} activeWorkers={0} uptime={125} />
    );
    expect(lastFrame()!).toContain("2m 5s");
  });

  it("renders uptime in hours format", () => {
    const { lastFrame } = render(
      <StatusBar queueDepth={0} activeWorkers={0} uptime={3725} />
    );
    expect(lastFrame()!).toContain("1h 2m");
  });

  it("shows alert count when > 0", () => {
    const { lastFrame } = render(
      <StatusBar queueDepth={0} activeWorkers={0} uptime={0} alertCount={3} />
    );
    expect(lastFrame()!).toContain("Alerts: 3");
  });

  it("hides alert count when 0", () => {
    const { lastFrame } = render(
      <StatusBar queueDepth={0} activeWorkers={0} uptime={0} alertCount={0} />
    );
    expect(lastFrame()!).not.toContain("Alerts:");
  });

  it("hides alert count when undefined", () => {
    const { lastFrame } = render(
      <StatusBar queueDepth={0} activeWorkers={0} uptime={0} />
    );
    expect(lastFrame()!).not.toContain("Alerts:");
  });

  it("shows provider name when provided", () => {
    const { lastFrame } = render(
      <StatusBar queueDepth={0} activeWorkers={0} uptime={0} providerName="anthropic" />
    );
    expect(lastFrame()!).toContain("Provider:");
    expect(lastFrame()!).toContain("anthropic");
  });

  it("hides provider when not provided", () => {
    const { lastFrame } = render(
      <StatusBar queueDepth={0} activeWorkers={0} uptime={0} />
    );
    expect(lastFrame()!).not.toContain("Provider:");
  });

  it("shows WhatsApp status as 'off' when disabled", () => {
    const { lastFrame } = render(
      <StatusBar queueDepth={0} activeWorkers={0} uptime={0} whatsappEnabled={false} />
    );
    expect(lastFrame()!).toContain("WA:");
    expect(lastFrame()!).toContain("off");
  });

  it("shows WhatsApp status as 'connecting' when enabled but not connected", () => {
    const { lastFrame } = render(
      <StatusBar queueDepth={0} activeWorkers={0} uptime={0} whatsappEnabled={true} whatsappConnected={false} />
    );
    expect(lastFrame()!).toContain("connecting");
  });

  it("shows WhatsApp status as 'connected' when enabled and connected", () => {
    const { lastFrame } = render(
      <StatusBar queueDepth={0} activeWorkers={0} uptime={0} whatsappEnabled={true} whatsappConnected={true} />
    );
    expect(lastFrame()!).toContain("connected");
  });
});

describe("App navigation state machine", () => {
  // Test the navigation logic extracted from app.tsx without rendering the full App
  // (which requires Store, Config, and other heavy dependencies)

  function createNavigationMachine() {
    let screen: Screen = "dashboard";
    let taskDetailId: string | null = null;

    const screenMap: Record<string, Screen> = {
      "1": "dashboard",
      "2": "tasks",
      "3": "crons",
      "4": "memory",
      "5": "alerts",
      "6": "logs",
      "7": "settings",
      "8": "experiments",
      "9": "pipelines",
    };

    return {
      get screen() { return screen; },
      get taskDetailId() { return taskDetailId; },
      get activeScreen(): Screen { return taskDetailId ? "tasks" : screen; },

      navigate(target: Screen, detail?: string) {
        screen = target;
        if (target === "tasks" && detail) {
          taskDetailId = detail;
        } else {
          taskDetailId = null;
        }
      },

      handleInput(input: string) {
        if (!taskDetailId && screenMap[input]) {
          this.navigate(screenMap[input]);
        }
      },
    };
  }

  it("starts on dashboard", () => {
    const nav = createNavigationMachine();
    expect(nav.screen).toBe("dashboard");
    expect(nav.activeScreen).toBe("dashboard");
  });

  it("switches screen via number keys", () => {
    const nav = createNavigationMachine();

    nav.handleInput("2");
    expect(nav.screen).toBe("tasks");

    nav.handleInput("5");
    expect(nav.screen).toBe("alerts");

    nav.handleInput("9");
    expect(nav.screen).toBe("pipelines");
  });

  it("ignores invalid keys", () => {
    const nav = createNavigationMachine();
    nav.handleInput("0");
    expect(nav.screen).toBe("dashboard");

    nav.handleInput("a");
    expect(nav.screen).toBe("dashboard");
  });

  it("navigates to task detail", () => {
    const nav = createNavigationMachine();
    nav.navigate("tasks", "task-123");

    expect(nav.screen).toBe("tasks");
    expect(nav.taskDetailId).toBe("task-123");
    expect(nav.activeScreen).toBe("tasks");
  });

  it("clears task detail when navigating away", () => {
    const nav = createNavigationMachine();
    nav.navigate("tasks", "task-123");
    expect(nav.taskDetailId).toBe("task-123");

    nav.navigate("dashboard");
    expect(nav.taskDetailId).toBeNull();
  });

  it("blocks number key navigation while in task detail", () => {
    const nav = createNavigationMachine();
    nav.navigate("tasks", "task-123");

    nav.handleInput("1"); // Should be blocked
    expect(nav.screen).toBe("tasks");
    expect(nav.taskDetailId).toBe("task-123");
  });

  it("allows navigation after leaving task detail", () => {
    const nav = createNavigationMachine();
    nav.navigate("tasks", "task-123");
    nav.navigate("tasks"); // exit detail view

    expect(nav.taskDetailId).toBeNull();

    nav.handleInput("1");
    expect(nav.screen).toBe("dashboard");
  });

  it("all 9 screens are reachable via number keys", () => {
    const nav = createNavigationMachine();
    const expected: [string, Screen][] = [
      ["1", "dashboard"],
      ["2", "tasks"],
      ["3", "crons"],
      ["4", "memory"],
      ["5", "alerts"],
      ["6", "logs"],
      ["7", "settings"],
      ["8", "experiments"],
      ["9", "pipelines"],
    ];

    for (const [key, screen] of expected) {
      nav.handleInput(key);
      expect(nav.screen).toBe(screen);
    }
  });
});
