import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { ContextMeter } from "../../src/components/lifeor/context-meter";
afterEach(cleanup);
describe("context status", () => {
  test("distinguishes unknown, estimated, compacting and measured usage", () => {
    const { rerender } = render(<ContextMeter compacting={false} />);
    expect(screen.getByRole("meter").getAttribute("aria-valuetext")).toBe(
      "Context not measured yet",
    );
    const usage = {
      tokens: 8000,
      window: 10000,
      percent: 80,
      outputReserve: 1000,
      estimated: true,
    };
    rerender(<ContextMeter usage={usage} compacting={false} />);
    expect(screen.getByText("Context ~80%")).toBeTruthy();
    rerender(<ContextMeter usage={usage} compacting />);
    expect(screen.getByText("Compacting context…")).toBeTruthy();
    rerender(
      <ContextMeter
        usage={{ ...usage, percent: 55, tokens: 5500, estimated: false }}
        compacting={false}
      />,
    );
    expect(screen.getByText("Context 55%")).toBeTruthy();
    expect(screen.getByRole("meter").getAttribute("aria-valuenow")).toBe("55");
  });
});
