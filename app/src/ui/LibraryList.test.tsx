/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LibraryList, ROW_HEIGHT } from "./LibraryList";
import type { StoredTrack } from "../db/library";
import { EMPTY_TAGS } from "../metadata/tags";
afterEach(cleanup);
it("keeps 100k tracks to a bounded DOM and selects the last row after scrolling", () => {
  const tracks = Array.from({ length: 100_000 }, (_, index) => ({ id: String(index), name: `Track ${index}`,
    tags: EMPTY_TAGS, manualBpm: null, manualKeyTonic: null, manualKeyMode: null, analysis: null, durationSec: 120 }) as StoredTrack);
  const select = vi.fn();
  const { container } = render(<LibraryList tracks={tracks} selectedId={null} jobs={{}} onSelect={select} />);
  expect(container.querySelectorAll(".row").length).toBeLessThan(30);
  fireEvent.scroll(container.querySelector(".library")!, { target: { scrollTop: 100_000 * ROW_HEIGHT - 640 } });
  fireEvent.click(screen.getByText("Track 99999"));
  expect(select).toHaveBeenCalledWith("99999");
  expect(container.querySelectorAll(".row").length).toBeLessThan(30);
});
