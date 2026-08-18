import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { UserAvatar } from "./UserAvatar";

describe("UserAvatar", () => {
  it("falls back to the user's initial when the remote image fails", () => {
    const { container } = render(
      <UserAvatar avatarUrl="https://example.invalid/avatar.png" name="Abhishek Bhat" />,
    );

    const image = container.querySelector("img");
    expect(image).toBeTruthy();
    if (image !== null) fireEvent.error(image);

    expect(screen.getByText("A")).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
  });
});
