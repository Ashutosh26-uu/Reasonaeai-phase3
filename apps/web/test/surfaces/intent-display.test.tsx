/**
 * @vitest-environment jsdom
 */

import type { StructuredIntent } from "@reasonateai/contracts/intent";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IntentDisplay } from "../../components/surfaces/intent-display";

describe("IntentDisplay Component", () => {
  beforeEach(() => {
    cleanup();
  });

  afterEach(() => {
    cleanup();
  });

  it("handles undefined intent gracefully", () => {
    render(<IntentDisplay />);
    expect(screen.getByText("No intent detected yet.")).toBeDefined();
  });

  it("handles completely empty intent correctly", () => {
    const emptyIntent: StructuredIntent = {
      components: [],
      inferredFeatures: [],
      screens: [],
      workflow: "",
    };

    render(<IntentDisplay intent={emptyIntent} />);

    expect(screen.getByText("No screens identified.")).toBeDefined();
    expect(screen.getByText("No components identified.")).toBeDefined();
    expect(screen.getByText("No workflow described.")).toBeDefined();
    expect(screen.getByText("No features inferred.")).toBeDefined();
  });

  it("renders fully populated intent correctly", () => {
    const fullIntent: StructuredIntent = {
      components: ["Header", "Footer"],
      inferredFeatures: ["Dark Mode", "Offline Support"],
      screens: ["Home Screen", "Settings Screen"],
      workflow: "User opens app and logs in.",
    };

    render(<IntentDisplay intent={fullIntent} />);

    // Check screens
    expect(screen.getByText("Home Screen")).toBeDefined();
    expect(screen.getByText("Settings Screen")).toBeDefined();

    // Check components
    expect(screen.getByText("Header")).toBeDefined();
    expect(screen.getByText("Footer")).toBeDefined();

    // Check workflow
    expect(screen.getByText("User opens app and logs in.")).toBeDefined();

    // Check features
    expect(screen.getByText("Dark Mode")).toBeDefined();
    expect(screen.getByText("Offline Support")).toBeDefined();
  });
});
