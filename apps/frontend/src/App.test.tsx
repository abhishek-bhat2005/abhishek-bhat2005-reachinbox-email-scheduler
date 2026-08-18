import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { App } from "./App";

describe("application scaffold", () => {
  it("renders the product heading", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "Email Scheduler" })).toBeTruthy();
  });
});
